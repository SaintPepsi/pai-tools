/**
 * Finalize tool — discovers orchestrated PRs and merges them.
 *
 * Handles conflict resolution via user input + Claude, re-verifies
 * after each merge, and tracks state for resumability.
 */

import { $ } from 'bun';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../../shared/log.ts';
import { promptLine } from '../../shared/prompt.ts';
import { runClaude } from '../../shared/claude.ts';
import { findRepoRoot, loadToolConfig, getStateFilePath } from '../../shared/config.ts';
import { runVerify } from '../verify/index.ts';
import type { VerifyCommand, E2EConfig } from '../verify/types.ts';
import type {
	FinalizeFlags,
	FinalizeState,
	PRMergeState,
	MergeOrder,
	MergeStrategy,
	ConflictInfo
} from './types.ts';

// Re-export types
export type { FinalizeFlags, FinalizeState, PRMergeState, MergeOrder } from './types.ts';

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
	try {
		const content = readFileSync(stateFile, 'utf-8');
		if (!content) return null;
		return JSON.parse(content);
	} catch {
		return null;
	}
}

export function saveFinalizeState(state: FinalizeState, stateFile: string): void {
	state.updatedAt = new Date().toISOString();
	writeFileSync(stateFile, JSON.stringify(state, null, 2));
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
// Orchestrator state reading
// ---------------------------------------------------------------------------

interface OrchestratorIssueState {
	number: number;
	title: string | null;
	status: string;
	branch: string | null;
	baseBranch: string | null;
	prNumber: number | null;
}

interface OrchestratorState {
	issues: Record<number, OrchestratorIssueState>;
}

// ---------------------------------------------------------------------------
// PR discovery
// ---------------------------------------------------------------------------

export async function discoverMergeablePRs(repoRoot: string): Promise<MergeOrder[]> {
	const stateFile = getStateFilePath(repoRoot, 'orchestrator');
	if (!existsSync(stateFile)) {
		log.error('No orchestrator state found. Run `pait orchestrate` first.');
		return [];
	}

	const raw = readFileSync(stateFile, 'utf-8');
	const state: OrchestratorState = JSON.parse(raw);

	const prs: MergeOrder[] = [];
	for (const issue of Object.values(state.issues)) {
		if (issue.status !== 'completed' || !issue.prNumber || !issue.branch) continue;

		// Check if PR is still open
		try {
			const prState = (
				await $`gh pr view ${issue.prNumber} --json state --jq .state`.text()
			).trim();
			if (prState !== 'OPEN') continue;
		} catch {
			continue;
		}

		prs.push({
			issueNumber: issue.number,
			prNumber: issue.prNumber,
			branch: issue.branch,
			baseBranch: issue.baseBranch ?? 'master'
		});
	}

	return prs;
}

// ---------------------------------------------------------------------------
// Merge ordering
// ---------------------------------------------------------------------------

export function determineMergeOrder(prs: MergeOrder[]): MergeOrder[] {
	// Build a map of branch -> PR for dependency resolution
	const branchMap = new Map<string, MergeOrder>();
	for (const pr of prs) {
		branchMap.set(pr.branch, pr);
	}

	// Stacked: if PR A's baseBranch is PR B's branch, B goes first
	const visited = new Set<string>();
	const result: MergeOrder[] = [];

	function visit(pr: MergeOrder): void {
		if (visited.has(pr.branch)) return;
		visited.add(pr.branch);

		// If this PR's base is another PR in our set, visit that first
		const dep = branchMap.get(pr.baseBranch);
		if (dep) {
			visit(dep);
		}

		result.push(pr);
	}

	// Sort by issue number for deterministic independent ordering
	const sorted = [...prs].sort((a, b) => a.issueNumber - b.issueNumber);
	for (const pr of sorted) {
		visit(pr);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Rebase + conflict handling
// ---------------------------------------------------------------------------

export async function rebaseBranch(
	branch: string,
	onto: string,
	repoRoot: string
): Promise<{ ok: boolean; conflicts?: ConflictInfo[] }> {
	try {
		await $`git -C ${repoRoot} checkout ${branch}`.quiet();
		await $`git -C ${repoRoot} rebase ${onto}`.quiet();
		return { ok: true };
	} catch {
		// Check for conflict
		const conflicts = await detectConflicts(repoRoot);
		if (conflicts.length > 0) {
			return { ok: false, conflicts };
		}
		// Abort failed rebase that isn't a conflict
		await $`git -C ${repoRoot} rebase --abort`.quiet().catch(() => {});
		return { ok: false };
	}
}

export async function detectConflicts(repoRoot: string): Promise<ConflictInfo[]> {
	try {
		const output = (
			await $`git -C ${repoRoot} diff --name-only --diff-filter=U`.text()
		).trim();
		if (!output) return [];
		return output.split('\n').map((file) => ({ file }));
	} catch {
		return [];
	}
}

export async function presentConflicts(
	conflicts: ConflictInfo[]
): Promise<Map<string, string>> {
	const intents = new Map<string, string>();

	log.warn(`${conflicts.length} file(s) have conflicts:`);
	for (const c of conflicts) {
		console.log(`  - ${c.file}`);
	}
	console.log('');

	for (const c of conflicts) {
		log.info(`Conflict in: ${c.file}`);
		const answer = await promptLine(
			'  Resolution (ours/theirs/describe intent): '
		);
		intents.set(c.file, answer.trim() || 'ours');
	}

	return intents;
}

export async function resolveConflicts(
	conflicts: ConflictInfo[],
	intents: Map<string, string>,
	repoRoot: string
): Promise<boolean> {
	for (const c of conflicts) {
		const intent = intents.get(c.file) ?? 'ours';

		if (intent === 'ours') {
			await $`git -C ${repoRoot} checkout --ours ${c.file}`.quiet();
			await $`git -C ${repoRoot} add ${c.file}`.quiet();
		} else if (intent === 'theirs') {
			await $`git -C ${repoRoot} checkout --theirs ${c.file}`.quiet();
			await $`git -C ${repoRoot} add ${c.file}`.quiet();
		} else {
			// Custom intent: use Claude to resolve
			const conflictContent = readFileSync(join(repoRoot, c.file), 'utf-8');
			const prompt = `You are resolving a git merge conflict in the file "${c.file}".

The user's intent for resolving this conflict is: "${intent}"

Here is the file with conflict markers:

${conflictContent}

Output ONLY the resolved file content. No explanation, no code fences, just the file content.`;

			const result = await runClaude({
				prompt,
				model: 'sonnet',
				cwd: repoRoot
			});

			if (result.ok && result.output.trim()) {
				writeFileSync(join(repoRoot, c.file), result.output);
				await $`git -C ${repoRoot} add ${c.file}`.quiet();
			} else {
				log.error(`Failed to resolve ${c.file} via Claude`);
				return false;
			}
		}
	}

	// Continue rebase (GIT_EDITOR=true prevents editor from opening in non-interactive context)
	try {
		await $`git -C ${repoRoot} rebase --continue`.env({ ...process.env, GIT_EDITOR: 'true' }).quiet();
		return true;
	} catch {
		log.error('Rebase continue failed after conflict resolution');
		await $`git -C ${repoRoot} rebase --abort`.quiet().catch(() => {});
		return false;
	}
}

export async function autoResolveConflicts(
	conflicts: ConflictInfo[],
	repoRoot: string
): Promise<boolean> {
	for (const c of conflicts) {
		const conflictContent = readFileSync(join(repoRoot, c.file), 'utf-8');
		const prompt = `You are resolving a git merge conflict in the file "${c.file}".

Resolve this conflict by keeping both changes where possible. If the changes are incompatible, prefer the incoming (feature branch) version marked with >>>>>>> but integrate any non-conflicting parts from the current branch marked with <<<<<<<.

Here is the file with conflict markers:

${conflictContent}

Output ONLY the resolved file content. No explanation, no code fences, just the file content.`;

		const result = await runClaude({
			prompt,
			model: 'sonnet',
			cwd: repoRoot
		});

		if (result.ok && result.output.trim()) {
			writeFileSync(join(repoRoot, c.file), result.output);
			await $`git -C ${repoRoot} add ${c.file}`.quiet();
			log.ok(`Auto-resolved: ${c.file}`);
		} else {
			log.error(`Failed to auto-resolve ${c.file}`);
			return false;
		}
	}

	// Continue rebase (GIT_EDITOR=true prevents editor from opening in non-interactive context)
	try {
		await $`git -C ${repoRoot} rebase --continue`.env({ ...process.env, GIT_EDITOR: 'true' }).quiet();
		return true;
	} catch {
		log.error('Rebase continue failed after auto-resolution');
		await $`git -C ${repoRoot} rebase --abort`.quiet().catch(() => {});
		return false;
	}
}

// ---------------------------------------------------------------------------
// PR merge
// ---------------------------------------------------------------------------

async function mergePR(
	prNumber: number,
	strategy: MergeStrategy,
	dryRun: boolean
): Promise<{ ok: boolean; error?: string }> {
	if (dryRun) {
		log.info(`[DRY RUN] Would merge PR #${prNumber} with --${strategy}`);
		return { ok: true };
	}

	// Retry once — GitHub may need a moment to process a force-push before merge
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await $`gh pr merge ${prNumber} --${strategy} --delete-branch`.quiet();
			return { ok: true };
		} catch (err) {
			if (attempt === 0) {
				log.info('Merge failed, retrying in 3s (GitHub may still be processing)...');
				await Bun.sleep(3000);
			} else {
				return { ok: false, error: String(err) };
			}
		}
	}
	return { ok: false, error: 'Unreachable' };
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
