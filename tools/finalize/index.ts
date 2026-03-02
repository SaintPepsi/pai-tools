/**
 * Finalize tool — discovers orchestrated PRs and merges them.
 *
 * Handles conflict resolution via user input + Claude, re-verifies
 * after each merge, and tracks state for resumability.
 */

import { $ } from 'bun';
import { log } from '../../shared/log.ts';
import { findRepoRoot, loadToolConfig, getStateFilePath } from '../../shared/config.ts';
import { loadState, saveState } from '../../shared/state.ts';
import { discoverMergeablePRs, determineMergeOrder, mergePR } from '../../shared/github.ts';
import { runVerify } from '../verify/runner.ts';
import type { VerifyCommand, E2EConfig, VerifyResult } from '../verify/types.ts';
import {
	rebaseBranch, detectConflicts, presentConflicts, resolveConflicts, autoResolveConflicts
} from '../../shared/git.ts';
export { rebaseBranch, detectConflicts, presentConflicts, resolveConflicts, autoResolveConflicts } from '../../shared/git.ts';
import type { ConflictInfo } from '../../shared/git.ts';
import type {
	FinalizeFlags,
	FinalizeState,
	PRMergeState,
	MergeStrategy
} from './types.ts';
import type { MergeOrder } from '../../shared/github.ts';

// Re-export types and shared GitHub operations
export type { FinalizeFlags, FinalizeState, PRMergeState } from './types.ts';
export type { MergeOrder } from '../../shared/github.ts';
export { discoverMergeablePRs, determineMergeOrder } from '../../shared/github.ts';

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface FinalizeDeps {
	/** Discover open orchestrated PRs from state. */
	discoverMergeablePRs: (repoRoot: string) => Promise<MergeOrder[]>;
	/** Sort PRs into merge order. */
	determineMergeOrder: (prs: MergeOrder[]) => MergeOrder[];
	/** Rebase a branch onto another. */
	rebaseBranch: (branch: string, onto: string, repoRoot: string) => Promise<{ ok: boolean; conflicts?: ConflictInfo[] }>;
	/** Auto-resolve conflicts via Claude. */
	autoResolveConflicts: (conflicts: ConflictInfo[], repoRoot: string) => Promise<boolean>;
	/** Present conflicts interactively and collect resolution intents. */
	presentConflicts: (conflicts: ConflictInfo[]) => Promise<Map<string, string>>;
	/** Resolve conflicts using the collected intents. */
	resolveConflicts: (conflicts: ConflictInfo[], intents: Map<string, string>, repoRoot: string) => Promise<boolean>;
	/** Merge a GitHub PR. */
	mergePR: (prNumber: number, strategy: MergeStrategy, dryRun: boolean) => Promise<{ ok: boolean; error?: string }>;
	/** Run post-merge verification. */
	runPostMergeVerify: (repoRoot: string, noVerify: boolean) => Promise<boolean>;
	/** Find the repo root on disk. */
	findRepoRoot: () => string;
	/** Get the state file path for the given tool. */
	getStateFilePath: (repoRoot: string, toolName: string) => string;
	/** Load finalize state from disk. */
	loadFinalizeState: (stateFile: string) => FinalizeState | null;
	/** Save finalize state to disk. */
	saveFinalizeState: (state: FinalizeState, stateFile: string) => void;
	/** Run a git+shell command quietly, catching errors with the provided handler. */
	gitQuiet: (cmd: string[], repoRoot: string) => Promise<void>;
	/** Run a git+shell command quietly, swallowing failures silently (for non-critical ops). */
	gitQuietSwallow: (cmd: string[], repoRoot: string) => Promise<void>;
	/** Run a gh shell command quietly, swallowing failures (e.g. issue close, pr edit). */
	ghQuietSwallow: (cmd: string[]) => Promise<void>;
	/** Call process.exit (injectable for tests). */
	exit: (code: number) => never;
	/** Log functions (injectable for tests). */
	log: {
		info: (msg: string) => void;
		ok: (msg: string) => void;
		warn: (msg: string) => void;
		error: (msg: string) => void;
		step: (msg: string) => void;
	};
	/** Console output (injectable for tests). */
	print: (msg: string) => void;
}

