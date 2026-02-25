import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadState, saveState } from './state.ts';

interface TestState {
	version: number;
	updatedAt: string;
	data: string;
}

describe('loadState', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'pai-state-test-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('returns null when file does not exist', () => {
		const result = loadState<TestState>(join(tempDir, 'missing.json'));
		expect(result).toBeNull();
	});

	test('returns null for invalid JSON', () => {
		const path = join(tempDir, 'bad.json');
		Bun.write(path, 'not-json');
		const result = loadState<TestState>(path);
		expect(result).toBeNull();
	});

	test('returns parsed object for valid JSON file', () => {
		const path = join(tempDir, 'state.json');
		const data: TestState = { version: 1, updatedAt: '2024-01-01T00:00:00.000Z', data: 'hello' };
		Bun.write(path, JSON.stringify(data));
		const result = loadState<TestState>(path);
		expect(result).toEqual(data);
	});
});

describe('saveState', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'pai-state-test-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('writes state as pretty-printed JSON', () => {
		const path = join(tempDir, 'state.json');
		const state: TestState = { version: 1, updatedAt: '', data: 'test' };
		saveState(state, path);
		expect(existsSync(path)).toBe(true);
		const raw = readFileSync(path, 'utf-8');
		expect(raw).toContain('\n');
		const parsed = JSON.parse(raw);
		expect(parsed.version).toBe(1);
		expect(parsed.data).toBe('test');
	});

	test('stamps updatedAt with current timestamp', () => {
		const path = join(tempDir, 'state.json');
		const before = Date.now();
		const state: TestState = { version: 1, updatedAt: '', data: 'ts-test' };
		saveState(state, path);
		const after = Date.now();

		const parsed = JSON.parse(readFileSync(path, 'utf-8')) as TestState;
		const savedTs = new Date(parsed.updatedAt).getTime();
		expect(savedTs).toBeGreaterThanOrEqual(before);
		expect(savedTs).toBeLessThanOrEqual(after);
	});

	test('mutates state.updatedAt in place', () => {
		const path = join(tempDir, 'state.json');
		const state: TestState = { version: 1, updatedAt: 'old', data: 'mutate' };
		saveState(state, path);
		expect(state.updatedAt).not.toBe('old');
	});

	test('roundtrip: save then load returns equivalent state', () => {
		const path = join(tempDir, 'state.json');
		const state: TestState = { version: 2, updatedAt: '', data: 'roundtrip' };
		saveState(state, path);
		const loaded = loadState<TestState>(path);
		expect(loaded?.version).toBe(2);
		expect(loaded?.data).toBe('roundtrip');
		expect(loaded?.updatedAt).toBe(state.updatedAt);
	});
});
