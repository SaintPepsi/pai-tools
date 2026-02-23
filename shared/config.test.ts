import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findRepoRoot, loadToolConfig, saveToolConfig, getStateFilePath, migrateStateIfNeeded } from './config.ts';

describe('findRepoRoot', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'pai-config-test-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('finds repo root with .git directory', () => {
		mkdirSync(join(tempDir, '.git'));
		expect(findRepoRoot(tempDir)).toBe(tempDir);
	});

	test('finds repo root from nested directory', () => {
		mkdirSync(join(tempDir, '.git'));
		const nested = join(tempDir, 'src', 'components');
		mkdirSync(nested, { recursive: true });
		expect(findRepoRoot(nested)).toBe(tempDir);
	});

	test('throws when no .git found', () => {
		const isolated = mkdtempSync(join(tmpdir(), 'pai-no-git-'));
		expect(() => findRepoRoot(isolated)).toThrow(/No git repository found/);
		rmSync(isolated, { recursive: true, force: true });
	});
});

describe('loadToolConfig / saveToolConfig', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'pai-config-test-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('loadToolConfig returns defaults when no config file', () => {
		const defaults = { name: 'test', count: 5 };
		const config = loadToolConfig(tempDir, 'myTool', defaults);
		expect(config).toEqual(defaults);
	});

	test('loadToolConfig merges user config with defaults', () => {
		mkdirSync(join(tempDir, '.pait'));
		writeFileSync(
			join(tempDir, '.pait', 'myTool.json'),
			JSON.stringify({ count: 10 })
		);

		const defaults = { name: 'test', count: 5 };
		const config = loadToolConfig(tempDir, 'myTool', defaults);
		expect(config.name).toBe('test');
		expect(config.count).toBe(10);
	});

	test('saveToolConfig creates .pait directory if missing', () => {
		saveToolConfig(tempDir, 'myTool', { key: 'value' });
		expect(existsSync(join(tempDir, '.pait'))).toBe(true);
		expect(existsSync(join(tempDir, '.pait', 'myTool.json'))).toBe(true);
	});

	test('saveToolConfig merges into existing config', () => {
		mkdirSync(join(tempDir, '.pait'));
		writeFileSync(
			join(tempDir, '.pait', 'myTool.json'),
			JSON.stringify({ existing: true, overwrite: 'old' })
		);

		saveToolConfig(tempDir, 'myTool', { overwrite: 'new', added: 42 });

		const saved = JSON.parse(readFileSync(join(tempDir, '.pait', 'myTool.json'), 'utf-8'));
		expect(saved.existing).toBe(true);
		expect(saved.overwrite).toBe('new');
		expect(saved.added).toBe(42);
	});

	test('save then load roundtrip preserves data', () => {
		const defaults = { name: 'default', items: [] as string[] };
		saveToolConfig(tempDir, 'roundtrip', { name: 'custom', items: ['a', 'b'] });
		const loaded = loadToolConfig(tempDir, 'roundtrip', defaults);
		expect(loaded.name).toBe('custom');
		expect(loaded.items).toEqual(['a', 'b']);
	});
});

describe('getStateFilePath', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'pai-state-path-test-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('creates .pait/state directory', () => {
		const path = getStateFilePath(tempDir, 'orchestrator');
		expect(path).toBe(join(tempDir, '.pait', 'state', 'orchestrator.json'));
		expect(existsSync(join(tempDir, '.pait', 'state'))).toBe(true);
	});

	test('creates .gitignore in .pait', () => {
		getStateFilePath(tempDir, 'orchestrator');
		const gitignore = readFileSync(join(tempDir, '.pait', '.gitignore'), 'utf-8');
		expect(gitignore).toContain('state/');
		expect(gitignore).toContain('logs/');
	});
});

describe('migrateStateIfNeeded', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'pai-migrate-test-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('copies legacy file to new location', () => {
		const legacyPath = join(tempDir, 'legacy-state.json');
		writeFileSync(legacyPath, JSON.stringify({ version: 1, issues: {} }));

		migrateStateIfNeeded(tempDir, 'orchestrator', legacyPath);

		const newPath = join(tempDir, '.pait', 'state', 'orchestrator.json');
		expect(existsSync(newPath)).toBe(true);
		const content = JSON.parse(readFileSync(newPath, 'utf-8'));
		expect(content.version).toBe(1);
	});

	test('does not overwrite existing new file', () => {
		const legacyPath = join(tempDir, 'legacy-state.json');
		writeFileSync(legacyPath, JSON.stringify({ version: 1, old: true }));

		// Create the new location first
		mkdirSync(join(tempDir, '.pait', 'state'), { recursive: true });
		const newPath = join(tempDir, '.pait', 'state', 'orchestrator.json');
		writeFileSync(newPath, JSON.stringify({ version: 1, new: true }));

		migrateStateIfNeeded(tempDir, 'orchestrator', legacyPath);

		const content = JSON.parse(readFileSync(newPath, 'utf-8'));
		expect(content.new).toBe(true);
		expect(content.old).toBeUndefined();
	});

	test('no-op when legacy file does not exist', () => {
		migrateStateIfNeeded(tempDir, 'orchestrator', join(tempDir, 'nonexistent.json'));
		// Should not create the state dir since there's nothing to migrate
		expect(existsSync(join(tempDir, '.pait', 'state', 'orchestrator.json'))).toBe(false);
	});
});
