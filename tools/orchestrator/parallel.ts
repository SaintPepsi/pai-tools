/**
 * Parallel execution scheduler for the issue orchestrator.
 *
 * Runs up to N issues concurrently with dependency-aware scheduling.
 * Issues become ready when all their deps complete; dependents of
 * failed issues are marked `blocked`.
 */

import { log } from '../../shared/log.ts';
import { RunLogger } from '../../shared/logging.ts';
import { saveState } from '../../shared/state.ts';
import { createWorktree, removeWorktree } from '../../shared/git.ts';
import { createPR } from '../../shared/github.ts';
import { runVerify } from '../verify/runner.ts';
import { implementIssue } from './agent-runner.ts';
import { fixVerificationFailure } from './verify-fixer.ts';
import { buildPRBody } from './execution.ts';
import { getIssueState } from './state-helpers.ts';
import { withRetries } from './retry.ts';
import { printStatus } from './display.ts';
import type {
	DependencyNode,
	OrchestratorConfig,
	OrchestratorFlags,
	OrchestratorState
} from './types.ts';

// ---------------------------------------------------------------------------
// Mutex — serializes state file writes to prevent race conditions
// ---------------------------------------------------------------------------

export class Mutex {
	private chain: Promise<void> = Promise.resolve();

	run<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.chain.then(fn);
		// Extend chain regardless of fn success/failure so future calls still queue
		this.chain = result.then(
			() => {},
			() => {}
		);
		return result;
	}
}

// ---------------------------------------------------------------------------
// Per-issue logger (prefixes all output with [#N])
// ---------------------------------------------------------------------------

