/**
 * Filesystem adapter — uses Bun native APIs for dependency injection.
 * No node:fs import required; Bun.file / Bun.write are global.
 */

import { $ } from 'bun';

export async function readFile(path: string): Promise<string> {
	return Bun.file(path).text();
}

export async function writeFile(path: string, content: string): Promise<void> {
	await Bun.write(path, content);
}

export async function fileExists(path: string): Promise<boolean> {
	return Bun.file(path).exists();
}

export async function removeDir(path: string): Promise<void> {
	await $`rm -rf ${path}`.nothrow().quiet();
}
