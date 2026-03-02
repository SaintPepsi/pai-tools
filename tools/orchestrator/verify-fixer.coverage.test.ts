/**
 * Coverage tests for verify-fixer.ts — targeting 100% line and function coverage.
 *
 * All external deps (runClaude, makeSpinner) are injected via mock VerifyFixerDeps
 * objects. No real agent calls are made.
 */

import { describe, test, expect, mock } from 'bun:test';

// Mock shared/log.ts BEFORE importing verify-fixer so defaultVerifyFixerDeps
// makeSpinner (new Spinner()) uses a no-op class — covering that arrow body
// without hitting real stdout or starting a real interval.
mock.module('../../shared/log.ts', () => ({
	log: { info: () => {}, ok: () => {}, warn: () => {}, error: () => {}, step: () => {}, dim: () => {} },
	Spinner: class { start(_msg: string) {} stop() {} },
}));

import { fixVerificationFailure, defaultVerifyFixerDeps } from './verify-fixer.ts';
import type { VerifyFixerDeps } from './verify-fixer.ts';
import type { OrchestratorConfig } from './types.ts';
import type { RunLogger } from '../../shared/logging.ts';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

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

type SpinnerCalls = { started: string[]; stopped: number };

function makeDeps(overrides: Partial<VerifyFixerDeps> & {
	runClaudeResult?: { ok: boolean; output: string };
	runClaudeThrows?: boolean;
} = {}): { deps: VerifyFixerDeps; spinnerCalls: SpinnerCalls; agentCalls: { prompt: string; model: string; cwd: string }[] } {
	const spinnerCalls: SpinnerCalls = { started: [], stopped: 0 };
	const agentCalls: { prompt: string; model: string; cwd: string }[] = [];

	const defaultResult = overrides.runClaudeResult ?? { ok: true, output: 'Agent output text' };
	const shouldThrow = overrides.runClaudeThrows ?? false;

	const deps: VerifyFixerDeps = {
		runClaude: async (opts) => {
			agentCalls.push({ prompt: opts.prompt, model: opts.model ?? '', cwd: opts.cwd ?? '' });
			if (shouldThrow) throw new Error('Claude failed');
			return defaultResult;
		},
		makeSpinner: () => ({
			start: (msg: string) => { spinnerCalls.started.push(msg); },
			stop: () => { spinnerCalls.stopped++; },
		}),
		...('runClaude' in overrides && !overrides.runClaudeResult && !overrides.runClaudeThrows
			? { runClaude: overrides.runClaude! }
			: {}),
		...('makeSpinner' in overrides ? { makeSpinner: overrides.makeSpinner! } : {}),
	};

	return { deps, spinnerCalls, agentCalls };
}

// ---------------------------------------------------------------------------
// fixVerificationFailure — core behavior
// ---------------------------------------------------------------------------

