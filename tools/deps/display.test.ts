import { describe, test, expect } from 'bun:test';
import { formatList, formatTree, formatValidation } from 'tools/deps/display.ts';
import type { IssueRelationships } from 'tools/deps/types.ts';
import type { GraphValidation } from 'tools/deps/graph.ts';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeIssue(number: number, overrides: Partial<IssueRelationships> = {}): IssueRelationships {
	return {
		id: number,
		number,
		title: `Issue ${number}`,
		state: 'OPEN',
		blockedBy: [],
		blocking: [],
		parent: null,
		subIssues: [],
		...overrides,
	};
}

// Strip ANSI escape codes for assertion clarity.
function strip(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// ─── formatList ───────────────────────────────────────────────────────────────

describe('formatList', () => {
	test('includes issue number and title', () => {
		const out = strip(formatList(makeIssue(42, { title: 'Do the thing' })));
		expect(out).toContain('#42');
		expect(out).toContain('Do the thing');
	});

	test('includes issue state', () => {
		const out = strip(formatList(makeIssue(1, { state: 'CLOSED' })));
		expect(out).toContain('CLOSED');
	});

	test('omits Blocked by section when empty', () => {
		const out = strip(formatList(makeIssue(1)));
		expect(out).not.toContain('Blocked by');
	});

	test('omits Blocking section when empty', () => {
		const out = strip(formatList(makeIssue(1)));
		expect(out).not.toContain('Blocking');
	});

	test('omits Parent line when null', () => {
		const out = strip(formatList(makeIssue(1)));
		expect(out).not.toContain('Parent');
	});

	test('omits Sub-issues section when empty', () => {
		const out = strip(formatList(makeIssue(1)));
		expect(out).not.toContain('Sub-issues');
	});

	test('renders blockedBy numbers', () => {
		const out = strip(formatList(makeIssue(5, { blockedBy: [2, 3] })));
		expect(out).toContain('Blocked by');
		expect(out).toContain('#2');
		expect(out).toContain('#3');
	});

	test('renders blocking numbers', () => {
		const out = strip(formatList(makeIssue(5, { blocking: [7, 8] })));
		expect(out).toContain('Blocking');
		expect(out).toContain('#7');
		expect(out).toContain('#8');
	});

	test('renders parent number', () => {
		const out = strip(formatList(makeIssue(5, { parent: 1 })));
		expect(out).toContain('Parent');
		expect(out).toContain('#1');
	});

	test('renders sub-issue numbers', () => {
		const out = strip(formatList(makeIssue(5, { subIssues: [10, 11] })));
		expect(out).toContain('Sub-issues');
		expect(out).toContain('#10');
		expect(out).toContain('#11');
	});

	test('fully populated issue shows all sections', () => {
		const rel = makeIssue(5, {
			blockedBy: [1],
			blocking: [9],
			parent: 2,
			subIssues: [6, 7],
		});
		const out = strip(formatList(rel));
		expect(out).toContain('Blocked by');
		expect(out).toContain('Blocking');
		expect(out).toContain('Parent');
		expect(out).toContain('Sub-issues');
	});
});

// ─── formatTree ───────────────────────────────────────────────────────────────

describe('formatTree', () => {
	test('returns placeholder for empty tiers', () => {
		const out = strip(formatTree([], new Map()));
		expect(out).toContain('no issues');
	});

	test('renders tier header with index', () => {
		const issues = new Map([[1, makeIssue(1)]]);
		const out = strip(formatTree([[1]], issues));
		expect(out).toContain('Tier 0');
	});

	test('renders issue number and title', () => {
		const issues = new Map([[3, makeIssue(3, { title: 'Build graph' })]]);
		const out = strip(formatTree([[3]], issues));
		expect(out).toContain('#3');
		expect(out).toContain('Build graph');
	});

	test('renders multiple tiers', () => {
		const issues = new Map([
			[1, makeIssue(1)],
			[2, makeIssue(2, { blockedBy: [1] })],
		]);
		const out = strip(formatTree([[1], [2]], issues));
		expect(out).toContain('Tier 0');
		expect(out).toContain('Tier 1');
		expect(out).toContain('#1');
		expect(out).toContain('#2');
	});

	test('renders blocker reference for blocked issues', () => {
		const issues = new Map([
			[1, makeIssue(1)],
			[2, makeIssue(2, { blockedBy: [1] })],
		]);
		const out = strip(formatTree([[1], [2]], issues));
		expect(out).toContain('blocked by #1');
	});

	test('shows (unknown) for issues not in the map', () => {
		const out = strip(formatTree([[99]], new Map()));
		expect(out).toContain('#99');
		expect(out).toContain('unknown');
	});

	test('tier header shows issue count', () => {
		const issues = new Map([[1, makeIssue(1)], [2, makeIssue(2)]]);
		const out = strip(formatTree([[1, 2]], issues));
		expect(out).toContain('2 issues');
	});

	test('tier header uses singular for one issue', () => {
		const issues = new Map([[1, makeIssue(1)]]);
		const out = strip(formatTree([[1]], issues));
		expect(out).toContain('1 issue');
		expect(out).not.toContain('1 issues');
	});
});

// ─── formatValidation ─────────────────────────────────────────────────────────

describe('formatValidation', () => {
	const validResult: GraphValidation = { cycles: [], missing: [], valid: true };

	test('returns valid message when no issues', () => {
		const out = strip(formatValidation(validResult));
		expect(out).toContain('valid');
	});

	test('valid message does not mention cycles or missing', () => {
		const out = strip(formatValidation(validResult));
		expect(out).not.toContain('Cycle');
		expect(out).not.toContain('Missing');
	});

	test('renders cycle with arrow path', () => {
		const out = strip(formatValidation({ cycles: [[1, 2]], missing: [], valid: false }));
		expect(out).toContain('#1');
		expect(out).toContain('#2');
		expect(out).toContain('→');
	});

	test('cycle path closes back to start', () => {
		const out = strip(formatValidation({ cycles: [[1, 2]], missing: [], valid: false }));
		// Should show #1 → #2 → #1
		expect(out).toMatch(/#1.*→.*#2.*→.*#1/);
	});

	test('renders missing dependency number', () => {
		const out = strip(formatValidation({ cycles: [], missing: [99], valid: false }));
		expect(out).toContain('#99');
		expect(out).toContain('Missing');
	});

	test('renders both cycles and missing deps', () => {
		const out = strip(formatValidation({ cycles: [[3, 4]], missing: [100], valid: false }));
		expect(out).toContain('Cycle');
		expect(out).toContain('Missing');
		expect(out).toContain('#3');
		expect(out).toContain('#100');
	});

	test('renders multiple cycles', () => {
		const out = strip(formatValidation({ cycles: [[1, 2], [5, 6]], missing: [], valid: false }));
		expect(out).toContain('#1');
		expect(out).toContain('#5');
	});

	test('renders multiple missing deps', () => {
		const out = strip(formatValidation({ cycles: [], missing: [10, 20], valid: false }));
		expect(out).toContain('#10');
		expect(out).toContain('#20');
	});
});
