/**
 * Generic JSON state persistence for .pait/ tool state files.
 */

import { join } from 'node:path';
import type { FsAdapter } from './adapters/fs.ts';
import { defaultFsAdapter } from './adapters/fs.ts';

export interface StateDeps {
	fs: FsAdapter;
}

export const defaultStateDeps: StateDeps = {
	fs: defaultFsAdapter,
};

/**
 * Load a JSON state file from disk.
 * Returns the parsed object, or null if the file is missing or unreadable.
 */
export function loadState<T>(path: string, deps: StateDeps = defaultStateDeps): T | null {
	if (!deps.fs.fileExists(path)) return null;
	const content = deps.fs.readFile(path);
	if (!content) return null;
	return deps.fs.parseJson(content) as T | null;
}

/**
 * Save a state object to disk as pretty-printed JSON.
 * Stamps `updatedAt` with the current ISO timestamp before writing.
 */
export function saveState<T extends { updatedAt: string }>(state: T, path: string, deps: StateDeps = defaultStateDeps): void {
	state.updatedAt = new Date().toISOString();
	deps.fs.writeFile(path, JSON.stringify(state, null, 2));
}

/**
 * Delete a tool's state file from `.pait/state/{toolName}.json`.
 * Silently ignores errors if the file does not exist.
 */
export function clearState(repoRoot: string, toolName: string, deps: StateDeps = defaultStateDeps): void {
	const statePath = join(repoRoot, '.pait', 'state', `${toolName}.json`);
	if (deps.fs.fileExists(statePath)) {
		deps.fs.unlinkFile(statePath);
	}
}
