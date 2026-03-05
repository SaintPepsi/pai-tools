import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { $ } from 'bun';
import { join } from 'node:path';
import {
	localBranchExists,
	deleteLocalBranch,
	detectConflicts,
	rebaseBranch,
	resolveConflicts,
	autoResolveConflicts,
} from 'shared/git.ts';
import type { GitDeps } from 'shared/git.ts';
import type { RollingWindow } from 'shared/log.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
	return (await $`mktemp -d`.text()).trim();
}

async function initRepo(tempDir: string): Promise<string> {
	const repoRoot = join(tempDir, 'repo');
	await $`mkdir -p ${repoRoot}`.quiet();
	await $`git -C ${repoRoot} init`.quiet();
	await $`git -C ${repoRoot} config user.email "test@example.com"`.quiet();
	await $`git -C ${repoRoot} config user.name "Test"`.quiet();
	await $`git -C ${repoRoot} checkout -b main`.quiet();
	return repoRoot;
}

type MockWindow = { updateCalls: string[]; clearCount: number };

/**
 * Mock deps that use real fs ops (so git commands work) but mock window/claude.
 * The `claude` mock calls onChunk and returns the given output.
 */
function makeConflictMockDeps(claudeOutput: string = 'resolved content\n'): {
	deps: GitDeps;
	window: MockWindow;
	windowHeaders: string[];
} {
	const window: MockWindow = { updateCalls: [], clearCount: 0 };
	const windowHeaders: string[] = [];

	const mockWindow = {
		update: (text: string) => { window.updateCalls.push(text); },
		clear: () => { window.clearCount++; },
	} as unknown as RollingWindow;

	const deps: GitDeps = {
		readFile: (path) => Bun.file(path).text(),
		writeFile: async (path, content) => { await Bun.write(path, content); },
		fileExists: (path) => Bun.file(path).exists(),
		removeDir: async (path) => { await $`rm -rf ${path}`.nothrow().quiet(); },
		env: Bun.env,
		makeWindow: (header, _logPath) => {
			windowHeaders.push(header);
			return mockWindow;
		},
		claude: async (opts) => {
			opts.onChunk?.('chunk-a');
			opts.onChunk?.('chunk-b');
			return { ok: true, output: claudeOutput };
		},
	};

	return { deps, window, windowHeaders };
}

/** Create a repo with a conflict in rebase state. Returns repoRoot and conflicting file name. */
async function setupConflict(repoRoot: string, fileName: string = 'README.md'): Promise<void> {
	await Bun.write(join(repoRoot, fileName), 'initial\n');
	await $`git -C ${repoRoot} add ${fileName}`.quiet();
	await $`git -C ${repoRoot} commit -m "initial"`.quiet();

	await $`git -C ${repoRoot} checkout -b feat/conflict`.quiet();
	await Bun.write(join(repoRoot, fileName), 'feature version\n');
	await $`git -C ${repoRoot} add ${fileName}`.quiet();
	await $`git -C ${repoRoot} commit -m "feature change"`.quiet();

	await $`git -C ${repoRoot} checkout main`.quiet();
	await Bun.write(join(repoRoot, fileName), 'main version\n');
	await $`git -C ${repoRoot} add ${fileName}`.quiet();
	await $`git -C ${repoRoot} commit -m "main change"`.quiet();

	await $`git -C ${repoRoot} checkout feat/conflict`.quiet();
	// This will conflict — don't throw on non-zero exit
	await $`git -C ${repoRoot} rebase main`.nothrow().quiet();
}

// ---------------------------------------------------------------------------
// Branch operations
// ---------------------------------------------------------------------------

