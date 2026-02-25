/**
 * Generic JSON state persistence for .pait/ tool state files.
 */

import { readFileSync, writeFileSync } from 'node:fs';

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
