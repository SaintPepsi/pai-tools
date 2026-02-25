import type {
	Tier1Result,
	Tier2Result,
	AnalysisResult,
	RefactorReport,
} from './types.ts';

export interface BuildReportParams {
	tier1Results: Tier1Result[];
	tier2Results: Map<string, Tier2Result>;
	cachedFiles: Set<string>;
	targetPath: string;
	totalFiles: number;
	cacheHits: number;
}

export function buildReport(params: BuildReportParams): RefactorReport {
	const { tier1Results, tier2Results, cachedFiles, targetPath, totalFiles, cacheHits } = params;

	const results: AnalysisResult[] = tier1Results.map(t1 => ({
		file: t1.file,
		relativePath: t1.relativePath,
		tier1: t1,
		tier2: tier2Results.get(t1.file) ?? null,
		cached: cachedFiles.has(t1.file),
	}));

	const critical = tier1Results.filter(r => r.severity === 'critical').length;
	const warnings = tier1Results.filter(r => r.severity === 'warn').length;
	const ok = tier1Results.filter(r => r.severity === 'ok').length;

	// flaggedFiles: count of files with severity !== 'ok' (i.e. 'warn' or 'critical')
	const flagged = tier1Results.filter(r => r.severity !== 'ok');
	const topOffenders = [...flagged]
		.sort((a, b) => b.signals.length - a.signals.length || b.lineCount - a.lineCount)
		.slice(0, 10)
		.map(r => ({ file: r.relativePath, lineCount: r.lineCount, signals: r.signals.length }));

	const estimatedEffort =
		critical > 10 ? 'Multiple sprints' :
		critical > 5 ? '1-2 sprints' :
		critical > 0 ? 'A few days' :
		warnings > 5 ? '1-2 days' :
		warnings > 0 ? 'A few hours' : 'None needed';

	return {
		timestamp: new Date().toISOString(),
		targetPath,
		totalFiles,
		analyzedFiles: tier1Results.length,
		flaggedFiles: flagged.length,
		aiAnalyzed: tier2Results.size,
		cacheHits,
		results,
		summary: {
			critical,
			warnings,
			ok,
			topOffenders,
			estimatedEffort,
		},
	};
}
