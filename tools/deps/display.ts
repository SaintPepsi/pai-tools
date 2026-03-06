/**
 * Terminal rendering helpers for the deps tool.
 *
 * Stateless display functions — return formatted strings, no I/O side effects.
 */

import type { IssueRelationships } from 'tools/deps/types.ts';
import type { GraphValidation } from 'tools/deps/graph.ts';

// ─── ANSI Colors ──────────────────────────────────────────────────────────────

const C = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	cyan: '\x1b[36m',
};

// ─── formatList ───────────────────────────────────────────────────────────────

/**
 * Render dependency relationships for a single issue.
 * Sections with no entries are omitted from the output.
 */
export function formatList(rel: IssueRelationships): string {
	const lines: string[] = [];

	lines.push(`${C.bold}#${rel.number}${C.reset} ${rel.title} ${C.dim}[${rel.state}]${C.reset}`);

	if (rel.blockedBy.length > 0) {
		lines.push(`  ${C.yellow}Blocked by:${C.reset}`);
		for (const n of rel.blockedBy) {
			lines.push(`    #${n}`);
		}
	}

	if (rel.blocking.length > 0) {
		lines.push(`  ${C.cyan}Blocking:${C.reset}`);
		for (const n of rel.blocking) {
			lines.push(`    #${n}`);
		}
	}

	if (rel.parent !== null) {
		lines.push(`  ${C.dim}Parent:${C.reset} #${rel.parent}`);
	}

	if (rel.subIssues.length > 0) {
		lines.push(`  ${C.dim}Sub-issues:${C.reset}`);
		for (const n of rel.subIssues) {
			lines.push(`    #${n}`);
		}
	}

	return lines.join('\n');
}

// ─── formatTree ───────────────────────────────────────────────────────────────

/**
 * Render a tiered dependency tree with issue titles.
 * Each tier contains issues whose blockers are resolved in earlier tiers.
 */
export function formatTree(tiers: number[][], issues: Map<number, IssueRelationships>): string {
	if (tiers.length === 0) return `${C.dim}(no issues)${C.reset}`;

	const lines: string[] = [];

	for (let t = 0; t < tiers.length; t++) {
		const tier = tiers[t];
		lines.push(`${C.bold}Tier ${t}${C.reset} ${C.dim}(${tier.length} issue${tier.length === 1 ? '' : 's'})${C.reset}`);

		for (const num of tier) {
			const rel = issues.get(num);
			const title = rel ? rel.title : '(unknown)';
			const state = rel ? ` ${C.dim}[${rel.state}]${C.reset}` : '';
			const blockers = rel && rel.blockedBy.length > 0
				? ` ${C.dim}← blocked by ${rel.blockedBy.map(n => `#${n}`).join(', ')}${C.reset}`
				: '';
			lines.push(`  ${C.cyan}#${num}${C.reset} ${title}${state}${blockers}`);
		}

		if (t < tiers.length - 1) lines.push('');
	}

	return lines.join('\n');
}

// ─── formatValidation ─────────────────────────────────────────────────────────

/**
 * Render cycle and missing dependency warnings from a graph validation result.
 */
export function formatValidation(validation: GraphValidation): string {
	if (validation.valid) {
		return `${C.green}✓ Dependency graph is valid — no cycles or missing dependencies.${C.reset}`;
	}

	const lines: string[] = [];

	if (validation.cycles.length > 0) {
		lines.push(`${C.red}${C.bold}Cycles detected:${C.reset}`);
		for (const cycle of validation.cycles) {
			const path = [...cycle, cycle[0]].map(n => `#${n}`).join(' → ');
			lines.push(`  ${C.red}→ ${path}${C.reset}`);
		}
	}

	if (validation.missing.length > 0) {
		if (lines.length > 0) lines.push('');
		lines.push(`${C.yellow}${C.bold}Missing dependencies:${C.reset}`);
		for (const n of validation.missing) {
			lines.push(`  ${C.yellow}→ #${n} is referenced but not in the graph${C.reset}`);
		}
	}

	return lines.join('\n');
}
