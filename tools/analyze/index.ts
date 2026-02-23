#!/usr/bin/env bun
/**
 * ============================================================================
 * ANALYZE — AI-powered file structure analyzer
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
 *   pait analyze <path> [flags]
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
 *   pait analyze ./src
 *   pait analyze ./src --tier1-only
 *   pait analyze ./src --issues --dry-run
 *   pait analyze ./src --threshold 200 --format json
 *   pait analyze . --budget 10
 *
 * ============================================================================
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, extname, relative, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { log, Spinner } from '../../shared/log.ts';
import { runClaude } from '../../shared/claude.ts';
import { findRepoRoot, loadToolConfig, getStateFilePath } from '../../shared/config.ts';
import type {
	RefactorFlags,
	LanguageProfile,
	Tier1Result,
	Tier2Result,
	AnalysisResult,
	AnalysisCache,
	RefactorReport,
	IssueData,
} from './types.ts';
import { LANGUAGE_PROFILES, DEFAULT_PROFILE, SOURCE_EXTENSIONS } from './language-profiles.ts';

export type { RefactorFlags } from './types.ts';

// ─── Cache & Hash Utilities ──────────────────────────────────────────────────

function computeFileHash(filePath: string): string {
	const content = readFileSync(filePath);
	return createHash('sha256').update(content).digest('hex');
}

function loadCache(repoRoot: string): AnalysisCache {
	const cachePath = getStateFilePath(repoRoot, 'analyze');
	if (!existsSync(cachePath)) return { entries: {} };
	try {
		return JSON.parse(readFileSync(cachePath, 'utf-8')) as AnalysisCache;
	} catch {
		return { entries: {} };
	}
}

function saveCache(repoRoot: string, cache: AnalysisCache): void {
	const cachePath = getStateFilePath(repoRoot, 'analyze');
	writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

// ─── GitHub Label Management ────────────────────────────────────────────────

const LABEL_COLORS: Record<string, string> = {
	'refactor': '1d76db',
	'ai-suggested': 'c5def5',
	'priority:high': 'e11d48',
};

async function ensureLabels(labels: string[], repoRoot: string): Promise<void> {
	for (const label of labels) {
		const check = Bun.spawnSync(['gh', 'label', 'list', '--search', label, '--json', 'name'], {
			cwd: repoRoot,
			stdout: 'pipe',
			stderr: 'pipe',
		});

		const output = new TextDecoder().decode(check.stdout as Buffer).trim();
		let exists = false;
		try {
			const parsed = JSON.parse(output) as { name: string }[];
			exists = parsed.some(l => l.name === label);
		} catch {}

		if (!exists) {
			const color = LABEL_COLORS[label] ?? 'ededed';
			const create = Bun.spawnSync(
				['gh', 'label', 'create', label, '--color', color, '--force'],
				{ cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' }
			);
			if (create.exitCode === 0) {
				log.info(`Created missing label: ${label}`);
			} else {
				log.warn(`Could not create label '${label}' — issue creation may fail`);
			}
		}
	}
}

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
		relativePath: relative(rootPath, filePath) || basename(filePath),
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

const ANALYSIS_PROMPT = `You are a code structure analyst specializing in SOLID principles. Analyze this file using these precise definitions:

## Single Responsibility Principle (SRP)
Robert C. Martin: "A module should have one, and only one, reason to change."
A "reason to change" means one actor or stakeholder. If two different actors (e.g., the CFO and the CTO) would request changes to the same file for different reasons, that file violates SRP. The test: "If I describe what this file does, do I need the word 'and'?" If yes, it likely has multiple responsibilities.

Look for:
- Multiple unrelated groups of functions that serve different stakeholders
- Mixed concerns: business logic alongside I/O, formatting alongside computation, parsing alongside rendering
- Functions that change for different reasons at different times

## Dependency Inversion Principle (DIP)
Robert C. Martin: "High-level modules should not depend on low-level modules. Both should depend on abstractions. Abstractions should not depend on details. Details should depend on abstractions."
The test: Does this file import concrete implementations directly (database drivers, HTTP clients, file system calls, specific API clients) when it could depend on an interface or abstraction instead? High-level policy code should not know about low-level implementation details.

Look for:
- Direct imports of concrete implementations where an interface/type would allow swapping
- High-level orchestration code mixed with low-level I/O or infrastructure details
- Tight coupling to specific libraries that makes testing or replacement difficult

## Additional Principles
- DRY: Is there duplicated logic that indicates mixed concerns being handled in parallel?
- YAGNI: Are there unused abstractions or over-engineered patterns that add complexity without value?

Respond in this exact JSON format (no markdown, no code fences, just raw JSON):
{
  "responsibilities": [
    {"name": "short name", "description": "what this responsibility does", "lineRanges": "e.g. 1-50, 120-180"}
  ],
  "suggestions": [
    {"filename": "suggested-file-name.ts", "responsibilities": ["responsibility name"], "rationale": "why this split makes sense"}
  ],
  "principles": ["SRP: explanation of specific violation", "DIP: explanation of specific violation"],
  "effort": "low|medium|high",
  "summary": "One paragraph summary of the file's structure problems and recommended refactoring approach"
}

Rules:
- Only suggest splits that genuinely improve the codebase
- Each suggested file should have a clear, single responsibility (one reason to change)
- For each SRP violation, name the two distinct actors/reasons that would drive changes
- For each DIP violation, name the concrete dependency and what abstraction would replace it
- If the file is actually well-structured despite its size, say so — size alone is not a violation
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

function buildIssueData(result: AnalysisResult): IssueData | null {
	if (result.tier1.severity === 'ok' && !result.tier2) return null;

	const { tier1, tier2 } = result;
	const splitCount = tier2?.suggestions?.length ?? 0;

	const title = splitCount > 0
		? `refactor(${tier1.relativePath}): split into ${splitCount} focused modules`
		: `refactor(${tier1.relativePath}): decompose file (${tier1.lineCount} lines)`;

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

		// Acceptance criteria from Tier 2 analysis
		body += `\n### Acceptance Criteria\n\n`;
		if (tier2.suggestions.length > 0) {
			for (const s of tier2.suggestions) {
				body += `- [ ] \`${s.filename}\` created with ${s.responsibilities.join(', ')} responsibility\n`;
			}
		}
		body += `- [ ] All existing exports re-exported or migrated (no broken imports)\n`;
		body += `- [ ] Original file removed or reduced to re-exports only\n`;
		body += `- [ ] No resulting file exceeds ${tier1.softThreshold} lines (soft threshold)\n`;
		body += `- [ ] Tests pass\n`;
	} else {
		// No Tier 2 data — flag for manual scoping
		body += `\n> **Note:** This issue was generated from heuristic signals only (no AI analysis). `;
		body += `It may need manual scoping or a \`pait analyze --budget\` re-run before automated implementation.\n`;

		body += `\n### Acceptance Criteria\n\n`;
		body += `- [ ] File decomposed into focused modules with single responsibilities\n`;
		body += `- [ ] All existing exports re-exported or migrated (no broken imports)\n`;
		body += `- [ ] No resulting file exceeds ${tier1.softThreshold} lines (soft threshold)\n`;
		body += `- [ ] Tests pass\n`;
	}

	body += `\n---\n_Generated by \`pait analyze\`_\n`;

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
	console.log(`${COLORS.cyan}${COLORS.bold}STRUCTURE ANALYSIS${COLORS.reset}`);
	console.log(`${COLORS.dim}${'─'.repeat(60)}${COLORS.reset}`);
	console.log(`${COLORS.dim}Target:${COLORS.reset}   ${report.targetPath}`);
	console.log(`${COLORS.dim}Files:${COLORS.reset}    ${report.totalFiles} discovered, ${report.analyzedFiles} analyzed, ${report.flaggedFiles} flagged`);
	console.log(`${COLORS.dim}AI:${COLORS.reset}       ${report.aiAnalyzed} files analyzed (${report.cacheHits} from cache)`);
	console.log(`${COLORS.dim}${'─'.repeat(60)}${COLORS.reset}`);
	console.log();

	// Show flagged files (or all files if verbose)
	const toShow = verbose
		? report.results
		: report.results.filter(r => r.tier1.severity !== 'ok');

	if (toShow.length === 0) {
		console.log(`  ${COLORS.green}All files within thresholds. Nothing to flag.${COLORS.reset}`);
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
			const cacheTag = result.cached ? ` ${COLORS.cyan}(cached)${COLORS.reset}` : '';
			console.log(`       ${COLORS.magenta}AI: ${tier2.responsibilities.length} responsibilities detected${cacheTag}${COLORS.reset}`);
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

export async function analyze(flags: RefactorFlags): Promise<void> {
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

	// Load per-repo config overrides from .pait/analyze.json
	const config = loadToolConfig(repoRoot, 'analyze', {
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

	// ── Tier 2: AI Semantic Analysis (with caching) ──
	const tier2Results = new Map<string, Tier2Result>();
	const cachedFiles = new Set<string>();
	const cache = loadCache(repoRoot);
	let cacheHits = 0;

	if (!flags.tier1Only && flagged.length > 0) {
		log.step('TIER 2 — AI SEMANTIC ANALYSIS');

		const candidates = flagged
			.sort((a, b) => b.lineCount - a.lineCount)
			.slice(0, flags.budget);

		// Check cache for each candidate
		let freshCount = 0;
		for (const candidate of candidates) {
			const hash = computeFileHash(candidate.file);
			const cacheKey = candidate.relativePath;
			const cached = cache.entries[cacheKey];

			if (cached && cached.hash === hash) {
				tier2Results.set(candidate.file, cached.result);
				cachedFiles.add(candidate.file);
				cacheHits++;
			} else {
				freshCount++;
			}
		}

		if (cacheHits > 0) {
			log.info(`Cache: ${cacheHits} hit(s), ${freshCount} file(s) need fresh analysis`);
		}

		if (freshCount > 0) {
			log.info(`Sending ${freshCount} files to Claude for analysis (budget: ${flags.budget})`);
			const aiSpinner = new Spinner();
			let analyzed = 0;

			for (const candidate of candidates) {
				if (cachedFiles.has(candidate.file)) continue;

				analyzed++;
				aiSpinner.start(`Analyzing ${candidate.relativePath} (${analyzed}/${freshCount})`);

				const result = await analyzeTier2(candidate.file, repoRoot);
				if (result) {
					tier2Results.set(candidate.file, result);

					// Cache the result
					const hash = computeFileHash(candidate.file);
					cache.entries[candidate.relativePath] = {
						hash,
						timestamp: new Date().toISOString(),
						result,
					};
				}

				aiSpinner.stop(`${COLORS.green}[OK]${COLORS.reset} ${candidate.relativePath}`);
			}

			// Save updated cache
			saveCache(repoRoot, cache);
		}

		log.ok(`AI analyzed ${tier2Results.size} files (${cacheHits} cached, ${freshCount} fresh)`);
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
		cached: cachedFiles.has(t1.file),
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
		cacheHits,
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

		// Collect all unique labels and ensure they exist
		const allLabels = new Set<string>();
		for (const result of flaggedResults) {
			const issueData = buildIssueData(result);
			if (issueData) {
				for (const label of issueData.labels) {
					allLabels.add(label);
				}
			}
		}

		if (!flags.dryRun && allLabels.size > 0) {
			log.info('Ensuring required labels exist...');
			await ensureLabels([...allLabels], repoRoot);
		}

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

// ─── Help Text ──────────────────────────────────────────────────────────────

const REFACTOR_HELP = `\x1b[36mpait analyze\x1b[0m — AI-powered file structure analyzer

\x1b[1mUSAGE\x1b[0m
  pait analyze [path] [flags]

\x1b[1mARGUMENTS\x1b[0m
  path               Target directory or file (default: .)

\x1b[1mFLAGS\x1b[0m
  --threshold <N>    Soft line threshold override (default: auto per language)
  --tier1-only       Skip AI analysis, run heuristics only (free, instant)
  --issues           Create GitHub issues for flagged files
  --dry-run          Preview issues without creating them
  --format <type>    Output format: terminal (default) | json
  --budget <N>       Max AI analysis calls (default: 50)
  --include <glob>   Only analyze matching files
  --verbose          Show all files including OK ones (default)
  --quiet, -q        Show only flagged files
  --help, -h         Show this help message

\x1b[1mEXAMPLES\x1b[0m
  pait analyze ./src                        Full two-tier analysis
  pait analyze ./src --tier1-only           Heuristics only (free)
  pait analyze ./src --issues --dry-run     Preview GitHub issues
  pait analyze ./src --format json          JSON output for CI
  pait analyze . --threshold 150            Custom line threshold
  pait analyze ./src --budget 10            Limit AI calls to 10

\x1b[1mANALYSIS TIERS\x1b[0m
  \x1b[33mTier 1 (Heuristic)\x1b[0m  Free, instant. Line count, function/export/class
                       density, import fan-in. Flags candidates for Tier 2.
  \x1b[35mTier 2 (AI)\x1b[0m         Claude Sonnet semantic analysis. Detects SRP and DIP
                       violations, suggests concrete file splits with rationale.

\x1b[1mPRINCIPLES\x1b[0m
  SRP   A module should have one, and only one, reason to change (Martin)
  DIP   High-level modules should not depend on low-level modules;
        both should depend on abstractions (Martin)
  DRY   Don't repeat yourself — duplicated logic signals mixed concerns
  YAGNI You aren't gonna need it — don't over-abstract prematurely

\x1b[1mCONFIG\x1b[0m
  Per-project overrides in .pait/analyze.json:
  { "softThreshold": 200, "hardThreshold": 400, "ignore": ["generated/"] }

\x1b[90mhttps://github.com/SaintPepsi/pai-tools\x1b[0m
`;

// ─── Flag Parser ────────────────────────────────────────────────────────────

export function parseAnalyzeFlags(args: string[]): RefactorFlags {
	const flags: RefactorFlags = {
		path: '.',
		threshold: null,
		tier1Only: false,
		issues: false,
		dryRun: false,
		format: 'terminal',
		budget: 50,
		include: null,
		verbose: true,
	};

	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		switch (arg) {
			case '--help':
			case '-h':
				console.log(REFACTOR_HELP);
				process.exit(0);
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
			case '--quiet':
			case '-q':
				flags.verbose = false;
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
