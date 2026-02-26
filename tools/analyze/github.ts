/**
 * ============================================================================
 * ANALYZE — GitHub Integration
 * ============================================================================
 *
 * GitHub label management and issue construction for analyze recommendations.
 * Handles label existence checks, label creation, issue body assembly, and
 * issue creation via the `gh` CLI.
 *
 * ============================================================================
 */

import { log } from '../../shared/log.ts';
import type { IssueData } from './types.ts';
export { buildIssueData } from './issue-formatter.ts';

// ─── Label Definitions ───────────────────────────────────────────────────────

const LABEL_COLORS: Record<string, string> = {
	'refactor': '1d76db',
	'ai-suggested': 'c5def5',
	'priority:high': 'e11d48',
};

// ─── Label Management ────────────────────────────────────────────────────────

export async function ensureLabels(labels: string[], repoRoot: string): Promise<void> {
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

// ─── Duplicate Detection ──────────────────────────────────────────────────────

/**
 * Check whether an open issue already exists targeting the given file path.
 * Searches for issues with a title matching `refactor({relativePath})`.
 * Returns the existing issue number if found, null otherwise.
 */
export function findExistingIssue(relativePath: string, repoRoot: string): number | null {
	const searchQuery = `refactor(${relativePath})`;
	const check = Bun.spawnSync(
		['gh', 'issue', 'list', '--search', searchQuery, '--state', 'open', '--json', 'number,title'],
		{
			cwd: repoRoot,
			stdout: 'pipe',
			stderr: 'pipe',
		}
	);

	const output = new TextDecoder().decode(check.stdout as Buffer).trim();
	try {
		const issues = JSON.parse(output) as { number: number; title: string }[];
		const match = issues.find(i => i.title.startsWith(`refactor(${relativePath})`));
		return match ? match.number : null;
	} catch {
		return null;
	}
}

// ─── Issue Creation ──────────────────────────────────────────────────────────

/**
 * Create a GitHub issue, skipping if a duplicate already exists for the same file.
 * Returns the new issue URL on success, null on skip or failure.
 */
export async function createGitHubIssue(
	issue: IssueData,
	repoRoot: string,
	dryRun: boolean,
): Promise<string | null> {
	// Build the full body, prepending dependency markers if needed
	let body = issue.body;
	if (issue.dependsOn && issue.dependsOn.length > 0) {
		const depList = issue.dependsOn.map(n => `#${n}`).join(', ');
		body = `> **Depends on:** ${depList}\n\n${body}`;
	}

	// Dry-run guard: return early before any network calls (including dedup check).
	if (dryRun) {
		const depStr = issue.dependsOn?.length ? ` (depends on: ${issue.dependsOn.map(n => `#${n}`).join(', ')})` : '';
		log.info(`[DRY RUN] Would create: ${issue.title}${depStr}`);
		return null;
	}

	// Deduplication check: skip if an open issue already targets this file.
	// Only runs outside dry-run to avoid unnecessary network calls during previews.
	if (issue.relativePath) {
		const existingNumber = findExistingIssue(issue.relativePath, repoRoot);
		if (existingNumber !== null) {
			log.info(`Skipping ${issue.relativePath} — open issue #${existingNumber} already exists`);
			return null;
		}
	}

	const labelArgs = issue.labels.flatMap(l => ['--label', l]);

	const proc = Bun.spawn(
		['gh', 'issue', 'create', '--title', issue.title, '--body', body, ...labelArgs],
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

/**
 * Parse an issue number from a GitHub issue URL.
 * e.g. "https://github.com/owner/repo/issues/42" → 42
 */
export function parseIssueNumber(url: string): number | null {
	const match = url.match(/\/issues\/(\d+)/);
	return match ? parseInt(match[1], 10) : null;
}
