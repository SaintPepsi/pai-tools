import { describe, test, expect } from 'bun:test';
import { parseFlags } from './flags.ts';
import type { FlagsDeps } from './flags.ts';

class ExitError extends Error {
	code: number;
	constructor(code: number) { super(`exit(${code})`); this.code = code; }
}

function makeDeps(): { deps: FlagsDeps; errors: string[] } {
	const errors: string[] = [];
	const deps: FlagsDeps = {
		exit: ((code: number) => { throw new ExitError(code); }) as (code: number) => never,
		logError: (msg: string) => { errors.push(msg); },
	};
	return { deps, errors };
}

describe('parseFlags — error branches', () => {
	test('--from with non-numeric value calls exit(1)', () => {
		const { deps, errors } = makeDeps();
		expect(() => parseFlags(['--from', 'abc'], deps)).toThrow(ExitError);
		expect(errors[0]).toContain('--from requires');
	});

	test('--from without a following arg calls exit(1)', () => {
		const { deps } = makeDeps();
		expect(() => parseFlags(['--from'], deps)).toThrow(ExitError);
	});

	test('--parallel with non-numeric value calls exit(1)', () => {
		const { deps, errors } = makeDeps();
		expect(() => parseFlags(['--parallel', 'abc'], deps)).toThrow(ExitError);
		expect(errors[0]).toContain('--parallel requires');
	});

	test('--parallel with zero calls exit(1)', () => {
		const { deps } = makeDeps();
		expect(() => parseFlags(['--parallel', '0'], deps)).toThrow(ExitError);
	});

	test('--parallel with negative calls exit(1)', () => {
		const { deps } = makeDeps();
		expect(() => parseFlags(['--parallel', '-1'], deps)).toThrow(ExitError);
	});

	test('--file without a following arg calls exit(1)', () => {
		const { deps, errors } = makeDeps();
		expect(() => parseFlags(['--file'], deps)).toThrow(ExitError);
		expect(errors[0]).toContain('--file requires');
	});

	test('--file with a flag-like value calls exit(1)', () => {
		const { deps } = makeDeps();
		expect(() => parseFlags(['--file', '--dry-run'], deps)).toThrow(ExitError);
	});

	test('--single with a numeric arg returns singleIssue', () => {
		const { deps } = makeDeps();
		const flags = parseFlags(['--single', '42'], deps);
		expect(flags.singleMode).toBe(true);
		expect(flags.singleIssue).toBe(42);
	});

	test('--single with no arg returns singleMode true, singleIssue null', () => {
		const { deps } = makeDeps();
		const flags = parseFlags(['--single'], deps);
		expect(flags.singleMode).toBe(true);
		expect(flags.singleIssue).toBeNull();
	});

	test('--single with flag-like next arg returns singleIssue null', () => {
		const { deps } = makeDeps();
		const flags = parseFlags(['--single', '--dry-run'], deps);
		expect(flags.singleMode).toBe(true);
		expect(flags.singleIssue).toBeNull();
	});

	test('--single with non-numeric arg returns singleIssue null', () => {
		const { deps } = makeDeps();
		const flags = parseFlags(['--single', 'abc'], deps);
		expect(flags.singleMode).toBe(true);
		expect(flags.singleIssue).toBeNull();
	});
});
