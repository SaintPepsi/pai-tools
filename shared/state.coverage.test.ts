import { describe, test, expect } from 'bun:test';
import { $ } from 'bun';
import { join } from 'node:path';
import { clearState, loadState, saveState } from './state.ts';
import type { StateDeps } from './state.ts';
import type { FsAdapter } from './adapters/fs.ts';

function makeMockFs(overrides: Partial<FsAdapter> = {}): FsAdapter {
	return {
		readFile: () => '',
		writeFile: () => {},
		appendFile: () => {},
		unlinkFile: () => {},
		fileExists: () => false,
		mkdirp: () => {},
		copyFile: () => {},
		rmrf: () => {},
		parseJson: (c) => { try { return JSON.parse(c); } catch { return null; } },
		...overrides,
	};
}

describe('clearState', () => {
	test('deletes state file when it exists', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		await $`mkdir -p ${join(tmpDir, '.pait', 'state')}`.quiet();
		const statePath = join(tmpDir, '.pait', 'state', 'orchestrator.json');
		await Bun.write(statePath, '{"version":1}');

		clearState(tmpDir, 'orchestrator');

		const exists = await Bun.file(statePath).exists();
		expect(exists).toBe(false);

		await $`rm -rf ${tmpDir}`.quiet();
	});

	test('no-op when state file does not exist', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		// Should not throw
		clearState(tmpDir, 'nonexistent-tool');

		await $`rm -rf ${tmpDir}`.quiet();
	});

	test('uses injected deps for filesystem operations', () => {
		let unlinkedPath = '';
		const mockFs = makeMockFs({
			fileExists: () => true,
			unlinkFile: (p) => { unlinkedPath = p; },
			mkdirp: () => {},
		});
		const deps: StateDeps = { fs: mockFs };

		clearState('/fake/root', 'test-tool', deps);
		expect(unlinkedPath).toContain('test-tool.json');
	});
});

describe('loadState — parseJson adapter', () => {
	test('returns null for invalid JSON via adapter', () => {
		const mockFs = makeMockFs({
			fileExists: () => true,
			readFile: () => 'not-json-at-all',
			parseJson: () => null,
		});
		const deps: StateDeps = { fs: mockFs };

		const result = loadState('/fake/path.json', deps);
		expect(result).toBeNull();
	});
});