async function defaultGitQuiet(cmd: string[], repoRoot: string): Promise<void> {
	const [git, ...args] = cmd;
	await $`${git} -C ${repoRoot} ${args}`.quiet().catch((e) => {
		log.warn(`git ${args.join(' ')} failed: ${String(e).slice(0, 200)}`);
	});
}

async function defaultGitQuietSwallow(cmd: string[], repoRoot: string): Promise<void> {
	const [git, ...args] = cmd;
	await $`${git} -C ${repoRoot} ${args}`.quiet().catch(() => {});
}

async function defaultGhQuietSwallow(cmd: string[]): Promise<void> {
	const [gh, ...args] = cmd;
	await $`${gh} ${args}`.quiet().catch(() => {});
}

export const defaultFinalizeDeps: FinalizeDeps = {
	discoverMergeablePRs,
	determineMergeOrder,
	rebaseBranch,
	autoResolveConflicts,
	presentConflicts,
	resolveConflicts,
	mergePR,
	runPostMergeVerify,
	findRepoRoot,
	getStateFilePath,
	loadFinalizeState,
	saveFinalizeState,
	gitQuiet: defaultGitQuiet,
	gitQuietSwallow: defaultGitQuietSwallow,
	ghQuietSwallow: defaultGhQuietSwallow,
	exit: (code) => process.exit(code),
	log,
	print: (msg) => console.log(msg),
};

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

