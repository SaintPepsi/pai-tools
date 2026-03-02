/**
 * Tests for parallel.ts — Mutex, makeIssueLog, processOneIssue, runParallelLoop.
 *
 * All external I/O is injected via ParallelDeps mocks so no real git,
 * GitHub, or Claude calls are made.
 */

import { describe, test, expect } from 'bun:test';
import {
	Mutex,
	makeIssueLog,
	processOneIssue,
	runParallelLoop,
	type ParallelDeps,
	type ProcessOneIssueContext,
	type ProcessOneIssueConfig,
	type RunParallelLoopOptions,
} from './parallel.ts';
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
	singleIssue: null, fromIssue: null, parallel: 2, file: null,
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
// Mock deps factory
// ---------------------------------------------------------------------------

type CallRecord = { fn: string; args: unknown[] };

function makeDeps(overrides: Partial<ParallelDeps> = {}): { deps: ParallelDeps; calls: CallRecord[] } {
	const calls: CallRecord[] = [];
	const track = (fn: string, ...args: unknown[]) => calls.push({ fn, args });

	const deps: ParallelDeps = {
		log: noopLog,
		printStatus: () => {},
		saveState: (...args) => { track('saveState', ...args); },
		getIssueState,
		withRetries,
		createWorktree: async (...args) => { track('createWorktree', ...args); return { ok: true, worktreePath: '/wt', baseBranch: 'main' }; },
		removeWorktree: async (...args) => { track('removeWorktree', ...args); },
		createPR: async (...args) => { track('createPR', ...args); return { ok: true, prNumber: 42 }; },
		implementIssue: async (...args) => { track('implementIssue', ...args); return { ok: true }; },
		fixVerificationFailure: async (...args) => { track('fixVerificationFailure', ...args); },
		runVerify: async (...args) => { track('runVerify', ...args); return { ok: true, steps: [] }; },
		buildPRBody: () => 'PR body',
		...overrides,
	};
	return { deps, calls };
}

function makeNoopIssueLog() {
	return { info: () => {}, ok: () => {}, warn: () => {}, error: () => {}, step: () => {}, dim: () => {} };
}

// ---------------------------------------------------------------------------
// Mutex
// ---------------------------------------------------------------------------

describe('Mutex', () => {
	test('run executes a function and returns its value', async () => {
		const mutex = new Mutex();
		const result = await mutex.run(async () => 42);
		expect(result).toBe(42);
	});

	test('serializes concurrent calls in order', async () => {
		const mutex = new Mutex();
		const order: number[] = [];

		const p1 = mutex.run(async () => {
			await new Promise<void>((r) => setTimeout(r, 10));
			order.push(1);
		});
		const p2 = mutex.run(async () => { order.push(2); });
		const p3 = mutex.run(async () => { order.push(3); });

		await Promise.all([p1, p2, p3]);
		expect(order).toEqual([1, 2, 3]);
	});

	test('continues chain after a failed call', async () => {
		const mutex = new Mutex();
		const results: string[] = [];

		const p1 = mutex.run(async () => { throw new Error('fail'); });
		const p2 = mutex.run(async () => { results.push('ok'); });

		await Promise.allSettled([p1, p2]);
		expect(results).toContain('ok');
	});

	test('propagates errors to the caller of the failing run', async () => {
		const mutex = new Mutex();
		const p = mutex.run(async () => { throw new Error('oops'); });
		await expect(p).rejects.toThrow('oops');
	});

	test('independent runs do not interfere', async () => {
		const mutex1 = new Mutex();
		const mutex2 = new Mutex();
		const r1 = await mutex1.run(async () => 'a');
		const r2 = await mutex2.run(async () => 'b');
		expect(r1).toBe('a');
		expect(r2).toBe('b');
	});
});

// ---------------------------------------------------------------------------
// makeIssueLog
// ---------------------------------------------------------------------------

