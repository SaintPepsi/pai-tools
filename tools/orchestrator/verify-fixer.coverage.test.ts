/**
 * Coverage tests for verify-fixer.ts.
 *
 * Tests the behaviour of fixVerificationFailure via injected deps —
 * no live Claude agent required.
 */

import { describe, test, expect } from 'bun:test';
import { fixVerificationFailure } from 'tools/orchestrator/verify-fixer.ts';
import type { FixVerificationOptions, VerifyFixerDeps } from 'tools/orchestrator/verify-fixer.ts';
import type { RollingWindow } from 'shared/log.ts';
import type { OrchestratorConfig } from 'tools/orchestrator/types.ts';
import type { RunLogger } from 'shared/logging.ts';
import type { RunClaudeOpts } from 'shared/claude.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(verifyCmds: string[] = ['bun test']): OrchestratorConfig {
	return {
		branchPrefix: 'feat/',
		baseBranch: 'main',
		worktreeDir: '.pait/worktrees',
		models: { implement: 'sonnet', assess: 'haiku' },
		retries: { implement: 1, verify: 1 },
		allowedTools: 'Bash Edit Write Read',
		verify: verifyCmds.map((cmd) => ({ name: cmd, cmd })),
	};
}

function makeLogger(): RunLogger & { agentOutputCalls: { issueNumber: number; output: string }[] } {
	const agentOutputCalls: { issueNumber: number; output: string }[] = [];
	return {
		path: '/tmp/test-run.jsonl',
		agentOutput: (issueNumber: number, output: string) => {
			agentOutputCalls.push({ issueNumber, output });
		},
		agentOutputCalls,
	} as unknown as RunLogger & { agentOutputCalls: { issueNumber: number; output: string }[] };
}

type MockWindow = {
	updateCalls: string[];
	clearCount: number;
};

function makeMockDeps(opts: {
	output?: string;
	rejects?: boolean;
	onRun?: (runClaudeOpts: RunClaudeOpts) => void;
} = {}): { deps: VerifyFixerDeps; window: MockWindow; windowHeader: string[] } {
	const { output = 'fix output', rejects = false, onRun } = opts;

	const window: MockWindow = { updateCalls: [], clearCount: 0 };
	const windowHeader: string[] = [];

	const mockWindow = {
		update: (text: string) => window.updateCalls.push(text),
		clear: () => { window.clearCount++; },
	} as unknown as RollingWindow;

	const deps: VerifyFixerDeps = {
		makeWindow: (header, _logPath) => {
			windowHeader.push(header);
			return mockWindow;
		},
		runClaude: async (runOpts) => {
			onRun?.(runOpts);
			if (rejects) throw new Error('agent failed');
			runOpts.onChunk?.('chunk-a');
			runOpts.onChunk?.('chunk-b');
			return { ok: true, output };
		},
	};

	return { deps, window, windowHeader };
}

