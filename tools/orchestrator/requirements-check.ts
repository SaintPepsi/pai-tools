/**
 * LLM-based requirements verification for the orchestrator.
 *
 * Extracts acceptance criteria from issue bodies, computes diff metrics,
 * and sends everything to an LLM for structured pass/fail assessment.
 */

import { runClaude as _runClaude } from '@shared/claude.ts';
import type { RunClaudeOpts } from '@shared/claude.ts';
import type { RunLogger } from '@shared/logging.ts';
import type { GitHubIssue } from '@shared/github.ts';
import type { OrchestratorConfig } from '@tools/orchestrator/types.ts';
import { log } from '@shared/log.ts';
import { safeJsonParse } from '@shared/adapters/json.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RequirementsCheckResult {
	ok: boolean;
	summary: string;
	criteria: { criterion: string; met: boolean; evidence: string }[];
}

export interface DiffMetrics {
	linesAdded: number;
	linesRemoved: number;
	filesChanged: number;
	fileTypes: string[];
}

export interface RequirementsCheckDeps {
	exec: (cmd: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
	runClaude: (opts: RunClaudeOpts) => Promise<{ ok: boolean; output: string }>;
	parseJson: (text: string) => { ok: true; value: unknown } | { ok: false };
}

export interface CheckRequirementsOpts {
	issue: GitHubIssue;
	baseBranch: string;
	worktreePath: string;
	config: OrchestratorConfig;
	logger: RunLogger;
}

// ---------------------------------------------------------------------------
// Default deps
// ---------------------------------------------------------------------------

async function defaultExec(cmd: string[]) {
	const proc = Bun.spawnSync(cmd);
	return {
		exitCode: proc.exitCode ?? 1,
		stdout: proc.stdout?.toString() ?? '',
		stderr: proc.stderr?.toString() ?? '',
	};
}

export const defaultRequirementsCheckDeps: RequirementsCheckDeps = {
	exec: defaultExec,
	runClaude: _runClaude,
	parseJson: safeJsonParse,
};

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Extract acceptance criteria from an issue body.
 * Matches checkbox items (- [ ] text, - [x] text) and numbered lists (1. text).
 */
export function extractAcceptanceCriteria(body: string): string[] {
	const criteria: string[] = [];
	const lines = body.split('\n');

	for (const line of lines) {
		// Match checkbox items: - [ ] text or - [x] text
		const checkboxMatch = line.match(/^-\s+\[[ x]\]\s+(.+)$/i);
		if (checkboxMatch) {
			criteria.push(checkboxMatch[1].trim());
			continue;
		}

		// Match numbered list items: 1. text, 2. text, etc.
		const numberedMatch = line.match(/^\d+\.\s+(.+)$/);
		if (numberedMatch) {
			criteria.push(numberedMatch[1].trim());
		}
	}

	return criteria;
}

/**
 * Compute diff metrics from a unified diff string.
 */
export function computeDiffMetrics(diff: string): DiffMetrics {
	if (!diff.trim()) {
		return { linesAdded: 0, linesRemoved: 0, filesChanged: 0, fileTypes: [] };
	}

	const lines = diff.split('\n');
	let linesAdded = 0;
	let linesRemoved = 0;
	let filesChanged = 0;
	const fileTypeSet = new Set<string>();

	for (const line of lines) {
		if (line.startsWith('diff --git')) {
			filesChanged++;

			// Extract filename from "diff --git a/path/file.ext b/path/file.ext"
			const fileMatch = line.match(/b\/(.+)$/);
			if (fileMatch) {
				const filename = fileMatch[1];
				// Handle special compound extensions first
				if (filename.endsWith('.test.ts')) {
					fileTypeSet.add('.test.ts');
				} else if (filename.endsWith('.test.js')) {
					fileTypeSet.add('.test.js');
				} else if (filename.endsWith('.d.ts')) {
					fileTypeSet.add('.d.ts');
				} else {
					const extMatch = filename.match(/(\.[^.]+)$/);
					if (extMatch) {
						fileTypeSet.add(extMatch[1]);
					}
				}
			}
			continue;
		}

		// Count added lines (lines starting with + but not +++)
		if (line.startsWith('+') && !line.startsWith('+++')) {
			linesAdded++;
			continue;
		}

		// Count removed lines (lines starting with - but not ---)
		if (line.startsWith('-') && !line.startsWith('---')) {
			linesRemoved++;
		}
	}

	return {
		linesAdded,
		linesRemoved,
		filesChanged,
		fileTypes: [...fileTypeSet].sort(),
	};
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

const PARSE_FAIL: RequirementsCheckResult = Object.freeze({
	ok: false,
	summary: '',
	criteria: [],
});

/**
 * Parse the LLM response into a structured result.
 * Returns null on failure (no JSON found or invalid JSON).
 */
function parseLlmResponse(
	output: string,
	parseJson: RequirementsCheckDeps['parseJson'],
): RequirementsCheckResult | null {
	const jsonMatch = output.match(/\{[\s\S]*\}/);
	if (!jsonMatch) return null;

	const result = parseJson(jsonMatch[0]);
	if (!result.ok) return null;

	const parsed = result.value as Record<string, unknown>;
	if (typeof parsed !== 'object' || parsed === null) return null;

	return {
		ok: Boolean(parsed.ok),
		summary: String(parsed.summary ?? ''),
		criteria: Array.isArray(parsed.criteria) ? parsed.criteria : [],
	};
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Run an LLM-based requirements check against the current diff.
 *
 * 1. Gets the diff between baseBranch and HEAD
 * 2. Extracts acceptance criteria from the issue body
 * 3. Sends everything to the LLM for assessment
 * 4. Returns a structured pass/fail result
 */
export async function checkRequirements(
	opts: CheckRequirementsOpts,
	deps: RequirementsCheckDeps = defaultRequirementsCheckDeps,
): Promise<RequirementsCheckResult> {
	const { issue, baseBranch, worktreePath, config, logger } = opts;

	// 1. Get the diff
	const diffResult = await deps.exec([
		'git', '-C', worktreePath, 'diff', `${baseBranch}...HEAD`,
	]);

	const diff = diffResult.stdout.trim();

	// 2. Empty diff = automatic fail
	if (!diff) {
		log.warn(`Requirements check: no diff found for #${issue.number}`);
		return { ok: false, summary: 'No diff found', criteria: [] };
	}

	// 3. Compute metrics and extract criteria
	const metrics = computeDiffMetrics(diff);
	const criteria = extractAcceptanceCriteria(issue.body);

	// 4. Build substance warning if needed
	let substanceWarning = '';
	if (criteria.length >= 5 && metrics.linesAdded < 20) {
		substanceWarning = `\n\nWARNING: The diff has very few lines added (${metrics.linesAdded}) relative to the number of acceptance criteria (${criteria.length}). Carefully evaluate whether the implementation has enough substance to satisfy these requirements. A trivial diff is unlikely to meet many complex criteria.`;
	}

	// 5. Build the LLM prompt
	const criteriaList = criteria.length > 0
		? criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
		: '(no explicit criteria found — assess based on issue description)';

	const prompt = `You are a requirements verification agent. Assess whether the code changes satisfy the issue requirements.

## Issue #${issue.number}: ${issue.title}

### Issue Body
${issue.body}

### Extracted Acceptance Criteria
${criteriaList}

### Diff Summary
- Lines added: ${metrics.linesAdded}
- Lines removed: ${metrics.linesRemoved}
- Files changed: ${metrics.filesChanged}
- File types: ${metrics.fileTypes.join(', ') || 'none'}

### Full Diff
${diff}${substanceWarning}

## Instructions

Evaluate each criterion and determine if the diff satisfies it. Respond with ONLY a JSON object (no markdown, no explanation outside JSON):

{
  "ok": true/false,
  "summary": "brief overall assessment",
  "criteria": [
    { "criterion": "the requirement text", "met": true/false, "evidence": "what in the diff supports this" }
  ]
}

Set "ok" to true only if ALL criteria are met.`;

	// 6. Call the LLM
	log.info(`Requirements check: sending diff (${metrics.linesAdded}+ ${metrics.linesRemoved}-) to LLM for #${issue.number}`);

	const llmResult = await deps.runClaude({
		prompt,
		model: config.models.assess,
		cwd: worktreePath,
	});

	// 7. Parse the response using explicit error returns
	const parsed = parseLlmResponse(llmResult.output, deps.parseJson);
	if (!parsed) {
		log.warn(`Requirements check: failed to parse LLM response for #${issue.number}`);
		return { ...PARSE_FAIL, summary: 'Failed to parse LLM response' };
	}

	logger.agentOutput(issue.number, llmResult.output);
	return parsed;
}
