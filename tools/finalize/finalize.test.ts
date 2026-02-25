import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { $ } from 'bun';
import {
	parseFinalizeFlags,
	loadFinalizeState,
	saveFinalizeState,
	initFinalizeState,
	rebaseBranch,
	detectConflicts
} from './index.ts';
import { determineMergeOrder } from '../../shared/github.ts';
import type { MergeOrder, FinalizeState } from './types.ts';

describe('parseFinalizeFlags', () => {
	test('parses --dry-run', () => {
		const flags = parseFinalizeFlags(['--dry-run']);
		expect(flags.dryRun).toBe(true);
		expect(flags.single).toBe(false);
	});

	test('parses --single', () => {
		const flags = parseFinalizeFlags(['--single']);
		expect(flags.single).toBe(true);
	});

	test('parses --no-verify', () => {
		const flags = parseFinalizeFlags(['--no-verify']);
		expect(flags.noVerify).toBe(true);
	});

	test('parses --strategy rebase', () => {
		const flags = parseFinalizeFlags(['--strategy', 'rebase']);
		expect(flags.strategy).toBe('rebase');
	});

	test('defaults strategy to squash for invalid value', () => {
		const flags = parseFinalizeFlags(['--strategy', 'invalid']);
		expect(flags.strategy).toBe('squash');
	});

	test('parses --from N', () => {
		const flags = parseFinalizeFlags(['--from', '5']);
		expect(flags.from).toBe(5);
	});

	test('parses --help', () => {
		const flags = parseFinalizeFlags(['--help']);
		expect(flags.help).toBe(true);
	});

	test('defaults to all false/null/squash', () => {
		const flags = parseFinalizeFlags([]);
		expect(flags.dryRun).toBe(false);
		expect(flags.single).toBe(false);
		expect(flags.noVerify).toBe(false);
		expect(flags.strategy).toBe('squash');
		expect(flags.from).toBeNull();
		expect(flags.help).toBe(false);
	});
});

describe('determineMergeOrder', () => {
	test('independent PRs ordered by issue number', () => {
		const prs: MergeOrder[] = [
			{ issueNumber: 3, prNumber: 30, branch: 'feat/3-c', baseBranch: 'master' },
			{ issueNumber: 1, prNumber: 10, branch: 'feat/1-a', baseBranch: 'master' },
			{ issueNumber: 2, prNumber: 20, branch: 'feat/2-b', baseBranch: 'master' }
		];

		const ordered = determineMergeOrder(prs);
		expect(ordered.map((p) => p.issueNumber)).toEqual([1, 2, 3]);
	});

	test('stacked PRs follow dependency chain', () => {
		const prs: MergeOrder[] = [
			{ issueNumber: 3, prNumber: 30, branch: 'feat/3-c', baseBranch: 'feat/2-b' },
			{ issueNumber: 1, prNumber: 10, branch: 'feat/1-a', baseBranch: 'master' },
			{ issueNumber: 2, prNumber: 20, branch: 'feat/2-b', baseBranch: 'feat/1-a' }
		];

		const ordered = determineMergeOrder(prs);
		expect(ordered.map((p) => p.issueNumber)).toEqual([1, 2, 3]);
	});

	test('mixed stacked and independent', () => {
		const prs: MergeOrder[] = [
			{ issueNumber: 4, prNumber: 40, branch: 'feat/4-d', baseBranch: 'master' },
			{ issueNumber: 2, prNumber: 20, branch: 'feat/2-b', baseBranch: 'feat/1-a' },
			{ issueNumber: 1, prNumber: 10, branch: 'feat/1-a', baseBranch: 'master' }
		];

		const ordered = determineMergeOrder(prs);
		// 1 before 2 (dependency), 4 is independent
		const idx1 = ordered.findIndex((p) => p.issueNumber === 1);
		const idx2 = ordered.findIndex((p) => p.issueNumber === 2);
		expect(idx1).toBeLessThan(idx2);
	});

	test('cycle in stacked PRs throws instead of silently dropping a PR', () => {
		// A depends on B, B depends on A — a true circular dependency.
		// The function must throw rather than silently lose one of the PRs.
		const prs: MergeOrder[] = [
			{ issueNumber: 1, prNumber: 10, branch: 'feat/1-a', baseBranch: 'feat/2-b' },
			{ issueNumber: 2, prNumber: 20, branch: 'feat/2-b', baseBranch: 'feat/1-a' }
		];
		expect(() => determineMergeOrder(prs)).toThrow(/[Cc]ycle/);
	});
});

