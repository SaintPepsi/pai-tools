import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { $ } from 'bun';
import { defaultFsAdapter } from '@shared/adapters/fs.ts';
import { rebaseBranch, detectConflicts } from '@shared/git.ts';

describe('git operations', () => {
	let tempDir: string;
	let repoRoot: string;

	beforeEach(async () => {
		tempDir = (await $`mktemp -d`.text()).trim();
		repoRoot = join(tempDir, 'repo');
		defaultFsAdapter.mkdirp(repoRoot);

		// Initialize a real git repo with an initial commit
		await $`git -C ${repoRoot} init`.quiet();
		await $`git -C ${repoRoot} checkout -b main`.quiet();
		defaultFsAdapter.writeFile(join(repoRoot, 'README.md'), 'initial\n');
		await $`git -C ${repoRoot} add README.md`.quiet();
		await $`git -C ${repoRoot} commit -m "initial"`.quiet();
	});

	afterEach(() => {
		defaultFsAdapter.rmrf(tempDir);
	});

	test('rebaseBranch: clean rebase succeeds', async () => {
		// Create a feature branch with a commit
		await $`git -C ${repoRoot} checkout -b feat/1-test`.quiet();
		defaultFsAdapter.writeFile(join(repoRoot, 'feature.txt'), 'feature\n');
		await $`git -C ${repoRoot} add feature.txt`.quiet();
		await $`git -C ${repoRoot} commit -m "add feature"`.quiet();

		// Add a non-conflicting commit to main
		await $`git -C ${repoRoot} checkout main`.quiet();
		defaultFsAdapter.writeFile(join(repoRoot, 'other.txt'), 'other\n');
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
		defaultFsAdapter.writeFile(join(repoRoot, 'README.md'), 'feature version\n');
		await $`git -C ${repoRoot} add README.md`.quiet();
		await $`git -C ${repoRoot} commit -m "feature change"`.quiet();

		// Add a conflicting commit to main
		await $`git -C ${repoRoot} checkout main`.quiet();
		defaultFsAdapter.writeFile(join(repoRoot, 'README.md'), 'main version\n');
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
		defaultFsAdapter.writeFile(join(repoRoot, 'feature.txt'), 'feature\n');
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
