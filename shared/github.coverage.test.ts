/**
 * Coverage tests for shared/github.ts — uses mock GithubDeps to exercise all branches
 * without running real gh CLI commands.
 */

import { describe, test, expect, mock } from 'bun:test';
import type { GithubDeps } from './github.ts';
import type { FsAdapter } from './adapters/fs.ts';
import {
	fetchOpenIssues,
	createSubIssues,
	createPR,
	determineMergeOrder,
	discoverMergeablePRs,
	mergePR,
	defaultGithubDeps,
} from './github.ts';
import type { GitHubIssue, MergeOrder } from './github.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFs(overrides: Partial<FsAdapter> = {}): FsAdapter {
	return {
		readFile: () => '',
		writeFile: () => {},
		appendFile: () => {},
		unlinkFile: () => {},
		fileExists: () => false,
		mkdirp: () => {},
		copyFile: () => {},
		rmrf: () => {},
		parseJson: () => null,
		...overrides,
	};
}

function makeDeps(overrides: Partial<GithubDeps> = {}): GithubDeps {
	return {
		exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
		fs: makeFs(),
		sleep: async () => {},
		...overrides,
	};
}

function makeIssue(n: number): GitHubIssue {
	return { number: n, title: `Issue ${n}`, body: 'body', state: 'open', labels: [] };
}

// ---------------------------------------------------------------------------
// fetchOpenIssues
// ---------------------------------------------------------------------------

