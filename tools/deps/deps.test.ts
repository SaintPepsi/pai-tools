import { describe, test, expect } from 'bun:test';
import {
	handleAdd,
	handleRemove,
	handleList,
	handleTree,
	handleValidate,
	handleSync,
} from 'tools/deps/index.ts';
import type { DepsHandlerDeps } from 'tools/deps/index.ts';
import type { DepsFlags, IssueRelationships } from 'tools/deps/types.ts';

// ─── Test Helpers ──────────────────────────────────────────────────────────────

function makeFlags(overrides: Partial<DepsFlags> = {}): DepsFlags {
	return {
		subcommand: null,
		issue: null,
		blocks: null,
		blockedBy: null,
		parent: null,
		child: null,
		apply: false,
		json: false,
		help: false,
		...overrides,
	};
}

function makeRel(overrides: Partial<IssueRelationships> = {}): IssueRelationships {
	return {
		id: 1,
		number: 1,
		title: 'Test issue',
		state: 'OPEN',
		blockedBy: [],
		blocking: [],
		parent: null,
		subIssues: [],
		...overrides,
	};
}

function makeDeps(overrides: Partial<DepsHandlerDeps> = {}): DepsHandlerDeps {
	return {
		getRelationships: async () => makeRel(),
		addBlockedBy: async () => {},
		removeBlockedBy: async () => {},
		setParent: async () => {},
		addSubIssue: async () => {},
		removeSubIssue: async () => {},
		getAllRelationships: async () => [],
		listIssuesWithBodies: async () => [],
		stdout: () => {},
		stderr: () => {},
		...overrides,
	};
}

// ─── handleAdd ────────────────────────────────────────────────────────────────

describe('handleAdd', () => {
	test('calls addBlockedBy when --blocked-by is set', async () => {
		const calls: Array<[number, number]> = [];
		const d = makeDeps({ addBlockedBy: async (n, b) => { calls.push([n, b]); } });
		await handleAdd(makeFlags({ issue: 12, blockedBy: 10 }), d);
		expect(calls).toEqual([[12, 10]]);
	});

	test('calls addBlockedBy reversed when --blocks is set', async () => {
		const calls: Array<[number, number]> = [];
		const d = makeDeps({ addBlockedBy: async (n, b) => { calls.push([n, b]); } });
		// issue 12 blocks issue 15 → 15 is blocked by 12
		await handleAdd(makeFlags({ issue: 12, blocks: 15 }), d);
		expect(calls).toEqual([[15, 12]]);
	});

	test('calls setParent when --parent is set', async () => {
		const calls: Array<[number, number | null]> = [];
		const d = makeDeps({ setParent: async (n, p) => { calls.push([n, p]); } });
		await handleAdd(makeFlags({ issue: 12, parent: 5 }), d);
		expect(calls).toEqual([[12, 5]]);
	});

	test('calls addSubIssue when --child is set', async () => {
		const calls: Array<[number, number]> = [];
		const d = makeDeps({ addSubIssue: async (n, s) => { calls.push([n, s]); } });
		await handleAdd(makeFlags({ issue: 5, child: 12 }), d);
		expect(calls).toEqual([[5, 12]]);
	});

	test('outputs confirmation after adding blocked-by', async () => {
		const lines: string[] = [];
		const d = makeDeps({ stdout: (l) => lines.push(l) });
		await handleAdd(makeFlags({ issue: 12, blockedBy: 10 }), d);
		expect(lines[0]).toContain('#12');
		expect(lines[0]).toContain('#10');
	});
});

// ─── handleRemove ─────────────────────────────────────────────────────────────

