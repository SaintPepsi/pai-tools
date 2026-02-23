/**
 * ============================================================================
 * ANALYZE — Output Formatters
 * ============================================================================
 *
 * Terminal rendering (ANSI colors, progress bars, severity indicators) and
 * JSON output formatting for the analyze report.
 *
 * ============================================================================
 */

import type { RefactorReport } from './types.ts';

// ─── ANSI Color Palette ──────────────────────────────────────────────────────

export const COLORS = {
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

// ─── Severity Helpers ────────────────────────────────────────────────────────

export function severityColor(severity: 'ok' | 'warn' | 'critical'): string {
	switch (severity) {
		case 'critical': return COLORS.red;
		case 'warn': return COLORS.yellow;
		case 'ok': return COLORS.green;
	}
}

export function severityIcon(severity: 'ok' | 'warn' | 'critical'): string {
	switch (severity) {
		case 'critical': return '!!!';
		case 'warn': return '!!';
		case 'ok': return 'OK';
	}
}

// ─── Progress Bar ────────────────────────────────────────────────────────────

export function formatBar(value: number, max: number, width: number = 20): string {
	const filled = Math.min(Math.round((value / max) * width), width);
	const empty = width - filled;
	const color = value > max * 0.8 ? COLORS.red : value > max * 0.5 ? COLORS.yellow : COLORS.green;
	return `${color}${'█'.repeat(filled)}${COLORS.dim}${'░'.repeat(empty)}${COLORS.reset}`;
}

// ─── Terminal Report Renderer ────────────────────────────────────────────────

export function renderTerminalReport(report: RefactorReport, verbose: boolean): void {
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

// ─── JSON Report Renderer ────────────────────────────────────────────────────

export function renderJsonReport(report: RefactorReport): void {
	console.log(JSON.stringify(report, null, 2));
}
