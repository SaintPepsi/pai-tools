import { describe, test, expect } from 'bun:test';
import { parseAnalyzeFlags } from './flags.ts';

describe('parseAnalyzeFlags', () => {
	// -- Happy paths for value-taking flags --------------------------------------

	test('parses --threshold with a numeric value', () => {
		const flags = parseAnalyzeFlags(['./src', '--threshold', '150']);
		expect(flags.threshold).toBe(150);
	});

	test('parses --budget with a numeric value', () => {
		const flags = parseAnalyzeFlags(['--budget', '20']);
		expect(flags.budget).toBe(20);
	});

	test('parses --format terminal', () => {
		const flags = parseAnalyzeFlags(['--format', 'terminal']);
		expect(flags.format).toBe('terminal');
	});

	test('parses --format json', () => {
		const flags = parseAnalyzeFlags(['--format', 'json']);
		expect(flags.format).toBe('json');
	});

	test('parses --include with a glob value', () => {
		const flags = parseAnalyzeFlags(['--include', '**/*.ts']);
		expect(flags.include).toBe('**/*.ts');
	});

	test('parses a positional path argument', () => {
		const flags = parseAnalyzeFlags(['./packages/core']);
		expect(flags.path).toBe('./packages/core');
	});

	// -- Bare boolean flags -------------------------------------------------------

	test('parses --tier1-only', () => {
		const flags = parseAnalyzeFlags(['--tier1-only']);
		expect(flags.tier1Only).toBe(true);
	});

	test('parses --issues', () => {
		const flags = parseAnalyzeFlags(['--issues']);
		expect(flags.issues).toBe(true);
	});

	test('parses --dry-run', () => {
		const flags = parseAnalyzeFlags(['--dry-run']);
		expect(flags.dryRun).toBe(true);
	});

	test('parses --verbose', () => {
		const flags = parseAnalyzeFlags(['--verbose']);
		expect(flags.verbose).toBe(true);
	});

	test('parses --quiet sets verbose to false', () => {
		const flags = parseAnalyzeFlags(['--quiet']);
		expect(flags.verbose).toBe(false);
	});

	test('parses -q as alias for --quiet', () => {
		const flags = parseAnalyzeFlags(['-q']);
		expect(flags.verbose).toBe(false);
	});

	// -- Default values -----------------------------------------------------------

	test('returns defaults when no args are passed', () => {
		const flags = parseAnalyzeFlags([]);
		expect(flags.path).toBe('.');
		expect(flags.threshold).toBeNull();
		expect(flags.tier1Only).toBe(false);
		expect(flags.issues).toBe(false);
		expect(flags.dryRun).toBe(false);
		expect(flags.format).toBe('terminal');
		expect(flags.budget).toBe(50);
		expect(flags.include).toBeNull();
		expect(flags.verbose).toBe(true);
	});

	// -- Missing-value edge cases -------------------------------------------------

	test('--threshold with no following arg produces NaN', () => {
		const flags = parseAnalyzeFlags(['--threshold']);
		// parseInt(undefined, 10) => NaN; document this as known edge case
		expect(Number.isNaN(flags.threshold)).toBe(true);
	});

	test('--budget with no following arg produces NaN', () => {
		const flags = parseAnalyzeFlags(['--budget']);
		expect(Number.isNaN(flags.budget)).toBe(true);
	});

	test('--format with no following arg stores undefined', () => {
		const flags = parseAnalyzeFlags(['--format']);
		// args[++i] => undefined when flag is last arg; stored as-is
		expect(flags.format).toBeUndefined();
	});

	test('--include with no following arg stores undefined', () => {
		const flags = parseAnalyzeFlags(['--include']);
		expect(flags.include).toBeUndefined();
	});

	// -- Unknown flags ------------------------------------------------------------

	test('silently ignores unknown flags starting with -', () => {
		const flags = parseAnalyzeFlags(['--unknown-flag', '--another-unknown']);
		expect(flags.path).toBe('.');
		expect(flags.tier1Only).toBe(false);
	});

	test('treats non-flag argument as path', () => {
		const flags = parseAnalyzeFlags(['./my-dir']);
		expect(flags.path).toBe('./my-dir');
	});
});
