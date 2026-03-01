import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { $ } from 'bun';
import {
	localBranchExists,
	deleteLocalBranch,
	detectConflicts,
	rebaseBranch
} from './git.ts';

describe('shared/git — branch operations', () => {
	let repoRoot: string;
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = (await $`mktemp -d`.text()).trim();
		repoRoot = `${tmpDir}/repo`;
		await $`mkdir -p ${repoRoot}`.quiet();
		await $`git -C ${repoRoot} init`.quiet();
		await $`git -C ${repoRoot} checkout -b main`.quiet();
		await $`git -C ${repoRoot} commit --allow-empty -m "initial"`.quiet();
	});

	afterEach(async () => {
		await $`rm -rf ${tmpDir}`.quiet();
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

describe('shared/git — rebase operations', () => {
	let repoRoot: string;
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = (await $`mktemp -d`.text()).trim();
		repoRoot = `${tmpDir}/repo`;
		await $`mkdir -p ${repoRoot}`.quiet();
		await $`git -C ${repoRoot} init`.quiet();
		await $`git -C ${repoRoot} checkout -b main`.quiet();
		await Bun.write(`${repoRoot}/README.md`, 'initial\n');
		await $`git -C ${repoRoot} add README.md`.quiet();
		await $`git -C ${repoRoot} commit -m "initial"`.quiet();
	});

	afterEach(async () => {
		await $`rm -rf ${tmpDir}`.quiet();
	});

	test('detectConflicts returns empty array when no conflicts', async () => {
		const result = await detectConflicts(repoRoot);
		expect(result).toEqual([]);
	});

	test('rebaseBranch succeeds with no divergence', async () => {
		await $`git -C ${repoRoot} checkout -b feat/clean`.quiet();
		await Bun.write(`${repoRoot}/feature.txt`, 'feature\n');
		await $`git -C ${repoRoot} add feature.txt`.quiet();
		await $`git -C ${repoRoot} commit -m "feature"`.quiet();

		const result = await rebaseBranch('feat/clean', 'main', repoRoot);
		expect(result.ok).toBe(true);
		expect(result.conflicts).toBeUndefined();
	});

	test('rebaseBranch detects conflicts', async () => {
		await $`git -C ${repoRoot} checkout -b feat/conflict`.quiet();
		await Bun.write(`${repoRoot}/README.md`, 'feature version\n');
		await $`git -C ${repoRoot} add README.md`.quiet();
		await $`git -C ${repoRoot} commit -m "feature change"`.quiet();

		await $`git -C ${repoRoot} checkout main`.quiet();
		await Bun.write(`${repoRoot}/README.md`, 'main version\n');
		await $`git -C ${repoRoot} add README.md`.quiet();
		await $`git -C ${repoRoot} commit -m "main change"`.quiet();

		const result = await rebaseBranch('feat/conflict', 'main', repoRoot);
		expect(result.ok).toBe(false);
		expect(result.conflicts).toBeDefined();
		expect(result.conflicts![0].file).toBe('README.md');
	});
});
