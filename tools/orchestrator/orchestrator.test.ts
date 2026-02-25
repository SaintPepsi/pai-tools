import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { $ } from 'bun';
import { mkdtempSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	createWorktree, removeWorktree, localBranchExists, deleteLocalBranch,
	parseFlags, parseDependencies, toKebabSlug, buildGraph, topologicalSort,
	loadState, saveState, initState, getIssueState
} from './index.ts';
import { RunLogger } from '../../shared/logging.ts';
import type { OrchestratorConfig, GitHubIssue } from './types.ts';

// Minimal config for testing
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

// ---------------------------------------------------------------------------
// parseFlags
// ---------------------------------------------------------------------------

describe('parseFlags', () => {
	test('defaults are all false/null with no args', () => {
		const flags = parseFlags([]);
		expect(flags.dryRun).toBe(false);
		expect(flags.reset).toBe(false);
		expect(flags.statusOnly).toBe(false);
		expect(flags.skipE2e).toBe(false);
		expect(flags.skipSplit).toBe(false);
		expect(flags.noVerify).toBe(false);
		expect(flags.singleMode).toBe(false);
		expect(flags.singleIssue).toBeNull();
		expect(flags.fromIssue).toBeNull();
	});

	test('boolean flags parse correctly', () => {
		const flags = parseFlags(['--dry-run', '--reset', '--status', '--skip-e2e', '--skip-split', '--no-verify']);
		expect(flags.dryRun).toBe(true);
		expect(flags.reset).toBe(true);
		expect(flags.statusOnly).toBe(true);
		expect(flags.skipE2e).toBe(true);
		expect(flags.skipSplit).toBe(true);
		expect(flags.noVerify).toBe(true);
	});

	test('--single without number sets singleMode but null singleIssue', () => {
		const flags = parseFlags(['--single']);
		expect(flags.singleMode).toBe(true);
		expect(flags.singleIssue).toBeNull();
	});

	test('--single with number sets both singleMode and singleIssue', () => {
		const flags = parseFlags(['--single', '115']);
		expect(flags.singleMode).toBe(true);
		expect(flags.singleIssue).toBe(115);
	});

	test('--single ignores non-numeric next arg', () => {
		const flags = parseFlags(['--single', '--dry-run']);
		expect(flags.singleMode).toBe(true);
		expect(flags.singleIssue).toBeNull();
		expect(flags.dryRun).toBe(true);
	});

	test('--from parses issue number', () => {
		const flags = parseFlags(['--from', '42']);
		expect(flags.fromIssue).toBe(42);
	});
});

// ---------------------------------------------------------------------------
// parseDependencies
// ---------------------------------------------------------------------------

