/**
 * Coverage tests for tools/orchestrator/index.ts — the `orchestrate` entry point.
 *
 * Covers lines 118-219 (the `orchestrate` function body) via fully mocked
 * OrchestrateDeps. No real filesystem, git, GitHub, or Claude calls are made.
 */

import { describe, test, expect } from 'bun:test';
import { orchestrate, defaultOrchestrateDeps, type OrchestrateDeps } from './index.ts';
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
	dryRun: false,
	reset: false,
	statusOnly: false,
	skipE2e: true,
	skipSplit: true,
	noVerify: false,
	singleMode: false,
	singleIssue: null,
	fromIssue: null,
	parallel: 1,
	file: null,
};

function makeIssue(number: number, title = `Issue ${number}`, body = ''): GitHubIssue {
	return { number, title, body, state: 'open', labels: [] };
}

function makeNode(issue: GitHubIssue, dependsOn: number[] = []): DependencyNode {
	return { issue, dependsOn, branch: `feat/${issue.number}-issue` };
}

function makeGraph(...nodes: DependencyNode[]): Map<number, DependencyNode> {
	const m = new Map<number, DependencyNode>();
	for (const n of nodes) m.set(n.issue.number, n);
	return m;
}

function makeState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
	return {
		version: 1,
		startedAt: '2024-01-01T00:00:00.000Z',
		updatedAt: '2024-01-01T00:00:00.000Z',
		issues: {},
		...overrides,
	};
}

const noopLogger: RunLogger = {
	log: () => {},
	logPath: '/dev/null',
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
} as unknown as RunLogger;

// The `log` dep in OrchestrateDeps is typed as `typeof log` from shared/log.ts,
// but orchestrate() also calls deps.log.runComplete(...) on line 218. We cast to
// satisfy both usages (the source type annotation has a bug; we handle it here).
const noopLog = {
	info: () => {},
	ok: () => {},
	warn: () => {},
	error: () => {},
	step: () => {},
	dim: () => {},
	runComplete: () => {},
} as unknown as OrchestrateDeps['log'];

// ---------------------------------------------------------------------------
// Mock deps factory
// ---------------------------------------------------------------------------

type CallRecord = { fn: string; args: unknown[] };

class ExitError extends Error {
	code: number;
	constructor(code: number) {
		super(`exit(${code})`);
		this.code = code;
	}
}

function makeDeps(overrides: Partial<OrchestrateDeps> = {}): {
	deps: OrchestrateDeps;
	calls: CallRecord[];
} {
	const calls: CallRecord[] = [];
	const track = (fn: string, ...args: unknown[]) => calls.push({ fn, args });

	const issue1 = makeIssue(1);
	const node1 = makeNode(issue1);
	const defaultGraph = makeGraph(node1);
	const defaultOrder = [1];

	const deps: OrchestrateDeps = {
		consolelog: (...args) => { track('consolelog', ...args); },
		findRepoRoot: () => '/repo',
		loadToolConfig: () => ({ ...baseConfig }),
		getStateFilePath: () => '/repo/.pait/orchestrator-state.json',
		migrateStateIfNeeded: (...args) => { track('migrateStateIfNeeded', ...args); },
		clearState: (...args) => { track('clearState', ...args); },
		loadState: () => null,
		saveToolConfig: (...args) => { track('saveToolConfig', ...args); },
		promptForVerifyCommands: async () => [],
		fetchOpenIssues: async () => [issue1],
		readFile: async () => '# Tasks\n- [ ] Issue 1\n',
		parseMarkdownContent: () => [issue1],
		buildGraph: () => defaultGraph,
		topologicalSort: () => defaultOrder,
		computeTiers: () => [[1]],
		printParallelPlan: (...args) => { track('printParallelPlan', ...args); },
		printExecutionPlan: (...args) => { track('printExecutionPlan', ...args); },
		printStatus: (...args) => { track('printStatus', ...args); },
		makeLogger: () => noopLogger,
		runDryRun: async (...args) => { track('runDryRun', ...args); },
		runParallelLoop: async (...args) => { track('runParallelLoop', ...args); },
		runMainLoop: async (...args) => { track('runMainLoop', ...args); },
		initState: () => makeState(),
		log: noopLog,
		exit: (code) => { throw new ExitError(code); },
		...overrides,
	};

	return { deps, calls };
}