export function parseFinalizeFlags(args: string[]): FinalizeFlags {
	const fromIdx = args.indexOf('--from');
	const from = fromIdx !== -1 && args[fromIdx + 1]
		? Number(args[fromIdx + 1])
		: null;

	const stratIdx = args.indexOf('--strategy');
	const rawStrategy = stratIdx !== -1 && args[stratIdx + 1] ? args[stratIdx + 1] : 'merge';
	const strategy = (['squash', 'merge', 'rebase'].includes(rawStrategy)
		? rawStrategy
		: 'merge') as MergeStrategy;

	return {
		dryRun: args.includes('--dry-run'),
		single: args.includes('--single'),
		noVerify: args.includes('--no-verify'),
		strategy,
		from,
		autoResolve: args.includes('--auto-resolve'),
		help: args.includes('--help') || args.includes('-h')
	};
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

export function loadFinalizeState(stateFile: string): FinalizeState | null {
	return loadState<FinalizeState>(stateFile);
}

export function saveFinalizeState(state: FinalizeState, stateFile: string): void {
	saveState(state, stateFile);
}

export function initFinalizeState(): FinalizeState {
	return {
		version: 1,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		prs: {}
	};
}

// ---------------------------------------------------------------------------
// Post-merge verification
// ---------------------------------------------------------------------------

export interface PostMergeVerifyDeps {
	loadToolConfig: <T>(repoRoot: string, toolName: string, defaults: T) => T;
	runVerify: (opts: { verify: VerifyCommand[]; e2e?: E2EConfig; cwd: string }) => Promise<{ ok: boolean }>;
}

const defaultPostMergeVerifyDeps: PostMergeVerifyDeps = {
	loadToolConfig,
	runVerify,
};

export async function runPostMergeVerify(
	repoRoot: string,
	noVerify: boolean,
	deps: PostMergeVerifyDeps = defaultPostMergeVerifyDeps
): Promise<boolean> {
	if (noVerify) return true;

	interface ConfigPartial {
		verify: VerifyCommand[];
		e2e?: E2EConfig;
	}

	const config = deps.loadToolConfig<ConfigPartial>(repoRoot, 'orchestrator', {
		verify: []
	});

	if (config.verify.length === 0 && !config.e2e) return true;

	const result = await deps.runVerify({
		verify: config.verify,
		e2e: config.e2e,
		cwd: repoRoot
	});

	return result.ok;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const FINALIZE_HELP = `\x1b[36mpait finalize\x1b[0m — Merge orchestrated PRs

\x1b[1mUSAGE\x1b[0m
  pait finalize [flags]

\x1b[1mFLAGS\x1b[0m
  --dry-run           Show merge plan without acting
  --single            Merge only the next PR, then stop
  --no-verify         Skip post-merge verification
  --strategy <type>   Merge strategy: merge (default) | squash | rebase
  --from <N>          Start from issue #N
  --auto-resolve      Resolve conflicts via Claude (non-interactive)
  --help, -h          Show this help message

Discovers completed orchestrated PRs and merges them in dependency order.
Handles conflicts interactively with optional Claude-assisted resolution.
`;

export async function finalize(flags: FinalizeFlags, deps: FinalizeDeps = defaultFinalizeDeps): Promise<void> {
	if (flags.help) {
		deps.print(FINALIZE_HELP);
		return;
	}

	deps.print('\n\x1b[36m╔══════════════════════════════════════════════╗\x1b[0m');
	deps.print('\x1b[36m║         PAI PR Finalizer                     ║\x1b[0m');
	deps.print('\x1b[36m╚══════════════════════════════════════════════╝\x1b[0m\n');

	const repoRoot = deps.findRepoRoot();
	const stateFile = deps.getStateFilePath(repoRoot, 'finalize');

	// Discover PRs
	deps.log.step('DISCOVERING PRs');
	const prs = await deps.discoverMergeablePRs(repoRoot);
	if (prs.length === 0) {
		deps.log.info('No mergeable PRs found.');
		return;
	}

	// Determine order
	const ordered = deps.determineMergeOrder(prs);
	deps.log.ok(`Found ${ordered.length} PR(s) to merge`);

	// Filter by --from
	let startIdx = 0;
	if (flags.from !== null) {
		startIdx = ordered.findIndex((pr) => pr.issueNumber === flags.from);
		if (startIdx === -1) {
			deps.log.error(`Issue #${flags.from} not found in merge queue`);
			deps.exit(1);
		}
	}

	// Show plan
	deps.log.step('MERGE PLAN');
	for (let i = startIdx; i < ordered.length; i++) {
		const pr = ordered[i];
		const marker = i === startIdx ? '→' : ' ';
		deps.print(`  ${marker} #${pr.issueNumber} PR #${pr.prNumber} (${pr.branch} → ${pr.baseBranch}) [${flags.strategy}]`);
	}

	if (flags.dryRun) {
		deps.log.info('\nDry run complete. No changes made.');
		return;
	}

	// Load or init state
	const state = deps.loadFinalizeState(stateFile) ?? initFinalizeState();

	// Ensure we're on the base branch with latest remote
	const baseBranch = ordered[startIdx]?.baseBranch ?? 'master';
	await deps.gitQuiet(['git', 'checkout', baseBranch], repoRoot);
	await deps.gitQuiet(['git', 'pull', '--ff-only'], repoRoot);

	// Merge loop
	for (let i = startIdx; i < ordered.length; i++) {
		const pr = ordered[i];
		deps.log.step(`MERGING #${pr.issueNumber} — PR #${pr.prNumber}`);

		// Initialize state entry
		if (!state.prs[pr.prNumber]) {
			state.prs[pr.prNumber] = {
				issueNumber: pr.issueNumber,
				prNumber: pr.prNumber,
				branch: pr.branch,
				baseBranch: pr.baseBranch,
				status: 'pending',
				mergedAt: null,
				error: null
			};
		}

		const prState = state.prs[pr.prNumber];

		// Pull latest base branch before rebase (CI may push version bumps between merges)
		await deps.gitQuiet(['git', 'checkout', baseBranch], repoRoot);
		await deps.gitQuiet(['git', 'pull', '--ff-only'], repoRoot);

		// Rebase onto target (handles stale branches, stacked PRs, and conflicts)
		deps.log.info(`Rebasing ${pr.branch} onto ${baseBranch}...`);
		const rebaseResult = await deps.rebaseBranch(pr.branch, baseBranch, repoRoot);

		if (!rebaseResult.ok) {
			if (rebaseResult.conflicts && rebaseResult.conflicts.length > 0) {
				deps.log.warn('Conflicts detected during rebase');
				let resolved: boolean;
				if (flags.autoResolve) {
					deps.log.info('Auto-resolving conflicts via Claude...');
					resolved = await deps.autoResolveConflicts(rebaseResult.conflicts, repoRoot);
				} else {
					const intents = await deps.presentConflicts(rebaseResult.conflicts);
					resolved = await deps.resolveConflicts(rebaseResult.conflicts, intents, repoRoot);
				}
				if (!resolved) {
					prState.status = 'conflict';
					prState.error = 'Conflict resolution failed';
					deps.saveFinalizeState(state, stateFile);
					deps.log.error(`Failed to resolve conflicts for PR #${pr.prNumber}`);
					continue;
				}
			} else {
				prState.status = 'failed';
				prState.error = 'Rebase failed (not a conflict)';
				deps.saveFinalizeState(state, stateFile);
				deps.log.error(`Rebase failed for PR #${pr.prNumber}`);
				continue;
			}
		}

		// Push rebased branch (always — remote must match local after rebase)
		await deps.gitQuiet(['git', 'push', '--force-with-lease', 'origin', pr.branch], repoRoot);

		// Retarget dependent PRs before merge (prevents orphaning when branch is deleted)
		for (const other of ordered) {
			if (other.baseBranch === pr.branch) {
				deps.log.info(`Retargeting PR #${other.prNumber} base: ${pr.branch} → ${baseBranch}`);
				await deps.ghQuietSwallow(['gh', 'pr', 'edit', String(other.prNumber), '--base', baseBranch]);
				other.baseBranch = baseBranch;
			}
		}

		// Merge
		const mergeResult = await deps.mergePR(pr.prNumber, flags.strategy, false);
		if (!mergeResult.ok) {
			prState.status = 'failed';
			prState.error = mergeResult.error ?? 'Merge failed';
			deps.saveFinalizeState(state, stateFile);
			deps.log.error(`Failed to merge PR #${pr.prNumber}: ${mergeResult.error}`);
			continue;
		}

		// Pull merged changes (includes squash commit + any CI version bumps)
		await deps.gitQuiet(['git', 'checkout', baseBranch], repoRoot);
		await deps.gitQuiet(['git', 'pull', '--ff-only'], repoRoot);

		// Post-merge verification
		if (!flags.noVerify) {
			deps.log.info('Running post-merge verification...');
			const verifyOk = await deps.runPostMergeVerify(repoRoot, false);
			if (!verifyOk) {
				deps.log.warn(`Post-merge verification failed for PR #${pr.prNumber}`);
				deps.log.warn('Continuing — the merge is already complete. Fix issues manually.');
			}
		}

		// Close the associated issue (belt-and-suspenders — PR body also has "Closes #N")
		await deps.ghQuietSwallow(['gh', 'issue', 'close', String(pr.issueNumber)]);

		prState.status = 'merged';
		prState.mergedAt = new Date().toISOString();
		prState.error = null;
		deps.saveFinalizeState(state, stateFile);
		deps.log.ok(`PR #${pr.prNumber} merged (issue #${pr.issueNumber})`);

		if (flags.single) {
			deps.log.info('Single mode — stopping after one merge.');
			break;
		}
	}

	// Summary
	deps.log.step('SUMMARY');
	const merged = Object.values(state.prs).filter((p) => p.status === 'merged').length;
	const failed = Object.values(state.prs).filter((p) => p.status === 'failed' || p.status === 'conflict').length;
	deps.print(`  Merged: ${merged}`);
	if (failed > 0) deps.print(`  Failed: ${failed}`);
	deps.log.ok('Finalize complete');
}
