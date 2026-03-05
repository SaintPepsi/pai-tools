/**
 * Claude agent invocations for the issue orchestrator.
 *
 * Handles issue size assessment, implementation prompt construction,
 * and agent-driven issue implementation via the Claude CLI.
 */

import { log, RollingWindow } from 'shared/log.ts';
import { runClaude as _runClaude } from 'shared/claude.ts';
import type { RunClaudeOpts } from 'shared/claude.ts';
import type { RunLogger } from 'shared/logging.ts';
import type { GitHubIssue, OrchestratorConfig } from 'tools/orchestrator/types.ts';
import { fixVerificationFailure as _fixVerificationFailure } from 'tools/orchestrator/verify-fixer.ts';

export interface AgentRunnerDeps {
	makeWindow: (header: string, logPath: string) => RollingWindow;
	runClaude: (opts: RunClaudeOpts) => Promise<{ ok: boolean; output: string }>;
}

const defaultDeps: AgentRunnerDeps = {
	makeWindow: (header, logPath) => new RollingWindow({ header, logPath }),
	runClaude: _runClaude,
};

export async function assessIssueSize(
	issue: GitHubIssue,
	config: OrchestratorConfig,
	repoRoot: string
): Promise<{
	shouldSplit: boolean;
	proposedSplits: { title: string; body: string }[];
	reasoning: string;
}> {
	const prompt = `You are assessing whether a GitHub issue is too large for a single Claude Code agent session to implement.

A single agent session can reliably handle:
- Up to ~3 new files
- Up to ~500 lines of new code
- One coherent feature or system

If the issue requires MORE than that, propose splitting it into smaller sub-issues that can each be done in one session.

ISSUE #${issue.number}: ${issue.title}

${issue.body}

Respond in EXACTLY this JSON format (no markdown, no code fences):
{
  "shouldSplit": true/false,
  "reasoning": "one sentence explanation",
  "proposedSplits": [
    {"title": "Sub-issue title", "body": "Sub-issue description with acceptance criteria"}
  ]
}

If shouldSplit is false, proposedSplits should be an empty array.
Be conservative — only split if it's genuinely too large. Most issues with clear acceptance criteria can be done in one pass.`;

	log.step(`Assessing #${issue.number} size`);

	const { output: rawResult } = await _runClaude({
		prompt,
		model: config.models.assess,
		cwd: repoRoot
	}).catch(() => ({
		ok: false,
		output: ''
	}));

	const jsonMatch = rawResult.match(/\{[\s\S]*\}/);
	if (!jsonMatch) {
		return {
			shouldSplit: false,
			reasoning: 'No JSON found in assessment response',
			proposedSplits: []
		};
	}

	type AssessResult = { shouldSplit: boolean; proposedSplits: { title: string; body: string }[]; reasoning: string };
	const parsed = await Promise.resolve(jsonMatch[0])
		.then(s => JSON.parse(s) as AssessResult)
		.catch(() => null);

	return parsed ?? { shouldSplit: false, reasoning: 'Failed to parse assessment', proposedSplits: [] };
}

export function buildImplementationPrompt(
	issue: GitHubIssue,
	branchName: string,
	baseBranch: string,
	config: OrchestratorConfig,
	repoRoot: string
): string {
	const verifyList = config.verify.length > 0
		? config.verify.map((v) => `- ${v.cmd}`).join('\n')
		: '(no verification commands configured)';

	return `You are implementing GitHub issue #${issue.number}: ${issue.title}

## Issue Description

${issue.body}

## Context

- You are on branch: ${branchName}
- Based on: ${baseBranch}
- Project root: ${repoRoot}

## Instructions

1. Read CLAUDE.md first for project conventions and quality requirements
2. Explore existing code related to this feature before writing new code
3. Implement the feature described in the issue
4. Write tests for new functionality (colocated with source files)
5. Follow existing patterns in the codebase — check similar features first
6. Make atomic commits with descriptive messages referencing #${issue.number}
7. Ensure all verification commands pass before finishing:
${verifyList}

Do NOT create a pull request. Just implement, test, and commit.`;
}

export async function fixVerificationFailure(
	issueNumber: number,
	failedStep: string,
	errorOutput: string,
	config: OrchestratorConfig,
	worktreePath: string,
	logger: RunLogger
): Promise<void> {
	return _fixVerificationFailure({ issueNumber, failedStep, errorOutput, config, worktreePath, logger });
}

export async function implementIssue(
	issue: GitHubIssue,
	branchName: string,
	baseBranch: string,
	config: OrchestratorConfig,
	worktreePath: string,
	logger: RunLogger,
	deps: AgentRunnerDeps = defaultDeps
): Promise<{ ok: boolean; error?: string }> {
	const prompt = buildImplementationPrompt(issue, branchName, baseBranch, config, worktreePath);

	const header = `Agent implementing #${issue.number}`;
	const window = deps.makeWindow(header, logger.path);

	const result = await deps.runClaude({
		prompt,
		model: config.models.implement,
		cwd: worktreePath,
		permissionMode: 'acceptEdits',
		allowedTools: config.allowedTools,
		onChunk: (chunk) => window.update(chunk),
	});

	window.clear();
	log.dim(result.output.slice(-500));

	// Log full agent output
	logger.agentOutput(issue.number, result.output);

	if (!result.ok) {
		return { ok: false, error: 'Claude agent failed (exit non-zero)' };
	}
	return { ok: true };
}
