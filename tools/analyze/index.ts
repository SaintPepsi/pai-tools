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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { log, Spinner } from '../../shared/log.ts';
import { findRepoRoot, loadToolConfig } from '../../shared/config.ts';
import type {
	RefactorFlags,
	Tier1Result,
	Tier2Result,
	AnalysisResult,
	RefactorReport,
} from './types.ts';
import { computeFileHash, loadCache, saveCache } from './cache.ts';
import { discoverFiles } from './discovery.ts';
import { analyzeTier1 } from './tier1.ts';
import { analyzeTier2 } from './tier2.ts';
import { COLORS, renderTerminalReport, renderJsonReport } from './formatters.ts';
import { buildIssueData, createGitHubIssue, ensureLabels } from './github.ts';

export type { RefactorFlags } from './types.ts';

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