describe('fetchOpenIssues', () => {
	test('uses gh api user when no authors provided', async () => {
		const calls: string[][] = [];
		const issues: GitHubIssue[] = [makeIssue(1), makeIssue(2)];
		const deps = makeDeps({
			exec: async (cmd) => {
				calls.push(cmd);
				if (cmd.includes('api')) return { exitCode: 0, stdout: 'testuser\n', stderr: '' };
				return { exitCode: 0, stdout: JSON.stringify(issues), stderr: '' };
			},
		});
		const result = await fetchOpenIssues(undefined, deps);
		expect(result).toHaveLength(2);
		expect(calls.some(c => c.includes('api'))).toBe(true);
	});

	test('uses provided authors without calling gh api user', async () => {
		const calls: string[][] = [];
		const deps = makeDeps({
			exec: async (cmd) => {
				calls.push(cmd);
				return { exitCode: 0, stdout: JSON.stringify([makeIssue(5)]), stderr: '' };
			},
		});
		const result = await fetchOpenIssues(['alice'], deps);
		expect(result).toHaveLength(1);
		expect(result[0].number).toBe(5);
		expect(calls.every(c => !c.includes('api'))).toBe(true);
	});

	test('deduplicates issues seen across multiple authors', async () => {
		const issue = makeIssue(10);
		const deps = makeDeps({
			exec: async () => ({ exitCode: 0, stdout: JSON.stringify([issue]), stderr: '' }),
		});
		const result = await fetchOpenIssues(['alice', 'bob'], deps);
		expect(result).toHaveLength(1);
	});

	test('returns empty array when no issues found', async () => {
		const deps = makeDeps({
			exec: async () => ({ exitCode: 0, stdout: '[]', stderr: '' }),
		});
		const result = await fetchOpenIssues(['alice'], deps);
		expect(result).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// createSubIssues
// ---------------------------------------------------------------------------

describe('createSubIssues', () => {
	test('creates sub-issues and returns their numbers', async () => {
		const parent = makeIssue(1);
		const deps = makeDeps({
			exec: async () => ({ exitCode: 0, stdout: 'https://github.com/owner/repo/issues/42', stderr: '' }),
		});
		const result = await createSubIssues(parent, [{ title: 'Sub A', body: 'body A' }], [], deps);
		expect(result).toEqual([42]);
	});

	test('chains sub-issues: second depends on first', async () => {
		const parent = makeIssue(1);
		let callCount = 0;
		const deps = makeDeps({
			exec: async () => {
				callCount++;
				const num = callCount === 1 ? 10 : 11;
				return { exitCode: 0, stdout: `https://github.com/owner/repo/issues/${num}`, stderr: '' };
			},
		});
		const splits = [{ title: 'Sub A', body: 'body A' }, { title: 'Sub B', body: 'body B' }];
		const result = await createSubIssues(parent, splits, [], deps);
		expect(result).toEqual([10, 11]);
	});

	test('includes parent deps in first sub-issue when no previous', async () => {
		const parent = makeIssue(5);
		const calls: string[][] = [];
		const deps = makeDeps({
			exec: async (cmd) => {
				calls.push(cmd);
				return { exitCode: 0, stdout: 'https://github.com/owner/repo/issues/20', stderr: '' };
			},
		});
		await createSubIssues(parent, [{ title: 'Sub', body: 'body' }], [3, 4, 5], deps);
		// parent deps [3,4] used (5 filtered out as it's the parent itself)
		const bodyArg = calls[0].find(a => a.includes('Depends on'));
		expect(bodyArg).toContain('#3');
		expect(bodyArg).toContain('#4');
	});

	test('skips issues with no number match', async () => {
		const parent = makeIssue(1);
		const deps = makeDeps({
			exec: async () => ({ exitCode: 0, stdout: 'no-number-here', stderr: '' }),
		});
		const result = await createSubIssues(parent, [{ title: 'Sub', body: 'body' }], [], deps);
		expect(result).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// createPR
// ---------------------------------------------------------------------------

describe('createPR', () => {
	test('returns ok:true with prNumber on success', async () => {
		const deps = makeDeps({
			exec: async (cmd) => {
				if (cmd.includes('push')) return { exitCode: 0, stdout: '', stderr: '' };
				return { exitCode: 0, stdout: 'https://github.com/owner/repo/pull/99', stderr: '' };
			},
		});
		const result = await createPR('Title', 'Body', 'main', 'feat/1', '/wt', deps);
		expect(result.ok).toBe(true);
		expect(result.prNumber).toBe(99);
	});

	test('returns ok:false when push fails', async () => {
		const deps = makeDeps({
			exec: async (cmd) => {
				if (cmd.includes('push')) return { exitCode: 1, stdout: '', stderr: 'push rejected' };
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		});
		const result = await createPR('Title', 'Body', 'main', 'feat/1', '/wt', deps);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('push');
	});

	test('returns ok:false when gh pr create fails', async () => {
		const deps = makeDeps({
			exec: async (cmd) => {
				if (cmd.includes('push')) return { exitCode: 0, stdout: '', stderr: '' };
				return { exitCode: 1, stdout: '', stderr: 'validation failed' };
			},
		});
		const result = await createPR('Title', 'Body', 'main', 'feat/1', '/wt', deps);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Failed to create PR');
	});

	test('handles pr output with no number match', async () => {
		const deps = makeDeps({
			exec: async () => ({ exitCode: 0, stdout: 'https://github.com/owner/repo/pull/created', stderr: '' }),
		});
		const result = await createPR('Title', 'Body', 'main', 'feat/1', '/wt', deps);
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// determineMergeOrder
// ---------------------------------------------------------------------------

describe('determineMergeOrder', () => {
	test('returns single PR unchanged', () => {
		const prs: MergeOrder[] = [{ issueNumber: 1, prNumber: 10, branch: 'feat/1', baseBranch: 'main' }];
		expect(determineMergeOrder(prs)).toEqual(prs);
	});

	test('orders stacked PRs: base before dependent', () => {
		const prs: MergeOrder[] = [
			{ issueNumber: 2, prNumber: 20, branch: 'feat/2', baseBranch: 'feat/1' },
			{ issueNumber: 1, prNumber: 10, branch: 'feat/1', baseBranch: 'main' },
		];
		const result = determineMergeOrder(prs);
		expect(result[0].branch).toBe('feat/1');
		expect(result[1].branch).toBe('feat/2');
	});

	test('orders independent PRs by issue number', () => {
		const prs: MergeOrder[] = [
			{ issueNumber: 3, prNumber: 30, branch: 'feat/3', baseBranch: 'main' },
			{ issueNumber: 1, prNumber: 10, branch: 'feat/1', baseBranch: 'main' },
			{ issueNumber: 2, prNumber: 20, branch: 'feat/2', baseBranch: 'main' },
		];
		const result = determineMergeOrder(prs);
		expect(result.map(p => p.issueNumber)).toEqual([1, 2, 3]);
	});

	test('throws on circular dependency', () => {
		const prs: MergeOrder[] = [
			{ issueNumber: 1, prNumber: 10, branch: 'feat/1', baseBranch: 'feat/2' },
			{ issueNumber: 2, prNumber: 20, branch: 'feat/2', baseBranch: 'feat/1' },
		];
		expect(() => determineMergeOrder(prs)).toThrow('Cycle detected');
	});

	test('returns empty array for empty input', () => {
		expect(determineMergeOrder([])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// discoverMergeablePRs
// ---------------------------------------------------------------------------

describe('discoverMergeablePRs', () => {
	// discoverMergeablePRs calls getStateFilePath which creates .pait/state/ on disk.
	// We use a real temp dir so that mkdir succeeds, then control the rest via deps.fs.

	test('returns empty array when state file does not exist', async () => {
		const tmpDir = (await Bun.$`mktemp -d`.text()).trim();
		const deps = makeDeps({ fs: makeFs({ fileExists: () => false }) });
		const result = await discoverMergeablePRs(tmpDir, deps);
		expect(result).toEqual([]);
		await Bun.$`rm -rf ${tmpDir}`.quiet();
	});

	test('returns open PRs from state file', async () => {
		const tmpDir = (await Bun.$`mktemp -d`.text()).trim();
		const state = {
			issues: {
				1: { number: 1, title: 'T', status: 'completed', branch: 'feat/1', baseBranch: 'main', prNumber: 10 },
				2: { number: 2, title: 'T', status: 'in_progress', branch: 'feat/2', baseBranch: 'main', prNumber: 20 },
			},
		};
		const deps = makeDeps({
			fs: makeFs({
				fileExists: () => true,
				readFile: () => JSON.stringify(state),
			}),
			exec: async (cmd) => {
				if (cmd.includes('view')) return { exitCode: 0, stdout: 'OPEN', stderr: '' };
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		});
		const result = await discoverMergeablePRs(tmpDir, deps);
		expect(result).toHaveLength(1);
		expect(result[0].issueNumber).toBe(1);
		expect(result[0].prNumber).toBe(10);
		await Bun.$`rm -rf ${tmpDir}`.quiet();
	});

	test('skips PRs that are not OPEN', async () => {
		const tmpDir = (await Bun.$`mktemp -d`.text()).trim();
		const state = {
			issues: {
				1: { number: 1, title: 'T', status: 'completed', branch: 'feat/1', baseBranch: 'main', prNumber: 10 },
			},
		};
		const deps = makeDeps({
			fs: makeFs({
				fileExists: () => true,
				readFile: () => JSON.stringify(state),
			}),
			exec: async () => ({ exitCode: 0, stdout: 'MERGED', stderr: '' }),
		});
		const result = await discoverMergeablePRs(tmpDir, deps);
		expect(result).toHaveLength(0);
		await Bun.$`rm -rf ${tmpDir}`.quiet();
	});

	test('skips PRs where gh pr view fails', async () => {
		const tmpDir = (await Bun.$`mktemp -d`.text()).trim();
		const state = {
			issues: {
				1: { number: 1, title: 'T', status: 'completed', branch: 'feat/1', baseBranch: 'main', prNumber: 10 },
			},
		};
		const deps = makeDeps({
			fs: makeFs({
				fileExists: () => true,
				readFile: () => JSON.stringify(state),
			}),
			exec: async () => ({ exitCode: 1, stdout: '', stderr: 'not found' }),
		});
		const result = await discoverMergeablePRs(tmpDir, deps);
		expect(result).toHaveLength(0);
		await Bun.$`rm -rf ${tmpDir}`.quiet();
	});

	test('uses "master" as fallback when baseBranch is null', async () => {
		const tmpDir = (await Bun.$`mktemp -d`.text()).trim();
		const state = {
			issues: {
				1: { number: 1, title: 'T', status: 'completed', branch: 'feat/1', baseBranch: null, prNumber: 10 },
			},
		};
		const deps = makeDeps({
			fs: makeFs({
				fileExists: () => true,
				readFile: () => JSON.stringify(state),
			}),
			exec: async () => ({ exitCode: 0, stdout: 'OPEN', stderr: '' }),
		});
		const result = await discoverMergeablePRs(tmpDir, deps);
		expect(result[0].baseBranch).toBe('master');
		await Bun.$`rm -rf ${tmpDir}`.quiet();
	});

	test('skips issues without prNumber or branch', async () => {
		const tmpDir = (await Bun.$`mktemp -d`.text()).trim();
		const state = {
			issues: {
				1: { number: 1, title: 'T', status: 'completed', branch: null, baseBranch: 'main', prNumber: 10 },
				2: { number: 2, title: 'T', status: 'completed', branch: 'feat/2', baseBranch: 'main', prNumber: null },
			},
		};
		const deps = makeDeps({
			fs: makeFs({
				fileExists: () => true,
				readFile: () => JSON.stringify(state),
			}),
			exec: async () => ({ exitCode: 0, stdout: 'OPEN', stderr: '' }),
		});
		const result = await discoverMergeablePRs(tmpDir, deps);
		expect(result).toHaveLength(0);
		await Bun.$`rm -rf ${tmpDir}`.quiet();
	});
});

// ---------------------------------------------------------------------------
// mergePR
// ---------------------------------------------------------------------------

describe('mergePR', () => {
	test('dry run returns ok:true without calling exec', async () => {
		const calls: string[][] = [];
		const deps = makeDeps({ exec: async (cmd) => { calls.push(cmd); return { exitCode: 0, stdout: '', stderr: '' }; } });
		const result = await mergePR(42, 'squash', true, deps);
		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(0);
	});

	test('returns ok:true when gh pr merge succeeds on first attempt', async () => {
		const deps = makeDeps({ exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
		const result = await mergePR(42, 'squash', false, deps);
		expect(result.ok).toBe(true);
	});

	test('retries once on failure then returns ok:true', async () => {
		let callCount = 0;
		const deps = makeDeps({
			exec: async () => {
				callCount++;
				if (callCount === 1) return { exitCode: 1, stdout: '', stderr: 'processing' };
				return { exitCode: 0, stdout: '', stderr: '' };
			},
			sleep: async () => {},
		});
		const result = await mergePR(42, 'merge', false, deps);
		expect(result.ok).toBe(true);
		expect(callCount).toBe(2);
	});

	test('returns ok:false after two failures', async () => {
		let callCount = 0;
		const deps = makeDeps({
			exec: async () => { callCount++; return { exitCode: 1, stdout: '', stderr: 'failed' }; },
			sleep: async () => {},
		});
		const result = await mergePR(42, 'rebase', false, deps);
		expect(result.ok).toBe(false);
		expect(result.error).toBe('failed');
		expect(callCount).toBe(2);
	});

	test('calls sleep between retry attempts', async () => {
		let slept = false;
		let callCount = 0;
		const deps = makeDeps({
			exec: async () => { callCount++; return { exitCode: 1, stdout: '', stderr: 'err' }; },
			sleep: async (ms) => { slept = true; expect(ms).toBe(3000); },
		});
		await mergePR(42, 'squash', false, deps);
		expect(slept).toBe(true);
	});

	test('supports all merge strategies', async () => {
		for (const strategy of ['squash', 'merge', 'rebase'] as const) {
			const calls: string[][] = [];
			const deps = makeDeps({ exec: async (cmd) => { calls.push(cmd); return { exitCode: 0, stdout: '', stderr: '' }; } });
			const result = await mergePR(1, strategy, false, deps);
			expect(result.ok).toBe(true);
			expect(calls[0].some(a => a === `--${strategy}`)).toBe(true);
		}
	});

	test('returns ok:true on successful second attempt', async () => {
		let callCount = 0;
		const deps = makeDeps({
			exec: async () => {
				callCount++;
				return callCount < 2
					? { exitCode: 1, stdout: '', stderr: 'not ready' }
					: { exitCode: 0, stdout: '', stderr: '' };
			},
			sleep: async () => {},
		});
		const result = await mergePR(7, 'squash', false, deps);
		expect(result.ok).toBe(true);
		expect(callCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// defaultGithubDeps.exec — exercise the real Bun.spawnSync path
// ---------------------------------------------------------------------------

describe('defaultGithubDeps — built-in dep implementations', () => {
	test('exec runs a real command and returns stdout', async () => {
		const result = await defaultGithubDeps.exec(['echo', 'hi']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe('hi');
	});

	test('exec returns non-zero exit for a failing command', async () => {
		const result = await defaultGithubDeps.exec(['false']);
		expect(result.exitCode).not.toBe(0);
	});

	test('sleep resolves after the given duration', async () => {
		const before = Date.now();
		await defaultGithubDeps.sleep(50);
		expect(Date.now() - before).toBeGreaterThanOrEqual(40);
	});
});
