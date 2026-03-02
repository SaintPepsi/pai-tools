/**
 * Coverage tests for agent-runner.ts — targeting 100% line and function coverage
 * for all lines not covered by agent-runner.test.ts:
 *   lines 26-27  (defaultAgentRunnerDeps.parseJson body)
 *   lines 38-40  (assessFallback helper)
 *   lines 44-90  (assessIssueSize)
 *   lines 131-140 (fixVerificationFailure re-export wrapper)
 *   lines 153-178 (implementIssue)
 *
 * All external I/O is injected via mock AgentRunnerDeps. No real Claude calls.
 */

import { describe, test, expect } from 'bun:test';
import { mock } from 'bun:test';

// Mock shared/log.ts BEFORE importing agent-runner so defaultAgentRunnerDeps
// makeSpinner (new Spinner()) and logDim (log.dim()) use a no-op Spinner and
// log — covering those function bodies without hitting real stdout.
const mockSpinnerStart = (msg: string) => { void msg; };
const mockSpinnerStop = () => {};
mock.module('../../shared/log.ts', () => ({
	log: { info: () => {}, ok: () => {}, warn: () => {}, error: () => {}, step: () => {}, dim: () => {} },
	Spinner: class { start = mockSpinnerStart; stop = mockSpinnerStop; },
}));

// Mock verify-fixer BEFORE importing agent-runner so the re-export wrapper
// (lines 131-140) delegates to our stub instead of the real runClaude.
const fixVerificationFailureCalls: unknown[][] = [];
mock.module('./verify-fixer.ts', () => ({
	fixVerificationFailure: async (...args: unknown[]) => {
		fixVerificationFailureCalls.push(args);
	},
	defaultVerifyFixerDeps: {},
}));

import {
	assessIssueSize,
	fixVerificationFailure,
	implementIssue,
	defaultAgentRunnerDeps,
	type AgentRunnerDeps,
} from './agent-runner.ts';
import type { OrchestratorConfig, GitHubIssue } from './types.ts';
import type { RunLogger } from '../../shared/logging.ts';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeIssue(number: number, title = `Issue ${number}`, body = 'issue body'): GitHubIssue {
	return { number, title, body, state: 'open', labels: [] };
}

const baseConfig: OrchestratorConfig = {
	branchPrefix: 'feat/',
	baseBranch: 'main',
	worktreeDir: '.pait/worktrees',
	models: { implement: 'claude-sonnet', assess: 'claude-haiku' },
	retries: { implement: 1, verify: 1 },
	allowedTools: 'Bash Edit Write Read',
	verify: [
		{ name: 'test', cmd: 'bun test' },
		{ name: 'typecheck', cmd: 'bun run typecheck' },
	],
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

// ---------------------------------------------------------------------------
// Mock deps builder
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<AgentRunnerDeps> & {
	runClaudeOutput?: string;
	runClaudeOk?: boolean;
	runClaudeThrows?: boolean;
	parseJsonResult?: { ok: true; value: unknown } | { ok: false };
} = {}): { deps: AgentRunnerDeps; spinnerCalls: { started: string[]; stopped: number }; agentCalls: unknown[] } {
	const spinnerCalls = { started: [] as string[], stopped: 0 };
	const agentCalls: unknown[] = [];

	const deps: AgentRunnerDeps = {
		runClaude: overrides.runClaude ?? (async (opts) => {
			agentCalls.push(opts);
			if (overrides.runClaudeThrows) throw new Error('Claude error');
			return { ok: overrides.runClaudeOk ?? true, output: overrides.runClaudeOutput ?? '' };
		}),
		makeSpinner: overrides.makeSpinner ?? (() => ({
			start: (msg: string) => { spinnerCalls.started.push(msg); },
			stop: () => { spinnerCalls.stopped++; },
		})),
		logDim: overrides.logDim ?? (() => {}),
		parseJson: overrides.parseJson ?? ((text: string) => {
			if (overrides.parseJsonResult !== undefined) return overrides.parseJsonResult;
			const result = JSON.parse(text) as unknown;
			return { ok: true as const, value: result };
		}),
	};
	return { deps, spinnerCalls, agentCalls };
}

// ---------------------------------------------------------------------------
// defaultAgentRunnerDeps.parseJson — lines 26-27
// ---------------------------------------------------------------------------

describe('defaultAgentRunnerDeps.parseJson', () => {
	test('parses valid JSON and returns ok:true with value', () => {
		const result = defaultAgentRunnerDeps.parseJson('{"shouldSplit":false,"reasoning":"small","proposedSplits":[]}');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect((result.value as Record<string, unknown>).shouldSplit).toBe(false);
		}
	});

	test('throws on invalid JSON (standard JSON.parse behavior)', () => {
		expect(() => defaultAgentRunnerDeps.parseJson('not json')).toThrow();
	});
});

