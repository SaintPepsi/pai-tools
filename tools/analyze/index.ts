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
import { buildIssueData, createGitHubIssue, ensureLabels, parseIssueNumber } from './github.ts';
import { buildReport } from './report-builder.ts';
import { parseAnalyzeFlags } from './flags.ts';
import { consolidateTier3 } from './tier3.ts';
import type { Tier3Result, IssueData } from './types.ts';

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

	// ── Output ──
	if (flags.format === 'json') {
		renderJsonReport(report);
	} else {
		renderTerminalReport(report, flags.verbose);
	}

	// ── GitHub Issues ──
	if (flags.issues) {
		log.step('GITHUB ISSUES');
		const flaggedResults = report.results.filter(r => r.tier1.severity !== 'ok');

		// ── Tier 3: Cross-file Consolidation ──
		let tier3: Tier3Result | null = null;
		if (!flags.tier1Only && tier2Results.size >= 2) {
			log.step('TIER 3 — CROSS-FILE CONSOLIDATION');
			const t3Spinner = new Spinner();
			t3Spinner.start('Consolidating cross-file patterns');
			tier3 = await consolidateTier3(results, repoRoot);
			if (tier3) {
				t3Spinner.stop(`${COLORS.green}[OK]${COLORS.reset} Cross-file consolidation complete`);
				log.info(tier3.summary);
				if (tier3.consolidatedIssues.length > 0) {
					log.info(`Found ${tier3.consolidatedIssues.length} cross-file consolidation(s)`);
				}
				if (tier3.dependencies.length > 0) {
					log.info(`Found ${tier3.dependencies.length} dependency relationship(s)`);
				}
			} else {
				t3Spinner.stop(`${COLORS.yellow}[WARN]${COLORS.reset} Tier 3 consolidation failed, proceeding without it`);
			}
		}

		// Build dependency map: relativePath → set of prerequisite relativePaths
		const dependencyMap = new Map<string, Set<string>>();
		if (tier3) {
			for (const dep of tier3.dependencies) {
				if (!dependencyMap.has(dep.dependent)) {
					dependencyMap.set(dep.dependent, new Set());
				}
				dependencyMap.get(dep.dependent)!.add(dep.prerequisite);
			}
		}

		// Files superseded by consolidated issues — skip their per-file issues
		const supersededFiles = new Set<string>();
		if (tier3) {
			for (const ci of tier3.consolidatedIssues) {
				for (const path of ci.supersedes) {
					supersededFiles.add(path);
				}
			}
		}

		// Build issue list: consolidated issues first, then per-file issues (excluding superseded)
		interface PendingIssue {
			issueData: IssueData;
			/** relativePath key used for dependency resolution. */
			key: string;
		}

		const consolidatedPending: PendingIssue[] = [];
		if (tier3) {
			for (const ci of tier3.consolidatedIssues) {
				// Sort files so the dedup key is stable regardless of AI output order.
				const sortedFiles = [...ci.files].sort();
				const primaryFile = sortedFiles[0];
				// Use a predictable title prefix so findExistingIssue can match it
				// on re-runs: the title starts with `refactor(${primaryFile})` which
				// matches the search pattern used by the dedup check.
				const title = `refactor(${primaryFile}): consolidated - ${ci.title}`;
				const fileList = ci.files.map(f => `\`${f}\``).join(', ');
				const body = `## Cross-file Consolidation\n\n${ci.body}\n\n**Covers files:** ${fileList}\n\n---\n_Generated by \`pait analyze\` (Tier 3 cross-file consolidation)_\n`;
				consolidatedPending.push({
					issueData: {
						title,
						body,
						labels: ['refactor', 'ai-suggested'],
						relativePath: primaryFile,
					},
					key: primaryFile,
				});
			}
		}

		const perFilePending: PendingIssue[] = [];
		for (const result of flaggedResults) {
			if (supersededFiles.has(result.relativePath)) {
				log.info(`Skipping ${result.relativePath} — covered by consolidated issue`);
				continue;
			}
			const issueData = buildIssueData(result);
			if (!issueData) continue;
			perFilePending.push({ issueData, key: result.relativePath });
		}

		// Topological sort: issues whose prereqs haven't been processed yet go last
		// Simple approach: process consolidated issues first (they are prerequisites),
		// then per-file issues in dependency order.
		const sortedPerFile = topologicalSort(perFilePending, dependencyMap);
		const allPending = [...consolidatedPending, ...sortedPerFile];

		// Collect all unique labels and ensure they exist
		const allLabels = new Set<string>();
		for (const { issueData } of allPending) {
			for (const label of issueData.labels) {
				allLabels.add(label);
			}
		}

		if (!flags.dryRun && allLabels.size > 0) {
			log.info('Ensuring required labels exist...');
			await ensureLabels([...allLabels], repoRoot);
		}

		// Create issues, tracking issue numbers for dependency resolution
		// Maps relativePath → issue number (after creation)
		const createdNumbers = new Map<string, number>();

		let created = 0;
		for (const { issueData, key } of allPending) {
			// Attach dependency numbers to this issue
			const prereqPaths = dependencyMap.get(key);
			if (prereqPaths && prereqPaths.size > 0) {
				const depNumbers: number[] = [];
				for (const prereqPath of prereqPaths) {
					const n = createdNumbers.get(prereqPath);
					if (n !== undefined) depNumbers.push(n);
				}
				if (depNumbers.length > 0) {
					issueData.dependsOn = depNumbers;
				}
			}

			const url = await createGitHubIssue(issueData, repoRoot, flags.dryRun);
			if (url) {
				log.ok(`Created: ${url}`);
				const num = parseIssueNumber(url);
				if (num !== null) createdNumbers.set(key, num);
				created++;
			} else if (flags.dryRun) {
				created++;
			}
		}

		const action = flags.dryRun ? 'would create' : 'created';
		log.ok(`${created} issues ${action}`);
	}
}

