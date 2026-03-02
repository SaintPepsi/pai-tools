import { describe, test, expect, spyOn } from 'bun:test';
import { runClaude, defaultDeps, type ClaudeDeps, type ClaudeProcess, type RunClaudeOpts } from './claude.ts';

function makeProc(output: string, exitCode: number): ClaudeProcess {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(output);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
	return {
		stdout: stream,
		exited: Promise.resolve(exitCode),
	};
}

function makeDeps(output: string, exitCode: number): ClaudeDeps & {
	calls: Array<{ cmd: string[]; opts: Parameters<ClaudeDeps['spawn']>[1] }>;
} {
	const calls: Array<{ cmd: string[]; opts: Parameters<ClaudeDeps['spawn']>[1] }> = [];
	return {
		spawn: (cmd, opts) => {
			calls.push({ cmd, opts });
			return makeProc(output, exitCode);
		},
		env: { HOME: '/home/test', PATH: '/usr/bin' },
		calls,
	};
}

describe('runClaude', () => {
	test('returns ok:true and output when exit code is 0', async () => {
		const deps = makeDeps('some output text', 0);
		const opts: RunClaudeOpts = { prompt: 'hello', model: 'haiku', cwd: '/tmp' };
		const result = await runClaude(opts, deps);
		expect(result.ok).toBe(true);
		expect(result.output).toBe('some output text');
	});

	test('returns ok:false when exit code is non-zero', async () => {
		const deps = makeDeps('error output', 1);
		const opts: RunClaudeOpts = { prompt: 'hello', model: 'haiku', cwd: '/tmp' };
		const result = await runClaude(opts, deps);
		expect(result.ok).toBe(false);
	});

	test('always includes -p and --model args', async () => {
		const deps = makeDeps('', 0);
		await runClaude({ prompt: 'p', model: 'sonnet', cwd: '/tmp' }, deps);
		expect(deps.calls[0].cmd).toContain('-p');
		expect(deps.calls[0].cmd).toContain('--model');
		expect(deps.calls[0].cmd).toContain('sonnet');
	});

	test('includes --permission-mode when permissionMode is set', async () => {
		const deps = makeDeps('', 0);
		await runClaude({ prompt: 'p', model: 'haiku', cwd: '/tmp', permissionMode: 'bypassPermissions' }, deps);
		const cmd = deps.calls[0].cmd;
		expect(cmd).toContain('--permission-mode');
		expect(cmd).toContain('bypassPermissions');
	});

	test('omits --permission-mode when permissionMode is not set', async () => {
		const deps = makeDeps('', 0);
		await runClaude({ prompt: 'p', model: 'haiku', cwd: '/tmp' }, deps);
		expect(deps.calls[0].cmd).not.toContain('--permission-mode');
	});

	test('includes --allowedTools when allowedTools is set', async () => {
		const deps = makeDeps('', 0);
		await runClaude({ prompt: 'p', model: 'haiku', cwd: '/tmp', allowedTools: 'Bash Edit' }, deps);
		const cmd = deps.calls[0].cmd;
		expect(cmd).toContain('--allowedTools');
		expect(cmd).toContain('Bash Edit');
	});

	test('omits --allowedTools when allowedTools is not set', async () => {
		const deps = makeDeps('', 0);
		await runClaude({ prompt: 'p', model: 'haiku', cwd: '/tmp' }, deps);
		expect(deps.calls[0].cmd).not.toContain('--allowedTools');
	});

	test('spawn is called with claude as first command token', async () => {
		const deps = makeDeps('', 0);
		await runClaude({ prompt: 'p', model: 'haiku', cwd: '/tmp' }, deps);
		expect(deps.calls[0].cmd[0]).toBe('claude');
	});

	test('passes cwd from opts to spawn', async () => {
		const deps = makeDeps('', 0);
		await runClaude({ prompt: 'p', model: 'haiku', cwd: '/repo/myproject' }, deps);
		expect(deps.calls[0].opts.cwd).toBe('/repo/myproject');
	});

	test('env passed to spawn includes deps.env keys and CLAUDECODE empty string', async () => {
		const deps = makeDeps('', 0);
		await runClaude({ prompt: 'p', model: 'haiku', cwd: '/tmp' }, deps);
		const spawnEnv = deps.calls[0].opts.env;
		expect(spawnEnv['HOME']).toBe('/home/test');
		expect(spawnEnv['CLAUDECODE']).toBe('');
	});

	test('env skips undefined values from deps.env', async () => {
		const deps = makeDeps('', 0);
		(deps.env as Record<string, string | undefined>)['MAYBE_UNSET'] = undefined;
		await runClaude({ prompt: 'p', model: 'haiku', cwd: '/tmp' }, deps);
		const spawnEnv = deps.calls[0].opts.env;
		expect('MAYBE_UNSET' in spawnEnv).toBe(false);
	});

	test('stdin blob contains the prompt text', async () => {
		const deps = makeDeps('', 0);
		await runClaude({ prompt: 'my prompt content', model: 'haiku', cwd: '/tmp' }, deps);
		const blob = deps.calls[0].opts.stdin;
		const text = await blob.text();
		expect(text).toBe('my prompt content');
	});
});

describe('defaultDeps', () => {
	test('defaultDeps.spawn delegates to Bun.spawn', () => {
		const fakeProc = makeProc('hello', 0);
		const spy = spyOn(Bun, 'spawn').mockReturnValue(fakeProc as ReturnType<typeof Bun.spawn>);
		const opts = {
			cwd: '/tmp',
			stdin: new Blob(['prompt']),
			stdout: 'pipe' as const,
			stderr: 'pipe' as const,
			env: { TEST: 'value' },
		};
		const result = defaultDeps.spawn(['claude', '-p'], opts);
		expect(spy).toHaveBeenCalledWith(['claude', '-p'], opts);
		expect(result).toBe(fakeProc);
		spy.mockRestore();
	});
});
