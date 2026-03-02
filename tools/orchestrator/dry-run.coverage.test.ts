/**
 * Coverage tests for tools/orchestrator/dry-run.ts
 *
 * Uses mock AgentRunnerDeps and controlled state/config/flags to exercise
 * every branch in runDryRun without real Claude CLI invocations.
 */

import { describe, test, expect, spyOn, mock } from 'bun:test';
import type { OrchestratorState, OrchestratorConfig, OrchestratorFlags, DependencyNode } from './types.ts';
import type { AssessSizeResult } from './agent-runner.ts';

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
// Module-level mock for assessIssueSize
// ---------------------------------------------------------------------------

// We mock the agent-runner module so runDryRun never calls Claude.
const agentRunner = await import('./agent-runner.ts');

// ---------------------------------------------------------------------------
// runDryRun — full range mode (singleMode: false)
// ---------------------------------------------------------------------------

describe('runDryRun — full range (singleMode false)', () => {
	test('runs over all issues and prints summary', async () => {
		const spy = spyOn(agentRunner, 'assessIssueSize').mockResolvedValue(makeNoSplitAssessment());

		const { runDryRun } = await import('./dry-run.ts');
		const graph = makeGraph([makeNode(1, 'Issue One'), makeNode(2, 'Issue Two')]);
		const state = makeState();
		const config = makeConfig();
		const flags = makeFlags();

		await runDryRun([1, 2], graph, state, config, flags, '/repo');

		expect(spy).toHaveBeenCalledTimes(2);
		spy.mockRestore();
	});

	test('skips already-completed issues', async () => {
		const spy = spyOn(agentRunner, 'assessIssueSize').mockResolvedValue(makeNoSplitAssessment());

		const { runDryRun } = await import('./dry-run.ts');
		const graph = makeGraph([makeNode(1, 'Done Issue'), makeNode(2, 'Pending Issue')]);
		const state = makeState({
			1: { number: 1, title: 'Done Issue', status: 'completed', branch: null, baseBranch: null, prNumber: null, error: null, completedAt: null, subIssues: null },
		});
		const flags = makeFlags();

		await runDryRun([1, 2], graph, state, makeConfig(), flags, '/repo');

		// assessIssueSize should only be called for issue 2 (issue 1 is completed)
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	test('continues when graph node is missing for an issue', async () => {
		const spy = spyOn(agentRunner, 'assessIssueSize').mockResolvedValue(makeNoSplitAssessment());

		const { runDryRun } = await import('./dry-run.ts');
		// graph only has node for issue 2, not issue 1
		const graph = makeGraph([makeNode(2, 'Issue Two')]);
		const state = makeState();
		const flags = makeFlags();

		// Should not throw; issue 1 is skipped because graph.get(1) returns undefined
		await runDryRun([1, 2], graph, state, makeConfig(), flags, '/repo');

		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	test('shows split assessment when shouldSplit is true', async () => {
		const splits = [{ title: 'Sub A', body: 'body A' }, { title: 'Sub B', body: 'body B' }];
		const spy = spyOn(agentRunner, 'assessIssueSize').mockResolvedValue(makeSplitAssessment(splits));

		const { runDryRun } = await import('./dry-run.ts');
		const graph = makeGraph([makeNode(1, 'Big Issue')]);
		const state = makeState();

		// Should complete without error even when split is recommended
		await runDryRun([1], graph, state, makeConfig(), makeFlags(), '/repo');

		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	test('shows verify step names in summary', async () => {
		const spy = spyOn(agentRunner, 'assessIssueSize').mockResolvedValue(makeNoSplitAssessment());

		const { runDryRun } = await import('./dry-run.ts');
		const config = makeConfig({
			verify: [{ name: 'typecheck', cmd: 'bun tsc' }, { name: 'test', cmd: 'bun test' }],
		});
		const graph = makeGraph([makeNode(1, 'Issue One')]);
		const state = makeState();

		await runDryRun([1], graph, state, config, makeFlags(), '/repo');

		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	test('shows e2e label when e2e configured and skipE2e is false', async () => {
		const spy = spyOn(agentRunner, 'assessIssueSize').mockResolvedValue(makeNoSplitAssessment());

		const { runDryRun } = await import('./dry-run.ts');
		const config = makeConfig({
			verify: [],
			e2e: { run: 'bun e2e', update: 'bun e2e --update', snapshotGlob: '**/*.snap' },
		});
		const graph = makeGraph([makeNode(1, 'Issue One')]);
		const state = makeState();
		const flags = makeFlags({ skipE2e: false });

		await runDryRun([1], graph, state, config, flags, '/repo');
		spy.mockRestore();
	});

	test('omits e2e label when skipE2e is true', async () => {
		const spy = spyOn(agentRunner, 'assessIssueSize').mockResolvedValue(makeNoSplitAssessment());

		const { runDryRun } = await import('./dry-run.ts');
		const config = makeConfig({
			e2e: { run: 'bun e2e', update: 'bun e2e --update', snapshotGlob: '**/*.snap' },
		});
		const graph = makeGraph([makeNode(1, 'Issue One')]);
		const state = makeState();
		const flags = makeFlags({ skipE2e: true });

		await runDryRun([1], graph, state, config, flags, '/repo');
		spy.mockRestore();
	});

	test('shows dep branches when issue depends on others', async () => {
		const spy = spyOn(agentRunner, 'assessIssueSize').mockResolvedValue(makeNoSplitAssessment());

		const { runDryRun } = await import('./dry-run.ts');
		const graph = makeGraph([makeNode(2, 'Dependent Issue', [1])]);
		const state = makeState();

		await runDryRun([2], graph, state, makeConfig(), makeFlags(), '/repo');

		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	test('skips assessment when skipSplit flag is set', async () => {
		const spy = spyOn(agentRunner, 'assessIssueSize').mockResolvedValue(makeNoSplitAssessment());

		const { runDryRun } = await import('./dry-run.ts');
		const graph = makeGraph([makeNode(1, 'Issue One')]);
		const state = makeState();
		const flags = makeFlags({ skipSplit: true });

		await runDryRun([1], graph, state, makeConfig(), flags, '/repo');

		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// runDryRun — singleMode with singleIssue specified
// ---------------------------------------------------------------------------

describe('runDryRun — singleMode with explicit singleIssue', () => {
	test('processes only the specified single issue', async () => {
		const spy = spyOn(agentRunner, 'assessIssueSize').mockResolvedValue(makeNoSplitAssessment());

		const { runDryRun } = await import('./dry-run.ts');
		const graph = makeGraph([makeNode(1, 'Issue One'), makeNode(2, 'Issue Two'), makeNode(3, 'Issue Three')]);
		const state = makeState();
		const flags = makeFlags({ singleMode: true, singleIssue: 2 });

		await runDryRun([1, 2, 3], graph, state, makeConfig(), flags, '/repo');

		// Only issue 2 should be assessed
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	test('exits with error when singleIssue not found in execution order', async () => {
		const { runDryRun } = await import('./dry-run.ts');
		const graph = makeGraph([makeNode(1, 'Issue One')]);
		const state = makeState();
		const flags = makeFlags({ singleMode: true, singleIssue: 99 });

		// process.exit(1) will throw in test environment
		const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
			throw new Error('process.exit called');
		}) as () => never);

		await expect(
			runDryRun([1], graph, state, makeConfig(), flags, '/repo')
		).rejects.toThrow('process.exit called');

		exitSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// runDryRun — singleMode without explicit singleIssue (find next pending)
// ---------------------------------------------------------------------------

describe('runDryRun — singleMode finding next pending issue', () => {
	test('processes first non-completed issue when singleIssue is null', async () => {
		const spy = spyOn(agentRunner, 'assessIssueSize').mockResolvedValue(makeNoSplitAssessment());

		const { runDryRun } = await import('./dry-run.ts');
		const graph = makeGraph([makeNode(1, 'Done'), makeNode(2, 'Pending')]);
		const state = makeState({
			1: { number: 1, title: 'Done', status: 'completed', branch: null, baseBranch: null, prNumber: null, error: null, completedAt: null, subIssues: null },
		});
		const flags = makeFlags({ singleMode: true, singleIssue: null });

		await runDryRun([1, 2], graph, state, makeConfig(), flags, '/repo');

		// Only issue 2 (first non-completed) should be assessed
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	test('processes first issue when all issues are pending (no state)', async () => {
		const spy = spyOn(agentRunner, 'assessIssueSize').mockResolvedValue(makeNoSplitAssessment());

		const { runDryRun } = await import('./dry-run.ts');
		const graph = makeGraph([makeNode(1, 'Issue One'), makeNode(2, 'Issue Two')]);
		const state = makeState();
		const flags = makeFlags({ singleMode: true, singleIssue: null });

		await runDryRun([1, 2], graph, state, makeConfig(), flags, '/repo');

		// Only issue 1 (first pending) should be assessed
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});
});