describe('shared/git — branch operations', () => {
	let tempDir: string;
	let repoRoot: string;

	beforeEach(async () => {
		tempDir = await makeTempDir();
		repoRoot = await initRepo(tempDir);
		await $`git -C ${repoRoot} commit --allow-empty -m "initial"`.quiet();
	});

	afterEach(async () => {
		await $`rm -rf ${tempDir}`.nothrow().quiet();
	});

	test('localBranchExists returns true for existing branch', async () => {
		expect(await localBranchExists('main', repoRoot)).toBe(true);
	});

	test('localBranchExists returns false for non-existent branch', async () => {
		expect(await localBranchExists('no-such-branch', repoRoot)).toBe(false);
	});

	test('deleteLocalBranch removes an existing branch', async () => {
		await $`git -C ${repoRoot} branch to-delete`.quiet();
		expect(await localBranchExists('to-delete', repoRoot)).toBe(true);

		await deleteLocalBranch('to-delete', repoRoot);
		expect(await localBranchExists('to-delete', repoRoot)).toBe(false);
	});

	test('deleteLocalBranch is a no-op for non-existent branch', async () => {
		await deleteLocalBranch('ghost-branch', repoRoot);
		expect(await localBranchExists('ghost-branch', repoRoot)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Rebase operations
// ---------------------------------------------------------------------------

describe('shared/git — rebase operations', () => {
	let tempDir: string;
	let repoRoot: string;

	beforeEach(async () => {
		tempDir = await makeTempDir();
		repoRoot = await initRepo(tempDir);
		await Bun.write(join(repoRoot, 'README.md'), 'initial\n');
		await $`git -C ${repoRoot} add README.md`.quiet();
		await $`git -C ${repoRoot} commit -m "initial"`.quiet();
	});

	afterEach(async () => {
		await $`rm -rf ${tempDir}`.nothrow().quiet();
	});

	test('detectConflicts returns empty array when no conflicts', async () => {
		const result = await detectConflicts(repoRoot);
		expect(result).toEqual([]);
	});

	test('rebaseBranch succeeds with no divergence', async () => {
		await $`git -C ${repoRoot} checkout -b feat/clean`.quiet();
		await Bun.write(join(repoRoot, 'feature.txt'), 'feature\n');
		await $`git -C ${repoRoot} add feature.txt`.quiet();
		await $`git -C ${repoRoot} commit -m "feature"`.quiet();

		const result = await rebaseBranch('feat/clean', 'main', repoRoot);
		expect(result.ok).toBe(true);
		expect(result.conflicts).toBeUndefined();
	});

	test('rebaseBranch detects conflicts', async () => {
		await $`git -C ${repoRoot} checkout -b feat/conflict`.quiet();
		await Bun.write(join(repoRoot, 'README.md'), 'feature version\n');
		await $`git -C ${repoRoot} add README.md`.quiet();
		await $`git -C ${repoRoot} commit -m "feature change"`.quiet();

		await $`git -C ${repoRoot} checkout main`.quiet();
		await Bun.write(join(repoRoot, 'README.md'), 'main version\n');
		await $`git -C ${repoRoot} add README.md`.quiet();
		await $`git -C ${repoRoot} commit -m "main change"`.quiet();

		const result = await rebaseBranch('feat/conflict', 'main', repoRoot);
		expect(result.ok).toBe(false);
		expect(result.conflicts).toBeDefined();
		expect(result.conflicts![0].file).toBe('README.md');
	});
});

// ---------------------------------------------------------------------------
// Conflict resolution — rolling window
// ---------------------------------------------------------------------------

describe('shared/git — autoResolveConflicts rolling window', () => {
	let tempDir: string;
	let repoRoot: string;

	beforeEach(async () => {
		tempDir = await makeTempDir();
		repoRoot = await initRepo(tempDir);
		await setupConflict(repoRoot);
	});

	afterEach(async () => {
		await $`rm -rf ${tempDir}`.nothrow().quiet();
	});

	test('calls makeWindow with a header containing the file name', async () => {
		const { deps, windowHeaders } = makeConflictMockDeps();
		await autoResolveConflicts([{ file: 'README.md' }], repoRoot, deps);
		expect(windowHeaders[0]).toContain('README.md');
	});

	test('wires onChunk to window.update', async () => {
		const { deps, window } = makeConflictMockDeps();
		await autoResolveConflicts([{ file: 'README.md' }], repoRoot, deps);
		expect(window.updateCalls).toContain('chunk-a');
		expect(window.updateCalls).toContain('chunk-b');
	});

	test('clears window after claude call', async () => {
		const { deps, window } = makeConflictMockDeps();
		await autoResolveConflicts([{ file: 'README.md' }], repoRoot, deps);
		expect(window.clearCount).toBe(1);
	});

	test('returns true when resolution succeeds', async () => {
		const { deps } = makeConflictMockDeps();
		const ok = await autoResolveConflicts([{ file: 'README.md' }], repoRoot, deps);
		expect(ok).toBe(true);
	});

	test('returns false when claude returns empty output', async () => {
		const { deps } = makeConflictMockDeps('');
		const ok = await autoResolveConflicts([{ file: 'README.md' }], repoRoot, deps);
		expect(ok).toBe(false);
	});
});

describe('shared/git — resolveConflicts rolling window', () => {
	let tempDir: string;
	let repoRoot: string;

	beforeEach(async () => {
		tempDir = await makeTempDir();
		repoRoot = await initRepo(tempDir);
		await setupConflict(repoRoot);
	});

	afterEach(async () => {
		await $`rm -rf ${tempDir}`.nothrow().quiet();
	});

	test('calls makeWindow with header containing the file name for custom intent', async () => {
		const { deps, windowHeaders } = makeConflictMockDeps();
		await resolveConflicts(
			[{ file: 'README.md' }],
			new Map([['README.md', 'prefer the feature change']]),
			repoRoot,
			deps
		);
		expect(windowHeaders[0]).toContain('README.md');
	});

	test('wires onChunk to window.update for custom intent', async () => {
		const { deps, window } = makeConflictMockDeps();
		await resolveConflicts(
			[{ file: 'README.md' }],
			new Map([['README.md', 'prefer the feature change']]),
			repoRoot,
			deps
		);
		expect(window.updateCalls).toContain('chunk-a');
		expect(window.updateCalls).toContain('chunk-b');
	});

	test('clears window after claude call for custom intent', async () => {
		const { deps, window } = makeConflictMockDeps();
		await resolveConflicts(
			[{ file: 'README.md' }],
			new Map([['README.md', 'prefer the feature change']]),
			repoRoot,
			deps
		);
		expect(window.clearCount).toBe(1);
	});

	test('does not call makeWindow for ours intent', async () => {
		const { deps, windowHeaders } = makeConflictMockDeps();
		await resolveConflicts(
			[{ file: 'README.md' }],
			new Map([['README.md', 'ours']]),
			repoRoot,
			deps
		);
		expect(windowHeaders).toHaveLength(0);
	});

	test('does not call makeWindow for theirs intent', async () => {
		const { deps, windowHeaders } = makeConflictMockDeps();
		await resolveConflicts(
			[{ file: 'README.md' }],
			new Map([['README.md', 'theirs']]),
			repoRoot,
			deps
		);
		expect(windowHeaders).toHaveLength(0);
	});
});