describe('fixVerificationFailure — prompt construction', () => {
	test('includes the failed step name in prompt', async () => {
		const { deps, agentCalls } = makeDeps();
		await fixVerificationFailure({
			issueNumber: 42,
			failedStep: 'bun test',
			errorOutput: 'Tests failed: 3 failures',
			config: baseConfig,
			worktreePath: '/worktrees/42',
			logger: noopLogger,
		}, deps);

		expect(agentCalls.length).toBe(1);
		expect(agentCalls[0].prompt).toContain('"bun test"');
	});

	test('includes the issue number in prompt', async () => {
		const { deps, agentCalls } = makeDeps();
		await fixVerificationFailure({
			issueNumber: 7,
			failedStep: 'lint',
			errorOutput: 'lint error here',
			config: baseConfig,
			worktreePath: '/worktrees/7',
			logger: noopLogger,
		}, deps);

		expect(agentCalls[0].prompt).toContain('#7');
	});

	test('includes the error output in prompt', async () => {
		const { deps, agentCalls } = makeDeps();
		await fixVerificationFailure({
			issueNumber: 10,
			failedStep: 'typecheck',
			errorOutput: 'TS2345: argument is not assignable',
			config: baseConfig,
			worktreePath: '/worktrees/10',
			logger: noopLogger,
		}, deps);

		expect(agentCalls[0].prompt).toContain('TS2345: argument is not assignable');
	});

	test('lists all verify commands in prompt', async () => {
		const { deps, agentCalls } = makeDeps();
		await fixVerificationFailure({
			issueNumber: 5,
			failedStep: 'test',
			errorOutput: 'failing',
			config: baseConfig,
			worktreePath: '/wt',
			logger: noopLogger,
		}, deps);

		expect(agentCalls[0].prompt).toContain('- bun test');
		expect(agentCalls[0].prompt).toContain('- bun run typecheck');
	});

	test('passes worktreePath as cwd to runClaude', async () => {
		const { deps, agentCalls } = makeDeps();
		await fixVerificationFailure({
			issueNumber: 99,
			failedStep: 'test',
			errorOutput: '',
			config: baseConfig,
			worktreePath: '/custom/worktree/path',
			logger: noopLogger,
		}, deps);

		expect(agentCalls[0].cwd).toBe('/custom/worktree/path');
	});

	test('passes implement model from config to runClaude', async () => {
		const { deps, agentCalls } = makeDeps();
		await fixVerificationFailure({
			issueNumber: 3,
			failedStep: 'test',
			errorOutput: '',
			config: baseConfig,
			worktreePath: '/wt',
			logger: noopLogger,
		}, deps);

		expect(agentCalls[0].model).toBe('claude-sonnet');
	});
});

describe('fixVerificationFailure — spinner behavior', () => {
	test('starts spinner with default label when spinnerLabel is not provided', async () => {
		const { deps, spinnerCalls } = makeDeps();
		await fixVerificationFailure({
			issueNumber: 42,
			failedStep: 'test',
			errorOutput: '',
			config: baseConfig,
			worktreePath: '/wt',
			logger: noopLogger,
		}, deps);

		expect(spinnerCalls.started.length).toBe(1);
		expect(spinnerCalls.started[0]).toContain('#42');
	});

	test('starts spinner with custom spinnerLabel when provided', async () => {
		const { deps, spinnerCalls } = makeDeps();
		await fixVerificationFailure({
			issueNumber: 5,
			failedStep: 'test',
			errorOutput: '',
			config: baseConfig,
			worktreePath: '/wt',
			logger: noopLogger,
			spinnerLabel: '[#5] Agent fixing verification',
		}, deps);

		expect(spinnerCalls.started[0]).toBe('[#5] Agent fixing verification');
	});

	test('stops spinner after runClaude completes', async () => {
		const { deps, spinnerCalls } = makeDeps();
		await fixVerificationFailure({
			issueNumber: 1,
			failedStep: 'test',
			errorOutput: '',
			config: baseConfig,
			worktreePath: '/wt',
			logger: noopLogger,
		}, deps);

		expect(spinnerCalls.stopped).toBe(1);
	});

	test('stops spinner even when runClaude throws', async () => {
		const { deps, spinnerCalls } = makeDeps({ runClaudeThrows: true });
		await fixVerificationFailure({
			issueNumber: 1,
			failedStep: 'test',
			errorOutput: '',
			config: baseConfig,
			worktreePath: '/wt',
			logger: noopLogger,
		}, deps);

		// Should still stop spinner via the .catch() fallback
		expect(spinnerCalls.stopped).toBe(1);
	});
});