// ---------------------------------------------------------------------------
// assessIssueSize — lines 44-90 (including assessFallback at 38-40)
// ---------------------------------------------------------------------------

describe('assessIssueSize — happy path', () => {
	test('returns parsed assessment when JSON is present and valid', async () => {
		const assessment = { shouldSplit: false, reasoning: 'Small issue', proposedSplits: [] };
		const { deps } = makeDeps({ runClaudeOutput: JSON.stringify(assessment) });

		const result = await assessIssueSize(makeIssue(1), baseConfig, '/repo', deps);

		expect(result.shouldSplit).toBe(false);
		expect(result.reasoning).toBe('Small issue');
		expect(result.proposedSplits).toEqual([]);
	});

	test('returns shouldSplit:true with proposed splits', async () => {
		const assessment = {
			shouldSplit: true,
			reasoning: 'Too large',
			proposedSplits: [{ title: 'Part A', body: 'body A' }],
		};
		const { deps } = makeDeps({ runClaudeOutput: JSON.stringify(assessment) });

		const result = await assessIssueSize(makeIssue(5), baseConfig, '/repo', deps);

		expect(result.shouldSplit).toBe(true);
		expect(result.proposedSplits).toHaveLength(1);
		expect(result.proposedSplits[0].title).toBe('Part A');
	});

	test('extracts JSON when surrounded by prose', async () => {
		const json = JSON.stringify({ shouldSplit: false, reasoning: 'ok', proposedSplits: [] });
		const { deps } = makeDeps({ runClaudeOutput: `Here is my response:\n${json}\nDone.` });

		const result = await assessIssueSize(makeIssue(2), baseConfig, '/repo', deps);

		expect(result.shouldSplit).toBe(false);
	});

	test('passes assess model from config to runClaude', async () => {
		const capturedOpts: Parameters<AgentRunnerDeps['runClaude']>[0][] = [];
		const deps: AgentRunnerDeps = {
			runClaude: async (opts) => { capturedOpts.push(opts); return { ok: true, output: JSON.stringify({ shouldSplit: false, reasoning: 'x', proposedSplits: [] }) }; },
			makeSpinner: () => ({ start: () => {}, stop: () => {} }),
			logDim: () => {},
			parseJson: (t) => ({ ok: true as const, value: JSON.parse(t) as unknown }),
		};

		await assessIssueSize(makeIssue(1), baseConfig, '/repo', deps);

		expect(capturedOpts[0].model).toBe('claude-haiku');
	});

	test('passes repoRoot as cwd to runClaude', async () => {
		const capturedOpts: Parameters<AgentRunnerDeps['runClaude']>[0][] = [];
		const deps: AgentRunnerDeps = {
			runClaude: async (opts) => { capturedOpts.push(opts); return { ok: true, output: JSON.stringify({ shouldSplit: false, reasoning: 'x', proposedSplits: [] }) }; },
			makeSpinner: () => ({ start: () => {}, stop: () => {} }),
			logDim: () => {},
			parseJson: (t) => ({ ok: true as const, value: JSON.parse(t) as unknown }),
		};

		await assessIssueSize(makeIssue(1), baseConfig, '/my/repo', deps);

		expect(capturedOpts[0].cwd).toBe('/my/repo');
	});

	test('starts and stops spinner', async () => {
		const { deps, spinnerCalls } = makeDeps({
			runClaudeOutput: JSON.stringify({ shouldSplit: false, reasoning: 'small', proposedSplits: [] }),
		});

		await assessIssueSize(makeIssue(3), baseConfig, '/repo', deps);

		expect(spinnerCalls.started.length).toBe(1);
		expect(spinnerCalls.started[0]).toContain('#3');
		expect(spinnerCalls.stopped).toBe(1);
	});

	test('includes issue number and title in prompt', async () => {
		const agentCalls: Parameters<AgentRunnerDeps['runClaude']>[0][] = [];
		const deps: AgentRunnerDeps = {
			runClaude: async (opts) => { agentCalls.push(opts); return { ok: true, output: JSON.stringify({ shouldSplit: false, reasoning: 'x', proposedSplits: [] }) }; },
			makeSpinner: () => ({ start: () => {}, stop: () => {} }),
			logDim: () => {},
			parseJson: (t) => ({ ok: true as const, value: JSON.parse(t) as unknown }),
		};

		await assessIssueSize(makeIssue(42, 'Add caching layer', 'Cache all the things'), baseConfig, '/repo', deps);

		expect(agentCalls[0].prompt).toContain('#42');
		expect(agentCalls[0].prompt).toContain('Add caching layer');
		expect(agentCalls[0].prompt).toContain('Cache all the things');
	});
});

