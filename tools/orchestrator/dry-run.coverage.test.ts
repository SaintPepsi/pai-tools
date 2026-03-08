/**
 * Coverage tests for tools/orchestrator/dry-run.ts
 *
 * Uses mock DryRunDeps and controlled state/config/flags to exercise
 * every branch in runDryRun without real Claude CLI invocations.
 */

import { describe, test, expect } from 'bun:test';
import { runDryRun, type DryRunDeps } from '@tools/orchestrator/dry-run.ts';
import type { OrchestratorState, OrchestratorConfig, OrchestratorFlags, DependencyNode } from '@tools/orchestrator/types.ts';
import type { AssessSizeResult } from '@tools/orchestrator/agent-runner.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
	return {
		branchPrefix: 'feat/',
		baseBranch: 'main',
		worktreeDir: '.worktrees',
		models: { implement: 'claude-opus-4-6', assess: 'claude-opus-4-6' },
		retries: { implement: 2, verify: 2 },
		allowedTools: 'all',
		verify: [],
		e2e: undefined,
		...overrides,
	};
}

function makeFlags(overrides: Partial<OrchestratorFlags> = {}): OrchestratorFlags {
	return {
		dryRun: true,
		reset: false,
		statusOnly: false,
		skipE2e: false,
		skipSplit: false,
		noVerify: false,
		singleMode: false,
		singleIssue: null,
		fromIssue: null,
		parallel: 1,
		file: null,
		...overrides,
	};
}

function makeState(issues: OrchestratorState['issues'] = {}): OrchestratorState {
	return { version: 1, startedAt: '', updatedAt: '', issues };
}

function makeNode(num: number, title: string, dependsOn: number[] = []): DependencyNode {
	return {
		issue: { number: num, title, body: 'body text', state: 'open', labels: [] },
		dependsOn,
		branch: `feat/${num}-issue`,
	};
}

function makeGraph(nodes: DependencyNode[]): Map<number, DependencyNode> {
	const map = new Map<number, DependencyNode>();
	for (const n of nodes) map.set(n.issue.number, n);
	return map;
}

function makeNoSplitAssessment(reasoning = 'Small issue'): AssessSizeResult {
	return { shouldSplit: false, proposedSplits: [], reasoning };
}

function makeSplitAssessment(splits: { title: string; body: string }[]): AssessSizeResult {
	return { shouldSplit: true, proposedSplits: splits, reasoning: 'Too large' };
}

// ---------------------------------------------------------------------------
// Mock deps factory
// ---------------------------------------------------------------------------

function mockLog() {
	const noop = (..._args: unknown[]) => {};
	return { step: noop, info: noop, ok: noop, warn: noop, error: noop, dim: noop } as DryRunDeps['log'];
}

function makeDeps(assessFn?: DryRunDeps['assessIssueSize']): DryRunDeps {
	return {
		log: mockLog(),
		consolelog: () => {},
		exit: ((code: number) => { throw new Error(`process.exit(${code})`); }) as (code: number) => never,
		assessIssueSize: assessFn ?? (async () => makeNoSplitAssessment()),
	};
}

function makeCountingAssessFn(result: AssessSizeResult = makeNoSplitAssessment()): { fn: DryRunDeps['assessIssueSize']; calls: number[] } {
	const tracker = { fn: null as unknown as DryRunDeps['assessIssueSize'], calls: [] as number[] };
	tracker.fn = (async (...args: unknown[]) => {
		tracker.calls.push(1);
		return result;
	}) as DryRunDeps['assessIssueSize'];
	return tracker;
}

// ---------------------------------------------------------------------------
// runDryRun — full range mode (singleMode: false)
// ---------------------------------------------------------------------------