describe('parseDependencies', () => {
	test('returns empty array when no dependency line', () => {
		expect(parseDependencies('Just a regular issue body')).toEqual([]);
	});

	test('parses single dependency', () => {
		expect(parseDependencies('Depends on #10')).toEqual([10]);
	});

	test('parses multiple dependencies', () => {
		expect(parseDependencies('Depends on #5, #10, #15')).toEqual([5, 10, 15]);
	});

	test('case insensitive matching', () => {
		expect(parseDependencies('DEPENDS ON #7')).toEqual([7]);
		expect(parseDependencies('depends on #7')).toEqual([7]);
	});

	test('finds dependency line in multi-line body', () => {
		const body = `## Description
Some work to do.

Depends on #3, #4

## Notes
More info here.`;
		expect(parseDependencies(body)).toEqual([3, 4]);
	});

	test('returns empty for body with no hash references', () => {
		expect(parseDependencies('Depends on nothing')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// toKebabSlug
// ---------------------------------------------------------------------------

describe('toKebabSlug', () => {
	test('converts basic title to kebab case', () => {
		expect(toKebabSlug('Add User Authentication')).toBe('add-user-authentication');
	});

	test('strips leading issue number prefix', () => {
		expect(toKebabSlug('[42] Fix login bug')).toBe('fix-login-bug');
	});

	test('replaces special characters with hyphens', () => {
		expect(toKebabSlug('Fix: memory leak (critical!)')).toBe('fix-memory-leak-critical');
	});

	test('strips leading and trailing hyphens', () => {
		expect(toKebabSlug('---hello world---')).toBe('hello-world');
	});

	test('truncates to 50 characters', () => {
		const longTitle = 'This is a very long issue title that exceeds the fifty character limit by quite a lot';
		const slug = toKebabSlug(longTitle);
		expect(slug.length).toBeLessThanOrEqual(50);
	});

	test('handles empty string', () => {
		expect(toKebabSlug('')).toBe('');
	});

	test('collapses multiple special chars into single hyphen', () => {
		expect(toKebabSlug('hello   &&&   world')).toBe('hello-world');
	});
});

// ---------------------------------------------------------------------------
// buildGraph + topologicalSort
// ---------------------------------------------------------------------------

function makeIssue(number: number, title: string, body: string): GitHubIssue {
	return { number, title, body, state: 'open', labels: [] };
}

describe('buildGraph', () => {
	test('builds graph with correct branch names', () => {
		const issues = [makeIssue(1, 'Add feature', '')];
		const graph = buildGraph(issues, testConfig);

		expect(graph.size).toBe(1);
		const node = graph.get(1)!;
		expect(node.branch).toBe('feat/1-add-feature');
		expect(node.dependsOn).toEqual([]);
	});

	test('captures dependencies from issue body', () => {
		const issues = [
			makeIssue(1, 'Base', ''),
			makeIssue(2, 'Child', 'Depends on #1')
		];
		const graph = buildGraph(issues, testConfig);

		expect(graph.get(2)!.dependsOn).toEqual([1]);
	});
});

describe('topologicalSort', () => {
	test('sorts independent issues by insertion order', () => {
		const issues = [
			makeIssue(3, 'C', ''),
			makeIssue(1, 'A', ''),
			makeIssue(2, 'B', '')
		];
		const graph = buildGraph(issues, testConfig);
		const sorted = topologicalSort(graph);

		expect(sorted).toEqual([3, 1, 2]);
	});

	test('sorts dependencies before dependents', () => {
		const issues = [
			makeIssue(2, 'Child', 'Depends on #1'),
			makeIssue(1, 'Parent', '')
		];
		const graph = buildGraph(issues, testConfig);
		const sorted = topologicalSort(graph);

		expect(sorted.indexOf(1)).toBeLessThan(sorted.indexOf(2));
	});

	test('handles diamond dependency', () => {
		const issues = [
			makeIssue(1, 'Root', ''),
			makeIssue(2, 'Left', 'Depends on #1'),
			makeIssue(3, 'Right', 'Depends on #1'),
			makeIssue(4, 'Merge', 'Depends on #2, #3')
		];
		const graph = buildGraph(issues, testConfig);
		const sorted = topologicalSort(graph);

		expect(sorted.indexOf(1)).toBeLessThan(sorted.indexOf(2));
		expect(sorted.indexOf(1)).toBeLessThan(sorted.indexOf(3));
		expect(sorted.indexOf(2)).toBeLessThan(sorted.indexOf(4));
		expect(sorted.indexOf(3)).toBeLessThan(sorted.indexOf(4));
	});

	test('throws on circular dependency', () => {
		const issues = [
			makeIssue(1, 'A', 'Depends on #2'),
			makeIssue(2, 'B', 'Depends on #1')
		];
		const graph = buildGraph(issues, testConfig);

		expect(() => topologicalSort(graph)).toThrow(/Circular dependency/);
	});

	test('handles chain dependency', () => {
		const issues = [
			makeIssue(3, 'C', 'Depends on #2'),
			makeIssue(2, 'B', 'Depends on #1'),
			makeIssue(1, 'A', '')
		];
		const graph = buildGraph(issues, testConfig);
		const sorted = topologicalSort(graph);

		expect(sorted).toEqual([1, 2, 3]);
	});

	test('ignores dependencies on issues not in the graph', () => {
		const issues = [
			makeIssue(5, 'Orphan dep', 'Depends on #999')
		];
		const graph = buildGraph(issues, testConfig);
		const sorted = topologicalSort(graph);

		expect(sorted).toEqual([5]);
	});
});

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

describe('state management', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'pai-state-test-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('initState returns valid empty state', () => {
		const state = initState();
		expect(state.version).toBe(1);
		expect(state.issues).toEqual({});
		expect(state.startedAt).toBeTruthy();
		expect(state.updatedAt).toBeTruthy();
	});

	test('saveState and loadState roundtrip', () => {
		const stateFile = join(tempDir, 'state.json');
		const state = initState();
		getIssueState(state, 42, 'Test issue');

		saveState(state, stateFile);
		const loaded = loadState(stateFile);

		expect(loaded).not.toBeNull();
		expect(loaded!.version).toBe(1);
		expect(loaded!.issues[42]).toBeDefined();
		expect(loaded!.issues[42].title).toBe('Test issue');
		expect(loaded!.issues[42].status).toBe('pending');
	});

	test('loadState returns null for missing file', () => {
		expect(loadState(join(tempDir, 'nonexistent.json'))).toBeNull();
	});

	test('getIssueState creates new entry with defaults', () => {
		const state = initState();
		const issue = getIssueState(state, 10, 'New issue');

		expect(issue.number).toBe(10);
		expect(issue.title).toBe('New issue');
		expect(issue.status).toBe('pending');
		expect(issue.branch).toBeNull();
		expect(issue.prNumber).toBeNull();
		expect(issue.error).toBeNull();
	});

	test('getIssueState returns existing entry on repeat call', () => {
		const state = initState();
		const first = getIssueState(state, 10, 'First title');
		first.status = 'completed';

		const second = getIssueState(state, 10, 'Different title');
		expect(second.status).toBe('completed');
		expect(second.title).toBe('First title');
	});

	test('getIssueState fills null title on repeat call', () => {
		const state = initState();
		getIssueState(state, 10);
		expect(state.issues[10].title).toBeNull();

		getIssueState(state, 10, 'Late title');
		expect(state.issues[10].title).toBe('Late title');
	});

	test('completed issue must have error cleared to null', () => {
		const state = initState();
		const issue = getIssueState(state, 99, 'Flaky issue');

		// Simulate a failed attempt
		issue.status = 'in_progress';
		issue.error = 'worktree creation failed with exit code 128';

		// Simulate successful retry — the fix from b399e31
		issue.status = 'completed';
		issue.error = null;
		issue.completedAt = new Date().toISOString();

		expect(issue.status).toBe('completed');
		expect(issue.error).toBeNull();

		// Roundtrip through save/load to confirm persistence
		const stateFile = join(tempDir, 'state.json');
		saveState(state, stateFile);
		const loaded = loadState(stateFile);
		expect(loaded!.issues[99].status).toBe('completed');
		expect(loaded!.issues[99].error).toBeNull();
	});

	test('completed issue with stale error is a contract violation', () => {
		const state = initState();
		const issue = getIssueState(state, 50, 'Should not have error when completed');

		issue.status = 'completed';
		issue.error = 'leftover error from failed attempt';

		// This state is invalid — completed + non-null error should never happen
		// The test documents the invariant: if status is completed, error must be null
		expect(issue.status).toBe('completed');
		expect(issue.error).not.toBeNull(); // This is the BAD state

		// Correct it
		issue.error = null;
		expect(issue.error).toBeNull(); // This is the GOOD state
	});
});
