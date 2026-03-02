import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { $ } from 'bun';
import { migrateStateIfNeeded, getStateFilePath } from './config.ts';

describe('migrateStateIfNeeded', () => {
	test('copies legacy file to new location when new does not exist', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		await $`mkdir -p ${join(tmpDir, '.pait', 'state')}`.quiet();

		const legacyPath = join(tmpDir, 'legacy-state.json');
		await Bun.write(legacyPath, '{"version":1}');

		migrateStateIfNeeded(tmpDir, 'test-tool', legacyPath);

		const newPath = join(tmpDir, '.pait', 'state', 'test-tool.json');
		const content = await Bun.file(newPath).text();
		expect(content).toBe('{"version":1}');

		await $`rm -rf ${tmpDir}`.quiet();
	});

	test('does not overwrite existing new state file', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		await $`mkdir -p ${join(tmpDir, '.pait', 'state')}`.quiet();

		const legacyPath = join(tmpDir, 'legacy.json');
		await Bun.write(legacyPath, '{"old":true}');

		const newPath = join(tmpDir, '.pait', 'state', 'test-tool.json');
		await Bun.write(newPath, '{"new":true}');

		migrateStateIfNeeded(tmpDir, 'test-tool', legacyPath);

		const content = await Bun.file(newPath).text();
		expect(content).toBe('{"new":true}');

		await $`rm -rf ${tmpDir}`.quiet();
	});

	test('no-op when legacy file does not exist', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		migrateStateIfNeeded(tmpDir, 'test-tool', join(tmpDir, 'nonexistent.json'));
		await $`rm -rf ${tmpDir}`.quiet();
	});
});

describe('getStateFilePath', () => {
	test('creates state dir and returns correct path', async () => {
		const tmpDir = (await $`mktemp -d`.text()).trim();
		const result = getStateFilePath(tmpDir, 'my-tool');

		expect(result).toBe(join(tmpDir, '.pait', 'state', 'my-tool.json'));

		await $`rm -rf ${tmpDir}`.quiet();
	});
});
