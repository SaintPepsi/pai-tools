/**
 * Tests for execution.ts — buildPRBody and runMainLoop.
 *
 * All external I/O is injected via ExecutionDeps mocks so no real git,
 * GitHub, or Claude calls are made.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
	buildPRBody,
	runMainLoop,
	defaultExecutionDeps,
	type ExecutionDeps,
	type RunMainLoopOptions,
} from './execution.ts';
import { getIssueState } from './state-helpers.ts';
import { withRetries } from './retry.ts';
import type {
	OrchestratorConfig,
	OrchestratorFlags,
	OrchestratorState,
	DependencyNode,
	GitHubIssue,
} from './types.ts';
import type { RunLogger } from '../../shared/logging.ts';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeIssue(number: number, title = `Issue ${number}`, body = ''): GitHubIssue {
	return { number, title, body, state: 'open', labels: [] };
}

function makeNode(issue: GitHubIssue, dependsOn: number[] = [], branch?: string): DependencyNode {
	return { issue, dependsOn, branch: branch ?? `feat/${issue.number}-issue` };
}

function makeGraph(...nodes: DependencyNode[]): Map<number, DependencyNode> {
	const m = new Map<number, DependencyNode>();
	for (const n of nodes) m.set(n.issue.number, n);
	return m;
}

function makeState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
	return { version: 1, startedAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', issues: {}, ...overrides };
}

const baseConfig: OrchestratorConfig = {
	branchPrefix: 'feat/',
	baseBranch: 'main',
	worktreeDir: '.pait/worktrees',
	models: { implement: 'claude-sonnet', assess: 'claude-haiku' },
	retries: { implement: 0, verify: 0 },
	allowedTools: 'Bash Edit Write Read',
	verify: [{ name: 'test', cmd: 'bun test' }],
};

const baseFlags: OrchestratorFlags = {
	dryRun: false, reset: false, statusOnly: false, skipE2e: true,
	skipSplit: true, noVerify: false, singleMode: false,
	singleIssue: null, fromIssue: null, parallel: 1, file: null,
};

const noopLogger: RunLogger = {
	log: () => {},
	path: '/dev/null',
	runStart: () => {},
	runComplete: () => {},
	issueStart: () => {},
	issueComplete: () => {},
	issueFailed: () => {},
	issueSplit: () => {},
	agentOutput: () => {},
	verifyPass: () => {},
	verifyFail: () => {},
	worktreeCreated: () => {},
	worktreeRemoved: () => {},
	branchCreated: () => {},
	prCreated: () => {},
};

const noopLog = {
	info: () => {}, ok: () => {}, warn: () => {}, error: () => {},
	step: () => {}, dim: () => {},
};

// ---------------------------------------------------------------------------
// Helpers to build mock deps
// ---------------------------------------------------------------------------

type CallRecord = { fn: string; args: unknown[] };

function makeDeps(overrides: Partial<ExecutionDeps> = {}): { deps: ExecutionDeps; calls: CallRecord[] } {
	const calls: CallRecord[] = [];
	const track = (fn: string, ...args: unknown[]) => calls.push({ fn, args });

	const deps: ExecutionDeps = {
		log: noopLog,
		exit: (code) => { throw new Error(`exit(${code})`); },
		saveState: (...args) => { track('saveState', ...args); },
		getIssueState,
		withRetries,
		buildGraph: () => new Map(),
		topologicalSort: () => [],
		printExecutionPlan: () => {},
		printStatus: () => {},
		createWorktree: async () => { track('createWorktree'); return { ok: true, worktreePath: '/wt', baseBranch: 'main' }; },
		removeWorktree: async (...args) => { track('removeWorktree', ...args); },
		fetchOpenIssues: async () => [],
		createSubIssues: async () => [],
		createPR: async () => { track('createPR'); return { ok: true, prNumber: 99 }; },
		assessIssueSize: async () => ({ shouldSplit: false, proposedSplits: [], reasoning: 'small' }),
		implementIssue: async () => { track('implementIssue'); return { ok: true }; },
		fixVerificationFailure: async () => {},
		runVerify: async () => { track('runVerify'); return { ok: true, steps: [] }; },
		...overrides,
	};
	return { deps, calls };
}

function makeOpts(
	executionOrder: number[],
	graph: Map<number, DependencyNode>,
	state: OrchestratorState,
	flags: Partial<OrchestratorFlags> = {},
	deps?: ExecutionDeps
): RunMainLoopOptions {
	return {
		executionOrder,
		graph,
		state,
		config: baseConfig,
		flags: { ...baseFlags, ...flags },
		stateFile: '/state.json',
		repoRoot: '/repo',
		logger: noopLogger,
		deps,
	};
}

// ---------------------------------------------------------------------------
// buildPRBody
// ---------------------------------------------------------------------------

describe('buildPRBody', () => {
	test('includes issue number in summary and changes sections', () => {
		const issue = makeIssue(42, 'Add auth');
		const body = buildPRBody(issue, baseConfig, baseFlags);
		expect(body).toContain('Closes #42');
		expect(body).toContain('issue #42');
	});

	test('includes verify checklist for each verify command', () => {
		const config: OrchestratorConfig = {
			...baseConfig,
			verify: [{ name: 'test', cmd: 'bun test' }, { name: 'lint', cmd: 'bun lint' }],
		};
		const body = buildPRBody(makeIssue(1), config, baseFlags);
		expect(body).toContain('`bun test` passes');
		expect(body).toContain('`bun lint` passes');
	});

	test('shows checked e2e line when e2e configured and not skipped', () => {
		const config: OrchestratorConfig = { ...baseConfig, e2e: { run: 'bun e2e', update: 'bun e2e --update', snapshotGlob: '**/*.snap' } };
		const flags: OrchestratorFlags = { ...baseFlags, skipE2e: false };
		const body = buildPRBody(makeIssue(1), config, flags);
		expect(body).toContain('`bun e2e` passes');
		expect(body).not.toContain('skipped');
	});

	test('shows unchecked e2e line when skipE2e is true', () => {
		const config: OrchestratorConfig = { ...baseConfig, e2e: { run: 'bun e2e', update: 'bun e2e --update', snapshotGlob: '**/*.snap' } };
		const flags: OrchestratorFlags = { ...baseFlags, skipE2e: true };
		const body = buildPRBody(makeIssue(1), config, flags);
		expect(body).toContain('E2E (skipped)');
		expect(body).toContain('[ ]');
	});

	test('omits e2e line when no e2e configured', () => {
		const config: OrchestratorConfig = { ...baseConfig, e2e: undefined };
		const body = buildPRBody(makeIssue(1), config, baseFlags);
		expect(body).not.toContain('E2E');
	});

	test('includes automation footer', () => {
		const body = buildPRBody(makeIssue(1), baseConfig, baseFlags);
		expect(body).toContain('Automated by pai orchestrate');
	});

	test('produces empty verify checklist when no verify commands', () => {
		const config: OrchestratorConfig = { ...baseConfig, verify: [] };
		const body = buildPRBody(makeIssue(1), config, baseFlags);
		expect(body).toContain('## Verification');
	});
});