function makeOpts(overrides: Partial<FixVerificationOptions> = {}): FixVerificationOptions {
	return {
		issueNumber: 42,
		failedStep: 'bun test',
		errorOutput: 'Test failed: expected true',
		config: makeConfig(),
		worktreePath: '/tmp/worktree-42',
		logger: makeLogger(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// RollingWindow integration
// ---------------------------------------------------------------------------

describe('fixVerificationFailure — rolling window', () => {
	test('creates window with header containing issue number', async () => {
		const { deps, windowHeader } = makeMockDeps();
		await fixVerificationFailure(makeOpts({ issueNumber: 7 }), deps);
		expect(windowHeader[0]).toContain('7');
	});

	test('creates window using logger.path as logPath', async () => {
		let capturedLogPath = '';
		const logger = makeLogger();
		const deps: VerifyFixerDeps = {
			makeWindow: (_header, logPath) => {
				capturedLogPath = logPath;
				return { update: () => {}, clear: () => {} } as unknown as RollingWindow;
			},
			runClaude: async () => ({ ok: true, output: '' }),
		};
		await fixVerificationFailure(makeOpts({ logger }), deps);
		expect(capturedLogPath).toBe(logger.path);
	});

	test('wires onChunk to window.update', async () => {
		const { deps, window } = makeMockDeps();
		await fixVerificationFailure(makeOpts(), deps);
		expect(window.updateCalls).toEqual(['chunk-a', 'chunk-b']);
	});

	test('clears window after runClaude completes', async () => {
		const { deps, window } = makeMockDeps();
		await fixVerificationFailure(makeOpts(), deps);
		expect(window.clearCount).toBe(1);
	});

	test('clears window even when runClaude throws', async () => {
		const { deps, window } = makeMockDeps({ rejects: true });
		await fixVerificationFailure(makeOpts(), deps);
		expect(window.clearCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

describe('fixVerificationFailure — prompt', () => {
	test('prompt contains failed step', async () => {
		let capturedPrompt = '';
		const { deps } = makeMockDeps({ onRun: (o) => { capturedPrompt = o.prompt; } });
		await fixVerificationFailure(makeOpts({ failedStep: 'bun run typecheck' }), deps);
		expect(capturedPrompt).toContain('bun run typecheck');
	});

	test('prompt contains error output', async () => {
		let capturedPrompt = '';
		const { deps } = makeMockDeps({ onRun: (o) => { capturedPrompt = o.prompt; } });
		await fixVerificationFailure(makeOpts({ errorOutput: 'TypeError: null is not a function' }), deps);
		expect(capturedPrompt).toContain('TypeError: null is not a function');
	});

	test('prompt contains issue number', async () => {
		let capturedPrompt = '';
		const { deps } = makeMockDeps({ onRun: (o) => { capturedPrompt = o.prompt; } });
		await fixVerificationFailure(makeOpts({ issueNumber: 99 }), deps);
		expect(capturedPrompt).toContain('#99');
	});

	test('prompt lists all verify commands', async () => {
		let capturedPrompt = '';
		const { deps } = makeMockDeps({ onRun: (o) => { capturedPrompt = o.prompt; } });
		const config = makeConfig(['bun test', 'bun run typecheck']);
		await fixVerificationFailure(makeOpts({ config }), deps);
		expect(capturedPrompt).toContain('bun test');
		expect(capturedPrompt).toContain('bun run typecheck');
	});

	test('runClaude receives correct model and cwd', async () => {
		let capturedOpts: RunClaudeOpts | undefined;
		const { deps } = makeMockDeps({ onRun: (o) => { capturedOpts = o; } });
		const config = makeConfig();
		await fixVerificationFailure(makeOpts({ config, worktreePath: '/tmp/wt-55' }), deps);
		expect(capturedOpts?.model).toBe('sonnet');
		expect(capturedOpts?.cwd).toBe('/tmp/wt-55');
	});
});

// ---------------------------------------------------------------------------
// Logger interaction
// ---------------------------------------------------------------------------

describe('fixVerificationFailure — logger', () => {
	test('calls logger.agentOutput with issue number and output', async () => {
		const logger = makeLogger();
		const { deps } = makeMockDeps({ output: 'fixed successfully' });
		await fixVerificationFailure(makeOpts({ issueNumber: 12, logger }), deps);
		expect(logger.agentOutputCalls).toHaveLength(1);
		expect(logger.agentOutputCalls[0].issueNumber).toBe(12);
		expect(logger.agentOutputCalls[0].output).toBe('fixed successfully');
	});

	test('calls logger.agentOutput with empty output when runClaude throws', async () => {
		const logger = makeLogger();
		const { deps } = makeMockDeps({ rejects: true });
		await fixVerificationFailure(makeOpts({ logger }), deps);
		expect(logger.agentOutputCalls).toHaveLength(1);
		expect(logger.agentOutputCalls[0].output).toBe('');
	});

	test('does not throw when runClaude rejects', async () => {
		const { deps } = makeMockDeps({ rejects: true });
		await expect(fixVerificationFailure(makeOpts(), deps)).resolves.toBeUndefined();
	});
});
