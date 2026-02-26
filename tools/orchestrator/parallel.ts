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

class Mutex {
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

type IssueLogger = {
	info(msg: string): void;
	ok(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
	step(msg: string): void;
	dim(msg: string): void;
};

function makeIssueLog(issueNum: number): IssueLogger {
	const prefix = `\x1b[2m[#${issueNum}]\x1b[0m `;
	return {
		info: (msg: string) => log.info(`${prefix}${msg}`),
		ok: (msg: string) => log.ok(`${prefix}${msg}`),
		warn: (msg: string) => log.warn(`${prefix}${msg}`),
		error: (msg: string) => log.error(`${prefix}${msg}`),
		step: (msg: string) => log.step(`${prefix}${msg}`),
		dim: (msg: string) => log.dim(`${prefix}${msg}`)
	};
}

// ---------------------------------------------------------------------------
// Single-issue pipeline (used by both sequential and parallel schedulers)
// ---------------------------------------------------------------------------

/**
 * Process a single issue in parallel mode.
 * Never throws — all errors are caught and recorded in state via safeUpdateState.
 */
async function processOneIssue(
	issueNum: number,
	node: DependencyNode,
	state: OrchestratorState,
	config: OrchestratorConfig,
	flags: OrchestratorFlags,
	repoRoot: string,
	logger: RunLogger,
	safeUpdateState: (fn: (s: OrchestratorState) => void) => Promise<void>,
	iLog: IssueLogger
): Promise<void> {
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

	const wtResult = await createWorktree(node.branch, depBranches, config, repoRoot, logger, issueNum);
	if (!wtResult.ok) {
		const errMsg = wtResult.error ?? 'Worktree creation failed';
		iLog.error(errMsg);
		await safeUpdateState((s) => {
			const is = getIssueState(s, issueNum, node.issue.title);
			is.status = 'failed';
			is.error = errMsg;
		});
		logger.issueFailed(issueNum, errMsg);
		return;
	}

	const { worktreePath, baseBranch } = wtResult;
	await safeUpdateState((s) => {
		const is = getIssueState(s, issueNum, node.issue.title);
		is.branch = node.branch;
		is.baseBranch = baseBranch;
		is.status = 'in_progress';
	});
	logger.issueStart(issueNum, node.issue.title, node.branch, baseBranch);
	iLog.ok(`Worktree at ${worktreePath} on branch ${node.branch} (base: ${baseBranch})`);

	// Implement (with retries)
	let lastImplError: string | undefined;
	const implRetryResult = await withRetries(
		async () => {
			const r = await implementIssue(node.issue, node.branch, baseBranch, config, worktreePath, logger);
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
			const is = getIssueState(s, issueNum, node.issue.title);
			is.status = 'failed';
			is.error = errMsg;
		});
		logger.issueFailed(issueNum, errMsg);
		await removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);
		return;
	}

	// Verify (with retries and fix attempts)
	iLog.info('Running verification pipeline...');
	let lastVerifyResult: Awaited<ReturnType<typeof runVerify>> | undefined;
	const verifyRetryResult = await withRetries(
		async () => {
			const r = await runVerify({
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
				await fixVerificationFailure({
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
			const is = getIssueState(s, issueNum, node.issue.title);
			is.status = 'failed';
			is.error = errMsg;
		});
		logger.issueFailed(issueNum, errMsg);
		await removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);
		return;
	}

	iLog.ok('All verification gates passed');

	// Create PR
	iLog.info('Creating pull request...');
	const prBody = buildPRBody(node.issue, config, flags);
	const prResult = await createPR(node.issue.title, prBody, baseBranch, node.branch, worktreePath);
	if (!prResult.ok) {
		const errMsg = prResult.error ?? 'PR creation failed';
		iLog.error(errMsg);
		await safeUpdateState((s) => {
			const is = getIssueState(s, issueNum, node.issue.title);
			is.status = 'failed';
			is.error = errMsg;
		});
		logger.issueFailed(issueNum, errMsg);
		await removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);
		return;
	}
	if (prResult.prNumber) logger.prCreated(issueNum, prResult.prNumber);

	// Clean up worktree
	await removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);

	// Mark complete
	const durationMs = Date.now() - issueStartTime;
	await safeUpdateState((s) => {
		const is = getIssueState(s, issueNum, node.issue.title);
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
export async function runParallelLoop(
	executionOrder: number[],
	graph: Map<number, DependencyNode>,
	state: OrchestratorState,
	config: OrchestratorConfig,
	flags: OrchestratorFlags,
	startIdx: number,
	stateFile: string,
	repoRoot: string,
	logger: RunLogger
): Promise<void> {
	const parallelN = flags.parallel;
	const mutex = new Mutex();

	// Issues before startIdx are treated as virtually completed for dep resolution
	const preCompleted = new Set(executionOrder.slice(0, startIdx));

	async function safeUpdateState(fn: (s: OrchestratorState) => void): Promise<void> {
		return mutex.run(async () => {
			fn(state);
			saveState(state, stateFile);
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

	log.info(`Starting parallel execution (${parallelN} concurrent slots)`);

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
					const entry = getIssueState(s, issueNum, node.issue.title);
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

			const iLog = makeIssueLog(issueNum);
			const slot = processOneIssue(
				issueNum,
				node,
				state,
				config,
				flags,
				repoRoot,
				logger,
				safeUpdateState,
				iLog
			).then(
				() => { activeSlots.delete(issueNum); },
				() => { activeSlots.delete(issueNum); }
			);
			activeSlots.set(issueNum, slot);
		}

		// If no slots running, we're done
		if (activeSlots.size === 0) break;

		// Wait for any slot to finish before re-evaluating
		await Promise.race([...activeSlots.values()]);
	}

	log.step('ALL PARALLEL WORK COMPLETE');
	printStatus(state);
}
