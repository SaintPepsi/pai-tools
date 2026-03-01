import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { makeLog, Spinner, defaultLogDeps, type LogDeps } from './log.ts';

function makeDeps(): LogDeps & { logs: unknown[][]; errors: unknown[][]; written: string[] } {
	const logs: unknown[][] = [];
	const errors: unknown[][] = [];
	const written: string[] = [];
	return {
		log: (...args) => { logs.push(args); },
		error: (...args) => { errors.push(args); },
		stdout: { write: (s: string) => { written.push(s); } },
		logs,
		errors,
		written,
	};
}

describe('makeLog', () => {
	test('info writes [INFO] with cyan escape', () => {
		const deps = makeDeps();
		const log = makeLog(deps);
		log.info('hello');
		expect(deps.logs.length).toBe(1);
		expect(String(deps.logs[0][0])).toContain('[INFO]');
		expect(String(deps.logs[0][0])).toContain('hello');
		expect(String(deps.logs[0][0])).toContain('\x1b[36m');
	});

	test('ok writes [OK] with green escape', () => {
		const deps = makeDeps();
		const log = makeLog(deps);
		log.ok('done');
		expect(deps.logs.length).toBe(1);
		expect(String(deps.logs[0][0])).toContain('[OK]');
		expect(String(deps.logs[0][0])).toContain('done');
		expect(String(deps.logs[0][0])).toContain('\x1b[32m');
	});

	test('warn writes [WARN] with yellow escape', () => {
		const deps = makeDeps();
		const log = makeLog(deps);
		log.warn('careful');
		expect(deps.logs.length).toBe(1);
		expect(String(deps.logs[0][0])).toContain('[WARN]');
		expect(String(deps.logs[0][0])).toContain('careful');
		expect(String(deps.logs[0][0])).toContain('\x1b[33m');
	});

	test('error writes [ERROR] with red escape via deps.error', () => {
		const deps = makeDeps();
		const log = makeLog(deps);
		log.error('boom');
		expect(deps.logs.length).toBe(0);
		expect(deps.errors.length).toBe(1);
		expect(String(deps.errors[0][0])).toContain('[ERROR]');
		expect(String(deps.errors[0][0])).toContain('boom');
		expect(String(deps.errors[0][0])).toContain('\x1b[31m');
	});

	test('step writes separator with magenta escape', () => {
		const deps = makeDeps();
		const log = makeLog(deps);
		log.step('phase one');
		expect(deps.logs.length).toBe(1);
		expect(String(deps.logs[0][0])).toContain('phase one');
		expect(String(deps.logs[0][0])).toContain('\x1b[35m');
		expect(String(deps.logs[0][0])).toContain('━━━');
	});

	test('dim writes message with dim escape', () => {
		const deps = makeDeps();
		const log = makeLog(deps);
		log.dim('subtle');
		expect(deps.logs.length).toBe(1);
		expect(String(deps.logs[0][0])).toContain('subtle');
		expect(String(deps.logs[0][0])).toContain('\x1b[2m');
	});
});

describe('defaultLogDeps', () => {
	test('defaultLogDeps.log calls console.log', () => {
		const spy = spyOn(console, 'log').mockImplementation(() => {});
		defaultLogDeps.log('test message');
		expect(spy).toHaveBeenCalledWith('test message');
		spy.mockRestore();
	});

	test('defaultLogDeps.error calls console.error', () => {
		const spy = spyOn(console, 'error').mockImplementation(() => {});
		defaultLogDeps.error('err message');
		expect(spy).toHaveBeenCalledWith('err message');
		spy.mockRestore();
	});
});

describe('Spinner', () => {
	let deps: ReturnType<typeof makeDeps>;
	let spinner: Spinner;

	beforeEach(() => {
		deps = makeDeps();
		spinner = new Spinner(deps);
	});

	test('start writes spinner frame to stdout', async () => {
		spinner.start('loading');
		await new Promise(r => setTimeout(r, 100));
		spinner.stop();
		expect(deps.written.some(s => s.includes('loading'))).toBe(true);
	});

	test('stop without message clears line but does not call log', () => {
		spinner.start('working');
		spinner.stop();
		expect(deps.written.some(s => s.includes('\r\x1b[K'))).toBe(true);
		expect(deps.logs.length).toBe(0);
	});

	test('stop with finalMessage calls deps.log', () => {
		spinner.start('working');
		spinner.stop('All done!');
		expect(deps.logs.length).toBe(1);
		expect(deps.logs[0][0]).toBe('All done!');
	});

	test('stop can be called without start (interval is null)', () => {
		// Should not throw even though interval was never set
		expect(() => spinner.stop()).not.toThrow();
		expect(deps.written.some(s => s.includes('\r\x1b[K'))).toBe(true);
	});

	test('stop clears interval so it does not keep writing', async () => {
		spinner.start('thinking');
		spinner.stop();
		const countAfterStop = deps.written.length;
		await new Promise(r => setTimeout(r, 100));
		// No new writes after stop
		expect(deps.written.length).toBe(countAfterStop);
	});

	test('start increments frame index on each tick', async () => {
		spinner.start('spinning');
		await new Promise(r => setTimeout(r, 200));
		spinner.stop();
		// Multiple frames should have been written
		const spinnerWrites = deps.written.filter(s => s.includes('spinning'));
		expect(spinnerWrites.length).toBeGreaterThan(1);
	});
});
