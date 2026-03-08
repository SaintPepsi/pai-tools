import { describe, test, expect } from 'bun:test';
import { reconcileWithGitHub, initState, getIssueState, type ReconciliationDeps } from '@tools/orchestrator/state-helpers.ts';

const noopLog = { info: () => {}, warn: () => {}, ok: () => {} };

describe('reconcileWithGitHub', () => {
	test('resets completed issue to failed when PR was closed without merge', async () => {
		const state = initState();
		const is = getIssueState(state, 1, 'Feature');
		is.status = 'completed';
		is.prNumber = 42;

		const deps: ReconciliationDeps = {
			exec: async (cmd) => {
				if (cmd.includes('pr') && cmd.includes('view')) {
					return { exitCode: 0, stdout: 'CLOSED', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			},
			log: noopLog,
		};

		const corrections = await reconcileWithGitHub(state, '/repo', deps);
		expect(state.issues[1].status).toBe('failed');
		expect(state.issues[1].error).toContain('closed without merge');
		expect(corrections.length).toBe(1);
	});

	test('leaves completed issue alone when PR was merged', async () => {
		const state = initState();
		const is = getIssueState(state, 1, 'Feature');
		is.status = 'completed';
		is.prNumber = 42;

		const deps: ReconciliationDeps = {
			exec: async () => ({ exitCode: 0, stdout: 'MERGED', stderr: '' }),
			log: noopLog,
		};

		const corrections = await reconcileWithGitHub(state, '/repo', deps);
		expect(state.issues[1].status).toBe('completed');
		expect(corrections.length).toBe(0);
	});

	test('marks split parent completed when all sub-issues are closed on GitHub', async () => {
		const state = initState();
		const parent = getIssueState(state, 1, 'Parent');
		parent.status = 'split';
		parent.subIssues = [10, 11];
		getIssueState(state, 10).status = 'completed';
		getIssueState(state, 11).status = 'in_progress';

		const deps: ReconciliationDeps = {
			exec: async (cmd) => {
				if (cmd.includes('issue') && cmd.includes('view')) {
					return { exitCode: 0, stdout: 'closed', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			},
			log: noopLog,
		};

		const corrections = await reconcileWithGitHub(state, '/repo', deps);
		expect(state.issues[1].status).toBe('completed');
		expect(corrections.length).toBeGreaterThanOrEqual(1);
	});

	test('does not mark split parent when some sub-issues are open on GitHub', async () => {
		const state = initState();
		const parent = getIssueState(state, 1, 'Parent');
		parent.status = 'split';
		parent.subIssues = [10, 11];
		getIssueState(state, 10).status = 'completed';
		getIssueState(state, 11).status = 'in_progress';

		const deps: ReconciliationDeps = {
			exec: async (cmd) => {
				if (cmd.includes('issue') && cmd.includes('view')) {
					const subNum = cmd[cmd.indexOf('view') + 1];
					if (subNum === '10') return { exitCode: 0, stdout: 'closed', stderr: '' };
					return { exitCode: 0, stdout: 'open', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			},
			log: noopLog,
		};

		const corrections = await reconcileWithGitHub(state, '/repo', deps);
		expect(state.issues[1].status).toBe('split');
		expect(corrections.length).toBe(0);
	});

	test('resets in_progress to pending when branch does not exist', async () => {
		const state = initState();
		const is = getIssueState(state, 1, 'Feature');
		is.status = 'in_progress';
		is.branch = 'feat/1-feature';

		const deps: ReconciliationDeps = {
			exec: async (cmd) => {
				if (cmd.includes('branch') && cmd.includes('--list')) {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			},
			log: noopLog,
		};

		const corrections = await reconcileWithGitHub(state, '/repo', deps);
		expect(state.issues[1].status).toBe('pending');
		expect(state.issues[1].branch).toBeNull();
		expect(state.issues[1].baseBranch).toBeNull();
		expect(corrections.length).toBe(1);
	});

	test('leaves in_progress alone when branch exists', async () => {
		const state = initState();
		const is = getIssueState(state, 1, 'Feature');
		is.status = 'in_progress';
		is.branch = 'feat/1-feature';

		const deps: ReconciliationDeps = {
			exec: async (cmd) => {
				if (cmd.includes('branch') && cmd.includes('--list')) {
					return { exitCode: 0, stdout: '  feat/1-feature', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			},
			log: noopLog,
		};

		const corrections = await reconcileWithGitHub(state, '/repo', deps);
		expect(state.issues[1].status).toBe('in_progress');
		expect(corrections.length).toBe(0);
	});

	test('handles gh CLI failures gracefully - leaves state unchanged', async () => {
		const state = initState();
		const is = getIssueState(state, 1, 'Feature');
		is.status = 'completed';
		is.prNumber = 42;

		const deps: ReconciliationDeps = {
			exec: async () => ({ exitCode: 1, stdout: '', stderr: 'network error' }),
			log: noopLog,
		};

		const corrections = await reconcileWithGitHub(state, '/repo', deps);
		expect(state.issues[1].status).toBe('completed');
		expect(corrections.length).toBe(0);
	});

	test('log message captures branch name before nulling it', async () => {
		const state = initState();
		const is = getIssueState(state, 1, 'Feature');
		is.status = 'in_progress';
		is.branch = 'feat/1-feature';

		const logged: string[] = [];
		const deps: ReconciliationDeps = {
			exec: async (cmd) => {
				if (cmd.includes('branch') && cmd.includes('--list')) {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			},
			log: { info: (m) => logged.push(m), warn: (m) => logged.push(m), ok: (m) => logged.push(m) },
		};

		const corrections = await reconcileWithGitHub(state, '/repo', deps);
		expect(corrections[0]).toContain('feat/1-feature');
		expect(corrections[0]).not.toContain('null');
	});

	test('skips completed issues without a prNumber', async () => {
		const state = initState();
		const is = getIssueState(state, 1, 'Feature');
		is.status = 'completed';
		is.prNumber = null;

		let execCalled = false;
		const deps: ReconciliationDeps = {
			exec: async () => { execCalled = true; return { exitCode: 0, stdout: '', stderr: '' }; },
			log: noopLog,
		};

		const corrections = await reconcileWithGitHub(state, '/repo', deps);
		expect(corrections.length).toBe(0);
		expect(execCalled).toBe(false);
	});

	test('skips in_progress issues without a branch', async () => {
		const state = initState();
		const is = getIssueState(state, 1, 'Feature');
		is.status = 'in_progress';
		is.branch = null;

		let execCalled = false;
		const deps: ReconciliationDeps = {
			exec: async () => { execCalled = true; return { exitCode: 0, stdout: '', stderr: '' }; },
			log: noopLog,
		};

		const corrections = await reconcileWithGitHub(state, '/repo', deps);
		expect(corrections.length).toBe(0);
		expect(execCalled).toBe(false);
	});
});