describe('runDryRun — full range (singleMode false)', () => {
	test('runs over all issues and prints summary', async () => {
		const tracker = makeCountingAssessFn();
		const deps = makeDeps(tracker.fn);
		const graph = makeGraph([makeNode(1, 'Issue One'), makeNode(2, 'Issue Two')]);
		const state = makeState();
		const config = makeConfig();
		const flags = makeFlags();

		await runDryRun([1, 2], graph, state, config, flags, '/repo', deps);

		expect(tracker.calls.length).toBe(2);
	});

	test('skips already-completed issues', async () => {
		const tracker = makeCountingAssessFn();
		const deps = makeDeps(tracker.fn);
		const graph = makeGraph([makeNode(1, 'Done Issue'), makeNode(2, 'Pending Issue')]);
		const state = makeState({
			1: { number: 1, title: 'Done Issue', status: 'completed', branch: null, baseBranch: null, prNumber: null, error: null, completedAt: null, subIssues: null },
		});
		const flags = makeFlags();

		await runDryRun([1, 2], graph, state, makeConfig(), flags, '/repo', deps);

		// assessIssueSize should only be called for issue 2 (issue 1 is completed)
		expect(tracker.calls.length).toBe(1);
	});

	test('continues when graph node is missing for an issue', async () => {
		const tracker = makeCountingAssessFn();
		const deps = makeDeps(tracker.fn);
		// graph only has node for issue 2, not issue 1
		const graph = makeGraph([makeNode(2, 'Issue Two')]);
		const state = makeState();
		const flags = makeFlags();

		// Should not throw; issue 1 is skipped because graph.get(1) returns undefined
		await runDryRun([1, 2], graph, state, makeConfig(), flags, '/repo', deps);

		expect(tracker.calls.length).toBe(1);
	});

	test('shows split assessment when shouldSplit is true', async () => {
		const splits = [{ title: 'Sub A', body: 'body A' }, { title: 'Sub B', body: 'body B' }];
		const tracker = makeCountingAssessFn(makeSplitAssessment(splits));
		const deps = makeDeps(tracker.fn);
		const graph = makeGraph([makeNode(1, 'Big Issue')]);
		const state = makeState();

		// Should complete without error even when split is recommended
		await runDryRun([1], graph, state, makeConfig(), makeFlags(), '/repo', deps);

		expect(tracker.calls.length).toBe(1);
	});

	test('shows verify step names in summary', async () => {
		const tracker = makeCountingAssessFn();
		const deps = makeDeps(tracker.fn);
		const config = makeConfig({
			verify: [{ name: 'typecheck', cmd: 'bun tsc' }, { name: 'test', cmd: 'bun test' }],
		});
		const graph = makeGraph([makeNode(1, 'Issue One')]);
		const state = makeState();

		await runDryRun([1], graph, state, config, makeFlags(), '/repo', deps);

		expect(tracker.calls.length).toBe(1);
	});

	test('shows e2e label when e2e configured and skipE2e is false', async () => {
		const tracker = makeCountingAssessFn();
		const deps = makeDeps(tracker.fn);
		const config = makeConfig({
			verify: [],
			e2e: { run: 'bun e2e', update: 'bun e2e --update', snapshotGlob: '**/*.snap' },
		});
		const graph = makeGraph([makeNode(1, 'Issue One')]);
		const state = makeState();
		const flags = makeFlags({ skipE2e: false });

		await runDryRun([1], graph, state, config, flags, '/repo', deps);
	});

	test('omits e2e label when skipE2e is true', async () => {
		const tracker = makeCountingAssessFn();
		const deps = makeDeps(tracker.fn);
		const config = makeConfig({
			e2e: { run: 'bun e2e', update: 'bun e2e --update', snapshotGlob: '**/*.snap' },
		});
		const graph = makeGraph([makeNode(1, 'Issue One')]);
		const state = makeState();
		const flags = makeFlags({ skipE2e: true });

		await runDryRun([1], graph, state, config, flags, '/repo', deps);
	});

	test('shows dep branches when issue depends on others', async () => {
		const tracker = makeCountingAssessFn();
		const deps = makeDeps(tracker.fn);
		const graph = makeGraph([makeNode(2, 'Dependent Issue', [1])]);
		const state = makeState();

		await runDryRun([2], graph, state, makeConfig(), makeFlags(), '/repo', deps);

		expect(tracker.calls.length).toBe(1);
	});

	test('skips assessment when skipSplit flag is set', async () => {
		const tracker = makeCountingAssessFn();
		const deps = makeDeps(tracker.fn);
		const graph = makeGraph([makeNode(1, 'Issue One')]);
		const state = makeState();
		const flags = makeFlags({ skipSplit: true });

		await runDryRun([1], graph, state, makeConfig(), flags, '/repo', deps);

		expect(tracker.calls.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// runDryRun — singleMode with singleIssue specified
// ---------------------------------------------------------------------------

describe('runDryRun — singleMode with explicit singleIssue', () => {
	test('processes only the specified single issue', async () => {
		const tracker = makeCountingAssessFn();
		const deps = makeDeps(tracker.fn);
		const graph = makeGraph([makeNode(1, 'Issue One'), makeNode(2, 'Issue Two'), makeNode(3, 'Issue Three')]);
		const state = makeState();
		const flags = makeFlags({ singleMode: true, singleIssue: 2 });

		await runDryRun([1, 2, 3], graph, state, makeConfig(), flags, '/repo', deps);

		// Only issue 2 should be assessed
		expect(tracker.calls.length).toBe(1);
	});

	test('exits with error when singleIssue not found in execution order', async () => {
		const deps = makeDeps();
		const graph = makeGraph([makeNode(1, 'Issue One')]);
		const state = makeState();
		const flags = makeFlags({ singleMode: true, singleIssue: 99 });

		await expect(
			runDryRun([1], graph, state, makeConfig(), flags, '/repo', deps)
		).rejects.toThrow('process.exit(1)');
	});
});

// ---------------------------------------------------------------------------
// runDryRun — singleMode without explicit singleIssue (find next pending)
// ---------------------------------------------------------------------------

describe('runDryRun — singleMode finding next pending issue', () => {
	test('processes first non-completed issue when singleIssue is null', async () => {
		const tracker = makeCountingAssessFn();
		const deps = makeDeps(tracker.fn);
		const graph = makeGraph([makeNode(1, 'Done'), makeNode(2, 'Pending')]);
		const state = makeState({
			1: { number: 1, title: 'Done', status: 'completed', branch: null, baseBranch: null, prNumber: null, error: null, completedAt: null, subIssues: null },
		});
		const flags = makeFlags({ singleMode: true, singleIssue: null });

		await runDryRun([1, 2], graph, state, makeConfig(), flags, '/repo', deps);

		// Only issue 2 (first non-completed) should be assessed
		expect(tracker.calls.length).toBe(1);
	});

	test('processes first issue when all issues are pending (no state)', async () => {
		const tracker = makeCountingAssessFn();
		const deps = makeDeps(tracker.fn);
		const graph = makeGraph([makeNode(1, 'Issue One'), makeNode(2, 'Issue Two')]);
		const state = makeState();
		const flags = makeFlags({ singleMode: true, singleIssue: null });

		await runDryRun([1, 2], graph, state, makeConfig(), flags, '/repo', deps);

		// Only issue 1 (first pending) should be assessed
		expect(tracker.calls.length).toBe(1);
	});
});
