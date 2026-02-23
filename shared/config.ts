/**
 * .pait/ directory discovery, config loading, and state path resolution.
 */

import { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * Walk up from `startDir` (default: cwd) until we find a `.git` directory.
 * Returns the repo root path, or throws if none found.
 */
export function findRepoRoot(startDir: string = process.cwd()): string {
	let dir = startDir;
	for (let i = 0; i < 64; i++) {
		if (existsSync(join(dir, '.git'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`No git repository found starting from ${startDir}`);
}

/**
 * Load a tool's config from `.pait/{toolName}.json` in the repo root.
 * Returns a shallow merge of `defaults` with the on-disk config.
 */
export function loadToolConfig<T>(
	repoRoot: string,
	toolName: string,
	defaults: T
): T {
	const configPath = join(repoRoot, '.pait', `${toolName}.json`);
	if (!existsSync(configPath)) return { ...defaults };

	const raw = readFileSync(configPath, 'utf-8');
	const userConfig = JSON.parse(raw) as Partial<T>;
	return { ...defaults, ...userConfig };
}

/**
 * Ensure `.pait/.gitignore` exists with the standard ignore entries.
 * Called automatically when `.pait/` subdirectories are created.
 */
function ensurePaitGitignore(repoRoot: string): void {
	const gitignorePath = join(repoRoot, '.pait', '.gitignore');
	if (existsSync(gitignorePath)) return;

	const paitDir = join(repoRoot, '.pait');
	if (!existsSync(paitDir)) {
		mkdirSync(paitDir, { recursive: true });
	}

	writeFileSync(gitignorePath, 'node_modules/\nworktrees/\nstate/\nlogs/\n');
}

/**
 * Get the path to a tool's state file at `.pait/state/{toolName}.json`.
 * Creates the `.pait/state/` directory and `.pait/.gitignore` if they don't exist.
 */
export function getStateFilePath(repoRoot: string, toolName: string): string {
	const stateDir = join(repoRoot, '.pait', 'state');
	if (!existsSync(stateDir)) {
		mkdirSync(stateDir, { recursive: true });
		ensurePaitGitignore(repoRoot);
	}
	return join(stateDir, `${toolName}.json`);
}

/**
 * Migrate legacy state file to the new `.pait/state/` location.
 * Only copies if the legacy file exists and the new one does not.
 */
export function migrateStateIfNeeded(
	repoRoot: string,
	toolName: string,
	legacyPath: string
): void {
	const newPath = getStateFilePath(repoRoot, toolName);
	if (existsSync(legacyPath) && !existsSync(newPath)) {
		copyFileSync(legacyPath, newPath);
	}
}
