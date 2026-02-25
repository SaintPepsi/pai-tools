import { describe, test, expect } from 'bun:test';
import { topologicalSort } from './index.ts';
import type { IssueData } from './types.ts';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeIssue(key: string): { issueData: IssueData; key: string } {
	return {
		issueData: {
			title: `refactor(${key}): decompose`,
			body: '',
			labels: ['refactor'],
			relativePath: key,
		},
		key,
	};
}

// ─── topologicalSort ───────────────────────────────────────────────────────

describe('topologicalSort', () => {
	test('returns original order when no dependencies exist', () => {
		const pending = [makeIssue('a.ts'), makeIssue('b.ts'), makeIssue('c.ts')];
		const result = topologicalSort(pending, new Map());
		expect(result.map(p => p.key)).toEqual(['a.ts', 'b.ts', 'c.ts']);
	});

	test('places prerequisite before dependent', () => {
		const pending = [makeIssue('b.ts'), makeIssue('a.ts')];
		// b depends on a
		const depMap = new Map([['b.ts', new Set(['a.ts'])]]);
		const result = topologicalSort(pending, depMap);
		const keys = result.map(p => p.key);
		expect(keys.indexOf('a.ts')).toBeLessThan(keys.indexOf('b.ts'));
	});

	test('handles a linear chain A → B → C (C output first)', () => {
		const pending = [makeIssue('a.ts'), makeIssue('b.ts'), makeIssue('c.ts')];
		// a depends on b, b depends on c
		const depMap = new Map([
			['a.ts', new Set(['b.ts'])],
			['b.ts', new Set(['c.ts'])],
		]);
		const result = topologicalSort(pending, depMap);
		const keys = result.map(p => p.key);
		expect(keys.indexOf('c.ts')).toBeLessThan(keys.indexOf('b.ts'));
		expect(keys.indexOf('b.ts')).toBeLessThan(keys.indexOf('a.ts'));
	});

	test('does not duplicate nodes', () => {
		const pending = [makeIssue('a.ts'), makeIssue('b.ts'), makeIssue('c.ts')];
		// Both b and c depend on a
		const depMap = new Map([
			['b.ts', new Set(['a.ts'])],
			['c.ts', new Set(['a.ts'])],
		]);
		const result = topologicalSort(pending, depMap);
		expect(result.length).toBe(3);
		const keys = result.map(p => p.key);
		// a appears exactly once and before b and c
		expect(keys.filter(k => k === 'a.ts')).toHaveLength(1);
		expect(keys.indexOf('a.ts')).toBeLessThan(keys.indexOf('b.ts'));
		expect(keys.indexOf('a.ts')).toBeLessThan(keys.indexOf('c.ts'));
	});

	test('cycle A → B → A: all nodes appear in output (no silent drops)', () => {
		const pending = [makeIssue('a.ts'), makeIssue('b.ts')];
		// a depends on b, b depends on a (cycle)
		const depMap = new Map([
			['a.ts', new Set(['b.ts'])],
			['b.ts', new Set(['a.ts'])],
		]);
		const result = topologicalSort(pending, depMap);
		// Both nodes must appear — cycle must not cause silent data loss
		expect(result.length).toBe(2);
		const keys = result.map(p => p.key);
		expect(keys).toContain('a.ts');
		expect(keys).toContain('b.ts');
	});

	test('cycle with external: all nodes appear, non-cycle node still sorted first', () => {
		// d has no deps, a → b → a (cycle), c depends on d
		const pending = [
			makeIssue('a.ts'),
			makeIssue('b.ts'),
			makeIssue('c.ts'),
			makeIssue('d.ts'),
		];
		const depMap = new Map([
			['a.ts', new Set(['b.ts'])],
			['b.ts', new Set(['a.ts'])],
			['c.ts', new Set(['d.ts'])],
		]);
		const result = topologicalSort(pending, depMap);
		expect(result.length).toBe(4);
		const keys = result.map(p => p.key);
		// d must appear before c
		expect(keys.indexOf('d.ts')).toBeLessThan(keys.indexOf('c.ts'));
		// Both cycle nodes present
		expect(keys).toContain('a.ts');
		expect(keys).toContain('b.ts');
	});

	test('ignores prerequisites that are not in the pending list', () => {
		const pending = [makeIssue('a.ts')];
		// a depends on z.ts which is not in pending (already created or external)
		const depMap = new Map([['a.ts', new Set(['z.ts'])]]);
		const result = topologicalSort(pending, depMap);
		expect(result.length).toBe(1);
		expect(result[0].key).toBe('a.ts');
	});
});
