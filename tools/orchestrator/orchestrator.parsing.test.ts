import { describe, test, expect } from 'bun:test';
import { parseFlags } from './index.ts';
import { parseDependencies, toKebabSlug } from './dependency-graph.ts';

// ---------------------------------------------------------------------------
// parseFlags
// ---------------------------------------------------------------------------

describe('parseFlags', () => {
	test('defaults are all false/null with no args', () => {
		const flags = parseFlags([]);
		expect(flags.dryRun).toBe(false);
		expect(flags.reset).toBe(false);
		expect(flags.statusOnly).toBe(false);
		expect(flags.skipE2e).toBe(false);
		expect(flags.skipSplit).toBe(false);
		expect(flags.noVerify).toBe(false);
		expect(flags.singleMode).toBe(false);
		expect(flags.singleIssue).toBeNull();
		expect(flags.fromIssue).toBeNull();
	});

	test('boolean flags parse correctly', () => {
		const flags = parseFlags(['--dry-run', '--reset', '--status', '--skip-e2e', '--skip-split', '--no-verify']);
		expect(flags.dryRun).toBe(true);
		expect(flags.reset).toBe(true);
		expect(flags.statusOnly).toBe(true);
		expect(flags.skipE2e).toBe(true);
		expect(flags.skipSplit).toBe(true);
		expect(flags.noVerify).toBe(true);
	});

	test('--single without number sets singleMode but null singleIssue', () => {
		const flags = parseFlags(['--single']);
		expect(flags.singleMode).toBe(true);
		expect(flags.singleIssue).toBeNull();
	});

	test('--single with number sets both singleMode and singleIssue', () => {
		const flags = parseFlags(['--single', '115']);
		expect(flags.singleMode).toBe(true);
		expect(flags.singleIssue).toBe(115);
	});

	test('--single ignores non-numeric next arg', () => {
		const flags = parseFlags(['--single', '--dry-run']);
		expect(flags.singleMode).toBe(true);
		expect(flags.singleIssue).toBeNull();
		expect(flags.dryRun).toBe(true);
	});

	test('--from parses issue number', () => {
		const flags = parseFlags(['--from', '42']);
		expect(flags.fromIssue).toBe(42);
	});
});

// ---------------------------------------------------------------------------
// parseDependencies
// ---------------------------------------------------------------------------

describe('parseDependencies', () => {
	test('returns empty array when no dependency line', () => {
		expect(parseDependencies('Just a regular issue body')).toEqual([]);
	});

	test('parses single dependency', () => {
		expect(parseDependencies('Depends on #10')).toEqual([10]);
	});

	test('parses multiple dependencies', () => {
		expect(parseDependencies('Depends on #5, #10, #15')).toEqual([5, 10, 15]);
	});

	test('case insensitive matching', () => {
		expect(parseDependencies('DEPENDS ON #7')).toEqual([7]);
		expect(parseDependencies('depends on #7')).toEqual([7]);
	});

	test('finds dependency line in multi-line body', () => {
		const body = `## Description
Some work to do.

Depends on #3, #4

## Notes
More info here.`;
		expect(parseDependencies(body)).toEqual([3, 4]);
	});

	test('returns empty for body with no hash references', () => {
		expect(parseDependencies('Depends on nothing')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// toKebabSlug
// ---------------------------------------------------------------------------

describe('toKebabSlug', () => {
	test('converts basic title to kebab case', () => {
		expect(toKebabSlug('Add User Authentication')).toBe('add-user-authentication');
	});

	test('strips leading issue number prefix', () => {
		expect(toKebabSlug('[42] Fix login bug')).toBe('fix-login-bug');
	});

	test('replaces special characters with hyphens', () => {
		expect(toKebabSlug('Fix: memory leak (critical!)')).toBe('fix-memory-leak-critical');
	});

	test('strips leading and trailing hyphens', () => {
		expect(toKebabSlug('---hello world---')).toBe('hello-world');
	});

	test('truncates to 50 characters', () => {
		const longTitle = 'This is a very long issue title that exceeds the fifty character limit by quite a lot';
		const slug = toKebabSlug(longTitle);
		expect(slug.length).toBeLessThanOrEqual(50);
	});

	test('handles empty string', () => {
		expect(toKebabSlug('')).toBe('');
	});

	test('collapses multiple special chars into single hyphen', () => {
		expect(toKebabSlug('hello   &&&   world')).toBe('hello-world');
	});
});
