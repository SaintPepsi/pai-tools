/**
 * Coverage tests for tools/finalize/index.ts
 *
 * Targets lines 83-105 (runPostMergeVerify) and 131-306 (finalize function).
 * All external I/O is injected via FinalizeDeps mocks — no real git, GitHub,
 * or filesystem calls are made.
 */

import { describe, test, expect } from 'bun:test';
import {
	finalize,
	runPostMergeVerify,
	defaultFinalizeDeps,
	initFinalizeState,
	type FinalizeDeps,
	type PostMergeVerifyDeps,
} from './index.ts';
import type { FinalizeFlags, FinalizeState, MergeOrder } from './index.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseFlags: FinalizeFlags = {
	dryRun: false,
	single: false,
	noVerify: false,
	strategy: 'merge',
	from: null,
	autoResolve: false,
	help: false,
};

function makePR(issueNumber: number, prNumber: number, branch = `feat/${issueNumber}-x`, baseBranch = 'master'): MergeOrder {
	return { issueNumber, prNumber, branch, baseBranch };
}

class ExitError extends Error {
	code: number;
	constructor(code: number) { super(`exit(${code})`); this.code = code; }
}

type CallRecord = { fn: string; args: unknown[] };

function makeDeps(overrides: Partial<FinalizeDeps> = {}): { deps: FinalizeDeps; calls: CallRecord[]; printed: string[] } {
	const calls: CallRecord[] = [];
	const printed: string[] = [];
	const track = (fn: string, ...args: unknown[]) => calls.push({ fn, args });

	const state = initFinalizeState();

	const deps: FinalizeDeps = {
		discoverMergeablePRs: async (repoRoot) => { track('discoverMergeablePRs', repoRoot); return [makePR(1, 10)]; },
		determineMergeOrder: (prs) => { track('determineMergeOrder', prs); return prs; },
		rebaseBranch: async (...args) => { track('rebaseBranch', ...args); return { ok: true }; },
		autoResolveConflicts: async (...args) => { track('autoResolveConflicts', ...args); return true; },
		presentConflicts: async (conflicts) => { track('presentConflicts', conflicts); return new Map(); },
		resolveConflicts: async (...args) => { track('resolveConflicts', ...args); return true; },
		mergePR: async (...args) => { track('mergePR', ...args); return { ok: true }; },
		runPostMergeVerify: async (...args) => { track('runPostMergeVerify', ...args); return true; },
		findRepoRoot: () => { track('findRepoRoot'); return '/repo'; },
		getStateFilePath: (repoRoot, tool) => { track('getStateFilePath', repoRoot, tool); return '/repo/.pait/state/finalize.json'; },
		loadFinalizeState: (sf) => { track('loadFinalizeState', sf); return null; },
		saveFinalizeState: (s, sf) => { track('saveFinalizeState', s, sf); },
		gitQuiet: async (...args) => { track('gitQuiet', ...args); },
		gitQuietSwallow: async (...args) => { track('gitQuietSwallow', ...args); },
		ghQuietSwallow: async (...args) => { track('ghQuietSwallow', ...args); },
		exit: (code) => { throw new ExitError(code); },
		log: {
			info: (msg) => { track('log.info', msg); },
			ok: (msg) => { track('log.ok', msg); },
			warn: (msg) => { track('log.warn', msg); },
			error: (msg) => { track('log.error', msg); },
			step: (msg) => { track('log.step', msg); },
		},
		print: (msg) => { printed.push(msg); },
		...overrides,
	};

	return { deps, calls, printed };
}

// ---------------------------------------------------------------------------
// runPostMergeVerify (lines 83-109)
// ---------------------------------------------------------------------------

