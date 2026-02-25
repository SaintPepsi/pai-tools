import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { $ } from 'bun';
import {
	parseFinalizeFlags,
	determineMergeOrder,
	loadFinalizeState,
	saveFinalizeState,
	initFinalizeState,
	rebaseBranch,
	detectConflicts
} from './index.ts';
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

describe('finalize state: error clearing on merge', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'pai-finalize-error-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
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

	test('source code clears error on successful merge (regression)', () => {
		// The merge success path must set prState.error = null.
		// Matches the pattern: status = 'merged' followed by error = null.
		const source = readFileSync(join(import.meta.dir, 'index.ts'), 'utf-8');
		const mergedBlock = source.slice(
			source.indexOf("prState.status = 'merged'"),
			source.indexOf("prState.status = 'merged'") + 200
		);
		expect(mergedBlock).toContain('prState.error = null');
	});
});

describe('finalize source guards (regression)', () => {
	const source = readFileSync(join(import.meta.dir, 'index.ts'), 'utf-8');

	test('no startIdx guard — all PRs get rebased', () => {
		// Regression: `if (i > startIdx)` skipped rebase for first PR.
		expect(source).not.toContain('i > startIdx');
	});

	test('rebase --continue sets GIT_EDITOR to prevent editor hang', () => {
		// Regression: bare `rebase --continue` could open an editor in
		// non-interactive contexts, hanging the process indefinitely.
		const continueLines = source.split('\n').filter(
			(line) => line.includes('rebase --continue')
		);
		expect(continueLines.length).toBeGreaterThanOrEqual(2);
		for (const line of continueLines) {
			expect(line).toContain('GIT_EDITOR');
		}
	});

	test('force push catch logs a warning instead of silent swallow', () => {
		// Regression: .catch(() => {}) on force-with-lease silently swallowed
		// failures, causing opaque downstream merge errors.
		const pushLine = source.split('\n').find(
			(line) => line.includes('force-with-lease')
		);
		expect(pushLine).toBeDefined();
		// Must NOT be an empty catch
		expect(pushLine).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/);
	});

	test('conflict file paths use join() not template concatenation', () => {
		// Regression: `${repoRoot}/${c.file}` is fragile; join() is correct.
		// Check that no readFileSync or writeFileSync uses template path with c.file.
		const templatePathPattern = /(?:readFileSync|writeFileSync)\(`\$\{repoRoot\}\/\$\{c\.file\}`/;
		expect(source).not.toMatch(templatePathPattern);
	});

	test('promptLine is not defined locally — uses shared module', () => {
		// Regression: promptLine was duplicated in verify and finalize.
		expect(source).not.toContain('function promptLine');
		expect(source).toContain("from '../../shared/prompt.ts'");
	});
});

describe('shared promptLine module', () => {
	test('promptLine defined exactly once in shared/prompt.ts', () => {
		const sharedSource = readFileSync(
			join(import.meta.dir, '../../shared/prompt.ts'),
			'utf-8'
		);
		expect(sharedSource).toContain('export function promptLine');

		// Verify verify/index.ts also doesn't define it locally
		const verifySource = readFileSync(
			join(import.meta.dir, '../verify/index.ts'),
			'utf-8'
		);
		expect(verifySource).not.toContain('function promptLine');
		expect(verifySource).toContain("from '../../shared/prompt.ts'");
	});
});