describe('handleRemove', () => {
	test('calls removeBlockedBy when --blocked-by is set', async () => {
		const calls: Array<[number, number]> = [];
		const d = makeDeps({ removeBlockedBy: async (n, b) => { calls.push([n, b]); } });
		await handleRemove(makeFlags({ issue: 12, blockedBy: 10 }), d);
		expect(calls).toEqual([[12, 10]]);
	});

	test('calls removeBlockedBy reversed when --blocks is set', async () => {
		const calls: Array<[number, number]> = [];
		const d = makeDeps({ removeBlockedBy: async (n, b) => { calls.push([n, b]); } });
		await handleRemove(makeFlags({ issue: 12, blocks: 15 }), d);
		expect(calls).toEqual([[15, 12]]);
	});

	test('calls setParent(null) when --parent is set', async () => {
		const calls: Array<[number, number | null]> = [];
		const d = makeDeps({ setParent: async (n, p) => { calls.push([n, p]); } });
		await handleRemove(makeFlags({ issue: 12, parent: 5 }), d);
		expect(calls).toEqual([[12, null]]);
	});

	test('calls removeSubIssue when --child is set', async () => {
		const calls: Array<[number, number]> = [];
		const d = makeDeps({ removeSubIssue: async (n, s) => { calls.push([n, s]); } });
		await handleRemove(makeFlags({ issue: 5, child: 12 }), d);
		expect(calls).toEqual([[5, 12]]);
	});
});

// ─── handleList ───────────────────────────────────────────────────────────────

describe('handleList', () => {
	test('calls getRelationships with the correct issue number', async () => {
		const calls: number[] = [];
		const d = makeDeps({ getRelationships: async (n) => { calls.push(n); return makeRel({ number: n }); } });
		await handleList(makeFlags({ issue: 42 }), d);
		expect(calls).toEqual([42]);
	});

	test('outputs formatted text by default', async () => {
		const lines: string[] = [];
		const d = makeDeps({
			getRelationships: async () => makeRel({ number: 7, title: 'My issue' }),
			stdout: (l) => lines.push(l),
		});
		await handleList(makeFlags({ issue: 7 }), d);
		expect(lines.join('\n')).toContain('#7');
		expect(lines.join('\n')).toContain('My issue');
	});

	test('outputs JSON when --json flag is set', async () => {
		const lines: string[] = [];
		const rel = makeRel({ number: 7, blockedBy: [3] });
		const d = makeDeps({
			getRelationships: async () => rel,
			stdout: (l) => lines.push(l),
		});
		await handleList(makeFlags({ issue: 7, json: true }), d);
		const parsed = JSON.parse(lines.join(''));
		expect(parsed.number).toBe(7);
		expect(parsed.blockedBy).toEqual([3]);
	});
});

// ─── handleTree ───────────────────────────────────────────────────────────────

describe('handleTree', () => {
	test('calls getAllRelationships', async () => {
		let called = false;
		const d = makeDeps({ getAllRelationships: async () => { called = true; return []; } });
		await handleTree(makeFlags(), d);
		expect(called).toBe(true);
	});

	test('outputs JSON when --json flag is set', async () => {
		const lines: string[] = [];
		const rel = makeRel({ number: 1, blockedBy: [] });
		const d = makeDeps({
			getAllRelationships: async () => [rel],
			stdout: (l) => lines.push(l),
		});
		await handleTree(makeFlags({ json: true }), d);
		const parsed = JSON.parse(lines.join(''));
		expect(Array.isArray(parsed.tiers)).toBe(true);
		expect(Array.isArray(parsed.issues)).toBe(true);
	});

	test('produces tiered output for issues with dependencies', async () => {
		const lines: string[] = [];
		const rels = [
			makeRel({ number: 1, blockedBy: [] }),
			makeRel({ number: 2, blockedBy: [1] }),
		];
		const d = makeDeps({
			getAllRelationships: async () => rels,
			stdout: (l) => lines.push(l),
		});
		await handleTree(makeFlags(), d);
		const output = lines.join('\n');
		// Tier 0 has no blockers, Tier 1 has blockers resolved
		expect(output).toContain('Tier 0');
		expect(output).toContain('Tier 1');
	});
});