// ---------------------------------------------------------------------------
// runMainLoop — start index resolution
// ---------------------------------------------------------------------------

describe('runMainLoop — start index resolution', () => {
	test('starts from beginning when all issues pending', async () => {
		const issue1 = makeIssue(1);
		const issue2 = makeIssue(2);
		const graph = makeGraph(makeNode(issue1), makeNode(issue2));
		const state = makeState();
		const { deps, calls } = makeDeps();

		await runMainLoop(makeOpts([1, 2], graph, state, {}, deps));

		const implCalls = calls.filter((c) => c.fn === 'implementIssue');
		expect(implCalls.length).toBe(2);
	});

	test('skips already-completed issues at start', async () => {
		const issue1 = makeIssue(1);
		const issue2 = makeIssue(2);
		const graph = makeGraph(makeNode(issue1), makeNode(issue2));
		const state = makeState();
		// Mark issue 1 as completed
		getIssueState(state, 1, 'Issue 1').status = 'completed';

		const { deps, calls } = makeDeps();
		await runMainLoop(makeOpts([1, 2], graph, state, {}, deps));

		const implCalls = calls.filter((c) => c.fn === 'implementIssue');
		expect(implCalls.length).toBe(1);
	});

	test('singleIssue flag jumps to that issue', async () => {
		const issue1 = makeIssue(1);
		const issue2 = makeIssue(2);
		const graph = makeGraph(makeNode(issue1), makeNode(issue2));
		const state = makeState();
		const { deps, calls } = makeDeps({ implementIssue: async () => { calls.push({ fn: 'implementIssue', args: [] }); return { ok: true }; } });

		await runMainLoop(makeOpts([1, 2], graph, state, { singleIssue: 2, singleMode: true }, deps));

		const implCalls = calls.filter((c) => c.fn === 'implementIssue');
		expect(implCalls.length).toBe(1);
	});

	test('fromIssue flag starts from that issue', async () => {
		const issue1 = makeIssue(1);
		const issue2 = makeIssue(2);
		const issue3 = makeIssue(3);
		const graph = makeGraph(makeNode(issue1), makeNode(issue2), makeNode(issue3));
		const state = makeState();
		const { deps, calls } = makeDeps();

		await runMainLoop(makeOpts([1, 2, 3], graph, state, { fromIssue: 2 }, deps));

		const implCalls = calls.filter((c) => c.fn === 'implementIssue');
		expect(implCalls.length).toBe(2); // issues 2 and 3
	});

	test('singleIssue not in order calls exit(1)', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const { deps } = makeDeps();

		await expect(
			runMainLoop(makeOpts([1], graph, state, { singleIssue: 99 }, deps))
		).rejects.toThrow('exit(1)');
	});

	test('fromIssue not in order calls exit(1)', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const { deps } = makeDeps();

		await expect(
			runMainLoop(makeOpts([1], graph, state, { fromIssue: 99 }, deps))
		).rejects.toThrow('exit(1)');
	});
});

