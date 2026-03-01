import { describe, test, expect } from 'bun:test';
import { $ } from 'bun';
import { verify, defaultVerifyDeps, type VerifyDeps } from './index.ts';
import { runVerify } from './runner.ts';
import type { VerifyFlags, VerifyOptions, VerifyResult } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFlags(overrides: Partial<VerifyFlags> = {}): VerifyFlags {
	return { skipE2e: false, filterName: null, json: false, help: false, ...overrides };
}

function makeDeps(overrides: Partial<VerifyDeps> = {}): { deps: VerifyDeps; logged: string[]; exited: number[] } {
	const logged: string[] = [];
	const exited: number[] = [];
	const deps: VerifyDeps = {
		log: (...args: unknown[]) => logged.push(args.map(String).join(' ')),
		exit: (code: number) => { exited.push(code); throw new Error(`process.exit(${code})`); },
		findRepoRoot: () => '/fake/repo',
		loadToolConfig: <T>(_root: string, _tool: string, defaults: T) => defaults,
		runVerify: async (_opts: VerifyOptions): Promise<VerifyResult> => ({ ok: true, steps: [] }),
		...overrides,
	};
	return { deps, logged, exited };
}

// ---------------------------------------------------------------------------
// verify() — help flag
// ---------------------------------------------------------------------------

