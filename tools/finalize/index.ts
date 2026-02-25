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
import { discoverMergeablePRs, determineMergeOrder } from './pr-discovery.ts';
import { mergePR } from '../../shared/github.ts';
import { runVerify } from '../verify/index.ts';
import type { VerifyCommand, E2EConfig } from '../verify/types.ts';
import {
	rebaseBranch, detectConflicts, presentConflicts, resolveConflicts, autoResolveConflicts
} from '../../shared/git.ts';
export { rebaseBranch, detectConflicts, presentConflicts, resolveConflicts, autoResolveConflicts } from '../../shared/git.ts';
import type {
	FinalizeFlags,
	FinalizeState,
	PRMergeState,
	MergeStrategy
} from './types.ts';

// Re-export types and shared GitHub operations
export type { FinalizeFlags, FinalizeState, PRMergeState, MergeOrder } from './types.ts';
export { discoverMergeablePRs, determineMergeOrder } from './pr-discovery.ts';

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

export function parseFinalizeFlags(args: string[]): FinalizeFlags {
	const fromIdx = args.indexOf('--from');
	const from = fromIdx !== -1 && args[fromIdx + 1]
		? Number(args[fromIdx + 1])
		: null;

	const stratIdx = args.indexOf('--strategy');
	const rawStrategy = stratIdx !== -1 && args[stratIdx + 1] ? args[stratIdx + 1] : 'squash';
	const strategy = (['squash', 'merge', 'rebase'].includes(rawStrategy)
		? rawStrategy
		: 'squash') as MergeStrategy;

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

async function runPostMergeVerify(
	repoRoot: string,
	noVerify: boolean
): Promise<boolean> {
	if (noVerify) return true;

	interface ConfigPartial {
		verify: VerifyCommand[];
		e2e?: E2EConfig;
	}

	const config = loadToolConfig<ConfigPartial>(repoRoot, 'orchestrator', {
		verify: []
	});

	if (config.verify.length === 0 && !config.e2e) return true;

	const result = await runVerify({
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
  --strategy <type>   Merge strategy: squash (default) | merge | rebase
  --from <N>          Start from issue #N
  --auto-resolve      Resolve conflicts via Claude (non-interactive)
  --help, -h          Show this help message

Discovers completed orchestrated PRs and merges them in dependency order.
Handles conflicts interactively with optional Claude-assisted resolution.
`;

export async function finalize(flags: FinalizeFlags): Promise<void> {
	if (flags.help) {
		console.log(FINALIZE_HELP);
		return;
	}

	console.log('\n\x1b[36m╔══════════════════════════════════════════════╗\x1b[0m');
	console.log('\x1b[36m║         PAI PR Finalizer                     ║\x1b[0m');
	console.log('\x1b[36m╚══════════════════════════════════════════════╝\x1b[0m\n');

	const repoRoot = findRepoRoot();
	const stateFile = getStateFilePath(repoRoot, 'finalize');

	// Discover PRs
	log.step('DISCOVERING PRs');
	const prs = await discoverMergeablePRs(repoRoot);
	if (prs.length === 0) {
		log.info('No mergeable PRs found.');
		return;
	}

	// Determine order
	const ordered = determineMergeOrder(prs);
	log.ok(`Found ${ordered.length} PR(s) to merge`);

	// Filter by --from
	let startIdx = 0;
	if (flags.from !== null) {
		startIdx = ordered.findIndex((pr) => pr.issueNumber === flags.from);
		if (startIdx === -1) {
			log.error(`Issue #${flags.from} not found in merge queue`);
			process.exit(1);
		}
	}

	// Show plan
	log.step('MERGE PLAN');
	for (let i = startIdx; i < ordered.length; i++) {
		const pr = ordered[i];
		const marker = i === startIdx ? '→' : ' ';
		console.log(`  ${marker} #${pr.issueNumber} PR #${pr.prNumber} (${pr.branch} → ${pr.baseBranch}) [${flags.strategy}]`);
	}

	if (flags.dryRun) {
		log.info('\nDry run complete. No changes made.');
		return;
	}

	// Load or init state
	const state = loadFinalizeState(stateFile) ?? initFinalizeState();

	// Ensure we're on the base branch
	const baseBranch = ordered[startIdx]?.baseBranch ?? 'master';
	await $`git -C ${repoRoot} checkout ${baseBranch}`.quiet();
	await $`git -C ${repoRoot} pull --ff-only`.quiet().catch(() => {});

	// Merge loop
	for (let i = startIdx; i < ordered.length; i++) {
		const pr = ordered[i];
		log.step(`MERGING #${pr.issueNumber} — PR #${pr.prNumber}`);

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

		// Rebase onto target (handles stale branches, stacked PRs, and conflicts)
		log.info(`Rebasing ${pr.branch} onto ${baseBranch}...`);
		const rebaseResult = await rebaseBranch(pr.branch, baseBranch, repoRoot);

		if (!rebaseResult.ok) {
			if (rebaseResult.conflicts && rebaseResult.conflicts.length > 0) {
				log.warn('Conflicts detected during rebase');
				let resolved: boolean;
				if (flags.autoResolve) {
					log.info('Auto-resolving conflicts via Claude...');
					resolved = await autoResolveConflicts(rebaseResult.conflicts, repoRoot);
				} else {
					const intents = await presentConflicts(rebaseResult.conflicts);
					resolved = await resolveConflicts(rebaseResult.conflicts, intents, repoRoot);
				}
				if (!resolved) {
					prState.status = 'conflict';
					prState.error = 'Conflict resolution failed';
					saveFinalizeState(state, stateFile);
					log.error(`Failed to resolve conflicts for PR #${pr.prNumber}`);
					continue;
				}
			} else {
				prState.status = 'failed';
				prState.error = 'Rebase failed (not a conflict)';
				saveFinalizeState(state, stateFile);
				log.error(`Rebase failed for PR #${pr.prNumber}`);
				continue;
			}
		}

		// Push rebased branch (always — remote must match local after rebase)
		await $`git -C ${repoRoot} push --force-with-lease origin ${pr.branch}`.quiet().catch((e) => {
			log.warn(`Force push failed for ${pr.branch}: ${String(e).slice(0, 200)}`);
		});

		// Retarget dependent PRs before merge (prevents orphaning when branch is deleted)
		for (const other of ordered) {
			if (other.baseBranch === pr.branch) {
				log.info(`Retargeting PR #${other.prNumber} base: ${pr.branch} → ${baseBranch}`);
				await $`gh pr edit ${other.prNumber} --base ${baseBranch}`.quiet().catch(() => {});
				other.baseBranch = baseBranch;
			}
		}

		// Merge
		const mergeResult = await mergePR(pr.prNumber, flags.strategy, false);
		if (!mergeResult.ok) {
			prState.status = 'failed';
			prState.error = mergeResult.error ?? 'Merge failed';
			saveFinalizeState(state, stateFile);
			log.error(`Failed to merge PR #${pr.prNumber}: ${mergeResult.error}`);
			continue;
		}

		// Pull merged changes
		await $`git -C ${repoRoot} checkout ${baseBranch}`.quiet();
		await $`git -C ${repoRoot} pull --ff-only`.quiet().catch(() => {});

		// Post-merge verification
		if (!flags.noVerify) {
			log.info('Running post-merge verification...');
			const verifyOk = await runPostMergeVerify(repoRoot, false);
			if (!verifyOk) {
				log.warn(`Post-merge verification failed for PR #${pr.prNumber}`);
				log.warn('Continuing — the merge is already complete. Fix issues manually.');
			}
		}

		// Close the associated issue (belt-and-suspenders — PR body also has "Closes #N")
		await $`gh issue close ${pr.issueNumber}`.quiet().catch(() => {});

		prState.status = 'merged';
		prState.mergedAt = new Date().toISOString();
		prState.error = null;
		saveFinalizeState(state, stateFile);
		log.ok(`PR #${pr.prNumber} merged (issue #${pr.issueNumber})`);

		if (flags.single) {
			log.info('Single mode — stopping after one merge.');
			break;
		}
	}

	// Summary
	log.step('SUMMARY');
	const merged = Object.values(state.prs).filter((p) => p.status === 'merged').length;
	const failed = Object.values(state.prs).filter((p) => p.status === 'failed' || p.status === 'conflict').length;
	console.log(`  Merged: ${merged}`);
	if (failed > 0) console.log(`  Failed: ${failed}`);
	log.ok('Finalize complete');
}