describe('runPostMergeVerify', () => {
	test('returns true immediately when noVerify is true', async () => {
		const result = await runPostMergeVerify('/repo', true);
		expect(result).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// finalize — help flag (line 132-135)
// ---------------------------------------------------------------------------

describe('finalize — help flag', () => {
	test('prints help and returns without doing anything when help=true', async () => {
		const { deps, printed, calls } = makeDeps();
		await finalize({ ...baseFlags, help: true }, deps);
		expect(printed.some((s) => s.includes('pait finalize'))).toBe(true);
		expect(calls.some((c) => c.fn === 'findRepoRoot')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// finalize — banner and repo root (lines 137-144)
// ---------------------------------------------------------------------------

describe('finalize — banner', () => {
	test('prints banner header before any work', async () => {
		const { deps, printed } = makeDeps({
			discoverMergeablePRs: async () => [],
		});
		await finalize(baseFlags, deps);
		expect(printed[0]).toContain('╔');
		expect(printed[1]).toContain('PAI PR Finalizer');
	});

	test('calls findRepoRoot to locate the repo', async () => {
		const { deps, calls } = makeDeps({ discoverMergeablePRs: async () => [] });
		await finalize(baseFlags, deps);
		expect(calls.some((c) => c.fn === 'findRepoRoot')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// finalize — no PRs found (lines 147-152)
// ---------------------------------------------------------------------------

describe('finalize — no PRs', () => {
	test('logs info and returns early when no PRs discovered', async () => {
		const { deps, calls } = makeDeps({ discoverMergeablePRs: async () => [] });
		await finalize(baseFlags, deps);
		expect(calls.some((c) => c.fn === 'log.info' && String(c.args[0]).includes('No mergeable'))).toBe(true);
		// Should NOT proceed to merge loop — no gitQuiet calls
		expect(calls.some((c) => c.fn === 'gitQuiet')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// finalize — --from flag (lines 158-165)
// ---------------------------------------------------------------------------

describe('finalize — --from flag', () => {
	test('starts merge loop from the specified issue', async () => {
		const prs = [makePR(1, 10), makePR(2, 20), makePR(3, 30)];
		const merged: number[] = [];
		const { deps } = makeDeps({
			discoverMergeablePRs: async () => prs,
			determineMergeOrder: (p) => p,
			mergePR: async (prNum) => { merged.push(prNum); return { ok: true }; },
		});
		await finalize({ ...baseFlags, from: 2 }, deps);
		expect(merged).not.toContain(10);
		expect(merged).toContain(20);
		expect(merged).toContain(30);
	});

	test('calls exit(1) when --from issue is not in queue', async () => {
		const { deps } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
		});
		await expect(finalize({ ...baseFlags, from: 99 }, deps)).rejects.toBeInstanceOf(ExitError);
	});

	test('logs error before exiting when --from issue not found', async () => {
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
		});
		await expect(finalize({ ...baseFlags, from: 99 }, deps)).rejects.toBeInstanceOf(ExitError);
		expect(calls.some((c) => c.fn === 'log.error' && String(c.args[0]).includes('#99'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// finalize — merge plan display (lines 167-174)
// ---------------------------------------------------------------------------

describe('finalize — merge plan display', () => {
	test('prints each PR in the plan', async () => {
		const prs = [makePR(1, 10, 'feat/1-a'), makePR(2, 20, 'feat/2-b')];
		const { deps, printed } = makeDeps({
			discoverMergeablePRs: async () => prs,
			determineMergeOrder: (p) => p,
		});
		await finalize(baseFlags, deps);
		expect(printed.some((s) => s.includes('#10'))).toBe(true);
		expect(printed.some((s) => s.includes('#20'))).toBe(true);
	});

	test('uses → marker for the start PR and space for others', async () => {
		const prs = [makePR(1, 10), makePR(2, 20)];
		const { deps, printed } = makeDeps({
			discoverMergeablePRs: async () => prs,
			determineMergeOrder: (p) => p,
		});
		await finalize(baseFlags, deps);
		const planLines = printed.filter((s) => s.includes('PR #'));
		// Leading marker: "  → #N PR ..." vs "    #N PR ..."
		expect(planLines[0]).toMatch(/^\s+→/);
		expect(planLines[1]).not.toMatch(/^\s+→/);
	});
});

// ---------------------------------------------------------------------------
// finalize — dry run (lines 176-179)
// ---------------------------------------------------------------------------

describe('finalize — dry run', () => {
	test('does not call mergePR when dry-run flag is set', async () => {
		const { deps, calls } = makeDeps({ discoverMergeablePRs: async () => [makePR(1, 10)] });
		await finalize({ ...baseFlags, dryRun: true }, deps);
		expect(calls.some((c) => c.fn === 'mergePR')).toBe(false);
	});

	test('logs dry-run complete message', async () => {
		const { deps, calls } = makeDeps({ discoverMergeablePRs: async () => [makePR(1, 10)] });
		await finalize({ ...baseFlags, dryRun: true }, deps);
		expect(calls.some((c) => c.fn === 'log.info' && String(c.args[0]).includes('Dry run'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// finalize — state loading (lines 180-182)
// ---------------------------------------------------------------------------

describe('finalize — state loading', () => {
	test('uses loaded state when state file exists', async () => {
		const existingState = initFinalizeState();
		existingState.prs[10] = {
			issueNumber: 1, prNumber: 10, branch: 'feat/1-x', baseBranch: 'master',
			status: 'merged', mergedAt: '2024-01-01T00:00:00.000Z', error: null
		};
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
			loadFinalizeState: () => existingState,
		});
		await finalize(baseFlags, deps);
		const saves = calls.filter((c) => c.fn === 'saveFinalizeState');
		expect(saves.length).toBeGreaterThan(0);
		// The state object used should be the existing one (not a fresh one)
		expect((saves[saves.length - 1].args[0] as FinalizeState).prs[10]).toBeDefined();
	});

	test('initialises fresh state when no state file exists', async () => {
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
			loadFinalizeState: () => null,
		});
		await finalize(baseFlags, deps);
		// Should have saved state with the PR entry initialised
		const saves = calls.filter((c) => c.fn === 'saveFinalizeState');
		expect(saves.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// finalize — git checkout + pull before merge loop (lines 184-189)
// ---------------------------------------------------------------------------

describe('finalize — initial git sync', () => {
	test('checks out baseBranch and pulls before merge loop', async () => {
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10, 'feat/1-x', 'main')],
			determineMergeOrder: (p) => p,
		});
		await finalize(baseFlags, deps);
		const gitCalls = calls.filter((c) => c.fn === 'gitQuiet');
		expect(gitCalls.some((c) => (c.args[0] as string[]).includes('checkout'))).toBe(true);
		expect(gitCalls.some((c) => (c.args[0] as string[]).includes('--ff-only'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// finalize — merge loop: happy path (lines 192-300)
// ---------------------------------------------------------------------------

describe('finalize — happy path merge', () => {
	test('calls rebaseBranch for each PR', async () => {
		const prs = [makePR(1, 10), makePR(2, 20)];
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => prs,
			determineMergeOrder: (p) => p,
		});
		await finalize(baseFlags, deps);
		const rebases = calls.filter((c) => c.fn === 'rebaseBranch');
		expect(rebases.length).toBe(2);
	});

	test('calls mergePR for each PR after successful rebase', async () => {
		const prs = [makePR(1, 10), makePR(2, 20)];
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => prs,
			determineMergeOrder: (p) => p,
		});
		await finalize(baseFlags, deps);
		const merges = calls.filter((c) => c.fn === 'mergePR');
		expect(merges.length).toBe(2);
	});

	test('force-pushes rebased branch before merging', async () => {
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10, 'feat/1-x')],
			determineMergeOrder: (p) => p,
		});
		await finalize(baseFlags, deps);
		const pushCalls = calls.filter(
			(c) => c.fn === 'gitQuiet' && (c.args[0] as string[]).includes('--force-with-lease')
		);
		expect(pushCalls.length).toBe(1);
	});

	test('marks PR as merged in state on success', async () => {
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
		});
		await finalize(baseFlags, deps);
		const saves = calls.filter((c) => c.fn === 'saveFinalizeState');
		const lastState = saves[saves.length - 1].args[0] as FinalizeState;
		expect(lastState.prs[10].status).toBe('merged');
		expect(lastState.prs[10].mergedAt).not.toBeNull();
		expect(lastState.prs[10].error).toBeNull();
	});

	test('closes the associated issue after merge', async () => {
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
		});
		await finalize(baseFlags, deps);
		const closes = calls.filter(
			(c) => c.fn === 'ghQuietSwallow' && (c.args[0] as string[]).includes('close')
		);
		expect(closes.length).toBe(1);
	});

	test('prints summary with merged count', async () => {
		const { deps, printed } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
		});
		await finalize(baseFlags, deps);
		expect(printed.some((s) => s.includes('Merged: 1'))).toBe(true);
	});

	test('does not print failed line when no failures', async () => {
		const { deps, printed } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
		});
		await finalize(baseFlags, deps);
		expect(printed.some((s) => s.includes('Failed:'))).toBe(false);
	});

	test('prints failed count when PRs failed', async () => {
		const { deps, printed } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10), makePR(2, 20)],
			determineMergeOrder: (p) => p,
			mergePR: async (prNum) => prNum === 10 ? { ok: true } : { ok: false, error: 'gh error' },
		});
		await finalize(baseFlags, deps);
		expect(printed.some((s) => s.includes('Failed:'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// finalize — merge loop: rebase failure paths (lines 219-244)
// ---------------------------------------------------------------------------

describe('finalize — rebase failure: not a conflict', () => {
	test('marks PR as failed when rebase fails with no conflicts', async () => {
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
			rebaseBranch: async () => ({ ok: false }),
		});
		await finalize(baseFlags, deps);
		const saves = calls.filter((c) => c.fn === 'saveFinalizeState');
		const lastState = saves[saves.length - 1].args[0] as FinalizeState;
		expect(lastState.prs[10].status).toBe('failed');
		expect(lastState.prs[10].error).toContain('not a conflict');
	});

	test('logs error and continues to next PR on rebase failure', async () => {
		const prs = [makePR(1, 10), makePR(2, 20)];
		const mergedPRs: number[] = [];
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => prs,
			determineMergeOrder: (p) => p,
			rebaseBranch: async (branch) => branch === 'feat/1-x' ? { ok: false } : { ok: true },
			mergePR: async (prNum) => { mergedPRs.push(prNum); return { ok: true }; },
		});
		await finalize(baseFlags, deps);
		expect(mergedPRs).not.toContain(10);
		expect(mergedPRs).toContain(20);
	});
});

describe('finalize — rebase failure: with conflicts, interactive resolution', () => {
	test('calls presentConflicts and resolveConflicts when autoResolve=false', async () => {
		const conflicts = [{ file: 'README.md' }];
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
			rebaseBranch: async () => ({ ok: false, conflicts }),
			presentConflicts: async (c) => { calls.push({ fn: 'presentConflicts', args: [c] }); return new Map([['README.md', 'ours']]); },
			resolveConflicts: async () => { calls.push({ fn: 'resolveConflicts', args: [] }); return true; },
		});
		await finalize({ ...baseFlags, autoResolve: false }, deps);
		expect(calls.some((c) => c.fn === 'presentConflicts')).toBe(true);
		expect(calls.some((c) => c.fn === 'resolveConflicts')).toBe(true);
	});

	test('calls autoResolveConflicts when autoResolve=true', async () => {
		const conflicts = [{ file: 'README.md' }];
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
			rebaseBranch: async () => ({ ok: false, conflicts }),
			autoResolveConflicts: async (c, r) => { calls.push({ fn: 'autoResolveConflicts', args: [c, r] }); return true; },
		});
		await finalize({ ...baseFlags, autoResolve: true }, deps);
		expect(calls.some((c) => c.fn === 'autoResolveConflicts')).toBe(true);
		expect(calls.some((c) => c.fn === 'presentConflicts')).toBe(false);
	});

	test('marks PR as conflict status when resolution fails', async () => {
		const conflicts = [{ file: 'README.md' }];
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
			rebaseBranch: async () => ({ ok: false, conflicts }),
			resolveConflicts: async () => false,
		});
		await finalize({ ...baseFlags, autoResolve: false }, deps);
		const saves = calls.filter((c) => c.fn === 'saveFinalizeState');
		const lastState = saves[saves.length - 1].args[0] as FinalizeState;
		expect(lastState.prs[10].status).toBe('conflict');
		expect(lastState.prs[10].error).toContain('Conflict resolution failed');
	});

	test('marks PR as conflict status when auto-resolution fails', async () => {
		const conflicts = [{ file: 'src/app.ts' }];
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
			rebaseBranch: async () => ({ ok: false, conflicts }),
			autoResolveConflicts: async () => false,
		});
		await finalize({ ...baseFlags, autoResolve: true }, deps);
		const saves = calls.filter((c) => c.fn === 'saveFinalizeState');
		const lastState = saves[saves.length - 1].args[0] as FinalizeState;
		expect(lastState.prs[10].status).toBe('conflict');
	});

	test('continues to merge after successful conflict resolution', async () => {
		const conflicts = [{ file: 'README.md' }];
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
			rebaseBranch: async () => ({ ok: false, conflicts }),
			resolveConflicts: async () => true,
		});
		await finalize({ ...baseFlags, autoResolve: false }, deps);
		expect(calls.some((c) => c.fn === 'mergePR')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// finalize — merge failure (lines 262-270)
// ---------------------------------------------------------------------------

describe('finalize — mergePR failure', () => {
	test('marks PR as failed when mergePR returns not-ok', async () => {
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
			mergePR: async () => ({ ok: false, error: 'gh auth failed' }),
		});
		await finalize(baseFlags, deps);
		const saves = calls.filter((c) => c.fn === 'saveFinalizeState');
		const lastState = saves[saves.length - 1].args[0] as FinalizeState;
		expect(lastState.prs[10].status).toBe('failed');
		expect(lastState.prs[10].error).toBe('gh auth failed');
	});

	test('uses "Merge failed" as fallback error when mergePR provides no error string', async () => {
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
			mergePR: async () => ({ ok: false }),
		});
		await finalize(baseFlags, deps);
		const saves = calls.filter((c) => c.fn === 'saveFinalizeState');
		const lastState = saves[saves.length - 1].args[0] as FinalizeState;
		expect(lastState.prs[10].error).toBe('Merge failed');
	});

	test('continues to next PR after merge failure', async () => {
		const prs = [makePR(1, 10), makePR(2, 20)];
		const mergedPRs: number[] = [];
		const { deps } = makeDeps({
			discoverMergeablePRs: async () => prs,
			determineMergeOrder: (p) => p,
			mergePR: async (prNum) => {
				if (prNum === 10) return { ok: false, error: 'fail' };
				mergedPRs.push(prNum);
				return { ok: true };
			},
		});
		await finalize(baseFlags, deps);
		expect(mergedPRs).toContain(20);
	});

	test('prints failed count in summary when failures occurred', async () => {
		const { deps, printed } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
			mergePR: async () => ({ ok: false, error: 'nope' }),
		});
		await finalize(baseFlags, deps);
		expect(printed.some((s) => s.includes('Failed: 1'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// finalize — post-merge verification (lines 277-285)
// ---------------------------------------------------------------------------

describe('finalize — post-merge verification', () => {
	test('calls runPostMergeVerify when noVerify=false', async () => {
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
		});
		await finalize({ ...baseFlags, noVerify: false }, deps);
		expect(calls.some((c) => c.fn === 'runPostMergeVerify')).toBe(true);
	});

	test('does not call runPostMergeVerify when noVerify=true', async () => {
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
		});
		await finalize({ ...baseFlags, noVerify: true }, deps);
		expect(calls.some((c) => c.fn === 'runPostMergeVerify')).toBe(false);
	});

	test('logs warning when verification fails but still continues', async () => {
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
			runPostMergeVerify: async () => false,
		});
		await finalize({ ...baseFlags, noVerify: false }, deps);
		const warns = calls.filter((c) => c.fn === 'log.warn');
		expect(warns.some((c) => String(c.args[0]).includes('verification failed'))).toBe(true);
		// PR should still be merged (verify failure is non-fatal)
		const saves = calls.filter((c) => c.fn === 'saveFinalizeState');
		const lastState = saves[saves.length - 1].args[0] as FinalizeState;
		expect(lastState.prs[10].status).toBe('merged');
	});
});

// ---------------------------------------------------------------------------
// finalize — retargeting dependent PRs (lines 253-259)
// ---------------------------------------------------------------------------

describe('finalize — retarget dependent PRs', () => {
	test('retargets stacked PRs that point to the just-merged branch', async () => {
		const pr1 = makePR(1, 10, 'feat/1-a', 'master');
		const pr2 = makePR(2, 20, 'feat/2-b', 'feat/1-a'); // stacked on pr1
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [pr1, pr2],
			determineMergeOrder: (p) => p,
		});
		await finalize(baseFlags, deps);
		const retargets = calls.filter(
			(c) => c.fn === 'ghQuietSwallow' && (c.args[0] as string[]).includes('edit')
		);
		expect(retargets.length).toBe(1);
		expect((retargets[0].args[0] as string[])).toContain('20');
	});

	test('does not retarget PRs whose base is not the just-merged branch', async () => {
		const pr1 = makePR(1, 10, 'feat/1-a', 'master');
		const pr2 = makePR(2, 20, 'feat/2-b', 'master'); // independent, not stacked
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [pr1, pr2],
			determineMergeOrder: (p) => p,
		});
		await finalize(baseFlags, deps);
		const retargets = calls.filter(
			(c) => c.fn === 'ghQuietSwallow' && (c.args[0] as string[]).includes('edit')
		);
		expect(retargets.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// finalize — --single mode (lines 295-299)
// ---------------------------------------------------------------------------

describe('finalize — single mode', () => {
	test('stops after the first successful merge when single=true', async () => {
		const prs = [makePR(1, 10), makePR(2, 20), makePR(3, 30)];
		const mergedPRs: number[] = [];
		const { deps } = makeDeps({
			discoverMergeablePRs: async () => prs,
			determineMergeOrder: (p) => p,
			mergePR: async (prNum) => { mergedPRs.push(prNum); return { ok: true }; },
		});
		await finalize({ ...baseFlags, single: true }, deps);
		expect(mergedPRs).toEqual([10]);
	});

	test('logs single-mode stop message', async () => {
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10), makePR(2, 20)],
			determineMergeOrder: (p) => p,
		});
		await finalize({ ...baseFlags, single: true }, deps);
		expect(calls.some((c) => c.fn === 'log.info' && String(c.args[0]).includes('Single mode'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// finalize — PR state initialisation (lines 195-207)
// ---------------------------------------------------------------------------

describe('finalize — PR state initialisation', () => {
	test('initialises state entry for PR not yet in state', async () => {
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10, 'feat/1-x', 'master')],
			determineMergeOrder: (p) => p,
			loadFinalizeState: () => null,
		});
		await finalize(baseFlags, deps);
		const saves = calls.filter((c) => c.fn === 'saveFinalizeState');
		const state = saves[0].args[0] as FinalizeState;
		expect(state.prs[10]).toBeDefined();
		expect(state.prs[10].issueNumber).toBe(1);
		expect(state.prs[10].branch).toBe('feat/1-x');
	});

	test('reuses existing state entry for PR already in state', async () => {
		const existingState = initFinalizeState();
		existingState.prs[10] = {
			issueNumber: 1, prNumber: 10, branch: 'feat/1-x', baseBranch: 'master',
			status: 'pending', mergedAt: null, error: 'previous error'
		};
		const { deps, calls } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
			loadFinalizeState: () => existingState,
		});
		await finalize(baseFlags, deps);
		// After successful merge, error should be cleared
		const saves = calls.filter((c) => c.fn === 'saveFinalizeState');
		const lastState = saves[saves.length - 1].args[0] as FinalizeState;
		expect(lastState.prs[10].status).toBe('merged');
		expect(lastState.prs[10].error).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// finalize — summary counts (lines 302-308)
// ---------------------------------------------------------------------------

describe('finalize — summary', () => {
	test('counts conflict-status PRs in failed total', async () => {
		const conflicts = [{ file: 'file.ts' }];
		const { deps, printed } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
			rebaseBranch: async () => ({ ok: false, conflicts }),
			resolveConflicts: async () => false,
		});
		await finalize(baseFlags, deps);
		expect(printed.some((s) => s.includes('Failed: 1'))).toBe(true);
	});

	test('Merged: 0 when all PRs failed', async () => {
		const { deps, printed } = makeDeps({
			discoverMergeablePRs: async () => [makePR(1, 10)],
			determineMergeOrder: (p) => p,
			mergePR: async () => ({ ok: false, error: 'nope' }),
		});
		await finalize(baseFlags, deps);
		expect(printed.some((s) => s.includes('Merged: 0'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// runPostMergeVerify — injectable dep paths (lines 172-196)
// ---------------------------------------------------------------------------

describe('runPostMergeVerify — injectable deps', () => {
	test('returns true when noVerify=true without touching deps', async () => {
		let loadCalled = false;
		const deps: PostMergeVerifyDeps = {
			loadToolConfig: () => { loadCalled = true; return { verify: [] }; },
			runVerify: async () => ({ ok: true }),
		};
		const result = await runPostMergeVerify('/any', true, deps);
		expect(result).toBe(true);
		expect(loadCalled).toBe(false);
	});

	test('returns true when config has no verify commands and no e2e', async () => {
		const deps: PostMergeVerifyDeps = {
			loadToolConfig: () => ({ verify: [] }),
			runVerify: async () => ({ ok: false }), // should not be called
		};
		const result = await runPostMergeVerify('/repo', false, deps);
		expect(result).toBe(true);
	});

	test('returns true when config has no verify commands and no e2e (e2e undefined)', async () => {
		const deps: PostMergeVerifyDeps = {
			loadToolConfig: () => ({ verify: [], e2e: undefined }),
			runVerify: async () => ({ ok: false }),
		};
		const result = await runPostMergeVerify('/repo', false, deps);
		expect(result).toBe(true);
	});

	test('calls runVerify when verify commands are present and returns its result', async () => {
		let verifyCalled = false;
		const deps: PostMergeVerifyDeps = {
			loadToolConfig: () => ({ verify: [{ name: 'test', cmd: 'bun test' }] }),
			runVerify: async () => { verifyCalled = true; return { ok: true }; },
		};
		const result = await runPostMergeVerify('/repo', false, deps);
		expect(verifyCalled).toBe(true);
		expect(result).toBe(true);
	});

	test('returns false when runVerify fails', async () => {
		const deps: PostMergeVerifyDeps = {
			loadToolConfig: () => ({ verify: [{ name: 'test', cmd: 'bun test' }] }),
			runVerify: async () => ({ ok: false }),
		};
		const result = await runPostMergeVerify('/repo', false, deps);
		expect(result).toBe(false);
	});

	test('calls runVerify when e2e is configured even with no verify commands', async () => {
		let verifyCalled = false;
		const deps: PostMergeVerifyDeps = {
			loadToolConfig: () => ({
				verify: [],
				e2e: { run: 'bun e2e', update: 'bun e2e --update', snapshotGlob: '**/*.snap' }
			}),
			runVerify: async () => { verifyCalled = true; return { ok: true }; },
		};
		const result = await runPostMergeVerify('/repo', false, deps);
		expect(verifyCalled).toBe(true);
		expect(result).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// defaultFinalizeDeps — default shell helper coverage (lines 82-97)
//
// These helpers wrap real Bun shell calls. We exercise them against a real
// temp git repo (setup via Bun.$) — no node:fs imports per coding standards.
// ---------------------------------------------------------------------------

describe('defaultFinalizeDeps — default shell helpers', () => {
	test('gitQuiet: succeeds on a real git command (git status)', async () => {
		// Use the current repo root — guaranteed to be a git repo
		const repoRoot = (await Bun.$`git rev-parse --show-toplevel`.text()).trim();
		// Should not throw — git status always exits 0 in a clean repo
		await expect(
			defaultFinalizeDeps.gitQuiet(['git', 'status'], repoRoot)
		).resolves.toBeUndefined();
	});

	test('gitQuiet: logs a warning on failure but does not throw', async () => {
		// Pass a nonexistent repo path — git will exit non-zero
		await expect(
			defaultFinalizeDeps.gitQuiet(['git', 'status'], '/nonexistent-repo-xyz')
		).resolves.toBeUndefined();
	});

	test('gitQuietSwallow: succeeds on a real git command', async () => {
		const repoRoot = (await Bun.$`git rev-parse --show-toplevel`.text()).trim();
		await expect(
			defaultFinalizeDeps.gitQuietSwallow(['git', 'status'], repoRoot)
		).resolves.toBeUndefined();
	});

	test('gitQuietSwallow: silently swallows failure', async () => {
		await expect(
			defaultFinalizeDeps.gitQuietSwallow(['git', 'status'], '/nonexistent-repo-xyz')
		).resolves.toBeUndefined();
	});

	test('ghQuietSwallow: silently swallows failure (gh not authenticated)', async () => {
		// Calling gh with a bogus command will fail — should be swallowed silently
		await expect(
			defaultFinalizeDeps.ghQuietSwallow(['gh', 'issue', 'close', '999999999'])
		).resolves.toBeUndefined();
	});

	test('defaultFinalizeDeps.exit delegates to process.exit', () => {
		const original = process.exit;
		let recorded: number | undefined;
		process.exit = (code?: number) => { recorded = code; return undefined as never; };
		defaultFinalizeDeps.exit(42);
		process.exit = original;
		expect(recorded).toBe(42);
	});
});

// ---------------------------------------------------------------------------
// runPostMergeVerify — default deps path (exercises defaultPostMergeVerifyDeps)
// ---------------------------------------------------------------------------

describe('runPostMergeVerify — default deps (no config file)', () => {
	test('returns true via default deps when repo has no orchestrator config', async () => {
		// Use a temp dir with no .pait/orchestrator.json — loadToolConfig returns
		// the default ({ verify: [] }), so runPostMergeVerify returns true without
		// calling runVerify. This exercises the defaultPostMergeVerifyDeps object.
		const tmpDir = (await Bun.$`mktemp -d`.text()).trim();
		const result = await runPostMergeVerify(tmpDir, false);
		await Bun.$`rm -rf ${tmpDir}`.quiet();
		expect(result).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// defaultFinalizeDeps — inline arrow coverage (print, exit)
// ---------------------------------------------------------------------------

describe('defaultFinalizeDeps — inline arrows', () => {
	test('print arrow writes to stdout without throwing', () => {
		// Exercises the (msg) => console.log(msg) arrow in defaultFinalizeDeps
		expect(() => defaultFinalizeDeps.print('test output')).not.toThrow();
	});
});
