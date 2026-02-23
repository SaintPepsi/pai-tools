import { readFileSync } from 'node:fs';
import { relative, basename } from 'node:path';
import type { Tier1Result } from './types.ts';
import { getLanguageProfile } from './discovery.ts';

// ─── Tier 1: Heuristic Analysis ─────────────────────────────────────────────

export function countMatches(content: string, pattern: RegExp): number {
	// Reset lastIndex and create fresh regex to avoid statefulness issues
	const regex = new RegExp(pattern.source, pattern.flags);
	const matches = content.match(regex);
	return matches?.length ?? 0;
}

export function analyzeTier1(filePath: string, rootPath: string, thresholdOverride: number | null): Tier1Result {
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
