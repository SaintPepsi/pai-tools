/**
 * Shared verify-fixer logic for the orchestrator.
 *
 * Invokes a Claude agent to fix verification failures, used by both the
 * sequential execution loop (execution.ts via agent-runner.ts) and the
 * parallel scheduler (parallel.ts).
 */

import { RollingWindow } from 'shared/log.ts';
import { runClaude as _runClaude } from 'shared/claude.ts';
import type { RunClaudeOpts } from 'shared/claude.ts';
import type { RunLogger } from 'shared/logging.ts';
import type { OrchestratorConfig } from 'tools/orchestrator/types.ts';

export interface VerifyFixerDeps {
	makeWindow: (header: string, logPath: string) => RollingWindow;
	runClaude: (opts: RunClaudeOpts) => Promise<{ ok: boolean; output: string }>;
}

const defaultDeps: VerifyFixerDeps = {
	makeWindow: (header, logPath) => new RollingWindow({ header, logPath }),
	runClaude: _runClaude,
};

export interface FixVerificationOptions {
	issueNumber: number;
	failedStep: string;
	errorOutput: string;
	config: OrchestratorConfig;
	worktreePath: string;
	logger: RunLogger;
}

/**
 * Invokes the Claude agent to fix a verification failure.
 *
 * Builds a targeted fix prompt from the failed step and error output, runs the
 * agent inside the issue worktree, and logs the agent output. Returns without
 * throwing — callers rely on the subsequent verify retry to detect success.
 */
export async function fixVerificationFailure(
	opts: FixVerificationOptions,
	deps: VerifyFixerDeps = defaultDeps,
): Promise<void> {
	const { issueNumber, failedStep, errorOutput, config, worktreePath, logger } = opts;

	const verifyList = config.verify.map((v) => `- ${v.cmd}`).join('\n');
	const fixPrompt = `The verification step "${failedStep}" failed for issue #${issueNumber}.

Error output:
${errorOutput}

Please fix the issues and ensure all verification commands pass:
${verifyList}

Commit your fixes referencing #${issueNumber}.`;

	const header = `Agent fixing verification for #${issueNumber}`;
	const window = deps.makeWindow(header, logger.path);

	const fixResult = await deps.runClaude({
		prompt: fixPrompt,
		model: config.models.implement,
		cwd: worktreePath,
		permissionMode: 'acceptEdits',
		allowedTools: config.allowedTools,
		onChunk: (chunk) => window.update(chunk),
	}).catch(() => ({ ok: false, output: '' }));

	window.clear();
	logger.agentOutput(issueNumber, fixResult.output);
}
