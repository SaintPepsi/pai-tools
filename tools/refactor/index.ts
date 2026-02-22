#!/usr/bin/env bun
/**
 * ============================================================================
 * REFACTOR — AI-powered file structure analyzer
 * ============================================================================
 *
 * Analyzes project files for structural issues using a two-tier approach:
 *   Tier 1: Fast heuristics (line count, export/function density, imports)
 *   Tier 2: AI semantic analysis (responsibility detection via Claude)
 *
 * Suggests which files need splitting based on SRP, DIP, DRY, and YAGNI.
 * Optionally creates GitHub issues for each recommendation.
 *
 * USAGE:
 *   pait refactor <path> [flags]
 *
 * FLAGS:
 *   --threshold <N>   Soft line threshold (default: auto per language)
 *   --tier1-only      Skip AI analysis, heuristics only
 *   --issues          Create GitHub issues for recommendations
 *   --dry-run         Show what issues would be created without creating them
 *   --format <type>   Output format: terminal (default) | json
 *   --budget <N>      Max AI analysis calls (default: 50)
 *   --include <glob>  Only analyze matching files (default: source files)
 *   --verbose         Show detailed analysis for all files, not just flagged
 *
 * EXAMPLES:
 *   pait refactor ./src
 *   pait refactor ./src --tier1-only
 *   pait refactor ./src --issues --dry-run
 *   pait refactor ./src --threshold 200 --format json
 *   pait refactor . --budget 10
 *
 * ============================================================================
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative, basename } from 'node:path';
import { log, Spinner } from '../../shared/log.ts';
import { runClaude } from '../../shared/claude.ts';
import { findRepoRoot, loadToolConfig } from '../../shared/config.ts';

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

interface LanguageProfile {
	name: string;
	extensions: string[];
	softThreshold: number;
	hardThreshold: number;
	exportPattern: RegExp;
	functionPattern: RegExp;
	classPattern: RegExp;
	importPattern: RegExp;
}

interface Tier1Result {
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

interface Responsibility {
	name: string;
	description: string;
	lineRanges: string;
}

interface SplitSuggestion {
	filename: string;
	responsibilities: string[];
	rationale: string;
}

interface Tier2Result {
	file: string;
	responsibilities: Responsibility[];
	suggestions: SplitSuggestion[];
	principles: string[];
	effort: 'low' | 'medium' | 'high';
	summary: string;
}

interface AnalysisResult {
	file: string;
	relativePath: string;
	tier1: Tier1Result;
	tier2: Tier2Result | null;
}

interface RefactorReport {
	timestamp: string;
	targetPath: string;
	totalFiles: number;
	analyzedFiles: number;
	flaggedFiles: number;
	aiAnalyzed: number;
	results: AnalysisResult[];
	summary: ReportSummary;
}

interface ReportSummary {
	critical: number;
	warnings: number;
	ok: number;
	topOffenders: { file: string; lineCount: number; signals: number }[];
	estimatedEffort: string;
}

// ─── Language Profiles ──────────────────────────────────────────────────────

const LANGUAGE_PROFILES: LanguageProfile[] = [
	{
		name: 'TypeScript',
		extensions: ['.ts', '.tsx'],
		softThreshold: 200,
		hardThreshold: 400,
		exportPattern: /^\s*export\s+(default\s+)?(function|class|const|let|var|interface|type|enum|abstract)/gm,
		functionPattern: /^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*(const|let|var)\s+\w+\s*=\s*(async\s+)?\(|^\s*(public|private|protected|static|async)\s+(async\s+)?\w+\s*\(/gm,
		classPattern: /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+\w+/gm,
		importPattern: /^\s*import\s+/gm,
	},
	{
		name: 'JavaScript',
		extensions: ['.js', '.jsx', '.mjs', '.cjs'],
		softThreshold: 200,
		hardThreshold: 400,
		exportPattern: /^\s*(export\s+(default\s+)?|module\.exports)/gm,
		functionPattern: /^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/gm,
		classPattern: /^\s*(export\s+)?(default\s+)?class\s+\w+/gm,
		importPattern: /^\s*(import\s+|const\s+\w+\s*=\s*require\()/gm,
	},
	{
		name: 'Python',
		extensions: ['.py'],
		softThreshold: 250,
		hardThreshold: 500,
		exportPattern: /^[a-zA-Z_]\w*\s*=/gm,  // Python: top-level assignments as "exports"
		functionPattern: /^\s*(async\s+)?def\s+\w+/gm,
		classPattern: /^\s*class\s+\w+/gm,
		importPattern: /^\s*(import\s+|from\s+\S+\s+import)/gm,
	},
	{
		name: 'Go',
		extensions: ['.go'],
		softThreshold: 300,
		hardThreshold: 600,
		exportPattern: /^func\s+[A-Z]|^type\s+[A-Z]|^var\s+[A-Z]/gm,
		functionPattern: /^func\s+/gm,
		classPattern: /^type\s+\w+\s+struct/gm,
		importPattern: /^\s*"[^"]+"/gm,
	},
	{
		name: 'Rust',
		extensions: ['.rs'],
		softThreshold: 300,
		hardThreshold: 600,
		exportPattern: /^\s*pub\s+(fn|struct|enum|trait|type|mod|const|static)/gm,
		functionPattern: /^\s*(pub\s+)?(async\s+)?fn\s+\w+/gm,
		classPattern: /^\s*(pub\s+)?(struct|enum|trait)\s+\w+/gm,
		importPattern: /^\s*use\s+/gm,
	},
	{
		name: 'Java',
		extensions: ['.java'],
		softThreshold: 250,
		hardThreshold: 500,
		exportPattern: /^\s*public\s+(class|interface|enum|record)/gm,
		functionPattern: /^\s*(public|private|protected|static|\s)+[\w<>\[\]]+\s+\w+\s*\(/gm,
		classPattern: /^\s*(public\s+)?(abstract\s+)?(class|interface|enum|record)\s+\w+/gm,
		importPattern: /^\s*import\s+/gm,
	},
	{
		name: 'C#',
		extensions: ['.cs'],
		softThreshold: 250,
		hardThreshold: 500,
		exportPattern: /^\s*public\s+(class|interface|enum|struct|record)/gm,
		functionPattern: /^\s*(public|private|protected|internal|static|async|virtual|override|\s)+[\w<>\[\]]+\s+\w+\s*\(/gm,
		classPattern: /^\s*(public\s+)?(abstract\s+|static\s+)?(class|interface|enum|struct|record)\s+\w+/gm,
		importPattern: /^\s*using\s+/gm,
	},
	{
		name: 'Ruby',
		extensions: ['.rb'],
		softThreshold: 200,
		hardThreshold: 400,
		exportPattern: /^\s*(def\s+self\.|module_function|attr_)/gm,
		functionPattern: /^\s*def\s+\w+/gm,
		classPattern: /^\s*(class|module)\s+\w+/gm,
		importPattern: /^\s*require\s+/gm,
	},
	{
		name: 'PHP',
		extensions: ['.php'],
		softThreshold: 200,
		hardThreshold: 400,
		exportPattern: /^\s*public\s+(function|static)/gm,
		functionPattern: /^\s*(public|private|protected|static|\s)*function\s+\w+/gm,
		classPattern: /^\s*(abstract\s+)?(class|interface|trait|enum)\s+\w+/gm,
		importPattern: /^\s*(use\s+|require|include)/gm,
	},
	{
		name: 'Swift',
		extensions: ['.swift'],
		softThreshold: 250,
		hardThreshold: 500,
		exportPattern: /^\s*(public|open)\s+(func|class|struct|enum|protocol)/gm,
		functionPattern: /^\s*(public\s+|private\s+|internal\s+|open\s+|static\s+|override\s+)*func\s+\w+/gm,
		classPattern: /^\s*(public\s+|open\s+)?(class|struct|enum|protocol|actor)\s+\w+/gm,
		importPattern: /^\s*import\s+/gm,
	},
];

const DEFAULT_PROFILE: LanguageProfile = {
	name: 'Unknown',
	extensions: [],
	softThreshold: 250,
	hardThreshold: 500,
	exportPattern: /^\s*export\s+/gm,
	functionPattern: /^\s*(function|def|func|fn)\s+\w+/gm,
	classPattern: /^\s*(class|struct|interface)\s+\w+/gm,
	importPattern: /^\s*(import|require|use|include)\s+/gm,
};

// ─── Ignore Patterns ────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
	'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
	'coverage', '.turbo', '.cache', 'vendor', 'target', '__pycache__',
	'.venv', 'venv', '.tox', 'pkg', 'bin', 'obj', '.svn', '.hg',
]);

const IGNORE_FILES = new Set([
	'package-lock.json', 'yarn.lock', 'bun.lock', 'pnpm-lock.yaml',
	'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock',
]);

const SOURCE_EXTENSIONS = new Set(
	LANGUAGE_PROFILES.flatMap(p => p.extensions)
);

// ─── File Discovery ─────────────────────────────────────────────────────────

function discoverFiles(rootPath: string, include: string | null): string[] {
	const files: string[] = [];

	function walk(dir: string): void {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.startsWith('.') && entry !== '.') continue;
			if (IGNORE_DIRS.has(entry)) continue;

			const fullPath = join(dir, entry);
			let stat;
			try {
				stat = statSync(fullPath);
			} catch {
				continue;
			}

			if (stat.isDirectory()) {
				walk(fullPath);
			} else if (stat.isFile()) {
				if (IGNORE_FILES.has(entry)) continue;
				const ext = extname(entry).toLowerCase();
				if (SOURCE_EXTENSIONS.has(ext)) {
					files.push(fullPath);
				}
			}
		}
	}

	// If path is a single file, just return it
	try {
		const stat = statSync(rootPath);
		if (stat.isFile()) {
			return [rootPath];
		}
	} catch {
		return [];
	}

	walk(rootPath);
	return files.sort();
}

function getLanguageProfile(filePath: string): LanguageProfile {
	const ext = extname(filePath).toLowerCase();
	return LANGUAGE_PROFILES.find(p => p.extensions.includes(ext)) ?? DEFAULT_PROFILE;
}

// ─── Tier 1: Heuristic Analysis ─────────────────────────────────────────────

function countMatches(content: string, pattern: RegExp): number {
	// Reset lastIndex and create fresh regex to avoid statefulness issues
	const regex = new RegExp(pattern.source, pattern.flags);
	const matches = content.match(regex);
	return matches?.length ?? 0;
}

function analyzeTier1(filePath: string, rootPath: string, thresholdOverride: number | null): Tier1Result {
	const content = readFileSync(filePath, 'utf-8');
	const profile = getLanguageProfile(filePath);
	const lines = content.split('\n');
	const lineCount = lines.length;

	const softThreshold = thresholdOverride ?? profile.softThreshold;
	const hardThreshold = thresholdOverride ? Math.round(thresholdOverride * 2) : profile.hardThreshold;

	const exportCount = countMatches(content, profile.exportPattern);
	const functionCount = countMatches(content, profile.functionPattern);
	const classCount = countMatches(content, profile.classPattern);
	const importCount = countMatches(content, profile.importPattern);

	const signals: string[] = [];

	// Line count signals
	if (lineCount > hardThreshold) {
		signals.push(`${lineCount} lines exceeds hard threshold (${hardThreshold})`);
	} else if (lineCount > softThreshold) {
		signals.push(`${lineCount} lines exceeds soft threshold (${softThreshold})`);
	}

	// Function density (many functions = likely multiple responsibilities)
	if (functionCount > 15) {
		signals.push(`High function count: ${functionCount} functions`);
	} else if (functionCount > 10) {
		signals.push(`Elevated function count: ${functionCount} functions`);
	}

	// Export density (many exports = possibly a barrel file or mixed concerns)
	if (exportCount > 10) {
		signals.push(`High export count: ${exportCount} exports`);
	}

	// Multiple classes (strong SRP violation signal)
	if (classCount > 1) {
		signals.push(`Multiple classes in one file: ${classCount} classes`);
	}

	// Import fan-in (many imports = high coupling)
	if (importCount > 20) {
		signals.push(`High import count: ${importCount} imports (coupling risk)`);
	} else if (importCount > 12) {
		signals.push(`Elevated import count: ${importCount} imports`);
	}

	// Determine severity
	let severity: 'ok' | 'warn' | 'critical' = 'ok';
	if (lineCount > hardThreshold || signals.length >= 3) {
		severity = 'critical';
	} else if (lineCount > softThreshold || signals.length >= 1) {
		severity = 'warn';
	}

	return {
		file: filePath,
		relativePath: relative(rootPath, filePath),
		language: profile.name,
		lineCount,
		exportCount,
		functionCount,
		classCount,
		importCount,
		softThreshold,
		hardThreshold,
		severity,
		signals,
	};
}

// ─── Tier 2: AI Semantic Analysis ───────────────────────────────────────────

const ANALYSIS_PROMPT = `You are a code structure analyst. Analyze this file for Single Responsibility Principle (SRP) violations, Dependency Inversion Principle (DIP) issues, and opportunities to split into focused modules.

Respond in this exact JSON format (no markdown, no code fences, just raw JSON):
{
  "responsibilities": [
    {"name": "short name", "description": "what this responsibility does", "lineRanges": "e.g. 1-50, 120-180"}
  ],
  "suggestions": [
    {"filename": "suggested-file-name.ts", "responsibilities": ["responsibility name"], "rationale": "why this split makes sense"}
  ],
  "principles": ["SRP: explanation of violation", "DIP: explanation if applicable"],
  "effort": "low|medium|high",
  "summary": "One paragraph summary of the file's structure problems and recommended refactoring approach"
}

Rules:
- Only suggest splits that genuinely improve the codebase
- Each suggested file should have a clear, single responsibility
- Consider DIP: are there concrete dependencies that should be abstractions?
- Consider DRY: is there duplicated logic that indicates mixed concerns?
- If the file is actually well-structured despite its size, say so
- "effort" reflects the difficulty of the refactoring, not the file's badness
- Keep responsibility names short (2-4 words)`;

async function analyzeTier2(filePath: string, repoRoot: string): Promise<Tier2Result | null> {
	let content: string;
	try {
		content = readFileSync(filePath, 'utf-8');
	} catch {
		return null;
	}

	// Truncate very large files to avoid overwhelming the model
	const maxChars = 32_000;
	const truncated = content.length > maxChars
		? content.slice(0, maxChars) + '\n\n[... truncated ...]'
		: content;

	const userPrompt = `File: ${basename(filePath)}\nLanguage: ${getLanguageProfile(filePath).name}\n\n${truncated}`;

	const result = await runClaude({
		prompt: `${ANALYSIS_PROMPT}\n\n${userPrompt}`,
		model: 'sonnet',
		cwd: repoRoot,
	});

	if (!result.ok) {
		log.warn(`AI analysis failed for ${basename(filePath)}: ${result.output.slice(0, 100)}`);
		return null;
	}

	try {
		// Extract JSON from response (handle potential markdown wrapping)
		const jsonMatch = result.output.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			log.warn(`No JSON in AI response for ${basename(filePath)}`);
			return null;
		}
		const parsed = JSON.parse(jsonMatch[0]) as Tier2Result;
		return { ...parsed, file: filePath };
	} catch (e) {
		log.warn(`Failed to parse AI response for ${basename(filePath)}`);
		return null;
	}
}

// ─── GitHub Issue Creation ──────────────────────────────────────────────────

interface IssueData {
	title: string;
	body: string;
	labels: string[];
}

function buildIssueData(result: AnalysisResult): IssueData | null {
	if (result.tier1.severity === 'ok' && !result.tier2) return null;

	const { tier1, tier2 } = result;
	const responsibilityCount = tier2?.suggestions?.length ?? 0;

	const title = responsibilityCount > 0
		? `refactor(${basename(tier1.file)}): split into ${responsibilityCount} focused modules`
		: `refactor(${basename(tier1.file)}): reduce complexity (${tier1.lineCount} lines)`;

	let body = `## File Structure Analysis\n\n`;
	body += `**File:** \`${tier1.relativePath}\`\n`;
	body += `**Language:** ${tier1.language}\n`;
	body += `**Lines:** ${tier1.lineCount} (soft: ${tier1.softThreshold}, hard: ${tier1.hardThreshold})\n`;
	body += `**Severity:** ${tier1.severity}\n\n`;

	body += `### Heuristic Signals\n\n`;
	for (const signal of tier1.signals) {
		body += `- ${signal}\n`;
	}

	if (tier2) {
		body += `\n### Detected Responsibilities\n\n`;
		for (const r of tier2.responsibilities) {
			body += `- **${r.name}**: ${r.description} (lines ${r.lineRanges})\n`;
		}

		if (tier2.suggestions.length > 0) {
			body += `\n### Suggested Split\n\n`;
			for (const s of tier2.suggestions) {
				body += `- \`${s.filename}\` — ${s.responsibilities.join(', ')}\n`;
				body += `  - _${s.rationale}_\n`;
			}
		}

		if (tier2.principles.length > 0) {
			body += `\n### Principle Violations\n\n`;
			for (const p of tier2.principles) {
				body += `- ${p}\n`;
			}
		}

		body += `\n### Effort: ${tier2.effort}\n\n`;
		body += `${tier2.summary}\n`;
	}

	body += `\n---\n_Generated by \`pait refactor\`_\n`;

	const labels = ['refactor', 'ai-suggested'];
	if (tier1.severity === 'critical') labels.push('priority:high');

	return { title, body, labels };
}

async function createGitHubIssue(issue: IssueData, repoRoot: string, dryRun: boolean): Promise<string | null> {
	if (dryRun) {
		log.info(`[DRY RUN] Would create: ${issue.title}`);
		return null;
	}

	const labelArgs = issue.labels.flatMap(l => ['--label', l]);

	const proc = Bun.spawn(
		['gh', 'issue', 'create', '--title', issue.title, '--body', issue.body, ...labelArgs],
		{
			cwd: repoRoot,
			stdout: 'pipe',
			stderr: 'pipe',
		}
	);

	const output = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		log.warn(`Failed to create issue: ${stderr.trim()}`);
		return null;
	}

	return output.trim();
}

// ─── Output Formatters ──────────────────────────────────────────────────────

const COLORS = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	magenta: '\x1b[35m',
	cyan: '\x1b[36m',
	white: '\x1b[37m',
	bgRed: '\x1b[41m',
	bgYellow: '\x1b[43m',
	bgGreen: '\x1b[42m',
};

function severityColor(severity: 'ok' | 'warn' | 'critical'): string {
	switch (severity) {
		case 'critical': return COLORS.red;
		case 'warn': return COLORS.yellow;
		case 'ok': return COLORS.green;
	}
}

function severityIcon(severity: 'ok' | 'warn' | 'critical'): string {
	switch (severity) {
		case 'critical': return '!!!';
		case 'warn': return '!!';
		case 'ok': return 'OK';
	}
}

function formatBar(value: number, max: number, width: number = 20): string {
	const filled = Math.min(Math.round((value / max) * width), width);
	const empty = width - filled;
	const color = value > max * 0.8 ? COLORS.red : value > max * 0.5 ? COLORS.yellow : COLORS.green;
	return `${color}${'█'.repeat(filled)}${COLORS.dim}${'░'.repeat(empty)}${COLORS.reset}`;
}

function renderTerminalReport(report: RefactorReport, verbose: boolean): void {
	console.log();
	console.log(`${COLORS.cyan}${COLORS.bold}REFACTOR ANALYSIS${COLORS.reset}`);
	console.log(`${COLORS.dim}${'─'.repeat(60)}${COLORS.reset}`);
	console.log(`${COLORS.dim}Target:${COLORS.reset}   ${report.targetPath}`);
	console.log(`${COLORS.dim}Files:${COLORS.reset}    ${report.totalFiles} discovered, ${report.analyzedFiles} analyzed, ${report.flaggedFiles} flagged`);
	console.log(`${COLORS.dim}AI:${COLORS.reset}       ${report.aiAnalyzed} files sent to Claude`);
	console.log(`${COLORS.dim}${'─'.repeat(60)}${COLORS.reset}`);
	console.log();

	// Show flagged files (or all files if verbose)
	const toShow = verbose
		? report.results
		: report.results.filter(r => r.tier1.severity !== 'ok');

	if (toShow.length === 0) {
		console.log(`  ${COLORS.green}All files within thresholds. Nothing to refactor.${COLORS.reset}`);
		console.log();
		return;
	}

	// Sort by severity (critical first) then by line count
	toShow.sort((a, b) => {
		const sevOrder = { critical: 0, warn: 1, ok: 2 };
		const sevDiff = sevOrder[a.tier1.severity] - sevOrder[b.tier1.severity];
		if (sevDiff !== 0) return sevDiff;
		return b.tier1.lineCount - a.tier1.lineCount;
	});

	for (const result of toShow) {
		const { tier1, tier2 } = result;
		const color = severityColor(tier1.severity);
		const icon = severityIcon(tier1.severity);

		console.log(`  ${color}[${icon}]${COLORS.reset} ${COLORS.bold}${tier1.relativePath}${COLORS.reset}`);
		console.log(`       ${COLORS.dim}${tier1.language} | ${tier1.lineCount} lines${COLORS.reset} ${formatBar(tier1.lineCount, tier1.hardThreshold)}`);
		console.log(`       ${COLORS.dim}fn:${tier1.functionCount} exp:${tier1.exportCount} cls:${tier1.classCount} imp:${tier1.importCount}${COLORS.reset}`);

		for (const signal of tier1.signals) {
			console.log(`       ${color}→ ${signal}${COLORS.reset}`);
		}

		if (tier2) {
			console.log(`       ${COLORS.magenta}AI: ${tier2.responsibilities.length} responsibilities detected${COLORS.reset}`);
			for (const r of tier2.responsibilities) {
				console.log(`       ${COLORS.dim}  • ${r.name}: ${r.description}${COLORS.reset}`);
			}
			if (tier2.suggestions.length > 0) {
				console.log(`       ${COLORS.cyan}Suggested split:${COLORS.reset}`);
				for (const s of tier2.suggestions) {
					console.log(`       ${COLORS.cyan}  → ${s.filename}${COLORS.reset} ${COLORS.dim}(${s.responsibilities.join(', ')})${COLORS.reset}`);
				}
			}
			console.log(`       ${COLORS.dim}Effort: ${tier2.effort} | ${tier2.summary.slice(0, 80)}...${COLORS.reset}`);
		}

		console.log();
	}

	// Summary
	console.log(`${COLORS.dim}${'─'.repeat(60)}${COLORS.reset}`);
	console.log(`${COLORS.bold}SUMMARY${COLORS.reset}`);
	console.log(`  ${COLORS.red}Critical:${COLORS.reset} ${report.summary.critical}  ${COLORS.yellow}Warnings:${COLORS.reset} ${report.summary.warnings}  ${COLORS.green}OK:${COLORS.reset} ${report.summary.ok}`);

	if (report.summary.topOffenders.length > 0) {
		console.log(`\n  ${COLORS.bold}Top offenders:${COLORS.reset}`);
		for (const off of report.summary.topOffenders.slice(0, 5)) {
			console.log(`    ${COLORS.red}${off.lineCount}${COLORS.reset} lines, ${off.signals} signals — ${off.file}`);
		}
	}

	console.log(`\n  ${COLORS.dim}Estimated effort: ${report.summary.estimatedEffort}${COLORS.reset}`);
	console.log();
}

function renderJsonReport(report: RefactorReport): void {
	console.log(JSON.stringify(report, null, 2));
}

// ─── Main Orchestrator ──────────────────────────────────────────────────────

export async function refactor(flags: RefactorFlags): Promise<void> {
	const targetPath = join(process.cwd(), flags.path);

	if (!existsSync(targetPath)) {
		log.error(`Path not found: ${targetPath}`);
		process.exit(1);
	}

	let repoRoot: string;
	try {
		repoRoot = findRepoRoot();
	} catch {
		repoRoot = process.cwd();
	}

	// Load per-repo config overrides from .pait/refactor.json
	const config = loadToolConfig(repoRoot, 'refactor', {
		softThreshold: null as number | null,
		hardThreshold: null as number | null,
		ignore: [] as string[],
	});

	log.step('DISCOVER');
	const spinner = new Spinner();
	spinner.start('Scanning for source files');
	const files = discoverFiles(targetPath, flags.include);
	spinner.stop(`${COLORS.green}[OK]${COLORS.reset} Found ${files.length} source files`);

	if (files.length === 0) {
		log.warn('No source files found. Check path and file extensions.');
		return;
	}

	// ── Tier 1: Heuristic Analysis ──
	log.step('TIER 1 — HEURISTIC ANALYSIS');
	const tier1Results: Tier1Result[] = [];

	for (const file of files) {
		const result = analyzeTier1(file, targetPath, flags.threshold);
		tier1Results.push(result);
	}

	const flagged = tier1Results.filter(r => r.severity !== 'ok');
	log.ok(`Analyzed ${tier1Results.length} files — ${flagged.length} flagged`);

	// ── Tier 2: AI Semantic Analysis ──
	const tier2Results = new Map<string, Tier2Result>();

	if (!flags.tier1Only && flagged.length > 0) {
		log.step('TIER 2 — AI SEMANTIC ANALYSIS');

		const candidates = flagged
			.sort((a, b) => b.lineCount - a.lineCount)
			.slice(0, flags.budget);

		log.info(`Sending ${candidates.length} files to Claude for analysis (budget: ${flags.budget})`);
		const aiSpinner = new Spinner();

		for (let i = 0; i < candidates.length; i++) {
			const candidate = candidates[i];
			aiSpinner.start(`Analyzing ${candidate.relativePath} (${i + 1}/${candidates.length})`);

			const result = await analyzeTier2(candidate.file, repoRoot);
			if (result) {
				tier2Results.set(candidate.file, result);
			}

			aiSpinner.stop(`${COLORS.green}[OK]${COLORS.reset} ${candidate.relativePath}`);
		}

		log.ok(`AI analyzed ${tier2Results.size} files`);
	} else if (flags.tier1Only) {
		log.dim('Tier 2 skipped (--tier1-only)');
	} else {
		log.ok('No files flagged — AI analysis not needed');
	}

	// ── Build Report ──
	const results: AnalysisResult[] = tier1Results.map(t1 => ({
		file: t1.file,
		relativePath: t1.relativePath,
		tier1: t1,
		tier2: tier2Results.get(t1.file) ?? null,
	}));

	const critical = tier1Results.filter(r => r.severity === 'critical').length;
	const warnings = tier1Results.filter(r => r.severity === 'warn').length;
	const ok = tier1Results.filter(r => r.severity === 'ok').length;

	const topOffenders = flagged
		.sort((a, b) => b.signals.length - a.signals.length || b.lineCount - a.lineCount)
		.slice(0, 10)
		.map(r => ({ file: r.relativePath, lineCount: r.lineCount, signals: r.signals.length }));

	const totalEffort = critical > 10 ? 'Multiple sprints' :
		critical > 5 ? '1-2 sprints' :
		critical > 0 ? 'A few days' :
		warnings > 5 ? '1-2 days' :
		warnings > 0 ? 'A few hours' : 'None needed';

	const report: RefactorReport = {
		timestamp: new Date().toISOString(),
		targetPath: flags.path,
		totalFiles: files.length,
		analyzedFiles: tier1Results.length,
		flaggedFiles: flagged.length,
		aiAnalyzed: tier2Results.size,
		results,
		summary: {
			critical,
			warnings,
			ok,
			topOffenders,
			estimatedEffort: totalEffort,
		},
	};

	// ── Output ──
	if (flags.format === 'json') {
		renderJsonReport(report);
	} else {
		renderTerminalReport(report, flags.verbose);
	}

	// ── GitHub Issues ──
	if (flags.issues) {
		log.step('GITHUB ISSUES');
		const flaggedResults = results.filter(r => r.tier1.severity !== 'ok');
		let created = 0;

		for (const result of flaggedResults) {
			const issueData = buildIssueData(result);
			if (!issueData) continue;

			const url = await createGitHubIssue(issueData, repoRoot, flags.dryRun);
			if (url) {
				log.ok(`Created: ${url}`);
				created++;
			} else if (flags.dryRun) {
				created++;
			}
		}

		const action = flags.dryRun ? 'would create' : 'created';
		log.ok(`${created} issues ${action}`);
	}
}

// ─── Flag Parser ────────────────────────────────────────────────────────────

export function parseRefactorFlags(args: string[]): RefactorFlags {
	const flags: RefactorFlags = {
		path: '.',
		threshold: null,
		tier1Only: false,
		issues: false,
		dryRun: false,
		format: 'terminal',
		budget: 50,
		include: null,
		verbose: false,
	};

	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		switch (arg) {
			case '--threshold':
				flags.threshold = parseInt(args[++i], 10);
				break;
			case '--tier1-only':
				flags.tier1Only = true;
				break;
			case '--issues':
				flags.issues = true;
				break;
			case '--dry-run':
				flags.dryRun = true;
				break;
			case '--format':
				flags.format = args[++i] as 'terminal' | 'json';
				break;
			case '--budget':
				flags.budget = parseInt(args[++i], 10);
				break;
			case '--include':
				flags.include = args[++i];
				break;
			case '--verbose':
				flags.verbose = true;
				break;
			default:
				if (!arg.startsWith('-')) {
					flags.path = arg;
				}
				break;
		}
		i++;
	}

	return flags;
}
