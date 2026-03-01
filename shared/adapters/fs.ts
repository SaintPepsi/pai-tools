/**
 * Adapter: wraps Node.js fs builtins behind injectable interfaces.
 * This file is exempt from the raw-import coding standard (adapters/ directory).
 */

import {
	readFileSync,
	writeFileSync,
	appendFileSync,
	unlinkSync,
	existsSync,
	mkdirSync,
	copyFileSync,
	rmSync,
} from 'node:fs';

export interface FsAdapter {
	readFile: (path: string) => string;
	writeFile: (path: string, data: string) => void;
	appendFile: (path: string, data: string) => void;
	unlinkFile: (path: string) => void;
	fileExists: (path: string) => boolean;
	mkdirp: (path: string) => void;
	copyFile: (src: string, dest: string) => void;
	rmrf: (path: string) => void;
	parseJson: (content: string) => unknown | null;
}

export const defaultFsAdapter: FsAdapter = {
	readFile: (p) => readFileSync(p, 'utf-8'),
	writeFile: (p, d) => writeFileSync(p, d),
	appendFile: (p, d) => appendFileSync(p, d),
	unlinkFile: (p) => unlinkSync(p),
	fileExists: (p) => existsSync(p),
	mkdirp: (p) => mkdirSync(p, { recursive: true }),
	copyFile: (src, dest) => copyFileSync(src, dest),
	rmrf: (p) => rmSync(p, { recursive: true, force: true }),
	parseJson: (content) => { try { return JSON.parse(content); } catch { return null; } },
};