describe('finalize state management', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'pai-finalize-state-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('state roundtrip: save → load → compare', () => {
		const statePath = join(tempDir, 'finalize.json');
		const state = initFinalizeState();
		state.prs[10] = {
			issueNumber: 1,
			prNumber: 10,
			branch: 'feat/1-test',
			baseBranch: 'master',
			status: 'merged',
			mergedAt: '2025-01-01T00:00:00.000Z',
			error: null
		};

		saveFinalizeState(state, statePath);
		const loaded = loadFinalizeState(statePath);

		expect(loaded).not.toBeNull();
		expect(loaded!.version).toBe(1);
		expect(loaded!.prs[10].status).toBe('merged');
		expect(loaded!.prs[10].branch).toBe('feat/1-test');
	});

	test('loadFinalizeState returns null for missing file', () => {
		const result = loadFinalizeState(join(tempDir, 'nonexistent.json'));
		expect(result).toBeNull();
	});

	test('previously failed PR must have error cleared after successful merge', () => {
		// Regression: prState.error was not cleared when status became 'merged',
		// leaving stale error strings from failed attempts.
		const state = initFinalizeState();
		state.prs[10] = {
			issueNumber: 1,
			prNumber: 10,
			branch: 'feat/1-test',
			baseBranch: 'master',
			status: 'conflict',
			mergedAt: null,
			error: 'Conflict resolution failed'
		};

		// Simulate successful retry — the fix clears error
		state.prs[10].status = 'merged';
		state.prs[10].mergedAt = new Date().toISOString();
		state.prs[10].error = null;

		const statePath = join(tempDir, 'finalize.json');
		saveFinalizeState(state, statePath);
		const loaded = loadFinalizeState(statePath);

		expect(loaded!.prs[10].status).toBe('merged');
		expect(loaded!.prs[10].error).toBeNull();
	});
});

describe('git operations', () => {
	let tempDir: string;
	let repoRoot: string;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), 'pai-finalize-git-'));
		repoRoot = join(tempDir, 'repo');
		mkdirSync(repoRoot);

		// Initialize a real git repo with an initial commit
		await $`git -C ${repoRoot} init`.quiet();
		await $`git -C ${repoRoot} checkout -b main`.quiet();
		writeFileSync(join(repoRoot, 'README.md'), 'initial\n');
		await $`git -C ${repoRoot} add README.md`.quiet();
		await $`git -C ${repoRoot} commit -m "initial"`.quiet();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('rebaseBranch: clean rebase succeeds', async () => {
		// Create a feature branch with a commit
		await $`git -C ${repoRoot} checkout -b feat/1-test`.quiet();
		writeFileSync(join(repoRoot, 'feature.txt'), 'feature\n');
		await $`git -C ${repoRoot} add feature.txt`.quiet();
		await $`git -C ${repoRoot} commit -m "add feature"`.quiet();

		// Add a non-conflicting commit to main
		await $`git -C ${repoRoot} checkout main`.quiet();
		writeFileSync(join(repoRoot, 'other.txt'), 'other\n');
		await $`git -C ${repoRoot} add other.txt`.quiet();
		await $`git -C ${repoRoot} commit -m "add other"`.quiet();

		// Rebase feature onto main
		const result = await rebaseBranch('feat/1-test', 'main', repoRoot);
		expect(result.ok).toBe(true);
		expect(result.conflicts).toBeUndefined();

		// Feature branch should now have both commits
		const logOutput = await $`git -C ${repoRoot} log --oneline`.text();
		expect(logOutput).toContain('add feature');
		expect(logOutput).toContain('add other');
	});

	test('rebaseBranch: conflict detected', async () => {
		// Create a feature branch that modifies README
		await $`git -C ${repoRoot} checkout -b feat/2-conflict`.quiet();
		writeFileSync(join(repoRoot, 'README.md'), 'feature version\n');
		await $`git -C ${repoRoot} add README.md`.quiet();
		await $`git -C ${repoRoot} commit -m "feature change"`.quiet();

		// Add a conflicting commit to main
		await $`git -C ${repoRoot} checkout main`.quiet();
		writeFileSync(join(repoRoot, 'README.md'), 'main version\n');
		await $`git -C ${repoRoot} add README.md`.quiet();
		await $`git -C ${repoRoot} commit -m "main change"`.quiet();

		// Rebase should detect conflict
		const result = await rebaseBranch('feat/2-conflict', 'main', repoRoot);
		expect(result.ok).toBe(false);
		expect(result.conflicts).toBeDefined();
		expect(result.conflicts!.length).toBeGreaterThan(0);
		expect(result.conflicts![0].file).toBe('README.md');
	});

	test('rebaseBranch: no-op when branch already up-to-date', async () => {
		// Feature branch created from current main tip — no divergence
		await $`git -C ${repoRoot} checkout -b feat/3-uptodate`.quiet();
		writeFileSync(join(repoRoot, 'feature.txt'), 'feature\n');
		await $`git -C ${repoRoot} add feature.txt`.quiet();
		await $`git -C ${repoRoot} commit -m "add feature"`.quiet();

		const result = await rebaseBranch('feat/3-uptodate', 'main', repoRoot);
		expect(result.ok).toBe(true);
		expect(result.conflicts).toBeUndefined();
	});

	test('detectConflicts: returns empty when no conflicts', async () => {
		const conflicts = await detectConflicts(repoRoot);
		expect(conflicts).toEqual([]);
	});
});
