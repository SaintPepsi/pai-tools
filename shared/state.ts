/**
 * Generic JSON state persistence for .pait/ tool state files.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { getStateFilePath } from './config.ts';

/**
 * Load a JSON state file from disk.
 * Returns the parsed object, or null if the file is missing or unreadable.
 */
export function loadState<T>(path: string): T | null {
	try {
		const content = readFileSync(path, 'utf-8');
		if (!content) return null;
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

/**
 * Save a state object to disk as pretty-printed JSON.
 * Stamps `updatedAt` with the current ISO timestamp before writing.
 */
export function saveState<T extends { updatedAt: string }>(state: T, path: string): void {
	state.updatedAt = new Date().toISOString();
	writeFileSync(path, JSON.stringify(state, null, 2));
}

/**
 * Delete a tool's state file from `.pait/state/{toolName}.json`.
 * Silently ignores errors if the file does not exist.
 */
export function clearState(repoRoot: string, toolName: string): void {
	const statePath = getStateFilePath(repoRoot, toolName);
	if (existsSync(statePath)) {
		unlinkSync(statePath);
	}
}
