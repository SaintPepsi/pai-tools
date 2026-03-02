/**
 * Orchestrator execution loop — implements issues sequentially via Claude agents.
 *
 * Contains the main orchestration loop (runMainLoop) and the PR body builder.
 * Extracted from index.ts to keep the entry point focused on config and routing.
 */

import { log } from '../../shared/log.ts';
import { saveState } from '../../shared/state.ts';
import { createWorktree, removeWorktree } from '../../shared/git.ts';
import { fetchOpenIssues, createSubIssues, createPR } from '../../shared/github.ts';
import { buildGraph, topologicalSort } from './dependency-graph.ts';
import { runVerify } from '../verify/index.ts';
import { assessIssueSize, implementIssue, fixVerificationFailure } from './agent-runner.ts';
import { printExecutionPlan, printStatus } from './display.ts';
import { getIssueState } from './state-helpers.ts';
import { withRetries } from './retry.ts';
import type {
	GitHubIssue,
	DependencyNode,
	OrchestratorState,
	OrchestratorConfig,
	OrchestratorFlags
} from './types.ts';
import type { RunLogger } from '../../shared/logging.ts';

// ---------------------------------------------------------------------------
// Dependency injection interfaces (split by concern for ISP compliance)
// ---------------------------------------------------------------------------

export interface ExecutionGitDeps {
	createWorktree: typeof createWorktree;
	removeWorktree: typeof removeWorktree;
}

export interface ExecutionGithubDeps {
	fetchOpenIssues: typeof fetchOpenIssues;
	createSubIssues: typeof createSubIssues;
	createPR: typeof createPR;
}

export interface ExecutionAgentDeps {
	assessIssueSize: typeof assessIssueSize;
	implementIssue: typeof implementIssue;
	fixVerificationFailure: typeof fixVerificationFailure;
	runVerify: typeof runVerify;
}

export interface ExecutionStateDeps {
	saveState: (state: OrchestratorState, file: string) => void;
	getIssueState: typeof getIssueState;
	withRetries: typeof withRetries;
}

export interface ExecutionDisplayDeps {
	buildGraph: typeof buildGraph;
	topologicalSort: typeof topologicalSort;
	printExecutionPlan: typeof printExecutionPlan;
	printStatus: typeof printStatus;
	log: typeof log;
	exit: (code: number) => never;
}

export type ExecutionDeps = ExecutionGitDeps & ExecutionGithubDeps & ExecutionAgentDeps & ExecutionStateDeps & ExecutionDisplayDeps;

// ---------------------------------------------------------------------------
// Options object for runMainLoop (split for ISP compliance)
// ---------------------------------------------------------------------------

/** Execution context: mutable data structures passed into the loop. */
export interface RunMainLoopContext {
	executionOrder: number[];
	graph: Map<number, DependencyNode>;
	state: OrchestratorState;
	stateFile: string;
	repoRoot: string;
	logger: RunLogger;
}

/** Execution config: immutable settings + flags + optional DI. */
export interface RunMainLoopConfig {
	config: OrchestratorConfig;
	flags: OrchestratorFlags;
	deps?: ExecutionDeps;
}

export type RunMainLoopOptions = RunMainLoopContext & RunMainLoopConfig;

export const defaultExecutionDeps: ExecutionDeps = {
	createWorktree,
	removeWorktree,
	fetchOpenIssues,
	createSubIssues,
	createPR,
	assessIssueSize,
	implementIssue,
	fixVerificationFailure,
	runVerify,
	saveState,
	getIssueState,
	withRetries,
	buildGraph,
	topologicalSort,
	printExecutionPlan,
	printStatus,
	log,
	exit: (code) => process.exit(code),
};

// ---------------------------------------------------------------------------
// PR body builder
// ---------------------------------------------------------------------------

export function buildPRBody(
	issue: GitHubIssue,
	config: OrchestratorConfig,
	flags: OrchestratorFlags
): string {
	const verifyChecklist = config.verify
		.map((v) => `- [x] \`${v.cmd}\` passes`)
		.join('\n');
	const e2eLine = config.e2e
		? (flags.skipE2e ? '- [ ] E2E (skipped)' : `- [x] \`${config.e2e.run}\` passes`)
		: '';

	return `## Summary

Closes #${issue.number}

## Changes

See issue #${issue.number} for full specification.

## Verification

${verifyChecklist}
${e2eLine}

---
Automated by pai orchestrate`;
}

// ---------------------------------------------------------------------------
// Main orchestration loop
// ---------------------------------------------------------------------------

