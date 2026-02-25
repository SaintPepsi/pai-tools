import { describe, test, expect } from 'bun:test';
import { buildIssueData, parseIssueNumber } from './github.ts';
import type { AnalysisResult, Tier1Result, Tier2Result } from './types.ts';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeTier1(overrides: Partial<Tier1Result> = {}): Tier1Result {
	return {
		file: '/project/src/foo.ts',
		relativePath: 'src/foo.ts',
		language: 'TypeScript',
		lineCount: 300,
		exportCount: 10,
		functionCount: 20,
		classCount: 2,
		importCount: 5,
		softThreshold: 200,
		hardThreshold: 400,
		severity: 'warn',
		signals: ['Large file'],
		...overrides,
	};
}

function makeResult(t1: Tier1Result, t2: Tier2Result | null = null): AnalysisResult {
	return {
		file: t1.file,
		relativePath: t1.relativePath,
		tier1: t1,
		tier2: t2,
		cached: false,
	};
}

// ─── buildIssueData ────────────────────────────────────────────────────────

describe('buildIssueData', () => {
	test('returns null when severity is ok and no tier2', () => {
		const result = makeResult(makeTier1({ severity: 'ok' }));
		expect(buildIssueData(result)).toBeNull();
	});

	test('returns IssueData with relativePath populated', () => {
		const t1 = makeTier1({ severity: 'warn', relativePath: 'src/bar.ts' });
		const issue = buildIssueData(makeResult(t1));
		expect(issue).not.toBeNull();
		expect(issue!.relativePath).toBe('src/bar.ts');
	});

	test('title includes split count when tier2 has suggestions', () => {
		const t1 = makeTier1({ severity: 'critical' });
		const t2: Tier2Result = {
			file: t1.file,
			responsibilities: [],
			suggestions: [
				{ filename: 'foo-a.ts', responsibilities: ['A'], rationale: 'r1' },
				{ filename: 'foo-b.ts', responsibilities: ['B'], rationale: 'r2' },
			],
			principles: [],
			effort: 'medium',
			summary: 'summary',
		};
		const issue = buildIssueData(makeResult(t1, t2));
		expect(issue!.title).toContain('split into 2 focused modules');
	});

	test('title uses decompose fallback when no split suggestions', () => {
		const t1 = makeTier1({ severity: 'warn', lineCount: 350 });
		const t2: Tier2Result = {
			file: t1.file,
			responsibilities: [],
			suggestions: [],
			principles: [],
			effort: 'low',
			summary: 'ok-ish',
		};
		const issue = buildIssueData(makeResult(t1, t2));
		expect(issue!.title).toContain('decompose file');
		expect(issue!.title).toContain('350 lines');
	});

	test('labels include priority:high for critical severity', () => {
		const t1 = makeTier1({ severity: 'critical' });
		const issue = buildIssueData(makeResult(t1));
		expect(issue!.labels).toContain('priority:high');
	});

	test('labels do not include priority:high for warn severity', () => {
		const t1 = makeTier1({ severity: 'warn' });
		const issue = buildIssueData(makeResult(t1));
		expect(issue!.labels).not.toContain('priority:high');
	});
});

// ─── parseIssueNumber ──────────────────────────────────────────────────────

describe('parseIssueNumber', () => {
	test('parses issue number from a standard GitHub URL', () => {
		const url = 'https://github.com/owner/repo/issues/42';
		expect(parseIssueNumber(url)).toBe(42);
	});

	test('parses issue number from URL with trailing newline', () => {
		const url = 'https://github.com/owner/repo/issues/99\n';
		expect(parseIssueNumber(url)).toBe(99);
	});

	test('returns null for non-issue URLs', () => {
		expect(parseIssueNumber('https://github.com/owner/repo')).toBeNull();
	});

	test('returns null for empty string', () => {
		expect(parseIssueNumber('')).toBeNull();
	});

	test('handles large issue numbers', () => {
		const url = 'https://github.com/owner/repo/issues/1234';
		expect(parseIssueNumber(url)).toBe(1234);
	});
});

// ─── IssueData.dependsOn / Depends on body injection ─────────────────────

describe('IssueData dependency fields', () => {
	test('buildIssueData sets no dependsOn by default', () => {
		const t1 = makeTier1({ severity: 'warn' });
		const issue = buildIssueData(makeResult(t1));
		expect(issue!.dependsOn).toBeUndefined();
	});

	test('IssueData can be extended with dependsOn numbers', () => {
		const t1 = makeTier1({ severity: 'warn' });
		const issue = buildIssueData(makeResult(t1))!;
		issue.dependsOn = [10, 11];
		expect(issue.dependsOn).toEqual([10, 11]);
	});
});
