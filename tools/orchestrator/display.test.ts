import { describe, test, expect } from 'bun:test';
import {
	printParallelPlan,
	printExecutionPlan,
	printStatus,
	defaultDisplayDeps,
	type DisplayDeps,
} from './display.ts';
import type { DependencyNode, OrchestratorState, IssueState } from './types.ts';
import type { GitHubIssue } from '../../shared/github.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(): { lines: string[]; deps: DisplayDeps } {
	const lines: string[] = [];
	return { lines, deps: { log: (...args: unknown[]) => lines.push(args.join(' ')) } };
}

function makeIssue(num: number, title: string): GitHubIssue {
	return { number: num, title, body: '', labels: [], author: 'user' };
}

function makeNode(num: number, title: string, dependsOn: number[], branch: string): DependencyNode {
	return { issue: makeIssue(num, title), dependsOn, branch };
}

function makeIssueState(overrides: Partial<IssueState> & { number: number }): IssueState {
	return {
		title: null,
		status: 'pending',
		branch: null,
		baseBranch: null,
		prNumber: null,
		error: null,
		completedAt: null,
		subIssues: null,
		...overrides,
	};
}

function makeState(issueList: IssueState[]): OrchestratorState {
	const issues: Record<number, IssueState> = {};
	for (const i of issueList) issues[i.number] = i;
	return { version: 1, startedAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T01:00:00Z', issues };
}

// ---------------------------------------------------------------------------
// printParallelPlan
// ---------------------------------------------------------------------------

describe('printParallelPlan', () => {
	test('single tier no deps', () => {
		const { lines, deps } = makeDeps();
		const graph = new Map<number, DependencyNode>([
			[1, makeNode(1, 'Issue one', [], 'feat/1')],
		]);
		// parallelN=2, tier has 1 issue → Math.min(1,2)=1 concurrent
		printParallelPlan([[1]], graph, 2, deps);

		expect(lines.some((l) => l.includes('Tier 0'))).toBe(true);
		expect(lines.some((l) => l.includes('1 concurrent'))).toBe(true);
		expect(lines.some((l) => l.includes('#1 Issue one'))).toBe(true);
		expect(lines.some((l) => l.includes('no deps'))).toBe(true);
		expect(lines.some((l) => l.includes('Total: 1 issues across 1 tier'))).toBe(true);
	});

	test('multiple tiers with deps and afterLabel', () => {
		const { lines, deps } = makeDeps();
		const graph = new Map<number, DependencyNode>([
			[1, makeNode(1, 'First', [], 'feat/1')],
			[2, makeNode(2, 'Second', [1], 'feat/2')],
		]);
		printParallelPlan([[1], [2]], graph, 3, deps);

		expect(lines.some((l) => l.includes('Tier 0') && !l.includes('after'))).toBe(true);
		expect(lines.some((l) => l.includes('Tier 1') && l.includes('after tier 0'))).toBe(true);
		expect(lines.some((l) => l.includes('#2 Second') && l.includes('deps: #1'))).toBe(true);
		expect(lines.some((l) => l.includes('Total: 2 issues across 2 tier'))).toBe(true);
	});

	test('node missing from graph is skipped gracefully', () => {
		const { lines, deps } = makeDeps();
		const graph = new Map<number, DependencyNode>(); // empty — node 99 missing
		printParallelPlan([[99]], graph, 1, deps);
		// Should still print Tier line and Total
		expect(lines.some((l) => l.includes('Tier 0'))).toBe(true);
		expect(lines.some((l) => l.includes('Total: 1 issues'))).toBe(true);
	});

	test('concurrent capped at parallelN when tier is larger', () => {
		const { lines, deps } = makeDeps();
		const graph = new Map<number, DependencyNode>([
			[1, makeNode(1, 'A', [], 'feat/1')],
			[2, makeNode(2, 'B', [], 'feat/2')],
			[3, makeNode(3, 'C', [], 'feat/3')],
		]);
		printParallelPlan([[1, 2, 3]], graph, 2, deps);
		expect(lines.some((l) => l.includes('2 concurrent'))).toBe(true);
	});

	test('multiple deps listed', () => {
		const { lines, deps } = makeDeps();
		const graph = new Map<number, DependencyNode>([
			[5, makeNode(5, 'Multi', [1, 2, 3], 'feat/5')],
		]);
		printParallelPlan([[5]], graph, 1, deps);
		expect(lines.some((l) => l.includes('deps: #1, #2, #3'))).toBe(true);
	});

	test('defaultDisplayDeps exports console.log', () => {
		expect(typeof defaultDisplayDeps.log).toBe('function');
	});
});

// ---------------------------------------------------------------------------
// printExecutionPlan
// ---------------------------------------------------------------------------

describe('printExecutionPlan', () => {
	test('single issue no deps uses baseBranch default', () => {
		const { lines, deps } = makeDeps();
		const graph = new Map<number, DependencyNode>([
			[1, makeNode(1, 'Solo issue', [], 'feat/1')],
		]);
		printExecutionPlan([1], graph, 'master', deps);

		expect(lines.some((l) => l.includes('#1 Solo issue'))).toBe(true);
		expect(lines.some((l) => l.includes('branches from master'))).toBe(true);
		expect(lines.some((l) => l.includes('Total: 1 issues'))).toBe(true);
	});

	test('issue with deps shows dep list not baseBranch', () => {
		const { lines, deps } = makeDeps();
		const graph = new Map<number, DependencyNode>([
			[2, makeNode(2, 'Dependent', [1], 'feat/2')],
		]);
		printExecutionPlan([2], graph, 'main', deps);

		expect(lines.some((l) => l.includes('deps: #1'))).toBe(true);
		expect(lines.every((l) => !l.includes('branches from'))).toBe(true);
	});

	test('multiple issues are padded and ordered', () => {
		const { lines, deps } = makeDeps();
		const graph = new Map<number, DependencyNode>([
			[10, makeNode(10, 'Tenth', [], 'feat/10')],
			[11, makeNode(11, 'Eleventh', [10], 'feat/11')],
		]);
		printExecutionPlan([10, 11], graph, 'main', deps);

		expect(lines.some((l) => l.includes(' 1.') && l.includes('#10'))).toBe(true);
		expect(lines.some((l) => l.includes(' 2.') && l.includes('#11'))).toBe(true);
		expect(lines.some((l) => l.includes('Total: 2 issues'))).toBe(true);
	});

	test('node missing from graph is skipped gracefully', () => {
		const { lines, deps } = makeDeps();
		const graph = new Map<number, DependencyNode>();
		printExecutionPlan([42], graph, 'main', deps);
		expect(lines.some((l) => l.includes('Total: 1 issues'))).toBe(true);
	});

	test('custom baseBranch appears in no-deps label', () => {
		const { lines, deps } = makeDeps();
		const graph = new Map<number, DependencyNode>([
			[3, makeNode(3, 'Branch test', [], 'feat/3')],
		]);
		printExecutionPlan([3], graph, 'develop', deps);
		expect(lines.some((l) => l.includes('branches from develop'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// printStatus
// ---------------------------------------------------------------------------

describe('printStatus', () => {
	test('completed entry shows checkmark icon', () => {
		const { lines, deps } = makeDeps();
		const state = makeState([makeIssueState({ number: 1, status: 'completed', title: 'Done' })]);
		printStatus(state, deps);
		expect(lines.some((l) => l.includes('✓') && l.includes('#1'))).toBe(true);
	});

	test('failed entry shows cross icon', () => {
		const { lines, deps } = makeDeps();
		const state = makeState([makeIssueState({ number: 2, status: 'failed', title: 'Broke' })]);
		printStatus(state, deps);
		expect(lines.some((l) => l.includes('✗') && l.includes('#2'))).toBe(true);
	});

	test('split entry shows split icon', () => {
		const { lines, deps } = makeDeps();
		const state = makeState([makeIssueState({ number: 3, status: 'split', title: 'Split' })]);
		printStatus(state, deps);
		expect(lines.some((l) => l.includes('↔') && l.includes('#3'))).toBe(true);
	});

	test('blocked entry shows blocked icon', () => {
		const { lines, deps } = makeDeps();
		const state = makeState([makeIssueState({ number: 4, status: 'blocked', title: 'Blocked' })]);
		printStatus(state, deps);
		expect(lines.some((l) => l.includes('⊘') && l.includes('#4'))).toBe(true);
	});

	test('pending entry shows dim circle icon', () => {
		const { lines, deps } = makeDeps();
		const state = makeState([makeIssueState({ number: 5, status: 'pending', title: 'Waiting' })]);
		printStatus(state, deps);
		expect(lines.some((l) => l.includes('○') && l.includes('#5'))).toBe(true);
	});

	test('blocked count appears in progress line', () => {
		const { lines, deps } = makeDeps();
		const state = makeState([
			makeIssueState({ number: 1, status: 'completed' }),
			makeIssueState({ number: 2, status: 'blocked' }),
			makeIssueState({ number: 3, status: 'pending' }),
		]);
		printStatus(state, deps);
		expect(lines.some((l) => l.includes('1 blocked'))).toBe(true);
	});

	test('no blocked issues omits blocked label', () => {
		const { lines, deps } = makeDeps();
		const state = makeState([
			makeIssueState({ number: 1, status: 'completed' }),
			makeIssueState({ number: 2, status: 'pending' }),
		]);
		printStatus(state, deps);
		expect(lines.every((l) => !l.includes('blocked'))).toBe(true);
	});

	test('PR number shown in output', () => {
		const { lines, deps } = makeDeps();
		const state = makeState([makeIssueState({ number: 7, status: 'completed', prNumber: 99 })]);
		printStatus(state, deps);
		expect(lines.some((l) => l.includes('PR #99'))).toBe(true);
	});

	test('error message shown when present', () => {
		const { lines, deps } = makeDeps();
		const state = makeState([makeIssueState({ number: 8, status: 'failed', error: 'build broke' })]);
		printStatus(state, deps);
		expect(lines.some((l) => l.includes('build broke'))).toBe(true);
	});

	test('null title omits title in output', () => {
		const { lines, deps } = makeDeps();
		const state = makeState([makeIssueState({ number: 9, status: 'pending', title: null })]);
		printStatus(state, deps);
		// Line should have #9 [pending] but no extra space-title segment
		expect(lines.some((l) => l.includes('#9') && l.includes('[pending]'))).toBe(true);
	});

	test('entries sorted by issue number', () => {
		const { lines, deps } = makeDeps();
		const state = makeState([
			makeIssueState({ number: 30, status: 'pending' }),
			makeIssueState({ number: 10, status: 'pending' }),
			makeIssueState({ number: 20, status: 'pending' }),
		]);
		printStatus(state, deps);
		const issueLines = lines.filter((l) => l.includes('[pending]'));
		expect(issueLines[0]).toContain('#10');
		expect(issueLines[1]).toContain('#20');
		expect(issueLines[2]).toContain('#30');
	});

	test('startedAt and updatedAt printed', () => {
		const { lines, deps } = makeDeps();
		const state = makeState([]);
		printStatus(state, deps);
		expect(lines.some((l) => l.includes('Started:') && l.includes('2024-01-01T00:00:00Z'))).toBe(true);
		expect(lines.some((l) => l.includes('Updated:') && l.includes('2024-01-01T01:00:00Z'))).toBe(true);
	});
});