// ---------------------------------------------------------------------------
// runMainLoop — skipping issues
// ---------------------------------------------------------------------------

describe('runMainLoop — issue skipping', () => {
	test('skips completed issues mid-loop', async () => {
		const issue1 = makeIssue(1);
		const issue2 = makeIssue(2);
		const issue3 = makeIssue(3);
		const graph = makeGraph(makeNode(issue1), makeNode(issue2), makeNode(issue3));
		const state = makeState();
		getIssueState(state, 2, 'Issue 2').status = 'completed';

		const { deps, calls } = makeDeps();
		await runMainLoop(makeOpts([1, 2, 3], graph, state, {}, deps));

		const implCalls = calls.filter((c) => c.fn === 'implementIssue');
		expect(implCalls.length).toBe(2); // 1 and 3, not 2
	});

	test('skips split issues', async () => {
		const issue1 = makeIssue(1);
		const issue2 = makeIssue(2);
		const graph = makeGraph(makeNode(issue1), makeNode(issue2));
		const state = makeState();
		getIssueState(state, 1, 'Issue 1').status = 'split';

		const { deps, calls } = makeDeps();
		await runMainLoop(makeOpts([1, 2], graph, state, {}, deps));

		const implCalls = calls.filter((c) => c.fn === 'implementIssue');
		expect(implCalls.length).toBe(1);
	});

	test('missing node in graph is skipped without error', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		// Put issue 99 in executionOrder but not in graph
		const { deps, calls } = makeDeps();

		await runMainLoop(makeOpts([99, 1], graph, state, {}, deps));

		const implCalls = calls.filter((c) => c.fn === 'implementIssue');
		expect(implCalls.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// runMainLoop — dependency checking
// ---------------------------------------------------------------------------

describe('runMainLoop — dependency checking', () => {
	test('exits when in-graph dep is not completed', async () => {
		const issue1 = makeIssue(1);
		const issue2 = makeIssue(2);
		// issue2 depends on issue1, but issue1 is not completed
		const graph = makeGraph(makeNode(issue1), makeNode(issue2, [1]));
		const state = makeState();
		// Start from issue2 directly
		const { deps } = makeDeps();

		await expect(
			runMainLoop(makeOpts([2], graph, state, { singleIssue: 2 }, deps))
		).rejects.toThrow('exit(1)');
	});

	test('proceeds when dep is external (not in graph)', async () => {
		const issue2 = makeIssue(2);
		// dep 1 not in graph — should be treated as met
		const graph = makeGraph(makeNode(issue2, [1]));
		const state = makeState();
		const { deps, calls } = makeDeps();

		await runMainLoop(makeOpts([2], graph, state, {}, deps));

		const implCalls = calls.filter((c) => c.fn === 'implementIssue');
		expect(implCalls.length).toBe(1);
	});

	test('proceeds when dep is completed', async () => {
		const issue1 = makeIssue(1);
		const issue2 = makeIssue(2);
		const graph = makeGraph(makeNode(issue1), makeNode(issue2, [1]));
		const state = makeState();
		getIssueState(state, 1).status = 'completed';

		const { deps, calls } = makeDeps();
		await runMainLoop(makeOpts([1, 2], graph, state, {}, deps));

		const implCalls = calls.filter((c) => c.fn === 'implementIssue');
		expect(implCalls.length).toBe(1); // only issue2 (issue1 is completed so skipped)
	});
});

// ---------------------------------------------------------------------------
// runMainLoop — worktree failure
// ---------------------------------------------------------------------------

describe('runMainLoop — worktree failure', () => {
	test('exits when worktree creation fails', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const { deps } = makeDeps({
			createWorktree: async () => ({ ok: false, error: 'git error', worktreePath: '', baseBranch: '' }),
		});

		await expect(
			runMainLoop(makeOpts([1], graph, state, {}, deps))
		).rejects.toThrow('exit(1)');
	});

	test('marks issue failed in state before exit on worktree error', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const { deps } = makeDeps({
			createWorktree: async () => ({ ok: false, error: 'disk full', worktreePath: '', baseBranch: '' }),
		});

		await expect(runMainLoop(makeOpts([1], graph, state, {}, deps))).rejects.toThrow();
		expect(state.issues[1]?.status).toBe('failed');
		expect(state.issues[1]?.error).toContain('disk full');
	});
});

// ---------------------------------------------------------------------------
// runMainLoop — implementation failure
// ---------------------------------------------------------------------------

describe('runMainLoop — implementation failure', () => {
	test('exits when implementation fails after all retries', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const { deps } = makeDeps({
			implementIssue: async () => ({ ok: false, error: 'agent error' }),
		});

		await expect(
			runMainLoop(makeOpts([1], graph, state, {}, deps))
		).rejects.toThrow('exit(1)');
	});

	test('marks issue failed and removes worktree on impl error', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const { deps, calls } = makeDeps({
			implementIssue: async () => ({ ok: false, error: 'timeout' }),
		});

		await expect(runMainLoop(makeOpts([1], graph, state, {}, deps))).rejects.toThrow();
		expect(state.issues[1]?.status).toBe('failed');
		const removes = calls.filter((c) => c.fn === 'removeWorktree');
		expect(removes.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// runMainLoop — verification failure
// ---------------------------------------------------------------------------

describe('runMainLoop — verification failure', () => {
	test('exits when verification fails after all retries', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const { deps } = makeDeps({
			runVerify: async () => ({ ok: false, steps: [], failedStep: 'test', error: 'tests failed' }),
		});

		await expect(
			runMainLoop(makeOpts([1], graph, state, {}, deps))
		).rejects.toThrow('exit(1)');
	});

	test('marks issue failed and removes worktree on verify error', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const { deps, calls } = makeDeps({
			runVerify: async () => ({ ok: false, steps: [], failedStep: 'lint', error: 'lint failed' }),
		});

		await expect(runMainLoop(makeOpts([1], graph, state, {}, deps))).rejects.toThrow();
		expect(state.issues[1]?.status).toBe('failed');
		expect(state.issues[1]?.error).toContain('lint');
		const removes = calls.filter((c) => c.fn === 'removeWorktree');
		expect(removes.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// runMainLoop — PR creation failure
// ---------------------------------------------------------------------------

describe('runMainLoop — PR creation failure', () => {
	test('exits when PR creation fails', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const { deps } = makeDeps({
			createPR: async () => ({ ok: false, error: 'gh auth error' }),
		});

		await expect(
			runMainLoop(makeOpts([1], graph, state, {}, deps))
		).rejects.toThrow('exit(1)');
	});

	test('marks issue failed and removes worktree on PR error', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const { deps, calls } = makeDeps({
			createPR: async () => ({ ok: false, error: 'rate limit' }),
		});

		await expect(runMainLoop(makeOpts([1], graph, state, {}, deps))).rejects.toThrow();
		expect(state.issues[1]?.status).toBe('failed');
		const removes = calls.filter((c) => c.fn === 'removeWorktree');
		expect(removes.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// runMainLoop — happy path completion
// ---------------------------------------------------------------------------

describe('runMainLoop — happy path', () => {
	test('marks issue completed with pr number on success', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const { deps } = makeDeps({
			createPR: async () => ({ ok: true, prNumber: 42 }),
		});

		await runMainLoop(makeOpts([1], graph, state, {}, deps));

		expect(state.issues[1]?.status).toBe('completed');
		expect(state.issues[1]?.prNumber).toBe(42);
		expect(state.issues[1]?.error).toBeNull();
	});

	test('removes worktree after successful completion', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const { deps, calls } = makeDeps();

		await runMainLoop(makeOpts([1], graph, state, {}, deps));

		const removes = calls.filter((c) => c.fn === 'removeWorktree');
		expect(removes.length).toBe(1);
	});

	test('processes multiple issues sequentially', async () => {
		const graph = makeGraph(makeNode(makeIssue(1)), makeNode(makeIssue(2)), makeNode(makeIssue(3)));
		const state = makeState();
		const { deps, calls } = makeDeps();

		await runMainLoop(makeOpts([1, 2, 3], graph, state, {}, deps));

		const implCalls = calls.filter((c) => c.fn === 'implementIssue');
		expect(implCalls.length).toBe(3);
		expect(state.issues[1]?.status).toBe('completed');
		expect(state.issues[2]?.status).toBe('completed');
		expect(state.issues[3]?.status).toBe('completed');
	});

	test('saves state at each key step', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const { deps, calls } = makeDeps();

		await runMainLoop(makeOpts([1], graph, state, {}, deps));

		const saves = calls.filter((c) => c.fn === 'saveState');
		expect(saves.length).toBeGreaterThanOrEqual(2); // in_progress + completed
	});

	test('singleMode stops after first issue and calls printStatus', async () => {
		const graph = makeGraph(makeNode(makeIssue(1)), makeNode(makeIssue(2)));
		const state = makeState();
		let printStatusCalled = false;
		const { deps, calls } = makeDeps({
			printStatus: () => { printStatusCalled = true; },
		});

		await runMainLoop(makeOpts([1, 2], graph, state, { singleMode: true }, deps));

		const implCalls = calls.filter((c) => c.fn === 'implementIssue');
		expect(implCalls.length).toBe(1);
		expect(printStatusCalled).toBe(true);
	});

	test('dep branch from node used when dep in graph', async () => {
		const issue1 = makeIssue(1);
		const issue2 = makeIssue(2);
		const node1 = makeNode(issue1, [], 'feat/1-issue');
		const node2 = makeNode(issue2, [1], 'feat/2-issue');
		const graph = makeGraph(node1, node2);
		const state = makeState();
		getIssueState(state, 1).status = 'completed';

		let capturedDepBranches: string[] = [];
		const { deps } = makeDeps({
			createWorktree: async (_branch, depBranches, ..._rest) => {
				capturedDepBranches = depBranches;
				return { ok: true, worktreePath: '/wt', baseBranch: 'main' };
			},
		});

		await runMainLoop(makeOpts([1, 2], graph, state, {}, deps));
		expect(capturedDepBranches).toContain('feat/1-issue');
	});

	test('dep branch from state used when dep not in graph', async () => {
		const issue2 = makeIssue(2);
		const node2 = makeNode(issue2, [1], 'feat/2-issue');
		// dep 1 NOT in graph
		const graph = makeGraph(node2);
		const state = makeState();
		// Put branch in state for dep 1
		getIssueState(state, 1).branch = 'feat/1-from-state';

		let capturedDepBranches: string[] = [];
		const { deps } = makeDeps({
			createWorktree: async (_branch, depBranches, ..._rest) => {
				capturedDepBranches = depBranches;
				return { ok: true, worktreePath: '/wt', baseBranch: 'main' };
			},
		});

		await runMainLoop(makeOpts([2], graph, state, {}, deps));
		expect(capturedDepBranches).toContain('feat/1-from-state');
	});
});

// ---------------------------------------------------------------------------
// runMainLoop — split flow
// ---------------------------------------------------------------------------

describe('runMainLoop — issue splitting', () => {
	test('marks issue as split when assessment says to split', async () => {
		const issue1 = makeIssue(1, 'Big issue', 'lots of work');
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();

		const subIssue10 = makeIssue(10, 'Sub A');
		const subIssue11 = makeIssue(11, 'Sub B');
		const freshGraph = makeGraph(makeNode(subIssue10), makeNode(subIssue11));

		const { deps } = makeDeps({
			assessIssueSize: async () => ({
				shouldSplit: true,
				proposedSplits: [{ title: 'Sub A', body: 'a' }, { title: 'Sub B', body: 'b' }],
				reasoning: 'too large',
			}),
			createSubIssues: async () => [10, 11],
			fetchOpenIssues: async () => [subIssue10, subIssue11],
			buildGraph: () => freshGraph,
			topologicalSort: () => [10, 11],
		});

		await runMainLoop(makeOpts([1], graph, state, { skipSplit: false }, deps));

		expect(state.issues[1]?.status).toBe('split');
		expect(state.issues[1]?.subIssues).toEqual([10, 11]);
	});

	test('does not split when skipSplit is true', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		let assessCalled = false;
		const { deps } = makeDeps({
			assessIssueSize: async () => { assessCalled = true; return { shouldSplit: true, proposedSplits: [{ title: 'x', body: 'y' }], reasoning: 'big' }; },
		});

		await runMainLoop(makeOpts([1], graph, state, { skipSplit: true }, deps));

		expect(assessCalled).toBe(false);
		expect(state.issues[1]?.status).toBe('completed');
	});

	test('does not split when shouldSplit is false', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const { deps, calls } = makeDeps({
			assessIssueSize: async () => ({ shouldSplit: false, proposedSplits: [], reasoning: 'small' }),
		});

		await runMainLoop(makeOpts([1], graph, state, { skipSplit: false }, deps));

		expect(state.issues[1]?.status).toBe('completed');
		const implCalls = calls.filter((c) => c.fn === 'implementIssue');
		expect(implCalls.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// runMainLoop — retry fixer callbacks (lines 299, 332-346)
// ---------------------------------------------------------------------------

describe('runMainLoop — retry fixer callbacks', () => {
	test('impl fixer callback is invoked on retry', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		let fixerCalled = false;
		let callCount = 0;
		// retries.implement = 1 means 2 attempts total; fixer runs between them
		const config: OrchestratorConfig = { ...baseConfig, retries: { implement: 1, verify: 0 } };
		const { deps } = makeDeps({
			implementIssue: async () => {
				callCount++;
				if (callCount === 1) return { ok: false, error: 'first attempt fails' };
				return { ok: true };
			},
			// We can detect the fixer ran via log.warn being called with "retry"
			log: { ...noopLog, warn: (msg) => { if (msg.includes('retry')) fixerCalled = true; } },
		});

		await runMainLoop({ ...makeOpts([1], graph, state, {}, deps), config });

		expect(fixerCalled).toBe(true);
		expect(state.issues[1]?.status).toBe('completed');
	});

	test('verify fixer callback is invoked on retry with failedStep', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		let fixVerifyCalled = false;
		let verifyCallCount = 0;
		// retries.verify = 1 means 2 attempts total; fixer runs between them
		const config: OrchestratorConfig = { ...baseConfig, retries: { implement: 0, verify: 1 } };
		const { deps } = makeDeps({
			runVerify: async () => {
				verifyCallCount++;
				if (verifyCallCount === 1) return { ok: false, steps: [], failedStep: 'test', error: 'fail' };
				return { ok: true, steps: [] };
			},
			fixVerificationFailure: async () => { fixVerifyCalled = true; },
		});

		await runMainLoop({ ...makeOpts([1], graph, state, {}, deps), config });

		expect(fixVerifyCalled).toBe(true);
		expect(state.issues[1]?.status).toBe('completed');
	});

	test('verify fixer callback skips fixVerificationFailure when no failedStep', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		let fixVerifyCalled = false;
		let verifyCallCount = 0;
		const config: OrchestratorConfig = { ...baseConfig, retries: { implement: 0, verify: 1 } };
		const { deps } = makeDeps({
			// fails but with NO failedStep — fixer should be skipped
			runVerify: async () => {
				verifyCallCount++;
				if (verifyCallCount === 1) return { ok: false, steps: [] };
				return { ok: true, steps: [] };
			},
			fixVerificationFailure: async () => { fixVerifyCalled = true; },
		});

		await runMainLoop({ ...makeOpts([1], graph, state, {}, deps), config });

		expect(fixVerifyCalled).toBe(false);
		expect(state.issues[1]?.status).toBe('completed');
	});
});

// ---------------------------------------------------------------------------
// defaultExecutionDeps — exit arrow coverage
// ---------------------------------------------------------------------------

describe('defaultExecutionDeps', () => {
	test('exit arrow delegates to process.exit', () => {
		const original = process.exit;
		let recorded: number | undefined;
		process.exit = (code?: number) => { recorded = code; return undefined as never; };
		defaultExecutionDeps.exit(42);
		process.exit = original;
		expect(recorded).toBe(42);
	});
});