export type IssueLogger = {
	info(msg: string): void;
	ok(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
	step(msg: string): void;
	dim(msg: string): void;
};

export function makeIssueLog(issueNum: number, deps: ParallelLogDeps = defaultParallelDeps): IssueLogger {
	const prefix = `\x1b[2m[#${issueNum}]\x1b[0m `;
	return {
		info: (msg: string) => deps.log.info(`${prefix}${msg}`),
		ok: (msg: string) => deps.log.ok(`${prefix}${msg}`),
		warn: (msg: string) => deps.log.warn(`${prefix}${msg}`),
		error: (msg: string) => deps.log.error(`${prefix}${msg}`),
		step: (msg: string) => deps.log.step(`${prefix}${msg}`),
		dim: (msg: string) => deps.log.dim(`${prefix}${msg}`)
	};
}

// ---------------------------------------------------------------------------
// Dependency injection interfaces (split by concern for ISP compliance)
// ---------------------------------------------------------------------------

export interface ParallelGitDeps {
	createWorktree: typeof createWorktree;
	removeWorktree: typeof removeWorktree;
}

export interface ParallelGithubDeps {
	createPR: typeof createPR;
}

export interface ParallelAgentDeps {
	implementIssue: typeof implementIssue;
	fixVerificationFailure: typeof fixVerificationFailure;
	runVerify: typeof runVerify;
	buildPRBody: typeof buildPRBody;
}

export interface ParallelStateDeps {
	saveState: (state: OrchestratorState, file: string) => void;
	getIssueState: typeof getIssueState;
	withRetries: typeof withRetries;
}

export interface ParallelLogDeps {
	log: typeof log;
	printStatus: typeof printStatus;
}

export type ParallelDeps = ParallelGitDeps & ParallelGithubDeps & ParallelAgentDeps & ParallelStateDeps & ParallelLogDeps;

export const defaultParallelDeps: ParallelDeps = {
	createWorktree,
	removeWorktree,
	createPR,
	implementIssue,
	fixVerificationFailure,
	runVerify,
	buildPRBody,
	saveState,
	getIssueState,
	withRetries,
	log,
	printStatus,
};

// ---------------------------------------------------------------------------
// Options objects (split to keep each interface ≤8 members)
// ---------------------------------------------------------------------------

export interface ProcessOneIssueContext {
	issueNum: number;
	node: DependencyNode;
	state: OrchestratorState;
	repoRoot: string;
	logger: RunLogger;
	safeUpdateState: (fn: (s: OrchestratorState) => void) => Promise<void>;
	iLog: IssueLogger;
}

export interface ProcessOneIssueConfig {
	config: OrchestratorConfig;
	flags: OrchestratorFlags;
	deps?: ParallelDeps;
}

/** Execution context for the parallel loop. */
export interface RunParallelLoopContext {
	executionOrder: number[];
	graph: Map<number, DependencyNode>;
	state: OrchestratorState;
	startIdx: number;
	stateFile: string;
	repoRoot: string;
	logger: RunLogger;
}

/** Config and flags for the parallel loop. */
export interface RunParallelLoopConfig {
	config: OrchestratorConfig;
	flags: OrchestratorFlags;
	deps?: ParallelDeps;
}

export type RunParallelLoopOptions = RunParallelLoopContext & RunParallelLoopConfig;

// ---------------------------------------------------------------------------
// Single-issue pipeline (used by the parallel scheduler)
// ---------------------------------------------------------------------------

/**
 * Process a single issue in parallel mode.
 * Never throws — all errors are caught and recorded in state via safeUpdateState.
 */
export async function processOneIssue(
	ctx: ProcessOneIssueContext,
	cfg: ProcessOneIssueConfig
): Promise<void> {
	const { issueNum, node, state, repoRoot, logger, safeUpdateState, iLog } = ctx;
	const { config, flags } = cfg;
	const d = cfg.deps ?? defaultParallelDeps;

	const issueStartTime = Date.now();
	iLog.step(`ISSUE #${issueNum}: ${node.issue.title}`);

	// Create worktree
	iLog.info('Creating worktree...');
	const depBranches = node.dependsOn
		.map((dep) => {
			const depState = state.issues[dep];
			if (depState?.branch) return depState.branch;
			return null;
		})
		.filter((b): b is string => b !== null);

	const wtResult = await d.createWorktree(node.branch, depBranches, config, repoRoot, logger, issueNum);
	if (!wtResult.ok) {
		const errMsg = wtResult.error ?? 'Worktree creation failed';
		iLog.error(errMsg);
		await safeUpdateState((s) => {
			const is = d.getIssueState(s, issueNum, node.issue.title);
			is.status = 'failed';
			is.error = errMsg;
		});
		logger.issueFailed(issueNum, errMsg);
		return;
	}

	const { worktreePath, baseBranch } = wtResult;
	await safeUpdateState((s) => {
		const is = d.getIssueState(s, issueNum, node.issue.title);
		is.branch = node.branch;
		is.baseBranch = baseBranch;
		is.status = 'in_progress';
	});
	logger.issueStart(issueNum, node.issue.title, node.branch, baseBranch);
	iLog.ok(`Worktree at ${worktreePath} on branch ${node.branch} (base: ${baseBranch})`);

	// Implement (with retries)
	let lastImplError: string | undefined;
	const implRetryResult = await d.withRetries(
		async () => {
			const r = await d.implementIssue({ issue: node.issue, branchName: node.branch, baseBranch, config, worktreePath, logger });
			if (!r.ok) lastImplError = r.error;
			return r;
		},
		async (attempt) => {
			iLog.warn(`Implementation retry ${attempt + 1}/${config.retries.implement}`);
		},
		config.retries.implement + 1
	);

	if (!implRetryResult.ok) {
		iLog.error(`Implementation attempt failed: ${lastImplError}`);
		const errMsg = `Implementation failed after ${config.retries.implement + 1} attempts: ${lastImplError}`;
		await safeUpdateState((s) => {
			const is = d.getIssueState(s, issueNum, node.issue.title);
			is.status = 'failed';
			is.error = errMsg;
		});
		logger.issueFailed(issueNum, errMsg);
		await d.removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);
		return;
	}

	// Verify (with retries and fix attempts)
	iLog.info('Running verification pipeline...');
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
				iLog.error(`Verification failed at ${failedStep}`);
				iLog.warn(`Verification retry ${attempt + 1}/${config.retries.verify} — feeding errors back to agent`);
				await d.fixVerificationFailure({
					issueNumber: issueNum,
					failedStep,
					errorOutput: lastVerifyResult?.error ?? '',
					config,
					worktreePath,
					logger,
					spinnerLabel: `[#${issueNum}] Agent fixing verification`
				});
			}
		},
		config.retries.verify + 1
	);

	if (!verifyRetryResult.ok) {
		const failedStep = lastVerifyResult?.failedStep ?? 'unknown';
		const errMsg = `Verification failed at ${failedStep} after ${config.retries.verify + 1} attempts: ${lastVerifyResult?.error}`;
		await safeUpdateState((s) => {
			const is = d.getIssueState(s, issueNum, node.issue.title);
			is.status = 'failed';
			is.error = errMsg;
		});
		logger.issueFailed(issueNum, errMsg);
		await d.removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);
		return;
	}

	iLog.ok('All verification gates passed');

	// Create PR
	iLog.info('Creating pull request...');
	const prBody = d.buildPRBody(node.issue, config, flags);
	const prResult = await d.createPR(node.issue.title, prBody, baseBranch, node.branch, worktreePath);
	if (!prResult.ok) {
		const errMsg = prResult.error ?? 'PR creation failed';
		iLog.error(errMsg);
		await safeUpdateState((s) => {
			const is = d.getIssueState(s, issueNum, node.issue.title);
			is.status = 'failed';
			is.error = errMsg;
		});
		logger.issueFailed(issueNum, errMsg);
		await d.removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);
		return;
	}
	if (prResult.prNumber) logger.prCreated(issueNum, prResult.prNumber);

	// Clean up worktree
	await d.removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);

	// Mark complete
	const durationMs = Date.now() - issueStartTime;
	await safeUpdateState((s) => {
		const is = d.getIssueState(s, issueNum, node.issue.title);
		is.status = 'completed';
		is.error = null;
		is.prNumber = prResult.prNumber ?? null;
		is.completedAt = new Date().toISOString();
	});
	logger.issueComplete(issueNum, prResult.prNumber, durationMs);
	iLog.ok(`Issue #${issueNum} completed → PR #${prResult.prNumber}`);
}

