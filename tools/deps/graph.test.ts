import { describe, test, expect } from 'bun:test';
import { buildDepsGraph, validateGraph, computeTiers } from 'tools/deps/graph.ts';
import type { IssueRelationships } from 'tools/deps/types.ts';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeIssue(number: number, blockedBy: number[] = []): IssueRelationships {
	return {
		id: number,
		number,
		title: `Issue ${number}`,
		state: 'OPEN',
		blockedBy,
		blocking: [],
		parent: null,
		subIssues: [],
	};
}

// ─── buildDepsGraph ───────────────────────────────────────────────────────────

describe('buildDepsGraph', () => {
	test('returns empty map for empty input', () => {
		const graph = buildDepsGraph([]);
		expect(graph.size).toBe(0);
	});

	test('creates one entry per issue', () => {
		const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
		const graph = buildDepsGraph(issues);
		expect(graph.size).toBe(3);
		expect(graph.has(1)).toBe(true);
		expect(graph.has(2)).toBe(true);
		expect(graph.has(3)).toBe(true);
	});

	test('maps issue number to its blockedBy array', () => {
		const issues = [makeIssue(1, [2, 3]), makeIssue(2), makeIssue(3)];
		const graph = buildDepsGraph(issues);
		expect(graph.get(1)).toEqual([2, 3]);
		expect(graph.get(2)).toEqual([]);
		expect(graph.get(3)).toEqual([]);
	});

	test('issue with no blockers maps to empty array', () => {
		const graph = buildDepsGraph([makeIssue(5)]);
		expect(graph.get(5)).toEqual([]);
	});
});

// ─── validateGraph ────────────────────────────────────────────────────────────

describe('validateGraph', () => {
	test('returns valid for empty graph', () => {
		const result = validateGraph(new Map());
		expect(result.valid).toBe(true);
		expect(result.cycles).toEqual([]);
		expect(result.missing).toEqual([]);
	});

	test('returns valid for acyclic graph with no missing deps', () => {
		const graph = new Map<number, number[]>([
			[1, []],
			[2, [1]],
			[3, [1, 2]],
		]);
		const result = validateGraph(graph);
		expect(result.valid).toBe(true);
		expect(result.cycles).toEqual([]);
		expect(result.missing).toEqual([]);
	});

	test('detects direct cycle A blocked-by B, B blocked-by A', () => {
		const graph = new Map<number, number[]>([
			[1, [2]],
			[2, [1]],
		]);
		const result = validateGraph(graph);
		expect(result.cycles.length).toBeGreaterThan(0);
		expect(result.valid).toBe(false);
	});

	test('detects three-node cycle A -> B -> C -> A', () => {
		const graph = new Map<number, number[]>([
			[1, [2]],
			[2, [3]],
			[3, [1]],
		]);
		const result = validateGraph(graph);
		expect(result.cycles.length).toBeGreaterThan(0);
		expect(result.valid).toBe(false);
	});

	test('cycle includes the nodes involved', () => {
		const graph = new Map<number, number[]>([
			[1, [2]],
			[2, [1]],
		]);
		const result = validateGraph(graph);
		const allCycleNodes = result.cycles.flat();
		expect(allCycleNodes).toContain(1);
		expect(allCycleNodes).toContain(2);
	});

	test('detects missing dependency', () => {
		const graph = new Map<number, number[]>([[1, [99]]]);
		const result = validateGraph(graph);
		expect(result.missing).toContain(99);
		expect(result.valid).toBe(false);
	});

	test('does not report known dep as missing', () => {
		const graph = new Map<number, number[]>([[1, [2]], [2, []]]);
		const result = validateGraph(graph);
		expect(result.missing).toEqual([]);
	});

	test('reports each missing dep only once even if referenced multiple times', () => {
		const graph = new Map<number, number[]>([
			[1, [99]],
			[3, [99]],
		]);
		const result = validateGraph(graph);
		expect(result.missing.filter(n => n === 99)).toHaveLength(1);
	});

	test('detects both cycles and missing deps in the same graph', () => {
		const graph = new Map<number, number[]>([
			[1, [2]],
			[2, [1]],  // cycle
			[3, [999]], // missing dep
		]);
		const result = validateGraph(graph);
		expect(result.cycles.length).toBeGreaterThan(0);
		expect(result.missing).toContain(999);
		expect(result.valid).toBe(false);
	});

	test('self-cycle counts as a cycle', () => {
		const graph = new Map<number, number[]>([[1, [1]]]);
		const result = validateGraph(graph);
		expect(result.cycles.length).toBeGreaterThan(0);
		expect(result.valid).toBe(false);
	});
});

// ─── computeTiers ─────────────────────────────────────────────────────────────

describe('computeTiers', () => {
	test('returns empty array for empty graph', () => {
		const result = computeTiers(new Map());
		expect(result).toEqual([]);
	});

	test('single unblocked issue goes to tier 0', () => {
		const graph = new Map<number, number[]>([[1, []]]);
		const result = computeTiers(graph);
		expect(result).toHaveLength(1);
		expect(result[0]).toContain(1);
	});

	test('all unblocked issues go to tier 0', () => {
		const graph = new Map<number, number[]>([[1, []], [2, []], [3, []]]);
		const result = computeTiers(graph);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual(expect.arrayContaining([1, 2, 3]));
	});

	test('issue blocked by tier-0 issue goes to tier 1', () => {
		const graph = new Map<number, number[]>([[1, []], [2, [1]]]);
		const result = computeTiers(graph);
		expect(result[0]).toContain(1);
		expect(result[1]).toContain(2);
	});

	test('linear chain produces one issue per tier', () => {
		const graph = new Map<number, number[]>([[1, []], [2, [1]], [3, [2]]]);
		const result = computeTiers(graph);
		expect(result).toHaveLength(3);
		expect(result[0]).toContain(1);
		expect(result[1]).toContain(2);
		expect(result[2]).toContain(3);
	});

	test('independent issues share a tier', () => {
		const graph = new Map<number, number[]>([
			[1, []],
			[2, []],
			[3, [1]],
			[4, [2]],
		]);
		const result = computeTiers(graph);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual(expect.arrayContaining([1, 2]));
		expect(result[1]).toEqual(expect.arrayContaining([3, 4]));
	});

	test('diamond dependency: two blockers both needed before dependent', () => {
		// 3 is blocked by both 1 and 2; 1 and 2 are unblocked
		const graph = new Map<number, number[]>([[1, []], [2, []], [3, [1, 2]]]);
		const result = computeTiers(graph);
		expect(result[0]).toEqual(expect.arrayContaining([1, 2]));
		expect(result[1]).toContain(3);
	});

	test('all issues in same tier when none block each other', () => {
		const graph = new Map<number, number[]>([[10, []], [20, []], [30, []]]);
		const result = computeTiers(graph);
		expect(result).toHaveLength(1);
		expect(result[0]).toHaveLength(3);
	});
});
