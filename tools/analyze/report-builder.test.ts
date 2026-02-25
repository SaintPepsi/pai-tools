import { describe, test, expect } from 'bun:test';
import { buildReport } from './report-builder.ts';
import type { Tier1Result, Tier2Result } from './types.ts';

function makeTier1(overrides: Partial<Tier1Result> = {}): Tier1Result {
	return {
		file: '/project/src/foo.ts',
		relativePath: 'src/foo.ts',
		language: 'TypeScript',
		lineCount: 100,
		exportCount: 5,
		functionCount: 10,
		classCount: 1,
		importCount: 3,
		softThreshold: 200,
		hardThreshold: 400,
		severity: 'ok',
		signals: [],
		...overrides,
	};
}

describe('buildReport', () => {
	test('returns a RefactorReport with correct metadata', () => {
		const t1 = makeTier1();
		const report = buildReport({
			tier1Results: [t1],
			tier2Results: new Map(),
			cachedFiles: new Set(),
			targetPath: './src',
			totalFiles: 5,
			cacheHits: 0,
		});

		expect(report.targetPath).toBe('./src');
		expect(report.totalFiles).toBe(5);
		expect(report.analyzedFiles).toBe(1);
		expect(report.flaggedFiles).toBe(0);
		expect(report.aiAnalyzed).toBe(0);
		expect(report.cacheHits).toBe(0);
		expect(typeof report.timestamp).toBe('string');
	});

	test('correctly counts critical, warn, and ok severities', () => {
		const tier1Results = [
			makeTier1({ severity: 'critical', file: '/a.ts', relativePath: 'a.ts' }),
			makeTier1({ severity: 'critical', file: '/b.ts', relativePath: 'b.ts' }),
			makeTier1({ severity: 'warn', file: '/c.ts', relativePath: 'c.ts' }),
			makeTier1({ severity: 'ok', file: '/d.ts', relativePath: 'd.ts' }),
		];

		const report = buildReport({
			tier1Results,
			tier2Results: new Map(),
			cachedFiles: new Set(),
			targetPath: '.',
			totalFiles: 4,
			cacheHits: 0,
		});

		expect(report.summary.critical).toBe(2);
		expect(report.summary.warnings).toBe(1);
		expect(report.summary.ok).toBe(1);
		expect(report.flaggedFiles).toBe(3);
	});

	test('builds results with tier2 data when available', () => {
		const t1 = makeTier1({ severity: 'critical' });
		const t2: Tier2Result = {
			file: '/project/src/foo.ts',
			responsibilities: [],
			suggestions: [],
			principles: ['SRP'],
			effort: 'high',
			summary: 'Does too much',
		};
		const tier2Results = new Map([[t1.file, t2]]);

		const report = buildReport({
			tier1Results: [t1],
			tier2Results,
			cachedFiles: new Set(),
			targetPath: '.',
			totalFiles: 1,
			cacheHits: 0,
		});

		expect(report.results[0].tier2).toBe(t2);
		expect(report.results[0].cached).toBe(false);
	});

	test('marks results as cached when file is in cachedFiles', () => {
		const t1 = makeTier1({ severity: 'warn' });
		const cachedFiles = new Set([t1.file]);

		const report = buildReport({
			tier1Results: [t1],
			tier2Results: new Map(),
			cachedFiles,
			targetPath: '.',
			totalFiles: 1,
			cacheHits: 1,
		});

		expect(report.results[0].cached).toBe(true);
		expect(report.cacheHits).toBe(1);
	});

	test('sorts top offenders by signal count descending, then line count', () => {
		const tier1Results = [
			makeTier1({ file: '/a.ts', relativePath: 'a.ts', severity: 'critical', signals: ['x'], lineCount: 500 }),
			makeTier1({ file: '/b.ts', relativePath: 'b.ts', severity: 'critical', signals: ['x', 'y', 'z'], lineCount: 200 }),
			makeTier1({ file: '/c.ts', relativePath: 'c.ts', severity: 'warn', signals: ['x', 'y'], lineCount: 300 }),
		];

		const report = buildReport({
			tier1Results,
			tier2Results: new Map(),
			cachedFiles: new Set(),
			targetPath: '.',
			totalFiles: 3,
			cacheHits: 0,
		});

		const offenders = report.summary.topOffenders;
		expect(offenders[0].file).toBe('b.ts'); // 3 signals
		expect(offenders[1].file).toBe('c.ts'); // 2 signals
		expect(offenders[2].file).toBe('a.ts'); // 1 signal
	});

	test('limits top offenders to 10', () => {
		const tier1Results = Array.from({ length: 15 }, (_, i) =>
			makeTier1({ file: `/f${i}.ts`, relativePath: `f${i}.ts`, severity: 'critical', signals: ['x'] })
		);

		const report = buildReport({
			tier1Results,
			tier2Results: new Map(),
			cachedFiles: new Set(),
			targetPath: '.',
			totalFiles: 15,
			cacheHits: 0,
		});

		expect(report.summary.topOffenders.length).toBe(10);
	});

	test.each([
		[11, 0, 'Multiple sprints'],
		[6, 0, '1-2 sprints'],
		[1, 0, 'A few days'],
		[0, 6, '1-2 days'],
		[0, 1, 'A few hours'],
		[0, 0, 'None needed'],
	])('estimates effort: %i critical, %i warn → %s', (critCount, warnCount, expected) => {
		const tier1Results = [
			...Array.from({ length: critCount }, (_, i) =>
				makeTier1({ file: `/c${i}.ts`, relativePath: `c${i}.ts`, severity: 'critical' })
			),
			...Array.from({ length: warnCount }, (_, i) =>
				makeTier1({ file: `/w${i}.ts`, relativePath: `w${i}.ts`, severity: 'warn' })
			),
		];

		const report = buildReport({
			tier1Results,
			tier2Results: new Map(),
			cachedFiles: new Set(),
			targetPath: '.',
			totalFiles: tier1Results.length,
			cacheHits: 0,
		});

		expect(report.summary.estimatedEffort).toBe(expected);
	});
});