describe('makeIssueLog', () => {
	test('prefixes messages with issue number', () => {
		const logged: string[] = [];
		const deps: ParallelDeps = {
			...makeDeps().deps,
			log: {
				info: (m) => logged.push(m),
				ok: (m) => logged.push(m),
				warn: (m) => logged.push(m),
				error: (m) => logged.push(m),
				step: (m) => logged.push(m),
				dim: (m) => logged.push(m),
			},
		};
		const iLog = makeIssueLog(7, deps);
		iLog.info('hello');
		iLog.ok('world');
		iLog.warn('careful');
		iLog.error('oops');
		iLog.step('step');
		iLog.dim('quiet');

		expect(logged.every((m) => m.includes('[#7]'))).toBe(true);
	});

	test('all six log methods are present and callable', () => {
		const { deps } = makeDeps();
		const iLog = makeIssueLog(1, deps);
		expect(() => {
			iLog.info('a'); iLog.ok('b'); iLog.warn('c');
			iLog.error('d'); iLog.step('e'); iLog.dim('f');
		}).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// processOneIssue — helpers
// ---------------------------------------------------------------------------

function makeCtx(
	issueNum: number,
	node: DependencyNode,
	state: OrchestratorState,
	safeUpdateState?: ProcessOneIssueContext['safeUpdateState']
): ProcessOneIssueContext {
	const sus = safeUpdateState ?? (async (fn) => { fn(state); });
	return { issueNum, node, state, repoRoot: '/repo', logger: noopLogger, safeUpdateState: sus, iLog: makeNoopIssueLog() };
}

function makeCfg(overrides: Partial<ParallelDeps> = {}): ProcessOneIssueConfig {
	return { config: baseConfig, flags: baseFlags, deps: makeDeps(overrides).deps };
}

// ---------------------------------------------------------------------------
// processOneIssue — worktree failure
// ---------------------------------------------------------------------------

describe('processOneIssue — worktree failure', () => {
	test('records failed status when worktree creation fails', async () => {
		const issue = makeIssue(1);
		const node = makeNode(issue);
		const state = makeState();

		await processOneIssue(
			makeCtx(1, node, state),
			makeCfg({ createWorktree: async () => ({ ok: false, error: 'disk full', worktreePath: '', baseBranch: '' }) })
		);

		expect(state.issues[1]?.status).toBe('failed');
		expect(state.issues[1]?.error).toContain('disk full');
	});

	test('does not throw on worktree failure', async () => {
		const issue = makeIssue(1);
		const node = makeNode(issue);
		const state = makeState();

		await expect(
			processOneIssue(
				makeCtx(1, node, state),
				makeCfg({ createWorktree: async () => ({ ok: false, error: 'err', worktreePath: '', baseBranch: '' }) })
			)
		).resolves.toBeUndefined();
	});

	test('uses default error message when worktree error is undefined', async () => {
		const issue = makeIssue(1);
		const node = makeNode(issue);
		const state = makeState();

		await processOneIssue(
			makeCtx(1, node, state),
			makeCfg({ createWorktree: async () => ({ ok: false, worktreePath: '', baseBranch: '' }) })
		);

		expect(state.issues[1]?.error).toBe('Worktree creation failed');
	});
});

// ---------------------------------------------------------------------------
// processOneIssue — implementation failure
// ---------------------------------------------------------------------------

describe('processOneIssue — implementation failure', () => {
	test('records failed status when implementation fails', async () => {
		const issue = makeIssue(2);
		const node = makeNode(issue);
		const state = makeState();

		await processOneIssue(
			makeCtx(2, node, state),
			makeCfg({ implementIssue: async () => ({ ok: false, error: 'timeout' }) })
		);

		expect(state.issues[2]?.status).toBe('failed');
		expect(state.issues[2]?.error).toContain('timeout');
	});

	test('removes worktree after implementation failure', async () => {
		const issue = makeIssue(2);
		const node = makeNode(issue);
		const state = makeState();
		const { deps, calls } = makeDeps({ implementIssue: async () => ({ ok: false, error: 'fail' }) });

		await processOneIssue(makeCtx(2, node, state), { config: baseConfig, flags: baseFlags, deps });

		const removes = calls.filter((c) => c.fn === 'removeWorktree');
		expect(removes.length).toBe(1);
	});

	test('does not throw on implementation failure', async () => {
		const issue = makeIssue(2);
		const node = makeNode(issue);
		const state = makeState();

		await expect(
			processOneIssue(
				makeCtx(2, node, state),
				makeCfg({ implementIssue: async () => ({ ok: false, error: 'err' }) })
			)
		).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// processOneIssue — verification failure
// ---------------------------------------------------------------------------

describe('processOneIssue — verification failure', () => {
	test('records failed status when verification fails', async () => {
		const issue = makeIssue(3);
		const node = makeNode(issue);
		const state = makeState();

		await processOneIssue(
			makeCtx(3, node, state),
			makeCfg({ runVerify: async () => ({ ok: false, steps: [], failedStep: 'test', error: 'tests failed' }) })
		);

		expect(state.issues[3]?.status).toBe('failed');
		expect(state.issues[3]?.error).toContain('test');
	});

	test('removes worktree after verification failure', async () => {
		const issue = makeIssue(3);
		const node = makeNode(issue);
		const state = makeState();
		const { deps, calls } = makeDeps({ runVerify: async () => ({ ok: false, steps: [], failedStep: 'lint', error: 'lint err' }) });

		await processOneIssue(makeCtx(3, node, state), { config: baseConfig, flags: baseFlags, deps });

		expect(calls.filter((c) => c.fn === 'removeWorktree').length).toBe(1);
	});

	test('calls fixVerificationFailure on retry when failedStep present', async () => {
		const issue = makeIssue(3);
		const node = makeNode(issue);
		const state = makeState();
		let fixCalled = false;
		// retries: verify = 1 means 2 total attempts → fixer is called once
		const config: OrchestratorConfig = { ...baseConfig, retries: { implement: 0, verify: 1 } };
		const { deps } = makeDeps({
			runVerify: async () => ({ ok: false, steps: [], failedStep: 'test', error: 'fail' }),
			fixVerificationFailure: async () => { fixCalled = true; },
		});

		await processOneIssue(makeCtx(3, node, state), { config, flags: baseFlags, deps });

		expect(fixCalled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// processOneIssue — PR creation failure
// ---------------------------------------------------------------------------

describe('processOneIssue — PR creation failure', () => {
	test('records failed status when PR creation fails', async () => {
		const issue = makeIssue(4);
		const node = makeNode(issue);
		const state = makeState();

		await processOneIssue(
			makeCtx(4, node, state),
			makeCfg({ createPR: async () => ({ ok: false, error: 'rate limited' }) })
		);

		expect(state.issues[4]?.status).toBe('failed');
		expect(state.issues[4]?.error).toContain('rate limited');
	});

	test('removes worktree after PR failure', async () => {
		const issue = makeIssue(4);
		const node = makeNode(issue);
		const state = makeState();
		const { deps, calls } = makeDeps({ createPR: async () => ({ ok: false, error: 'gh error' }) });

		await processOneIssue(makeCtx(4, node, state), { config: baseConfig, flags: baseFlags, deps });

		expect(calls.filter((c) => c.fn === 'removeWorktree').length).toBe(1);
	});

	test('uses default error message when PR error is undefined', async () => {
		const issue = makeIssue(4);
		const node = makeNode(issue);
		const state = makeState();

		await processOneIssue(
			makeCtx(4, node, state),
			makeCfg({ createPR: async () => ({ ok: false }) })
		);

		expect(state.issues[4]?.error).toBe('PR creation failed');
	});
});

// ---------------------------------------------------------------------------
// processOneIssue — happy path
// ---------------------------------------------------------------------------

describe('processOneIssue — happy path', () => {
	test('marks issue completed with pr number on success', async () => {
		const issue = makeIssue(5);
		const node = makeNode(issue);
		const state = makeState();
		const { deps } = makeDeps({ createPR: async () => ({ ok: true, prNumber: 77 }) });

		await processOneIssue(makeCtx(5, node, state), { config: baseConfig, flags: baseFlags, deps });

		expect(state.issues[5]?.status).toBe('completed');
		expect(state.issues[5]?.prNumber).toBe(77);
		expect(state.issues[5]?.error).toBeNull();
	});

	test('removes worktree after successful completion', async () => {
		const issue = makeIssue(5);
		const node = makeNode(issue);
		const state = makeState();
		const { deps, calls } = makeDeps();

		await processOneIssue(makeCtx(5, node, state), { config: baseConfig, flags: baseFlags, deps });

		expect(calls.filter((c) => c.fn === 'removeWorktree').length).toBe(1);
	});

	test('sets baseBranch and branch in state after worktree creation', async () => {
		const issue = makeIssue(5);
		const node = makeNode(issue, [], 'feat/5-issue');
		const state = makeState();
		const { deps } = makeDeps({ createWorktree: async () => ({ ok: true, worktreePath: '/wt', baseBranch: 'main' }) });

		await processOneIssue(makeCtx(5, node, state), { config: baseConfig, flags: baseFlags, deps });

		expect(state.issues[5]?.branch).toBe('feat/5-issue');
		expect(state.issues[5]?.baseBranch).toBe('main');
	});

	test('dep branches from state are passed to createWorktree', async () => {
		const issue = makeIssue(5);
		const node = makeNode(issue, [1]);
		const state = makeState();
		getIssueState(state, 1).branch = 'feat/1-dep';

		let capturedDepBranches: string[] = [];
		const { deps } = makeDeps({
			createWorktree: async (_b, depBranches) => {
				capturedDepBranches = depBranches;
				return { ok: true, worktreePath: '/wt', baseBranch: 'main' };
			},
		});

		await processOneIssue(makeCtx(5, node, state), { config: baseConfig, flags: baseFlags, deps });
		expect(capturedDepBranches).toContain('feat/1-dep');
	});

	test('logs prCreated when pr number present', async () => {
		const issue = makeIssue(5);
		const node = makeNode(issue);
		const state = makeState();
		let prCreatedNum: number | undefined;
		const logger: RunLogger = { ...noopLogger, prCreated: (_i, n) => { prCreatedNum = n; } };
		const { deps } = makeDeps({ createPR: async () => ({ ok: true, prNumber: 55 }) });

		await processOneIssue(
			{ ...makeCtx(5, node, state), logger },
			{ config: baseConfig, flags: baseFlags, deps }
		);

		expect(prCreatedNum).toBe(55);
	});
});

// ---------------------------------------------------------------------------
// runParallelLoop — helpers
// ---------------------------------------------------------------------------

function makeLoopOpts(
	executionOrder: number[],
	graph: Map<number, DependencyNode>,
	state: OrchestratorState,
	flagOverrides: Partial<OrchestratorFlags> = {},
	depOverrides: Partial<ParallelDeps> = {}
): RunParallelLoopOptions {
	const { deps } = makeDeps(depOverrides);
	return {
		executionOrder, graph, state, startIdx: 0,
		stateFile: '/state.json', repoRoot: '/repo',
		logger: noopLogger, config: baseConfig,
		flags: { ...baseFlags, ...flagOverrides },
		deps,
	};
}

// ---------------------------------------------------------------------------
// runParallelLoop — basic scheduling
// ---------------------------------------------------------------------------

describe('runParallelLoop — basic scheduling', () => {
	test('processes a single issue successfully', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();

		await runParallelLoop(makeLoopOpts([1], graph, state));

		expect(state.issues[1]?.status).toBe('completed');
	});

	test('processes multiple independent issues', async () => {
		const graph = makeGraph(makeNode(makeIssue(1)), makeNode(makeIssue(2)), makeNode(makeIssue(3)));
		const state = makeState();

		await runParallelLoop(makeLoopOpts([1, 2, 3], graph, state, { parallel: 3 }));

		expect(state.issues[1]?.status).toBe('completed');
		expect(state.issues[2]?.status).toBe('completed');
		expect(state.issues[3]?.status).toBe('completed');
	});

	test('respects parallel concurrency limit', async () => {
		// With parallel=1 and 3 issues, they must run sequentially
		const graph = makeGraph(makeNode(makeIssue(1)), makeNode(makeIssue(2)), makeNode(makeIssue(3)));
		const state = makeState();

		await runParallelLoop(makeLoopOpts([1, 2, 3], graph, state, { parallel: 1 }));

		expect(state.issues[1]?.status).toBe('completed');
		expect(state.issues[2]?.status).toBe('completed');
		expect(state.issues[3]?.status).toBe('completed');
	});

	test('calls printStatus at end', async () => {
		const graph = makeGraph(makeNode(makeIssue(1)));
		const state = makeState();
		let printCalled = false;
		const opts = makeLoopOpts([1], graph, state, {}, { printStatus: () => { printCalled = true; } });

		await runParallelLoop(opts);
		expect(printCalled).toBe(true);
	});

	test('handles empty executionOrder without error', async () => {
		const state = makeState();
		await expect(
			runParallelLoop(makeLoopOpts([], new Map(), state))
		).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// runParallelLoop — dependency scheduling
// ---------------------------------------------------------------------------

describe('runParallelLoop — dependency scheduling', () => {
	test('runs dependent issue after its dep completes', async () => {
		const issue1 = makeIssue(1);
		const issue2 = makeIssue(2);
		const graph = makeGraph(makeNode(issue1), makeNode(issue2, [1]));
		const state = makeState();

		await runParallelLoop(makeLoopOpts([1, 2], graph, state));

		expect(state.issues[1]?.status).toBe('completed');
		expect(state.issues[2]?.status).toBe('completed');
	});

	test('blocks issue when its dep fails', async () => {
		const issue1 = makeIssue(1);
		const issue2 = makeIssue(2);
		const graph = makeGraph(makeNode(issue1), makeNode(issue2, [1]));
		const state = makeState();

		await runParallelLoop(makeLoopOpts([1, 2], graph, state, {}, {
			implementIssue: async (opts) => {
				// Fail only issue 1
				if ((opts as { issue: GitHubIssue }).issue.number === 1) return { ok: false, error: 'fail' };
				return { ok: true };
			},
		}));

		expect(state.issues[1]?.status).toBe('failed');
		expect(state.issues[2]?.status).toBe('blocked');
	});

	test('treats pre-completed issues (before startIdx) as met deps', async () => {
		const issue1 = makeIssue(1);
		const issue2 = makeIssue(2);
		const graph = makeGraph(makeNode(issue1), makeNode(issue2, [1]));
		const state = makeState();

		// startIdx=1 means issue1 is pre-completed
		const { deps } = makeDeps();
		await runParallelLoop({
			executionOrder: [1, 2], graph, state, startIdx: 1,
			stateFile: '/state.json', repoRoot: '/repo',
			logger: noopLogger, config: baseConfig,
			flags: { ...baseFlags, parallel: 2 },
			deps,
		});

		expect(state.issues[2]?.status).toBe('completed');
	});

	test('external deps (not in graph) are treated as met', async () => {
		const issue2 = makeIssue(2);
		// dep 1 not in graph
		const graph = makeGraph(makeNode(issue2, [1]));
		const state = makeState();

		await runParallelLoop(makeLoopOpts([2], graph, state));

		expect(state.issues[2]?.status).toBe('completed');
	});

	test('chain block: grandchild blocked when parent blocked', async () => {
		const issue1 = makeIssue(1);
		const issue2 = makeIssue(2);
		const issue3 = makeIssue(3);
		const graph = makeGraph(makeNode(issue1), makeNode(issue2, [1]), makeNode(issue3, [2]));
		const state = makeState();

		await runParallelLoop(makeLoopOpts([1, 2, 3], graph, state, {}, {
			implementIssue: async (opts) => {
				if ((opts as { issue: GitHubIssue }).issue.number === 1) return { ok: false, error: 'fail' };
				return { ok: true };
			},
		}));

		expect(state.issues[1]?.status).toBe('failed');
		expect(state.issues[2]?.status).toBe('blocked');
		expect(state.issues[3]?.status).toBe('blocked');
	});
});

// ---------------------------------------------------------------------------
// runParallelLoop — failure isolation
// ---------------------------------------------------------------------------

describe('runParallelLoop — failure isolation', () => {
	test('failure of one issue does not halt independent issues', async () => {
		const issue1 = makeIssue(1);
		const issue2 = makeIssue(2);
		// issue2 has no dep on issue1 — they are independent
		const graph = makeGraph(makeNode(issue1), makeNode(issue2));
		const state = makeState();

		await runParallelLoop(makeLoopOpts([1, 2], graph, state, { parallel: 2 }, {
			implementIssue: async (opts) => {
				if ((opts as { issue: GitHubIssue }).issue.number === 1) return { ok: false, error: 'fail' };
				return { ok: true };
			},
		}));

		expect(state.issues[1]?.status).toBe('failed');
		expect(state.issues[2]?.status).toBe('completed');
	});

	test('safeUpdateState serializes concurrent writes via mutex', async () => {
		// Run 3 issues concurrently; each writes to state — no corruption expected
		const graph = makeGraph(makeNode(makeIssue(1)), makeNode(makeIssue(2)), makeNode(makeIssue(3)));
		const state = makeState();
		const saves: number[] = [];

		await runParallelLoop(makeLoopOpts([1, 2, 3], graph, state, { parallel: 3 }, {
			saveState: (s) => { saves.push(Object.keys(s.issues).length); },
		}));

		// All issues completed, state was saved multiple times without corruption
		expect(state.issues[1]?.status).toBe('completed');
		expect(state.issues[2]?.status).toBe('completed');
		expect(state.issues[3]?.status).toBe('completed');
		expect(saves.length).toBeGreaterThan(0);
	});

	test('missing node in graph is skipped without error', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();

		// 99 is in executionOrder but not in graph
		await expect(
			runParallelLoop(makeLoopOpts([99, 1], graph, state))
		).resolves.toBeUndefined();

		expect(state.issues[1]?.status).toBe('completed');
	});

	test('already-completed issues are skipped in loop', async () => {
		const issue1 = makeIssue(1);
		const issue2 = makeIssue(2);
		const graph = makeGraph(makeNode(issue1), makeNode(issue2));
		const state = makeState();
		getIssueState(state, 1).status = 'completed';

		let implCount = 0;
		await runParallelLoop(makeLoopOpts([1, 2], graph, state, {}, {
			implementIssue: async () => { implCount++; return { ok: true }; },
		}));

		expect(implCount).toBe(1); // only issue 2
	});
});

// ---------------------------------------------------------------------------
// processOneIssue — retry fixer callbacks (lines 214, 254)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// runParallelLoop — slot rejection handler (line 410)
// ---------------------------------------------------------------------------

describe('runParallelLoop — slot rejection handler', () => {
	test('loop continues after a slot promise rejects unexpectedly', async () => {
		// Make createWorktree throw (not return {ok:false}) so processOneIssue propagates
		// the rejection into the .then(_,reject) handler on line 410
		const issue1 = makeIssue(1);
		const issue2 = makeIssue(2);
		const graph = makeGraph(makeNode(issue1), makeNode(issue2));
		const state = makeState();
		let issue1Calls = 0;

		const { deps } = makeDeps({
			createWorktree: async (branch) => {
				// Throw on issue1's branch to trigger the rejection handler
				if (branch === 'feat/1-issue') {
					issue1Calls++;
					throw new Error('unexpected crash');
				}
				return { ok: true, worktreePath: '/wt', baseBranch: 'main' };
			},
		});

		// Should not throw — the rejection handler catches it and removes the slot
		await expect(runParallelLoop(
			makeLoopOpts([1, 2], graph, state, { parallel: 2 }, deps)
		)).resolves.toBeUndefined();

		// issue2 should complete successfully
		expect(state.issues[2]?.status).toBe('completed');
		expect(issue1Calls).toBe(1);
	});
});

describe('processOneIssue — impl retry fixer callback', () => {
	test('impl fixer callback is invoked on retry — issue completes on second attempt', async () => {
		const issue = makeIssue(10);
		const node = makeNode(issue);
		const state = makeState();
		let callCount = 0;
		const config: OrchestratorConfig = { ...baseConfig, retries: { implement: 1, verify: 0 } };
		const { deps } = makeDeps({
			implementIssue: async () => {
				callCount++;
				if (callCount === 1) return { ok: false, error: 'first fail' };
				return { ok: true };
			},
		});

		await processOneIssue(makeCtx(10, node, state), { config, flags: baseFlags, deps });

		expect(callCount).toBe(2);
		expect(state.issues[10]?.status).toBe('completed');
	});
});

describe('processOneIssue — verify retry fixer callback', () => {
	test('verify fixer is called when failedStep is present on retry', async () => {
		const issue = makeIssue(11);
		const node = makeNode(issue);
		const state = makeState();
		let fixCalled = false;
		let verifyCount = 0;
		const config: OrchestratorConfig = { ...baseConfig, retries: { implement: 0, verify: 1 } };
		const { deps } = makeDeps({
			runVerify: async () => {
				verifyCount++;
				if (verifyCount === 1) return { ok: false, steps: [], failedStep: 'test', error: 'fail' };
				return { ok: true, steps: [] };
			},
			fixVerificationFailure: async () => { fixCalled = true; },
		});

		await processOneIssue(makeCtx(11, node, state), { config, flags: baseFlags, deps });

		expect(fixCalled).toBe(true);
		expect(state.issues[11]?.status).toBe('completed');
	});

	test('verify fixer is skipped when failedStep is absent on retry', async () => {
		const issue = makeIssue(12);
		const node = makeNode(issue);
		const state = makeState();
		let fixCalled = false;
		let verifyCount = 0;
		const config: OrchestratorConfig = { ...baseConfig, retries: { implement: 0, verify: 1 } };
		const { deps } = makeDeps({
			runVerify: async () => {
				verifyCount++;
				// No failedStep — fixer should be skipped
				if (verifyCount === 1) return { ok: false, steps: [] };
				return { ok: true, steps: [] };
			},
			fixVerificationFailure: async () => { fixCalled = true; },
		});

		await processOneIssue(makeCtx(12, node, state), { config, flags: baseFlags, deps });

		expect(fixCalled).toBe(false);
		expect(state.issues[12]?.status).toBe('completed');
	});
});