// ─── Topological Sort ────────────────────────────────────────────────────────

/**
 * Sort pending issues so that prerequisites appear before their dependents.
 * Falls back to original order for issues without dependencies.
 *
 * Cycle handling: when a back-edge is detected (key already in the `visiting`
 * set), the node that triggered the cycle is appended to the output immediately
 * so it is never silently dropped. This means cycles degrade gracefully to an
 * arbitrary-but-complete ordering rather than losing issues.
 *
 * Exported for unit testing.
 */
export function topologicalSort(
	pending: Array<{ issueData: import('./types.ts').IssueData; key: string }>,
	dependencyMap: Map<string, Set<string>>,
): Array<{ issueData: import('./types.ts').IssueData; key: string }> {
	if (dependencyMap.size === 0) return pending;

	const result: typeof pending = [];
	const inResult = new Set<string>();
	const visiting = new Set<string>();

	const pendingByKey = new Map(pending.map(p => [p.key, p]));

	function visit(key: string): void {
		if (inResult.has(key)) return;
		if (visiting.has(key)) {
			// Cycle detected — add the node now so it is never silently dropped.
			// It will appear before its own prerequisites in the output, which
			// is unavoidable when a genuine cycle exists.
			if (pendingByKey.has(key)) {
				result.push(pendingByKey.get(key)!);
				inResult.add(key);
			}
			return;
		}

		visiting.add(key);

		const prereqs = dependencyMap.get(key);
		if (prereqs) {
			for (const prereq of prereqs) {
				if (pendingByKey.has(prereq)) {
					visit(prereq);
				}
			}
		}

		visiting.delete(key);
		if (pendingByKey.has(key) && !inResult.has(key)) {
			result.push(pendingByKey.get(key)!);
			inResult.add(key);
		}
	}

	for (const { key } of pending) {
		visit(key);
	}

	return result;
}

