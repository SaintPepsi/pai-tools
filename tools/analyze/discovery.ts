import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { LanguageProfile } from './types.ts';
import { LANGUAGE_PROFILES, DEFAULT_PROFILE, SOURCE_EXTENSIONS } from './language-profiles.ts';

// ─── Ignore Patterns ────────────────────────────────────────────────────────

export const IGNORE_DIRS = new Set([
	'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
	'coverage', '.turbo', '.cache', 'vendor', 'target', '__pycache__',
	'.venv', 'venv', '.tox', 'pkg', 'bin', 'obj', '.svn', '.hg',
]);

export const IGNORE_FILES = new Set([
	'package-lock.json', 'yarn.lock', 'bun.lock', 'pnpm-lock.yaml',
	'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock',
]);

// ─── File Discovery ─────────────────────────────────────────────────────────

export function discoverFiles(rootPath: string, include: string | null): string[] {
	const files: string[] = [];

	function walk(dir: string): void {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.startsWith('.') && entry !== '.') continue;
			if (IGNORE_DIRS.has(entry)) continue;

			const fullPath = join(dir, entry);
			let stat;
			try {
				stat = statSync(fullPath);
			} catch {
				continue;
			}

			if (stat.isDirectory()) {
				walk(fullPath);
			} else if (stat.isFile()) {
				if (IGNORE_FILES.has(entry)) continue;
				const ext = extname(entry).toLowerCase();
				if (SOURCE_EXTENSIONS.has(ext)) {
					files.push(fullPath);
				}
			}
		}
	}

	// If path is a single file, just return it
	try {
		const stat = statSync(rootPath);
		if (stat.isFile()) {
			return [rootPath];
		}
	} catch {
		return [];
	}

	walk(rootPath);
	return files.sort();
}

export function getLanguageProfile(filePath: string): LanguageProfile {
	const ext = extname(filePath).toLowerCase();
	return LANGUAGE_PROFILES.find(p => p.extensions.includes(ext)) ?? DEFAULT_PROFILE;
}
