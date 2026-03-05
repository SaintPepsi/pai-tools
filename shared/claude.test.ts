import { describe, test, expect } from 'bun:test';
import { runClaude } from 'shared/claude.ts';
import type { RunClaudeDeps } from 'shared/claude.ts';

function makeProc(chunks: string[], exitCode = 0) {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
	return {
		stdout: stream,
		stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
		exited: Promise.resolve(exitCode),
	};
}

function makeDeps(chunks: string[], exitCode = 0): RunClaudeDeps {
	return {
		spawn: (_cmd: string[], _opts: object) => makeProc(chunks, exitCode) as ReturnType<typeof Bun.spawn>,
		env: { HOME: '/home/test' },
	};
}

describe('runClaude', () => {
	test('returns concatenated output from all chunks', async () => {
		const result = await runClaude(
			{ prompt: 'test', model: 'claude-3', cwd: '/tmp' },
			makeDeps(['hello ', 'world']),
		);
		expect(result.ok).toBe(true);
		expect(result.output).toBe('hello world');
	});

	test('calls onChunk for each streamed chunk', async () => {
		const received: string[] = [];
		await runClaude(
			{ prompt: 'test', model: 'claude-3', cwd: '/tmp', onChunk: (c) => received.push(c) },
			makeDeps(['foo', 'bar', 'baz']),
		);
		expect(received).toEqual(['foo', 'bar', 'baz']);
	});

	test('onChunk chunks concatenate to full output', async () => {
		const received: string[] = [];
		const result = await runClaude(
			{ prompt: 'test', model: 'claude-3', cwd: '/tmp', onChunk: (c) => received.push(c) },
			makeDeps(['line1\n', 'line2\n', 'line3\n']),
		);
		expect(received.join('')).toBe(result.output);
	});

	test('works without onChunk provided', async () => {
		const result = await runClaude(
			{ prompt: 'test', model: 'claude-3', cwd: '/tmp' },
			makeDeps(['output']),
		);
		expect(result.output).toBe('output');
	});

	test('returns ok: false on non-zero exit code', async () => {
		const result = await runClaude(
			{ prompt: 'test', model: 'claude-3', cwd: '/tmp' },
			makeDeps(['error output'], 1),
		);
		expect(result.ok).toBe(false);
		expect(result.output).toBe('error output');
	});

	test('returns empty output for empty stream', async () => {
		const result = await runClaude(
			{ prompt: 'test', model: 'claude-3', cwd: '/tmp' },
			makeDeps([]),
		);
		expect(result.output).toBe('');
		expect(result.ok).toBe(true);
	});
});
