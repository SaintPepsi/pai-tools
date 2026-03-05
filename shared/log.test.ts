import { describe, test, expect } from 'bun:test';
import { RollingWindow } from '@shared/log';

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
		// The second update must emit more writes (the clear + redraw)
		expect(output.length).toBeGreaterThan(firstDrawCount);
		// And the combined output must contain a cursor-up escape (the clear)
		const allOutput = output.join('');
		expect(allOutput).toContain('\x1b[');
		expect(allOutput).toContain('A');
	});
});
