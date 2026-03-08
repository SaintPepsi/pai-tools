import { describe, test, expect } from 'bun:test';
import { parseDepsFlags } from 'tools/deps/flags.ts';

describe('parseDepsFlags', () => {
	// -- Subcommands -------------------------------------------------------------

	test('parses add subcommand', () => {
		const flags = parseDepsFlags(['add']);
		expect(flags.subcommand).toBe('add');
	});

	test('parses remove subcommand', () => {
		const flags = parseDepsFlags(['remove']);
		expect(flags.subcommand).toBe('remove');
	});

	test('parses list subcommand', () => {
		const flags = parseDepsFlags(['list']);
		expect(flags.subcommand).toBe('list');
	});

	test('parses tree subcommand', () => {
		const flags = parseDepsFlags(['tree']);
		expect(flags.subcommand).toBe('tree');
	});

	test('parses validate subcommand', () => {
		const flags = parseDepsFlags(['validate']);
		expect(flags.subcommand).toBe('validate');
	});

	test('parses sync subcommand', () => {
		const flags = parseDepsFlags(['sync']);
		expect(flags.subcommand).toBe('sync');
	});

	test('returns null subcommand for empty args', () => {
		const flags = parseDepsFlags([]);
		expect(flags.subcommand).toBeNull();
	});

	// -- Numeric flags -----------------------------------------------------------

	test('parses --issue with a numeric value', () => {
		const flags = parseDepsFlags(['--issue', '12']);
		expect(flags.issue).toBe(12);
	});

	test('parses --blocks with a numeric value', () => {
		const flags = parseDepsFlags(['--blocks', '5']);
		expect(flags.blocks).toBe(5);
	});

	test('parses --blocked-by with a numeric value', () => {
		const flags = parseDepsFlags(['--blocked-by', '10']);
		expect(flags.blockedBy).toBe(10);
	});

	test('parses --parent with a numeric value', () => {
		const flags = parseDepsFlags(['--parent', '3']);
		expect(flags.parent).toBe(3);
	});

	test('parses --child with a numeric value', () => {
		const flags = parseDepsFlags(['--child', '7']);
		expect(flags.child).toBe(7);
	});

	// -- Boolean flags -----------------------------------------------------------

	test('parses --apply', () => {
		const flags = parseDepsFlags(['--apply']);
		expect(flags.apply).toBe(true);
	});

	test('parses --json', () => {
		const flags = parseDepsFlags(['--json']);
		expect(flags.json).toBe(true);
	});

	// -- Default values ----------------------------------------------------------

	test('returns defaults when no args are passed', () => {
		const flags = parseDepsFlags([]);
		expect(flags.subcommand).toBeNull();
		expect(flags.issue).toBeNull();
		expect(flags.blocks).toBeNull();
		expect(flags.blockedBy).toBeNull();
		expect(flags.parent).toBeNull();
		expect(flags.child).toBeNull();
		expect(flags.apply).toBe(false);
		expect(flags.json).toBe(false);
		expect(flags.help).toBe(false);
	});

	// -- Combined usage ----------------------------------------------------------

	test('parses subcommand with numeric flags together', () => {
		const flags = parseDepsFlags(['add', '--issue', '12', '--blocked-by', '10']);
		expect(flags.subcommand).toBe('add');
		expect(flags.issue).toBe(12);
		expect(flags.blockedBy).toBe(10);
	});

	test('parses sync with --apply and --json', () => {
		const flags = parseDepsFlags(['sync', '--apply', '--json']);
		expect(flags.subcommand).toBe('sync');
		expect(flags.apply).toBe(true);
		expect(flags.json).toBe(true);
	});

	// -- Missing-value edge cases ------------------------------------------------

	test('--issue with no following arg produces NaN', () => {
		const flags = parseDepsFlags(['--issue']);
		expect(Number.isNaN(flags.issue)).toBe(true);
	});

	test('--blocks with no following arg produces NaN', () => {
		const flags = parseDepsFlags(['--blocks']);
		expect(Number.isNaN(flags.blocks)).toBe(true);
	});

	test('--blocked-by with no following arg produces NaN', () => {
		const flags = parseDepsFlags(['--blocked-by']);
		expect(Number.isNaN(flags.blockedBy)).toBe(true);
	});

	test('--parent with no following arg produces NaN', () => {
		const flags = parseDepsFlags(['--parent']);
		expect(Number.isNaN(flags.parent)).toBe(true);
	});

	test('--child with no following arg produces NaN', () => {
		const flags = parseDepsFlags(['--child']);
		expect(Number.isNaN(flags.child)).toBe(true);
	});

	// -- Unknown / unrecognized args ---------------------------------------------

	test('silently ignores unknown flags starting with -', () => {
		const flags = parseDepsFlags(['--unknown', 'list']);
		expect(flags.subcommand).toBe('list');
	});

	test('silently ignores unknown positional args', () => {
		const flags = parseDepsFlags(['notasubcommand']);
		expect(flags.subcommand).toBeNull();
	});
});