// ─── handleValidate ───────────────────────────────────────────────────────────

describe('handleValidate', () => {
	test('calls getAllRelationships', async () => {
		let called = false;
		const d = makeDeps({ getAllRelationships: async () => { called = true; return []; } });
		await handleValidate(makeFlags(), d);
		expect(called).toBe(true);
	});

	test('outputs valid message for a clean graph', async () => {
		const lines: string[] = [];
		const d = makeDeps({
			getAllRelationships: async () => [makeRel({ number: 1, blockedBy: [] })],
			stdout: (l) => lines.push(l),
		});
		await handleValidate(makeFlags(), d);
		expect(lines.join('\n')).toContain('valid');
	});

	test('outputs JSON validation result when --json flag is set', async () => {
		const lines: string[] = [];
		const d = makeDeps({
			getAllRelationships: async () => [makeRel({ number: 1, blockedBy: [] })],
			stdout: (l) => lines.push(l),
		});
		await handleValidate(makeFlags({ json: true }), d);
		const parsed = JSON.parse(lines.join(''));
		expect(parsed.valid).toBe(true);
		expect(Array.isArray(parsed.cycles)).toBe(true);
	});
});

// ─── handleSync ───────────────────────────────────────────────────────────────

describe('handleSync', () => {
	test('reports nothing when all text deps already have native relationships', async () => {
		const lines: string[] = [];
		const d = makeDeps({
			listIssuesWithBodies: async () => [
				{ number: 12, title: 'Feat', body: 'Depends on #10' },
			],
			getAllRelationships: async () => [
				makeRel({ number: 12, blockedBy: [10] }),
			],
			stdout: (l) => lines.push(l),
		});
		await handleSync(makeFlags(), d);
		expect(lines.join('\n')).toContain('already synced');
	});

	test('detects text-based deps not in native relationships', async () => {
		const lines: string[] = [];
		const d = makeDeps({
			listIssuesWithBodies: async () => [
				{ number: 12, title: 'Feat', body: 'Depends on #10' },
			],
			getAllRelationships: async () => [makeRel({ number: 12, blockedBy: [] })],
			stdout: (l) => lines.push(l),
		});
		await handleSync(makeFlags(), d);
		expect(lines.join('\n')).toContain('#12');
		expect(lines.join('\n')).toContain('#10');
	});

	test('does not call addBlockedBy without --apply', async () => {
		const calls: Array<[number, number]> = [];
		const d = makeDeps({
			listIssuesWithBodies: async () => [
				{ number: 12, title: 'Feat', body: 'Depends on #10' },
			],
			getAllRelationships: async () => [makeRel({ number: 12, blockedBy: [] })],
			addBlockedBy: async (n, b) => { calls.push([n, b]); },
		});
		await handleSync(makeFlags({ apply: false }), d);
		expect(calls).toEqual([]);
	});

	test('calls addBlockedBy when --apply is set', async () => {
		const calls: Array<[number, number]> = [];
		const d = makeDeps({
			listIssuesWithBodies: async () => [
				{ number: 12, title: 'Feat', body: 'Depends on #10' },
			],
			getAllRelationships: async () => [makeRel({ number: 12, blockedBy: [] })],
			addBlockedBy: async (n, b) => { calls.push([n, b]); },
		});
		await handleSync(makeFlags({ apply: true }), d);
		expect(calls).toEqual([[12, 10]]);
	});

	test('detects "Blocked by #N" pattern in issue body', async () => {
		const lines: string[] = [];
		const d = makeDeps({
			listIssuesWithBodies: async () => [
				{ number: 5, title: 'Issue', body: 'Blocked by #3' },
			],
			getAllRelationships: async () => [makeRel({ number: 5, blockedBy: [] })],
			stdout: (l) => lines.push(l),
		});
		await handleSync(makeFlags(), d);
		expect(lines.join('\n')).toContain('#5');
		expect(lines.join('\n')).toContain('#3');
	});
});