describe('verify() — help flag', () => {
	test('prints help text and returns without calling runVerify', async () => {
		const { deps, logged } = makeDeps();
		let runVerifyCalled = false;
		deps.runVerify = async () => { runVerifyCalled = true; return { ok: true, steps: [] }; };

		await verify(makeFlags({ help: true }), deps);

		expect(logged.some((l) => l.includes('pait verify'))).toBe(true);
		expect(runVerifyCalled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// verify() — no config → exits with 1
// ---------------------------------------------------------------------------

describe('verify() — no commands configured', () => {
	test('exits 1 when verify is empty and no e2e', async () => {
		const { deps, exited } = makeDeps({
			loadToolConfig: <T>(_r: string, _t: string, defaults: T) => defaults as T,
		});

		await expect(verify(makeFlags(), deps)).rejects.toThrow('process.exit(1)');
		expect(exited).toEqual([1]);
	});

	test('does not exit when e2e is configured', async () => {
		const { deps, exited } = makeDeps({
			loadToolConfig: <T>(_r: string, _t: string, _defaults: T) => ({
				verify: [],
				e2e: { run: 'true', update: 'true', snapshotGlob: '*.snap' },
			} as unknown as T),
		});

		await verify(makeFlags(), deps);
		expect(exited).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// verify() — json output
// ---------------------------------------------------------------------------

describe('verify() — json flag', () => {
	test('prints JSON result and returns when --json', async () => {
		const result: VerifyResult = { ok: true, steps: [{ name: 'lint', ok: true, durationMs: 10 }] };
		const { deps, logged } = makeDeps({
			loadToolConfig: <T>(_r: string, _t: string, _d: T) => ({ verify: [{ name: 'lint', cmd: 'true' }] } as unknown as T),
			runVerify: async () => result,
		});

		await verify(makeFlags({ json: true }), deps);

		const jsonLine = logged.find((l) => l.startsWith('{'));
		expect(jsonLine).toBeDefined();
		const parsed = JSON.parse(jsonLine!);
		expect(parsed.ok).toBe(true);
		expect(parsed.steps[0].name).toBe('lint');
	});
});

// ---------------------------------------------------------------------------
// verify() — success path (non-json)
// ---------------------------------------------------------------------------

describe('verify() — success path', () => {
	test('logs steps on success', async () => {
		const result: VerifyResult = {
			ok: true,
			steps: [
				{ name: 'typecheck', ok: true, durationMs: 42 },
				{ name: 'test', ok: true, durationMs: 100 },
			],
		};
		const { deps } = makeDeps({
			loadToolConfig: <T>(_r: string, _t: string, _d: T) => ({ verify: [{ name: 'typecheck', cmd: 'tsc' }] } as unknown as T),
			runVerify: async () => result,
		});

		// Should complete without throwing
		await verify(makeFlags(), deps);
	});
});

// ---------------------------------------------------------------------------
// verify() — failure path (non-json)
// ---------------------------------------------------------------------------

describe('verify() — failure path', () => {
	test('logs step icons and exits 1 on failure', async () => {
		const result: VerifyResult = {
			ok: false,
			failedStep: 'test',
			error: 'tests failed',
			steps: [
				{ name: 'lint', ok: true, durationMs: 5 },
				{ name: 'test', ok: false, durationMs: 99, error: 'tests failed' },
			],
		};
		const { deps, logged, exited } = makeDeps({
			loadToolConfig: <T>(_r: string, _t: string, _d: T) => ({ verify: [{ name: 'lint', cmd: 'true' }, { name: 'test', cmd: 'exit 1' }] } as unknown as T),
			runVerify: async () => result,
		});

		await expect(verify(makeFlags(), deps)).rejects.toThrow('process.exit(1)');
		expect(exited).toEqual([1]);
		// Both step icon lines should be logged
		expect(logged.some((l) => l.includes('✓') && l.includes('lint'))).toBe(true);
		expect(logged.some((l) => l.includes('✗') && l.includes('test'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// defaultVerifyDeps
// ---------------------------------------------------------------------------

describe('defaultVerifyDeps', () => {
	test('exposes expected functions', () => {
		expect(typeof defaultVerifyDeps.log).toBe('function');
		expect(typeof defaultVerifyDeps.exit).toBe('function');
		expect(typeof defaultVerifyDeps.findRepoRoot).toBe('function');
		expect(typeof defaultVerifyDeps.loadToolConfig).toBe('function');
		expect(typeof defaultVerifyDeps.runVerify).toBe('function');
	});
});

// ---------------------------------------------------------------------------
// runVerify — E2E paths (uncovered in verify.test.ts)
// ---------------------------------------------------------------------------

describe('runVerify — E2E pass', () => {
	test('e2e passes on first run — adds e2e step', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		const result = await runVerify({
			verify: [],
			e2e: { run: 'true', update: 'true', snapshotGlob: '*.snap' },
			cwd: tmpDir,
			skipE2e: false,
		});

		expect(result.ok).toBe(true);
		expect(result.steps.some((s) => s.name === 'e2e' && s.ok)).toBe(true);
	});

	test('e2e passes after snapshot update — step name reflects update', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		// First run fails (exit 1), update succeeds (true), retry succeeds (true)
		// We script this by writing a counter file
		await Bun.write(`${tmpDir}/count`, '0');
		const runScript = `
			n=$(cat ${tmpDir}/count)
			echo $((n+1)) > ${tmpDir}/count
			[ "$n" -gt 0 ] && exit 0 || exit 1
		`;

		const result = await runVerify({
			verify: [],
			e2e: { run: `sh -c '${runScript}'`, update: 'true', snapshotGlob: '*.snap' },
			cwd: tmpDir,
			skipE2e: false,
		});

		expect(result.ok).toBe(true);
		expect(result.steps.some((s) => s.name.includes('after snapshot update') && s.ok)).toBe(true);
	});

	test('e2e fails even after snapshot update — returns ok:false', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		const result = await runVerify({
			verify: [],
			e2e: { run: 'exit 1', update: 'true', snapshotGlob: '*.snap' },
			cwd: tmpDir,
			skipE2e: false,
		});

		expect(result.ok).toBe(false);
		expect(result.failedStep).toBe('e2e');
		expect(result.steps.some((s) => s.name === 'e2e' && !s.ok)).toBe(true);
	});

	test('e2e logger callbacks fire on pass', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		const events: string[] = [];
		await runVerify({
			verify: [],
			e2e: { run: 'true', update: 'true', snapshotGlob: '*.snap' },
			cwd: tmpDir,
			skipE2e: false,
			issueNumber: 7,
			logger: {
				verifyPass: (_n, step) => events.push(`pass:${step}`),
				verifyFail: (_n, step) => events.push(`fail:${step}`),
			},
		});
		expect(events).toContain('pass:e2e');
	});

	test('e2e logger callbacks fire on fail', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		const events: string[] = [];
		await runVerify({
			verify: [],
			e2e: { run: 'exit 1', update: 'true', snapshotGlob: '*.snap' },
			cwd: tmpDir,
			skipE2e: false,
			issueNumber: 8,
			logger: {
				verifyPass: (_n, step) => events.push(`pass:${step}`),
				verifyFail: (_n, step) => events.push(`fail:${step}`),
			},
		});
		expect(events).toContain('fail:e2e');
	});

	test('e2e logger fires verifyPass after snapshot update', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		await Bun.write(`${tmpDir}/count2`, '0');
		const runScript = `
			n=$(cat ${tmpDir}/count2)
			echo $((n+1)) > ${tmpDir}/count2
			[ "$n" -gt 0 ] && exit 0 || exit 1
		`;
		const events: string[] = [];
		await runVerify({
			verify: [],
			e2e: { run: `sh -c '${runScript}'`, update: 'true', snapshotGlob: '*.snap' },
			cwd: tmpDir,
			skipE2e: false,
			issueNumber: 9,
			logger: {
				verifyPass: (_n, step) => events.push(`pass:${step}`),
				verifyFail: (_n, step) => events.push(`fail:${step}`),
			},
		});
		expect(events.some((e) => e.includes('pass:e2e'))).toBe(true);
	});
});
