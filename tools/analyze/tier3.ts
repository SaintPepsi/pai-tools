/**
 * ============================================================================
 * ANALYZE — Tier 3: Cross-file Consolidation
 * ============================================================================
 *
 * After all Tier 2 per-file analyses are complete, this pass feeds the
 * aggregate results to Claude in a single call to identify:
 *   - Shared responsibilities duplicated across files → shared/ module issues
 *   - Dependency ordering between per-file refactoring issues
 *   - Consolidated cross-cutting issues that replace or supplement per-file ones
 *
 * No caching — this is one cheap call per run operating on already-analyzed data.
 *
 * ============================================================================
 */

import { log } from '../../shared/log.ts';
import { runClaude } from '../../shared/claude.ts';
import type { AnalysisResult, Tier3Result } from './types.ts';

// ─── Prompt ──────────────────────────────────────────────────────────────────

export const CONSOLIDATION_PROMPT = `You are a codebase architect reviewing per-file refactoring analyses to find cross-file patterns.

You will receive a JSON array of per-file analysis results. Each entry has:
- relativePath: the file's path relative to the repo root
- responsibilities: detected responsibilities in that file
- suggestions: suggested split modules
- principles: violated principles

Your task is to identify:

1. **Shared extractions** — responsibilities or utilities that appear in multiple files and should become a single shared/ module instead of being extracted independently in each file.
   Example: If orchestrator.ts and finalize.ts both handle "JSON state persistence", extract once to shared/state.ts, not twice.

2. **Dependency ordering** — which per-file splits must happen before others.
   Rules:
   - Test file splits depend on their corresponding source file splits
   - Tool-specific module splits depend on shared extractions (if the shared module is extracted first, the tool modules import from it)
   - Cross-tool moves depend on the target tool's structure being settled

3. **Consolidated issues** — where per-file suggestions should be merged into a single cross-cutting issue.

Respond in this exact JSON format (no markdown, no code fences, just raw JSON):
{
  "consolidatedIssues": [
    {
      "title": "short issue title (max 80 chars)",
      "body": "markdown body describing what to extract, where it goes, and why",
      "files": ["relative/path/to/file1.ts", "relative/path/to/file2.ts"],
      "supersedes": ["relative/path/that/is/covered/by/this.ts"]
    }
  ],
  "dependencies": [
    {
      "prerequisite": "relative/path/that/must/go/first.ts",
      "dependent": "relative/path/that/depends/on/it.ts",
      "reason": "test file depends on source file split being complete first"
    }
  ],
  "summary": "One paragraph summarizing cross-file patterns found and the recommended consolidation strategy"
}

Rules:
- Only create consolidatedIssues when the same responsibility genuinely appears in 2+ files
- Dependencies should only capture REQUIRED ordering, not just "nice to have" ordering
- If no cross-file patterns exist, return empty arrays with a summary explaining why
- Keep consolidatedIssue titles under 80 characters
- The "supersedes" field lists relativePaths of per-file issues whose suggestion is now covered by this consolidated issue
- Do NOT suggest consolidating files that serve clearly different purposes`;

// ─── Tier 3: Cross-file Consolidation ────────────────────────────────────────

export async function consolidateTier3(
	results: AnalysisResult[],
	repoRoot: string,
): Promise<Tier3Result | null> {
	// Only analyze results that have Tier 2 data with actual suggestions
	const tier2Results = results
		.filter(r => r.tier2 !== null)
		.map(r => ({
			relativePath: r.relativePath,
			responsibilities: r.tier2!.responsibilities,
			suggestions: r.tier2!.suggestions,
			principles: r.tier2!.principles,
		}));

	if (tier2Results.length < 2) {
		// Nothing to consolidate with fewer than 2 analyzed files
		return {
			consolidatedIssues: [],
			dependencies: [],
			summary: 'Fewer than 2 files with AI analysis — no cross-file patterns to consolidate.',
		};
	}

	const userPrompt = JSON.stringify(tier2Results, null, 2);

	const result = await runClaude({
		prompt: `${CONSOLIDATION_PROMPT}\n\nPer-file analysis results:\n${userPrompt}`,
		model: 'sonnet',
		cwd: repoRoot,
	});

	if (!result.ok) {
		log.warn(`Tier 3 consolidation failed: ${result.output.slice(0, 100)}`);
		return null;
	}

	try {
		const jsonMatch = result.output.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			log.warn('No JSON in Tier 3 consolidation response');
			return null;
		}
		return JSON.parse(jsonMatch[0]) as Tier3Result;
	} catch {
		log.warn('Failed to parse Tier 3 consolidation response');
		return null;
	}
}
