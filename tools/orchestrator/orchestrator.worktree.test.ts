import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { $ } from 'bun';
import { mkdtempSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorktree, removeWorktree, localBranchExists, deleteLocalBranch } from '../../shared/git.ts';
import { RunLogger } from '../../shared/logging.ts';
import type { OrchestratorConfig } from './types.ts';

const testConfig: OrchestratorConfig = {
	branchPrefix: 'feat/',
	baseBranch: 'main',
	worktreeDir: '.pait/worktrees',
	models: { implement: 'sonnet', assess: 'haiku' },
	retries: { implement: 1, verify: 1 },
	allowedTools: 'Bash Edit Write Read',
	verify: []
};

describe('worktree management', () => {
	let tempDir: string;
	let repoRoot: string;
	let logger: RunLogger;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), 'pai-wt-test-'));
		repoRoot = join(tempDir, 'repo');
		mkdirSync(repoRoot);

		// Initialize a real git repo with an initial commit
		await $`git -C ${repoRoot} init`.quiet();
		await $`git -C ${repoRoot} checkout -b main`.quiet();
		await $`git -C ${repoRoot} commit --allow-empty -m "initial"`.quiet();

		logger = new RunLogger(tempDir);
	});

	afterEach(async () => {
		// Clean up any worktrees first
		await $`git -C ${repoRoot} worktree prune`.quiet().catch(() => {});
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('createWorktree creates directory and branch from base', async () => {
		const result = await createWorktree(
			'feat/1-test-feature',
			[],
			{ ...testConfig, worktreeDir: join(tempDir, 'worktrees') },
			repoRoot,
			logger,
			1
		);

		expect(result.ok).toBe(true);
		expect(result.baseBranch).toBe('main');
		expect(existsSync(result.worktreePath)).toBe(true);

		// Branch should exist
		expect(await localBranchExists('feat/1-test-feature', repoRoot)).toBe(true);

		// Clean up
		await removeWorktree(result.worktreePath, 'feat/1-test-feature', repoRoot, logger, 1);
	});

	test('createWorktree deletes stale branch before creating fresh', async () => {
		// Create a branch manually (simulating leftover from previous run)
		await $`git -C ${repoRoot} branch feat/2-stale-branch`.quiet();
		expect(await localBranchExists('feat/2-stale-branch', repoRoot)).toBe(true);

		const result = await createWorktree(
			'feat/2-stale-branch',
			[],
			{ ...testConfig, worktreeDir: join(tempDir, 'worktrees') },
			repoRoot,
			logger,
			2
		);

		expect(result.ok).toBe(true);
		expect(existsSync(result.worktreePath)).toBe(true);

		// Clean up
		await removeWorktree(result.worktreePath, 'feat/2-stale-branch', repoRoot, logger, 2);
	});

	test('removeWorktree cleans up directory', async () => {
		const result = await createWorktree(
			'feat/3-cleanup-test',
			[],
			{ ...testConfig, worktreeDir: join(tempDir, 'worktrees') },
			repoRoot,
			logger,
			3
		);

		expect(result.ok).toBe(true);
		expect(existsSync(result.worktreePath)).toBe(true);

		await removeWorktree(result.worktreePath, 'feat/3-cleanup-test', repoRoot, logger, 3);

		expect(existsSync(result.worktreePath)).toBe(false);
	});

	test('createWorktree cleans up leftover worktree directory', async () => {
		const wtDir = join(tempDir, 'worktrees');

		// First creation
		const result1 = await createWorktree(
			'feat/4-rerun',
			[],
			{ ...testConfig, worktreeDir: wtDir },
			repoRoot,
			logger,
			4
		);
		expect(result1.ok).toBe(true);

		// Remove worktree but simulate a partial cleanup (remove git tracking but leave dir)
		await removeWorktree(result1.worktreePath, 'feat/4-rerun', repoRoot, logger, 4);

		// Second creation — should succeed even if artifacts exist
		const result2 = await createWorktree(
			'feat/4-rerun',
			[],
			{ ...testConfig, worktreeDir: wtDir },
			repoRoot,
			logger,
			4
		);
		expect(result2.ok).toBe(true);
		expect(existsSync(result2.worktreePath)).toBe(true);

		// Clean up
		await removeWorktree(result2.worktreePath, 'feat/4-rerun', repoRoot, logger, 4);
	});

	test('createWorktree bases on dependency branch when provided', async () => {
		// Create a dep branch with a commit
		await $`git -C ${repoRoot} checkout -b feat/dep-branch`.quiet();
		await $`git -C ${repoRoot} commit --allow-empty -m "dep work"`.quiet();
		await $`git -C ${repoRoot} checkout main`.quiet();

		const result = await createWorktree(
			'feat/5-depends-on-dep',
			['feat/dep-branch'],
			{ ...testConfig, worktreeDir: join(tempDir, 'worktrees') },
			repoRoot,
			logger,
			5
		);

		expect(result.ok).toBe(true);
		expect(result.baseBranch).toBe('feat/dep-branch');

		// The worktree branch should contain the dep branch's commit
		const log = await $`git -C ${result.worktreePath} log --oneline`.text();
		expect(log).toContain('dep work');

		await removeWorktree(result.worktreePath, 'feat/5-depends-on-dep', repoRoot, logger, 5);
	});

	test('deleteLocalBranch removes existing branch', async () => {
		await $`git -C ${repoRoot} branch test-delete-me`.quiet();
		expect(await localBranchExists('test-delete-me', repoRoot)).toBe(true);

		await deleteLocalBranch('test-delete-me', repoRoot);
		expect(await localBranchExists('test-delete-me', repoRoot)).toBe(false);
	});

	test('deleteLocalBranch is safe when branch does not exist', async () => {
		// Should not throw
		await deleteLocalBranch('nonexistent-branch', repoRoot);
		expect(await localBranchExists('nonexistent-branch', repoRoot)).toBe(false);
	});
});
