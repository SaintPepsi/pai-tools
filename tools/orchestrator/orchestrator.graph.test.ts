import { describe, test, expect } from 'bun:test';
import { buildGraph, topologicalSort } from './dependency-graph.ts';
import type { GitHubIssue, OrchestratorConfig } from './types.ts';

const testConfig: OrchestratorConfig = {
	branchPrefix: 'feat/',
	baseBranch: 'main',
	worktreeDir: '.pait/worktrees',
	models: { implement: 'sonnet', assess: 'haiku' },
	retries: { implement: 1, verify: 1 },
	allowedTools: 'Bash Edit Write Read',
	verify: []
};

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