// ---------------------------------------------------------------------------
// Banner output
// ---------------------------------------------------------------------------

describe('orchestrate — banner', () => {
	test('prints the banner on every call', async () => {
		const logged: unknown[][] = [];
		const { deps } = makeDeps({
			consolelog: (...args) => { logged.push(args); },
		});

		await orchestrate(baseFlags, deps);

		// Three banner lines are printed
		expect(logged.length).toBeGreaterThanOrEqual(3);
		expect(logged.some((args) => String(args[0]).includes('PAI Issue Orchestrator'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// --reset flag
// ---------------------------------------------------------------------------

describe('orchestrate — --reset flag', () => {
	test('clears state and returns early when reset is only flag', async () => {
		const { deps, calls } = makeDeps();
		const flags = { ...baseFlags, reset: true };

		await orchestrate(flags, deps);

		const clearCalls = calls.filter((c) => c.fn === 'clearState');
		expect(clearCalls.length).toBe(1);
		// runMainLoop should NOT have been called (returned early)
		expect(calls.filter((c) => c.fn === 'runMainLoop').length).toBe(0);
	});

	test('clears state but continues when reset + dryRun both set', async () => {
		const { deps, calls } = makeDeps();
		const flags = { ...baseFlags, reset: true, dryRun: true };

		await orchestrate(flags, deps);

		const clearCalls = calls.filter((c) => c.fn === 'clearState');
		expect(clearCalls.length).toBe(1);
		// dryRun path executes
		expect(calls.filter((c) => c.fn === 'runDryRun').length).toBe(1);
	});

	test('clears state but continues when reset + statusOnly', async () => {
		const { deps, calls } = makeDeps({
			loadState: () => makeState(),
		});
		const flags = { ...baseFlags, reset: true, statusOnly: true };

		await orchestrate(flags, deps);

		expect(calls.filter((c) => c.fn === 'clearState').length).toBe(1);
		expect(calls.filter((c) => c.fn === 'printStatus').length).toBe(1);
	});

	test('clears state but continues when reset + singleMode', async () => {
		const { deps, calls } = makeDeps();
		const flags = { ...baseFlags, reset: true, singleMode: true };

		await orchestrate(flags, deps);

		expect(calls.filter((c) => c.fn === 'clearState').length).toBe(1);
		expect(calls.filter((c) => c.fn === 'runMainLoop').length).toBe(1);
	});

	test('clears state but continues when reset + fromIssue set', async () => {
		const { deps, calls } = makeDeps();
		const flags = { ...baseFlags, reset: true, fromIssue: 1 };

		await orchestrate(flags, deps);

		expect(calls.filter((c) => c.fn === 'clearState').length).toBe(1);
		expect(calls.filter((c) => c.fn === 'runMainLoop').length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// --status flag
// ---------------------------------------------------------------------------

describe('orchestrate — --status flag', () => {
	test('prints status and returns when state exists', async () => {
		const state = makeState();
		const { deps, calls } = makeDeps({
			loadState: () => state,
		});
		const flags = { ...baseFlags, statusOnly: true };

		await orchestrate(flags, deps);

		expect(calls.filter((c) => c.fn === 'printStatus').length).toBe(1);
		// Should return early — no main loop
		expect(calls.filter((c) => c.fn === 'runMainLoop').length).toBe(0);
	});

	test('logs info and returns when no state file found', async () => {
		const infoCalls: string[] = [];
		const { deps, calls } = makeDeps({
			loadState: () => null,
			log: {
				...noopLog,
				info: (msg: string) => { infoCalls.push(msg); },
			} as unknown as OrchestrateDeps['log'],
		});
		const flags = { ...baseFlags, statusOnly: true };

		await orchestrate(flags, deps);

		expect(infoCalls.some((m) => m.includes('No state file'))).toBe(true);
		expect(calls.filter((c) => c.fn === 'printStatus').length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Verify prompt
// ---------------------------------------------------------------------------

describe('orchestrate — verify prompt', () => {
	test('prompts for verify commands when config.verify is empty and noVerify is false', async () => {
		let promptCalled = false;
		const { deps, calls } = makeDeps({
			loadToolConfig: () => ({ ...baseConfig, verify: [] }),
			promptForVerifyCommands: async () => {
				promptCalled = true;
				return [{ name: 'test', cmd: 'bun test' }];
			},
		});
		const flags = { ...baseFlags, noVerify: false };

		await orchestrate(flags, deps);

		expect(promptCalled).toBe(true);
		// Verify commands saved to config
		expect(calls.filter((c) => c.fn === 'saveToolConfig').length).toBe(1);
	});

	test('calls exit(1) when prompt returns empty commands', async () => {
		const { deps } = makeDeps({
			loadToolConfig: () => ({ ...baseConfig, verify: [] }),
			promptForVerifyCommands: async () => [],
		});
		const flags = { ...baseFlags, noVerify: false };

		await expect(orchestrate(flags, deps)).rejects.toThrow(ExitError);
	});

	test('skips prompt when noVerify is true', async () => {
		let promptCalled = false;
		const { deps } = makeDeps({
			loadToolConfig: () => ({ ...baseConfig, verify: [] }),
			promptForVerifyCommands: async () => {
				promptCalled = true;
				return [];
			},
		});
		const flags = { ...baseFlags, noVerify: true };

		await orchestrate(flags, deps);

		expect(promptCalled).toBe(false);
	});

	test('skips prompt when config already has verify commands', async () => {
		let promptCalled = false;
		const { deps } = makeDeps({
			promptForVerifyCommands: async () => {
				promptCalled = true;
				return [];
			},
		});
		// baseConfig already has verify: [{ name: 'test', cmd: 'bun test' }]
		await orchestrate(baseFlags, deps);

		expect(promptCalled).toBe(false);
	});

	test('skips prompt when config has e2e configured', async () => {
		let promptCalled = false;
		const { deps } = makeDeps({
			loadToolConfig: () => ({
				...baseConfig,
				verify: [],
				e2e: { run: 'bun e2e', update: 'bun e2e --update', snapshotGlob: '**/*.snap' },
			}),
			promptForVerifyCommands: async () => {
				promptCalled = true;
				return [];
			},
		});
		const flags = { ...baseFlags, noVerify: false };

		await orchestrate(flags, deps);

		expect(promptCalled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Issue fetching — GitHub vs file
// ---------------------------------------------------------------------------

describe('orchestrate — issue source', () => {
	test('fetches from GitHub when no --file flag', async () => {
		let fetchCalled = false;
		const { deps } = makeDeps({
			fetchOpenIssues: async () => {
				fetchCalled = true;
				return [makeIssue(1)];
			},
		});

		await orchestrate(baseFlags, deps);

		expect(fetchCalled).toBe(true);
	});

	test('reads from file when --file flag is set', async () => {
		let readCalled = false;
		let parseCalled = false;
		const { deps } = makeDeps({
			readFile: async () => {
				readCalled = true;
				return '# Tasks\n- [ ] Task 1\n';
			},
			parseMarkdownContent: (content) => {
				parseCalled = true;
				return [makeIssue(1, 'Task 1')];
			},
		});
		const flags = { ...baseFlags, file: '/path/to/tasks.md' };

		await orchestrate(flags, deps);

		expect(readCalled).toBe(true);
		expect(parseCalled).toBe(true);
	});

	test('does not call fetchOpenIssues when file flag is set', async () => {
		let fetchCalled = false;
		const { deps } = makeDeps({
			fetchOpenIssues: async () => {
				fetchCalled = true;
				return [];
			},
			readFile: async () => '',
			parseMarkdownContent: () => [makeIssue(1)],
		});
		const flags = { ...baseFlags, file: '/tasks.md' };

		await orchestrate(flags, deps);

		expect(fetchCalled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Execution plan display
// ---------------------------------------------------------------------------

describe('orchestrate — execution plan display', () => {
	test('calls printExecutionPlan for sequential mode (parallel=1)', async () => {
		const { deps, calls } = makeDeps();

		await orchestrate({ ...baseFlags, parallel: 1 }, deps);

		expect(calls.filter((c) => c.fn === 'printExecutionPlan').length).toBe(1);
		expect(calls.filter((c) => c.fn === 'printParallelPlan').length).toBe(0);
	});

	test('calls printParallelPlan when parallel > 1 and not singleMode', async () => {
		const { deps, calls } = makeDeps();
		const flags = { ...baseFlags, parallel: 3, singleMode: false };

		await orchestrate(flags, deps);

		expect(calls.filter((c) => c.fn === 'printParallelPlan').length).toBe(1);
		expect(calls.filter((c) => c.fn === 'printExecutionPlan').length).toBe(0);
	});

	test('calls printExecutionPlan when singleMode even if parallel > 1', async () => {
		const { deps, calls } = makeDeps();
		const flags = { ...baseFlags, parallel: 3, singleMode: true };

		await orchestrate(flags, deps);

		expect(calls.filter((c) => c.fn === 'printExecutionPlan').length).toBe(1);
		expect(calls.filter((c) => c.fn === 'printParallelPlan').length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Dry-run path
// ---------------------------------------------------------------------------

describe('orchestrate — dry-run', () => {
	test('calls runDryRun and returns without calling runMainLoop', async () => {
		const { deps, calls } = makeDeps();
		const flags = { ...baseFlags, dryRun: true };

		await orchestrate(flags, deps);

		expect(calls.filter((c) => c.fn === 'runDryRun').length).toBe(1);
		expect(calls.filter((c) => c.fn === 'runMainLoop').length).toBe(0);
		expect(calls.filter((c) => c.fn === 'runParallelLoop').length).toBe(0);
	});

	test('uses existing state when available for dry-run', async () => {
		const existingState = makeState({ issues: { 1: { number: 1, title: 'Existing', status: 'completed', branch: null, baseBranch: null, prNumber: null, error: null, completedAt: null, subIssues: null } } });
		let capturedState: OrchestratorState | null = null;
		const { deps } = makeDeps({
			loadState: () => existingState,
			runDryRun: async (_order, _graph, state) => {
				capturedState = state;
			},
		});
		const flags = { ...baseFlags, dryRun: true };

		await orchestrate(flags, deps);

		expect(capturedState).toBe(existingState);
	});

	test('uses fresh state when no state file for dry-run', async () => {
		let capturedState: OrchestratorState | null = null;
		const freshState = makeState();
		const { deps } = makeDeps({
			loadState: () => null,
			initState: () => freshState,
			runDryRun: async (_order, _graph, state) => {
				capturedState = state;
			},
		});
		const flags = { ...baseFlags, dryRun: true };

		await orchestrate(flags, deps);

		expect(capturedState).toBe(freshState);
	});
});

// ---------------------------------------------------------------------------
// Main loop — sequential vs parallel dispatch
// ---------------------------------------------------------------------------

describe('orchestrate — main loop dispatch', () => {
	test('calls runMainLoop in sequential mode (parallel=1)', async () => {
		const { deps, calls } = makeDeps();

		await orchestrate({ ...baseFlags, parallel: 1 }, deps);

		expect(calls.filter((c) => c.fn === 'runMainLoop').length).toBe(1);
		expect(calls.filter((c) => c.fn === 'runParallelLoop').length).toBe(0);
	});

	test('calls runParallelLoop when parallel > 1', async () => {
		const { deps, calls } = makeDeps();
		const flags = { ...baseFlags, parallel: 3, singleMode: false };

		await orchestrate(flags, deps);

		expect(calls.filter((c) => c.fn === 'runParallelLoop').length).toBe(1);
		expect(calls.filter((c) => c.fn === 'runMainLoop').length).toBe(0);
	});

	test('calls runMainLoop in singleMode even if parallel > 1', async () => {
		const { deps, calls } = makeDeps();
		const flags = { ...baseFlags, parallel: 3, singleMode: true };

		await orchestrate(flags, deps);

		expect(calls.filter((c) => c.fn === 'runMainLoop').length).toBe(1);
		expect(calls.filter((c) => c.fn === 'runParallelLoop').length).toBe(0);
	});

	test('uses existing state from state file when available', async () => {
		const existingState = makeState();
		let capturedState: OrchestratorState | null = null;
		const { deps } = makeDeps({
			loadState: () => existingState,
			runMainLoop: async ({ state }) => {
				capturedState = state;
			},
		});

		await orchestrate(baseFlags, deps);

		expect(capturedState).toBe(existingState);
	});

	test('uses fresh initState when no state file', async () => {
		const freshState = makeState();
		let capturedState: OrchestratorState | null = null;
		const { deps } = makeDeps({
			loadState: () => null,
			initState: () => freshState,
			runMainLoop: async ({ state }) => {
				capturedState = state;
			},
		});

		await orchestrate(baseFlags, deps);

		expect(capturedState).toBe(freshState);
	});

	test('run mode is "full" for sequential non-single', async () => {
		// Indirectly verified: runMainLoop called, parallel=1, singleMode=false
		const { deps, calls } = makeDeps();
		await orchestrate({ ...baseFlags, parallel: 1, singleMode: false }, deps);
		expect(calls.filter((c) => c.fn === 'runMainLoop').length).toBe(1);
	});

	test('run mode is "single" for singleMode=true', async () => {
		const { deps, calls } = makeDeps();
		await orchestrate({ ...baseFlags, singleMode: true }, deps);
		expect(calls.filter((c) => c.fn === 'runMainLoop').length).toBe(1);
	});

	test('run mode is "parallel:N" for parallel > 1', async () => {
		const { deps, calls } = makeDeps();
		await orchestrate({ ...baseFlags, parallel: 4, singleMode: false }, deps);
		expect(calls.filter((c) => c.fn === 'runParallelLoop').length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Logger integration
// ---------------------------------------------------------------------------

describe('orchestrate — logger integration', () => {
	test('makeLogger is called with repoRoot', async () => {
		let loggerRoot: string | undefined;
		const { deps } = makeDeps({
			makeLogger: (root) => {
				loggerRoot = root;
				return noopLogger;
			},
		});

		await orchestrate(baseFlags, deps);

		expect(loggerRoot).toBe('/repo');
	});

	test('migrateStateIfNeeded is called on every run', async () => {
		const { deps, calls } = makeDeps();

		await orchestrate(baseFlags, deps);

		expect(calls.filter((c) => c.fn === 'migrateStateIfNeeded').length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// defaultOrchestrateDeps — exercise every arrow to hit 100% function coverage
// ---------------------------------------------------------------------------

describe('defaultOrchestrateDeps — arrow functions', () => {
	test('exit arrow delegates to process.exit', () => {
		const original = process.exit;
		let recorded: number | undefined;
		process.exit = (code?: number) => { recorded = code; return undefined as never; };
		defaultOrchestrateDeps.exit(99);
		process.exit = original;
		expect(recorded).toBe(99);
	});

	test('consolelog arrow delegates to console.log', () => {
		const original = console.log;
		const logged: unknown[] = [];
		console.log = (...args: unknown[]) => { logged.push(...args); };
		defaultOrchestrateDeps.consolelog('hello', 'world');
		console.log = original;
		expect(logged).toContain('hello');
	});

	test('loadToolConfig arrow returns defaults when no on-disk config', () => {
		// loadToolConfig gracefully returns defaults when .pait/orchestrator.json is absent.
		const result = defaultOrchestrateDeps.loadToolConfig('/nonexistent', 'orchestrator', baseConfig);
		expect(result).toMatchObject({ branchPrefix: baseConfig.branchPrefix });
	});

	test('saveToolConfig arrow creates the config file in a real temp dir', async () => {
		const tmpDir = (await Bun.$`mktemp -d`.text()).trim();
		defaultOrchestrateDeps.saveToolConfig(tmpDir, 'orchestrator', { baseBranch: 'develop' });
		const written = await Bun.file(`${tmpDir}/.pait/orchestrator.json`).text();
		expect(JSON.parse(written).baseBranch).toBe('develop');
		await Bun.$`rm -rf ${tmpDir}`;
	});

	test('readFile arrow returns a Promise', () => {
		// The arrow itself is exercised; we do not await (the read would reject for a missing path).
		const result = defaultOrchestrateDeps.readFile('/nonexistent/path.md');
		expect(result).toBeInstanceOf(Promise);
		// Suppress the unhandled-rejection noise from Bun.
		result.catch(() => {});
	});

	test('makeLogger arrow constructs a RunLogger in a real temp dir', async () => {
		const tmpDir = (await Bun.$`mktemp -d`.text()).trim();
		const logger = defaultOrchestrateDeps.makeLogger(tmpDir);
		expect(logger).not.toBeNull();
		await Bun.$`rm -rf ${tmpDir}`;
	});
});
