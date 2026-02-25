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
} from './types.ts';
import { computeFileHash, loadCache, saveCache } from './cache.ts';
import { discoverFiles } from './discovery.ts';
import { analyzeTier1 } from './tier1.ts';
import { analyzeTier2 } from './tier2.ts';
import { COLORS, renderTerminalReport, renderJsonReport } from './formatters.ts';
import { buildIssueData, createGitHubIssue, ensureLabels } from './github.ts';
import { buildReport } from './report-builder.ts';
import { parseAnalyzeFlags } from './flags.ts';

export type { RefactorFlags } from './types.ts';
export { parseAnalyzeFlags };

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
	const report = buildReport({
		tier1Results,
		tier2Results,
		cachedFiles,
		targetPath: flags.path,
		totalFiles: files.length,
		cacheHits,
	});
	const { results } = report;

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

