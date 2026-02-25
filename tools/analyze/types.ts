// ─── Types ──────────────────────────────────────────────────────────────────

export interface RefactorFlags {
	path: string;
	threshold: number | null;
	tier1Only: boolean;
	issues: boolean;
	dryRun: boolean;
	format: 'terminal' | 'json';
	budget: number;
	include: string | null;
	verbose: boolean;
}

export interface LanguageProfile {
	name: string;
	extensions: string[];
	softThreshold: number;
	hardThreshold: number;
	exportPattern: RegExp;
	functionPattern: RegExp;
	classPattern: RegExp;
	importPattern: RegExp;
}

export interface Tier1Result {
	file: string;
	relativePath: string;
	language: string;
	lineCount: number;
	exportCount: number;
	functionCount: number;
	classCount: number;
	importCount: number;
	softThreshold: number;
	hardThreshold: number;
	severity: 'ok' | 'warn' | 'critical';
	signals: string[];
}

export interface Responsibility {
	name: string;
	description: string;
	lineRanges: string;
}

export interface SplitSuggestion {
	filename: string;
	responsibilities: string[];
	rationale: string;
}

export interface Tier2Result {
	file: string;
	responsibilities: Responsibility[];
	suggestions: SplitSuggestion[];
	principles: string[];
	effort: 'low' | 'medium' | 'high';
	summary: string;
}

export interface AnalysisResult {
	file: string;
	relativePath: string;
	tier1: Tier1Result;
	tier2: Tier2Result | null;
	cached: boolean;
}

export interface CacheEntry {
	hash: string;
	timestamp: string;
	result: Tier2Result;
}

export interface AnalysisCache {
	entries: Record<string, CacheEntry>;
}

export interface RefactorReport {
	timestamp: string;
	targetPath: string;
	totalFiles: number;
	analyzedFiles: number;
	flaggedFiles: number;
	aiAnalyzed: number;
	cacheHits: number;
	results: AnalysisResult[];
	summary: ReportSummary;
}

export interface ReportSummary {
	critical: number;
	warnings: number;
	ok: number;
	topOffenders: { file: string; lineCount: number; signals: number }[];
	estimatedEffort: string;
}

export interface IssueData {
	title: string;
	body: string;
	labels: string[];
	/** Relative file path this issue targets (used for dedup check). */
	relativePath?: string;
	/** Issue numbers this issue depends on (used for Depends on markers). */
	dependsOn?: number[];
}

// ─── Tier 3 Types ─────────────────────────────────────────────────────────────

/** A consolidated cross-file issue produced by Tier 3 analysis. */
export interface ConsolidatedIssue {
	/** Short title for the GitHub issue. */
	title: string;
	/** Markdown body describing what to extract and where. */
	body: string;
	/** Relative paths of source files this issue covers. */
	files: string[];
	/** IDs (relativePath) of per-file issues this consolidated issue supersedes. */
	supersedes: string[];
}

/** A dependency relationship between two per-file issues. */
export interface Tier3Dependency {
	/** relativePath of the issue that must be resolved first. */
	prerequisite: string;
	/** relativePath of the issue that depends on the prerequisite. */
	dependent: string;
	/** Human-readable reason for the dependency. */
	reason: string;
}

/** Full output of the Tier 3 consolidation pass. */
export interface Tier3Result {
	/** Cross-file shared-module extraction issues. */
	consolidatedIssues: ConsolidatedIssue[];
	/** Dependency edges between per-file issues. */
	dependencies: Tier3Dependency[];
	/** One-paragraph summary of cross-file patterns found. */
	summary: string;
}
