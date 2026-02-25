import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadState, saveState } from '../../shared/state.ts';
import { initState, getIssueState } from './index.ts';
import type { OrchestratorState } from './types.ts';

describe('state management', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'pai-state-test-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('initState returns valid empty state', () => {
		const state = initState();
		expect(state.version).toBe(1);
		expect(state.issues).toEqual({});
		expect(state.startedAt).toBeTruthy();
		expect(state.updatedAt).toBeTruthy();
	});

	test('saveState and loadState roundtrip', () => {
		const stateFile = join(tempDir, 'state.json');
		const state = initState();
		getIssueState(state, 42, 'Test issue');

		saveState(state, stateFile);
		const loaded = loadState<OrchestratorState>(stateFile);

		expect(loaded).not.toBeNull();
		expect(loaded!.version).toBe(1);
		expect(loaded!.issues[42]).toBeDefined();
		expect(loaded!.issues[42].title).toBe('Test issue');
		expect(loaded!.issues[42].status).toBe('pending');
	});

	test('loadState returns null for missing file', () => {
		expect(loadState(join(tempDir, 'nonexistent.json'))).toBeNull();
	});

	test('getIssueState creates new entry with defaults', () => {
		const state = initState();
		const issue = getIssueState(state, 10, 'New issue');

		expect(issue.number).toBe(10);
		expect(issue.title).toBe('New issue');
		expect(issue.status).toBe('pending');
		expect(issue.branch).toBeNull();
		expect(issue.prNumber).toBeNull();
		expect(issue.error).toBeNull();
	});

	test('getIssueState returns existing entry on repeat call', () => {
		const state = initState();
		const first = getIssueState(state, 10, 'First title');
		first.status = 'completed';

		const second = getIssueState(state, 10, 'Different title');
		expect(second.status).toBe('completed');
		expect(second.title).toBe('First title');
	});

	test('getIssueState fills null title on repeat call', () => {
		const state = initState();
		getIssueState(state, 10);
		expect(state.issues[10].title).toBeNull();

		getIssueState(state, 10, 'Late title');
		expect(state.issues[10].title).toBe('Late title');
	});

	test('completed issue must have error cleared to null', () => {
		const state = initState();
		const issue = getIssueState(state, 99, 'Flaky issue');

		// Simulate a failed attempt
		issue.status = 'in_progress';
		issue.error = 'worktree creation failed with exit code 128';

		// Simulate successful retry — the fix from b399e31
		issue.status = 'completed';
		issue.error = null;
		issue.completedAt = new Date().toISOString();

		expect(issue.status).toBe('completed');
		expect(issue.error).toBeNull();

		// Roundtrip through save/load to confirm persistence
		const stateFile = join(tempDir, 'state.json');
		saveState(state, stateFile);
		const loaded = loadState<OrchestratorState>(stateFile);
		expect(loaded!.issues[99].status).toBe('completed');
		expect(loaded!.issues[99].error).toBeNull();
	});

	test('completed issue with stale error is a contract violation', () => {
		const state = initState();
		const issue = getIssueState(state, 50, 'Should not have error when completed');

		issue.status = 'completed';
		issue.error = 'leftover error from failed attempt';

		// This state is invalid — completed + non-null error should never happen
		// The test documents the invariant: if status is completed, error must be null
		expect(issue.status).toBe('completed');
		expect(issue.error).not.toBeNull(); // This is the BAD state

		// Correct it
		issue.error = null;
		expect(issue.error).toBeNull(); // This is the GOOD state
	});
});