describe('fixVerificationFailure — logger behavior', () => {
	test('calls logger.agentOutput with issue number and agent output', async () => {
		const agentOutputCalls: { issueNumber: number; output: string }[] = [];
		const logger: RunLogger = {
			...noopLogger,
			agentOutput: (num, out) => { agentOutputCalls.push({ issueNumber: num, output: out }); },
		};

		const { deps } = makeDeps({ runClaudeResult: { ok: true, output: 'fixed the tests' } });
		await fixVerificationFailure({
			issueNumber: 17,
			failedStep: 'test',
			errorOutput: '',
			config: baseConfig,
			worktreePath: '/wt',
			logger,
		}, deps);

		expect(agentOutputCalls.length).toBe(1);
		expect(agentOutputCalls[0].issueNumber).toBe(17);
		expect(agentOutputCalls[0].output).toBe('fixed the tests');
	});

	test('calls logger.agentOutput with empty output when runClaude throws', async () => {
		const agentOutputCalls: { issueNumber: number; output: string }[] = [];
		const logger: RunLogger = {
			...noopLogger,
			agentOutput: (num, out) => { agentOutputCalls.push({ issueNumber: num, output: out }); },
		};

		const { deps } = makeDeps({ runClaudeThrows: true });
		await fixVerificationFailure({
			issueNumber: 8,
			failedStep: 'test',
			errorOutput: 'error',
			config: baseConfig,
			worktreePath: '/wt',
			logger,
		}, deps);

		expect(agentOutputCalls.length).toBe(1);
		expect(agentOutputCalls[0].issueNumber).toBe(8);
		expect(agentOutputCalls[0].output).toBe('');
	});
});

describe('fixVerificationFailure — runClaude options', () => {
	test('passes permissionMode acceptEdits to runClaude', async () => {
		const capturedOpts: Parameters<VerifyFixerDeps['runClaude']>[0][] = [];
		const deps: VerifyFixerDeps = {
			runClaude: async (opts) => { capturedOpts.push(opts); return { ok: true, output: '' }; },
			makeSpinner: () => ({ start: () => {}, stop: () => {} }),
		};

		await fixVerificationFailure({
			issueNumber: 1,
			failedStep: 'test',
			errorOutput: '',
			config: baseConfig,
			worktreePath: '/wt',
			logger: noopLogger,
		}, deps);

		expect(capturedOpts[0].permissionMode).toBe('acceptEdits');
	});

	test('passes allowedTools from config to runClaude', async () => {
		const capturedOpts: Parameters<VerifyFixerDeps['runClaude']>[0][] = [];
		const deps: VerifyFixerDeps = {
			runClaude: async (opts) => { capturedOpts.push(opts); return { ok: true, output: '' }; },
			makeSpinner: () => ({ start: () => {}, stop: () => {} }),
		};

		await fixVerificationFailure({
			issueNumber: 1,
			failedStep: 'test',
			errorOutput: '',
			config: baseConfig,
			worktreePath: '/wt',
			logger: noopLogger,
		}, deps);

		expect(capturedOpts[0].allowedTools).toBe('Bash Edit Write Read');
	});

	test('returns void (undefined) on success', async () => {
		const { deps } = makeDeps();
		const result = await fixVerificationFailure({
			issueNumber: 1,
			failedStep: 'test',
			errorOutput: '',
			config: baseConfig,
			worktreePath: '/wt',
			logger: noopLogger,
		}, deps);

		expect(result).toBeUndefined();
	});

	test('returns void (undefined) even when runClaude throws', async () => {
		const { deps } = makeDeps({ runClaudeThrows: true });
		const result = await fixVerificationFailure({
			issueNumber: 1,
			failedStep: 'test',
			errorOutput: '',
			config: baseConfig,
			worktreePath: '/wt',
			logger: noopLogger,
		}, deps);

		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// defaultVerifyFixerDeps — covers makeSpinner arrow body
// (shared/log.ts is mocked above so no real stdout is touched)
// ---------------------------------------------------------------------------

describe('defaultVerifyFixerDeps — default arrow functions', () => {
	test('makeSpinner returns an object with start and stop', () => {
		const spinner = defaultVerifyFixerDeps.makeSpinner();
		expect(typeof spinner.start).toBe('function');
		expect(typeof spinner.stop).toBe('function');
		spinner.start('test label');
		spinner.stop();
	});
});