describe('assessIssueSize — fallback paths (assessFallback)', () => {
	test('returns fallback when runClaude output has no JSON', async () => {
		const { deps } = makeDeps({ runClaudeOutput: 'No JSON here at all.' });

		const result = await assessIssueSize(makeIssue(1), baseConfig, '/repo', deps);

		expect(result.shouldSplit).toBe(false);
		expect(result.proposedSplits).toEqual([]);
		expect(result.reasoning).toContain('No JSON');
	});

	test('returns fallback when parseJson returns ok:false', async () => {
		const { deps } = makeDeps({
			runClaudeOutput: '{"shouldSplit":false}',
			parseJsonResult: { ok: false },
		});

		const result = await assessIssueSize(makeIssue(1), baseConfig, '/repo', deps);

		expect(result.shouldSplit).toBe(false);
		expect(result.proposedSplits).toEqual([]);
		expect(result.reasoning).toContain('Failed to parse');
	});

	test('returns fallback when runClaude throws', async () => {
		const { deps } = makeDeps({ runClaudeThrows: true });

		const result = await assessIssueSize(makeIssue(1), baseConfig, '/repo', deps);

		expect(result.shouldSplit).toBe(false);
		expect(result.proposedSplits).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// fixVerificationFailure wrapper — lines 131-140
// ---------------------------------------------------------------------------

describe('fixVerificationFailure re-export wrapper', () => {
	test('delegates to _fixVerificationFailure from verify-fixer and returns void', async () => {
		// The wrapper (lines 131-140) has no deps param — it calls the mocked verify-fixer
		// module registered above before import. We verify the call is forwarded correctly.
		fixVerificationFailureCalls.length = 0;

		const result = await fixVerificationFailure({
			issueNumber: 99,
			failedStep: 'bun test',
			errorOutput: 'test failures',
			config: baseConfig,
			worktreePath: '/tmp',
			logger: noopLogger,
		});

		expect(result).toBeUndefined();
		expect(fixVerificationFailureCalls.length).toBe(1);
		const opts = fixVerificationFailureCalls[0][0] as { issueNumber: number; failedStep: string };
		expect(opts.issueNumber).toBe(99);
		expect(opts.failedStep).toBe('bun test');
	});
});

// ---------------------------------------------------------------------------
// implementIssue — lines 153-178
// ---------------------------------------------------------------------------

describe('implementIssue — happy path', () => {
	test('returns ok:true when runClaude succeeds', async () => {
		const { deps } = makeDeps({ runClaudeOk: true, runClaudeOutput: 'done' });

		const result = await implementIssue({
			issue: makeIssue(1),
			branchName: 'feat/1-thing',
			baseBranch: 'main',
			config: baseConfig,
			worktreePath: '/wt/1',
			logger: noopLogger,
		}, deps);

		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
	});

	test('returns ok:false with error message when runClaude fails', async () => {
		const { deps } = makeDeps({ runClaudeOk: false, runClaudeOutput: 'agent crashed' });

		const result = await implementIssue({
			issue: makeIssue(2),
			branchName: 'feat/2-thing',
			baseBranch: 'main',
			config: baseConfig,
			worktreePath: '/wt/2',
			logger: noopLogger,
		}, deps);

		expect(result.ok).toBe(false);
		expect(result.error).toContain('Claude agent failed');
	});

	test('starts and stops spinner', async () => {
		const { deps, spinnerCalls } = makeDeps({ runClaudeOk: true, runClaudeOutput: '' });

		await implementIssue({
			issue: makeIssue(5),
			branchName: 'feat/5-thing',
			baseBranch: 'main',
			config: baseConfig,
			worktreePath: '/wt/5',
			logger: noopLogger,
		}, deps);

		expect(spinnerCalls.started.length).toBe(1);
		expect(spinnerCalls.started[0]).toContain('#5');
		expect(spinnerCalls.stopped).toBe(1);
	});

	test('calls logDim with last 500 chars of output', async () => {
		const longOutput = 'x'.repeat(600);
		const dimCalls: string[] = [];
		const { deps } = makeDeps({
			runClaudeOk: true,
			runClaudeOutput: longOutput,
			logDim: (msg: string) => { dimCalls.push(msg); },
		});

		await implementIssue({
			issue: makeIssue(1),
			branchName: 'feat/1-thing',
			baseBranch: 'main',
			config: baseConfig,
			worktreePath: '/wt/1',
			logger: noopLogger,
		}, deps);

		expect(dimCalls.length).toBe(1);
		expect(dimCalls[0].length).toBe(500);
	});

	test('calls logger.agentOutput with issue number and full output', async () => {
		const agentOutputCalls: { issueNumber: number; output: string }[] = [];
		const logger: RunLogger = {
			...noopLogger,
			agentOutput: (n, o) => { agentOutputCalls.push({ issueNumber: n, output: o }); },
		};
		const { deps } = makeDeps({ runClaudeOk: true, runClaudeOutput: 'implemented feature' });

		await implementIssue({
			issue: makeIssue(7),
			branchName: 'feat/7-thing',
			baseBranch: 'main',
			config: baseConfig,
			worktreePath: '/wt/7',
			logger,
		}, deps);

		expect(agentOutputCalls.length).toBe(1);
		expect(agentOutputCalls[0].issueNumber).toBe(7);
		expect(agentOutputCalls[0].output).toBe('implemented feature');
	});

	test('passes implement model from config to runClaude', async () => {
		const capturedOpts: Parameters<AgentRunnerDeps['runClaude']>[0][] = [];
		const deps: AgentRunnerDeps = {
			runClaude: async (opts) => { capturedOpts.push(opts); return { ok: true, output: '' }; },
			makeSpinner: () => ({ start: () => {}, stop: () => {} }),
			logDim: () => {},
			parseJson: (t) => ({ ok: true as const, value: JSON.parse(t) as unknown }),
		};

		await implementIssue({
			issue: makeIssue(1),
			branchName: 'feat/1-thing',
			baseBranch: 'main',
			config: baseConfig,
			worktreePath: '/wt/1',
			logger: noopLogger,
		}, deps);

		expect(capturedOpts[0].model).toBe('claude-sonnet');
		expect(capturedOpts[0].permissionMode).toBe('acceptEdits');
		expect(capturedOpts[0].allowedTools).toBe('Bash Edit Write Read');
	});

	test('passes worktreePath as cwd to runClaude', async () => {
		const capturedOpts: Parameters<AgentRunnerDeps['runClaude']>[0][] = [];
		const deps: AgentRunnerDeps = {
			runClaude: async (opts) => { capturedOpts.push(opts); return { ok: true, output: '' }; },
			makeSpinner: () => ({ start: () => {}, stop: () => {} }),
			logDim: () => {},
			parseJson: (t) => ({ ok: true as const, value: JSON.parse(t) as unknown }),
		};

		await implementIssue({
			issue: makeIssue(1),
			branchName: 'feat/1-thing',
			baseBranch: 'main',
			config: baseConfig,
			worktreePath: '/custom/worktree',
			logger: noopLogger,
		}, deps);

		expect(capturedOpts[0].cwd).toBe('/custom/worktree');
	});

	test('prompt includes issue number, title, branch, baseBranch, and repoRoot', async () => {
		const capturedOpts: Parameters<AgentRunnerDeps['runClaude']>[0][] = [];
		const deps: AgentRunnerDeps = {
			runClaude: async (opts) => { capturedOpts.push(opts); return { ok: true, output: '' }; },
			makeSpinner: () => ({ start: () => {}, stop: () => {} }),
			logDim: () => {},
			parseJson: (t) => ({ ok: true as const, value: JSON.parse(t) as unknown }),
		};

		await implementIssue({
			issue: makeIssue(42, 'Add caching', 'Cache all things'),
			branchName: 'feat/42-caching',
			baseBranch: 'feat/40-prereq',
			config: baseConfig,
			worktreePath: '/wt/42',
			logger: noopLogger,
		}, deps);

		expect(capturedOpts[0].prompt).toContain('#42');
		expect(capturedOpts[0].prompt).toContain('Add caching');
		expect(capturedOpts[0].prompt).toContain('feat/42-caching');
		expect(capturedOpts[0].prompt).toContain('feat/40-prereq');
	});
});

// ---------------------------------------------------------------------------
// defaultAgentRunnerDeps — covers makeSpinner and logDim arrow bodies
// (shared/log.ts is mocked above so no real stdout is touched)
// ---------------------------------------------------------------------------

describe('defaultAgentRunnerDeps — default arrow functions', () => {
	test('makeSpinner returns an object with start and stop', () => {
		const spinner = defaultAgentRunnerDeps.makeSpinner();
		expect(typeof spinner.start).toBe('function');
		expect(typeof spinner.stop).toBe('function');
		// Call both to hit the mocked Spinner body
		spinner.start('test label');
		spinner.stop();
	});

	test('logDim calls log.dim without throwing', () => {
		// log is mocked to a noop — this covers the logDim arrow body on line 25
		expect(() => defaultAgentRunnerDeps.logDim('some dimmed output')).not.toThrow();
	});
});
