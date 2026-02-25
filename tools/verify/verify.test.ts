import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { $ } from 'bun';
import { runVerify, parseVerifyFlags } from './index.ts';
import type { VerifyCommand, VerifyOptions } from './types.ts';

describe('parseVerifyFlags', () => {
	test('parses --skip-e2e', () => {
		const flags = parseVerifyFlags(['--skip-e2e']);
		expect(flags.skipE2e).toBe(true);
		expect(flags.json).toBe(false);
	});

	test('parses --name <step>', () => {
		const flags = parseVerifyFlags(['--name', 'lint']);
		expect(flags.filterName).toBe('lint');
	});

	test('parses --json', () => {
		const flags = parseVerifyFlags(['--json']);
		expect(flags.json).toBe(true);
	});

	test('parses --help', () => {
		const flags = parseVerifyFlags(['--help']);
		expect(flags.help).toBe(true);
	});

	test('defaults to all false/null', () => {
		const flags = parseVerifyFlags([]);
		expect(flags.skipE2e).toBe(false);
		expect(flags.filterName).toBeNull();
		expect(flags.json).toBe(false);
		expect(flags.help).toBe(false);
	});
});

describe('runVerify', () => {
	let tempDir: string;

	function setup(): string {
		tempDir = mkdtempSync(join(tmpdir(), 'pai-verify-test-'));
		return tempDir;
	}

	function cleanup(): void {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	}

	test('all commands pass → ok: true, steps populated', async () => {
		const cwd = setup();
		try {
			const result = await runVerify({
				verify: [
					{ name: 'echo-test', cmd: 'echo ok' },
					{ name: 'true-test', cmd: 'true' }
				],
				cwd
			});

			expect(result.ok).toBe(true);
			expect(result.steps).toHaveLength(2);
			expect(result.steps[0].name).toBe('echo-test');
			expect(result.steps[0].ok).toBe(true);
			expect(result.steps[0].durationMs).toBeGreaterThanOrEqual(0);
			expect(result.steps[1].name).toBe('true-test');
			expect(result.steps[1].ok).toBe(true);
		} finally {
			cleanup();
		}
	});

	test('command fails → ok: false, failedStep set', async () => {
		const cwd = setup();
		try {
			const result = await runVerify({
				verify: [{ name: 'fail-test', cmd: 'exit 1' }],
				cwd
			});

			expect(result.ok).toBe(false);
			expect(result.failedStep).toBe('fail-test');
			expect(result.steps).toHaveLength(1);
			expect(result.steps[0].ok).toBe(false);
		} finally {
			cleanup();
		}
	});

	test('skip E2E when skipE2e is true', async () => {
		const cwd = setup();
		try {
			const result = await runVerify({
				verify: [{ name: 'check', cmd: 'true' }],
				e2e: { run: 'exit 1', update: 'true', snapshotGlob: '*.snap' },
				cwd,
				skipE2e: true
			});

			expect(result.ok).toBe(true);
			expect(result.steps).toHaveLength(1);
			// E2E not in steps
			expect(result.steps.find((s) => s.name === 'e2e')).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test('filterName runs only matching step', async () => {
		const cwd = setup();
		try {
			const result = await runVerify({
				verify: [
					{ name: 'lint', cmd: 'true' },
					{ name: 'test', cmd: 'true' },
					{ name: 'build', cmd: 'true' }
				],
				cwd,
				filterName: 'test'
			});

			expect(result.ok).toBe(true);
			expect(result.steps).toHaveLength(1);
			expect(result.steps[0].name).toBe('test');
		} finally {
			cleanup();
		}
	});

	test('empty verify list → ok: true, steps: []', async () => {
		const cwd = setup();
		try {
			const result = await runVerify({
				verify: [],
				cwd
			});

			expect(result.ok).toBe(true);
			expect(result.steps).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	test('first passes, second fails → partial results', async () => {
		const cwd = setup();
		try {
			const result = await runVerify({
				verify: [
					{ name: 'pass-step', cmd: 'true' },
					{ name: 'fail-step', cmd: 'exit 1' }
				],
				cwd
			});

			expect(result.ok).toBe(false);
			expect(result.failedStep).toBe('fail-step');
			expect(result.steps).toHaveLength(2);
			expect(result.steps[0].ok).toBe(true);
			expect(result.steps[1].ok).toBe(false);
		} finally {
			cleanup();
		}
	});

	test('logger receives pass/fail callbacks', async () => {
		const cwd = setup();
		try {
			const events: string[] = [];
			const logger = {
				verifyPass: (n: number, step: string) => events.push(`pass:${step}`),
				verifyFail: (n: number, step: string, err: string) => events.push(`fail:${step}`)
			};

			await runVerify({
				verify: [
					{ name: 'ok-step', cmd: 'true' },
					{ name: 'bad-step', cmd: 'exit 1' }
				],
				cwd,
				logger,
				issueNumber: 42
			});

			expect(events).toEqual(['pass:ok-step', 'fail:bad-step']);
		} finally {
			cleanup();
		}
	});
});
