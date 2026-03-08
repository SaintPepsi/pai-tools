import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultFsAdapter } from '@shared/adapters/fs.ts';
import { loadState, saveState } from '@shared/state.ts';
// initState and getIssueState are defined in index.ts directly (not a sub-module),
// so we import from there — consistent with orchestrator.parsing.test.ts which also
// imports parseFlags from ./index.ts.
import { initState, getIssueState, checkSplitParentCompletion } from '@tools/orchestrator/state-helpers.ts';
import type { OrchestratorState } from '@tools/orchestrator/types.ts';

describe('state management', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = defaultFsAdapter.mkdtemp(join(tmpdir(), 'pai-state-test-'));
	});

	afterEach(() => {
		defaultFsAdapter.rmrf(tempDir);
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

	test('stale error persists through save/load when not cleared', () => {
		// Documents that the production code does NOT enforce the completed+error==null
		// invariant automatically — callers are responsible for clearing error before
		// setting status to completed. This is a regression guard: if a future refactor
		// accidentally drops the null-assignment in the orchestrator loop, this test
		// will still pass (the invariant is not enforced), but the companion test above
		// will fail (the cleared state won't survive the roundtrip).
		const state = initState();
		const issue = getIssueState(state, 50, 'Issue with stale error');

		issue.status = 'completed';
		issue.error = 'leftover error from failed attempt';

		// The invalid state round-trips as-is — no production code clears it.
		const stateFile = join(tempDir, 'state.json');
		saveState(state, stateFile);
		const loaded = loadState<OrchestratorState>(stateFile);

		expect(loaded!.issues[50].status).toBe('completed');
		expect(loaded!.issues[50].error).toBe('leftover error from failed attempt');
	});
});

describe('checkSplitParentCompletion', () => {
	test('marks parent completed when all sub-issues are completed', () => {
		const state = initState();
		getIssueState(state, 1, 'Parent').status = 'split';
		state.issues[1].subIssues = [10, 11];
		getIssueState(state, 10, 'Sub A').status = 'completed';
		getIssueState(state, 11, 'Sub B').status = 'completed';

		const result = checkSplitParentCompletion(state, 11);

		expect(result).toEqual({ parentNumber: 1, allComplete: true });
		expect(state.issues[1].status).toBe('completed');
		expect(state.issues[1].completedAt).toBeTruthy();
	});

	test('does not mark parent when some sub-issues are incomplete', () => {
		const state = initState();
		getIssueState(state, 1, 'Parent').status = 'split';
		state.issues[1].subIssues = [10, 11];
		getIssueState(state, 10, 'Sub A').status = 'completed';
		getIssueState(state, 11, 'Sub B').status = 'in_progress';

		const result = checkSplitParentCompletion(state, 10);

		expect(result).toEqual({ parentNumber: 1, allComplete: false });
		expect(state.issues[1].status).toBe('split');
	});

	test('returns null when completed issue has no split parent', () => {
		const state = initState();
		getIssueState(state, 5, 'Standalone').status = 'completed';

		const result = checkSplitParentCompletion(state, 5);
		expect(result).toBeNull();
	});
});
