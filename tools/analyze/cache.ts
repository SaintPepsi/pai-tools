import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getStateFilePath } from '../../shared/config.ts';
import type { AnalysisCache } from './types.ts';

// ─── Cache & Hash Utilities ──────────────────────────────────────────────────

export function computeFileHash(filePath: string): string {
	const content = readFileSync(filePath);
	return createHash('sha256').update(content).digest('hex');
}

export function loadCache(repoRoot: string): AnalysisCache {
	const cachePath = getStateFilePath(repoRoot, 'analyze');
	if (!existsSync(cachePath)) return { entries: {} };
	try {
		return JSON.parse(readFileSync(cachePath, 'utf-8')) as AnalysisCache;
	} catch {
		return { entries: {} };
	}
}

export function saveCache(repoRoot: string, cache: AnalysisCache): void {
	const cachePath = getStateFilePath(repoRoot, 'analyze');
	writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}
