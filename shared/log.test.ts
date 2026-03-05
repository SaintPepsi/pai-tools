import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { makeLog, Spinner, RollingWindow, defaultLogDeps, type LogDeps } from '@shared/log.ts';

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
		expect(() => spinner.stop()).not.toThrow();
		expect(deps.written.some(s => s.includes('\r\x1b[K'))).toBe(true);
	});

	test('stop clears interval so it does not keep writing', async () => {
		spinner.start('thinking');
		spinner.stop();
		const countAfterStop = deps.written.length;
		await new Promise(r => setTimeout(r, 100));
		expect(deps.written.length).toBe(countAfterStop);
	});

	test('start increments frame index on each tick', async () => {
		spinner.start('spinning');
		await new Promise(r => setTimeout(r, 200));
		spinner.stop();
		const spinnerWrites = deps.written.filter(s => s.includes('spinning'));
		expect(spinnerWrites.length).toBeGreaterThan(1);
	});
});

describe('RollingWindow', () => {
	function makeWindow(opts?: {
		header?: string;
		logPath?: string;
		capacity?: number;
	}): { window: RollingWindow; output: string[] } {
		const output: string[] = [];
		const window = new RollingWindow({
			header: opts?.header ?? 'Test Header',
			logPath: opts?.logPath ?? '/tmp/test.log',
			capacity: opts?.capacity,
			deps: { write: (s: string) => output.push(s) },
		});
		return { window, output };
	}

	test('getLines returns empty array initially', () => {
		const { window } = makeWindow();
		expect(window.getLines()).toEqual([]);
	});

	test('update adds a single line to buffer', () => {
		const { window } = makeWindow();
		window.update('hello');
		expect(window.getLines()).toEqual(['hello']);
	});

	test('update splits multiline text and adds each non-empty line', () => {
		const { window } = makeWindow();
		window.update('line1\nline2\nline3');
		expect(window.getLines()).toEqual(['line1', 'line2', 'line3']);
	});

	test('update filters empty lines from multiline text', () => {
		const { window } = makeWindow();
		window.update('line1\n\nline2\n');
		expect(window.getLines()).toEqual(['line1', 'line2']);
	});

	test('buffer evicts oldest entries when capacity is exceeded', () => {
		const { window } = makeWindow({ capacity: 3 });
		window.update('a');
		window.update('b');
		window.update('c');
		window.update('d');
		expect(window.getLines()).toEqual(['b', 'c', 'd']);
	});

	test('default capacity is 10', () => {
		const { window } = makeWindow();
		for (let i = 1; i <= 11; i++) {
			window.update(`line${i}`);
		}
		const lines = window.getLines();
		expect(lines.length).toBe(10);
		expect(lines[0]).toBe('line2');
		expect(lines[9]).toBe('line11');
	});

	test('getLines returns a copy — mutations do not affect internal buffer', () => {
		const { window } = makeWindow();
		window.update('original');
		const lines = window.getLines();
		lines.push('injected');
		expect(window.getLines()).toEqual(['original']);
	});

	test('clear writes ANSI cursor-up and clear-to-end-of-screen escape', () => {
		const { window, output } = makeWindow({ capacity: 3 });
		window.update('a');
		output.length = 0;

		window.clear();

		expect(output.length).toBe(1);
		expect(output[0]).toContain('\x1b[');
		expect(output[0]).toContain('A');
		expect(output[0]).toContain('\x1b[J');
	});

	test('clear is a no-op when nothing has been rendered', () => {
		const { window, output } = makeWindow();
		window.clear();
		expect(output).toEqual([]);
	});

	test('clear after clear is a no-op (idempotent)', () => {
		const { window, output } = makeWindow();
		window.update('x');
		window.clear();
		output.length = 0;
		window.clear();
		expect(output).toEqual([]);
	});

	test('update renders header line', () => {
		const { window, output } = makeWindow({ header: 'My Task' });
		window.update('log line');
		const rendered = output.join('');
		expect(rendered).toContain('My Task');
	});

	test('update renders logPath footer line', () => {
		const { window, output } = makeWindow({ logPath: '/var/log/task.log' });
		window.update('log line');
		const rendered = output.join('');
		expect(rendered).toContain('/var/log/task.log');
	});

	test('update renders current buffer lines', () => {
		const { window, output } = makeWindow();
		window.update('first\nsecond');
		const rendered = output.join('');
		expect(rendered).toContain('first');
		expect(rendered).toContain('second');
	});

	test('second update clears previous output before redrawing', () => {
		const { window, output } = makeWindow();
		window.update('first');
		const firstDrawCount = output.length;
		window.update('second');
		expect(output.length).toBeGreaterThan(firstDrawCount);
		const allOutput = output.join('');
		expect(allOutput).toContain('\x1b[');
		expect(allOutput).toContain('A');
	});
});