// ---------------------------------------------------------------------------
// Parallel scheduler
// ---------------------------------------------------------------------------

/**
 * Parallel main loop — runs up to N issues concurrently.
 * Uses dependency-aware scheduling: issues become ready when all their deps complete.
 * Failures do not halt other issues; dependents of failed issues are marked `blocked`.
 */
export async function runParallelLoop(opts: RunParallelLoopOptions): Promise<void> {
	const { executionOrder, graph, state, startIdx, stateFile, repoRoot, logger, config, flags } = opts;
	const d = opts.deps ?? defaultParallelDeps;

	const parallelN = flags.parallel;
	const mutex = new Mutex();

	// Issues before startIdx are treated as virtually completed for dep resolution
	const preCompleted = new Set(executionOrder.slice(0, startIdx));

	async function safeUpdateState(fn: (s: OrchestratorState) => void): Promise<void> {
		return mutex.run(async () => {
			fn(state);
			d.saveState(state, stateFile);
		});
	}

	function isDepMet(dep: number): boolean {
		if (!graph.has(dep)) return true; // external dep, not tracked
		if (preCompleted.has(dep)) return true;
		return state.issues[dep]?.status === 'completed';
	}

	function isDepFailed(dep: number): boolean {
		if (!graph.has(dep)) return false;
		if (preCompleted.has(dep)) return false;
		const ds = state.issues[dep];
		return ds?.status === 'failed' || ds?.status === 'blocked';
	}

	const workIssues = executionOrder.slice(startIdx);
	const activeSlots = new Map<number, Promise<void>>();

	d.log.info(`Starting parallel execution (${parallelN} concurrent slots)`);

	while (true) {
		// Mark newly-blocked issues (whose deps have failed/blocked)
		for (const issueNum of workIssues) {
			const node = graph.get(issueNum);
			if (!node) continue;
			const is = state.issues[issueNum];
			if (is && ['completed', 'failed', 'split', 'blocked', 'in_progress'].includes(is.status)) continue;
			if (activeSlots.has(issueNum)) continue;

			const failedDep = node.dependsOn.find(isDepFailed);
			if (failedDep !== undefined) {
				await safeUpdateState((s) => {
					const entry = d.getIssueState(s, issueNum, node.issue.title);
					entry.status = 'blocked';
					entry.error = `Dependency #${failedDep} failed or was blocked`;
				});
				logger.issueFailed(issueNum, `Blocked — dependency #${failedDep} failed`);
			}
		}

		// Fill slots with ready issues (all deps met, no failed deps, not active/done)
		for (const issueNum of workIssues) {
			if (activeSlots.size >= parallelN) break;
			if (activeSlots.has(issueNum)) continue;

			const node = graph.get(issueNum);
			if (!node) continue;

			const is = state.issues[issueNum];
			if (is && ['completed', 'failed', 'split', 'blocked', 'in_progress'].includes(is.status)) continue;

			// All in-graph deps must be met
			const unmet = node.dependsOn.filter((dep) => graph.has(dep) && !isDepMet(dep));
			if (unmet.length > 0) continue;

			// No dep may be failed/blocked
			if (node.dependsOn.some(isDepFailed)) continue;

			const iLog = makeIssueLog(issueNum, d);
			const slot = processOneIssue(
				{ issueNum, node, state, repoRoot, logger, safeUpdateState, iLog },
				{ config, flags, deps: d }
			).then(
				() => { activeSlots.delete(issueNum); },
				async (err) => {
					activeSlots.delete(issueNum);
					await safeUpdateState((s) => {
						const entry = d.getIssueState(s, issueNum, node.issue.title);
						entry.status = 'failed';
						entry.error = err?.message ?? 'Unexpected error during processing';
					});
				}
			);
			activeSlots.set(issueNum, slot);
		}

		// If no slots running, we're done
		if (activeSlots.size === 0) break;

		// Wait for any slot to finish before re-evaluating
		await Promise.race([...activeSlots.values()]);
	}

	d.log.step('ALL PARALLEL WORK COMPLETE');
	d.printStatus(state);
}