export async function runMainLoop(opts: RunMainLoopOptions): Promise<void> {
	const { executionOrder, graph, state, stateFile, repoRoot, logger, config, flags } = opts;
	const d = opts.deps ?? defaultExecutionDeps;

	let startIdx = 0;
	if (flags.singleIssue !== null) {
		startIdx = executionOrder.indexOf(flags.singleIssue);
		if (startIdx === -1) {
			d.log.error(`Issue #${flags.singleIssue} not found in execution order`);
			d.exit(1);
		}
	} else if (flags.fromIssue !== null) {
		startIdx = executionOrder.indexOf(flags.fromIssue);
		if (startIdx === -1) {
			d.log.error(`Issue #${flags.fromIssue} not found in execution order`);
			d.exit(1);
		}
	} else {
		for (let i = 0; i < executionOrder.length; i++) {
			const issueState = state.issues[executionOrder[i]];
			if (!issueState || issueState.status !== 'completed') {
				startIdx = i;
				break;
			}
		}
	}

	const modeLabel = flags.singleMode ? ' (single issue mode)' : '';
	const startNode = graph.get(executionOrder[startIdx]);
	const startTitle = startNode ? `: ${startNode.issue.title}` : '';
	d.log.info(
		`Starting from issue #${executionOrder[startIdx]}${startTitle} (position ${startIdx + 1}/${executionOrder.length})${modeLabel}`
	);

	for (let i = startIdx; i < executionOrder.length; i++) {
		const issueNum = executionOrder[i];
		const node = graph.get(issueNum);
		if (!node) continue;

		const issueState = d.getIssueState(state, issueNum, node.issue.title);
		if (issueState.status === 'completed') {
			d.log.dim(`Skipping #${issueNum} (already completed)`);
			continue;
		}
		if (issueState.status === 'split') {
			d.log.dim(`Skipping #${issueNum} (split into sub-issues)`);
			continue;
		}

		const issueStartTime = Date.now();
		d.log.step(`ISSUE #${issueNum}: ${node.issue.title} (${i + 1}/${executionOrder.length})`);

		// Check dependencies
		const unmetDeps = node.dependsOn.filter((dep) => {
			if (!graph.has(dep)) return false;
			const depState = state.issues[dep];
			return !depState || depState.status !== 'completed';
		});

		if (unmetDeps.length > 0) {
			d.log.error(`Unmet dependencies: ${unmetDeps.map((dep) => `#${dep}`).join(', ')}`);
			d.log.error('Cannot proceed — dependencies must be completed first');
			issueState.status = 'failed';
			issueState.error = `Unmet dependencies: ${unmetDeps.join(', ')}`;
			d.saveState(state, stateFile);
			logger.issueFailed(issueNum, issueState.error);
			d.exit(1);
		}

		// Assess splitting
		if (!flags.skipSplit) {
			d.log.info('Assessing issue size...');
			const assessment = await d.assessIssueSize(node.issue, config, repoRoot);
			d.log.dim(`Assessment: ${assessment.reasoning}`);

			if (assessment.shouldSplit && assessment.proposedSplits.length > 0) {
				d.log.warn(
					`Issue #${issueNum} needs splitting into ${assessment.proposedSplits.length} sub-issues`
				);

				const subIssueNumbers = await d.createSubIssues(
					node.issue,
					assessment.proposedSplits,
					node.dependsOn
				);

				issueState.status = 'split';
				issueState.subIssues = subIssueNumbers;
				d.saveState(state, stateFile);
				logger.issueSplit(issueNum, subIssueNumbers);

				d.log.ok(`Split into: ${subIssueNumbers.map((n) => `#${n}`).join(', ')}`);
				d.log.info('Re-fetching issues and rebuilding graph...');

				const freshIssues = await d.fetchOpenIssues(config.allowedAuthors);
				const freshGraph = d.buildGraph(freshIssues, config);
				const freshOrder = d.topologicalSort(freshGraph);

				graph.clear();
				for (const [k, v] of freshGraph) graph.set(k, v);
				executionOrder.length = 0;
				executionOrder.push(...freshOrder);

				d.printExecutionPlan(executionOrder, graph, config.baseBranch);

				const firstSubIdx = executionOrder.findIndex((n) => subIssueNumbers.includes(n));
				if (firstSubIdx !== -1) {
					i = firstSubIdx - 1;
				}
				continue;
			}
		}

		// Create worktree with fresh branch
		d.log.info('Creating worktree...');
		const depBranches = node.dependsOn
			.map((dep) => {
				const depNode = graph.get(dep);
				if (depNode) return depNode.branch;
				const depState = state.issues[dep];
				if (depState?.branch) return depState.branch;
				return null;
			})
			.filter((b): b is string => b !== null);

		const wtResult = await d.createWorktree(node.branch, depBranches, config, repoRoot, logger, issueNum);
		if (!wtResult.ok) {
			d.log.error(wtResult.error ?? 'Unknown worktree creation error');
			issueState.status = 'failed';
			issueState.error = wtResult.error ?? 'Worktree creation failed';
			d.saveState(state, stateFile);
			logger.issueFailed(issueNum, issueState.error);
			d.exit(1);
		}

		const { worktreePath, baseBranch } = wtResult;
		issueState.branch = node.branch;
		issueState.baseBranch = baseBranch;
		issueState.status = 'in_progress';
		d.saveState(state, stateFile);
		logger.issueStart(issueNum, node.issue.title, node.branch, baseBranch);

		d.log.ok(`Worktree at ${worktreePath} on branch ${node.branch} (base: ${baseBranch})`);

		// Implement (inside worktree)
		let lastImplError: string | undefined;
		const implRetryResult = await d.withRetries(
			async () => {
				const r = await d.implementIssue({ issue: node.issue, branchName: node.branch, baseBranch, config, worktreePath, logger });
				if (!r.ok) lastImplError = r.error;
				return r;
			},
			async (attempt) => {
				d.log.warn(`Implementation retry ${attempt + 1}/${config.retries.implement}`);
			},
			config.retries.implement + 1
		);

		if (!implRetryResult.ok) {
			d.log.error(`Implementation attempt failed: ${lastImplError}`);
			issueState.status = 'failed';
			issueState.error = `Implementation failed after ${config.retries.implement + 1} attempts: ${lastImplError}`;
			d.saveState(state, stateFile);
			logger.issueFailed(issueNum, issueState.error);
			await d.removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);
			d.log.error('HALTING — implementation failed');
			d.exit(1);
		}

		// Verify (inside worktree)
		d.log.info('Running verification pipeline...');
		let lastVerifyResult: Awaited<ReturnType<typeof runVerify>> | undefined;
		const verifyRetryResult = await d.withRetries(
			async () => {
				const r = await d.runVerify({
					verify: config.verify,
					e2e: config.e2e,
					cwd: worktreePath,
					skipE2e: flags.skipE2e,
					logger,
					issueNumber: issueNum
				});
				lastVerifyResult = r;
				return r;
			},
			async (attempt) => {
				const failedStep = lastVerifyResult?.failedStep;
				if (failedStep) {
					d.log.error(`Verification failed at ${failedStep}`);
					d.log.warn(
						`Verification retry ${attempt + 1}/${config.retries.verify} — feeding errors back to agent`
					);
					await d.fixVerificationFailure({
						issueNumber: issueNum,
						failedStep,
						errorOutput: lastVerifyResult?.error ?? '',
						config,
						worktreePath,
						logger
					});
				}
			},
			config.retries.verify + 1
		);

		if (!verifyRetryResult.ok) {
			const failedStep = lastVerifyResult?.failedStep ?? 'unknown';
			issueState.status = 'failed';
			issueState.error = `Verification failed at ${failedStep} after ${config.retries.verify + 1} attempts: ${lastVerifyResult?.error}`;
			d.saveState(state, stateFile);
			logger.issueFailed(issueNum, issueState.error);
			await d.removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);
			d.log.error('HALTING — verification failed');
			d.exit(1);
		}

		d.log.ok('All verification gates passed');

		// Create PR (push from worktree)
		d.log.info('Creating pull request...');
		const prBody = buildPRBody(node.issue, config, flags);
		const prResult = await d.createPR(node.issue.title, prBody, baseBranch, node.branch, worktreePath);
		if (!prResult.ok) {
			d.log.error(prResult.error ?? 'PR creation failed');
			issueState.status = 'failed';
			issueState.error = prResult.error ?? 'PR creation failed';
			d.saveState(state, stateFile);
			logger.issueFailed(issueNum, issueState.error);
			await d.removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);
			d.exit(1);
		}
		if (prResult.prNumber) logger.prCreated(issueNum, prResult.prNumber);

		// Clean up worktree (branch stays for the PR)
		await d.removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);

		// Mark complete
		const durationMs = Date.now() - issueStartTime;
		issueState.status = 'completed';
		issueState.error = null;
		issueState.prNumber = prResult.prNumber ?? null;
		issueState.completedAt = new Date().toISOString();
		d.saveState(state, stateFile);
		logger.issueComplete(issueNum, prResult.prNumber, durationMs);

		d.log.ok(`Issue #${issueNum} completed → PR #${prResult.prNumber}`);

		if (flags.singleMode) {
			d.log.step('SINGLE ISSUE COMPLETE');
			d.log.info(`Finished #${issueNum}. Run again to process the next issue.`);
			d.printStatus(state);
			break;
		}
	}

	if (!flags.singleMode) {
		d.log.step('ALL ISSUES COMPLETED');
		d.printStatus(state);
	}
}
