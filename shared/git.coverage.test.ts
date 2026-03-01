/**
 * Coverage tests for shared/git.ts — uses mock GitDeps to exercise all branches
 * without running real git commands.
 */

import { describe, test, expect, mock } from 'bun:test';
import type { GitDeps } from './git.ts';
import type { FsAdapter } from './adapters/fs.ts';
import type { RunClaudeOpts } from './claude.ts';
import {
	localBranchExists,
	deleteLocalBranch,
	createWorktree,
	removeWorktree,
	rebaseBranch,
	detectConflicts,
	presentConflicts,
	resolveConflicts,
	autoResolveConflicts,
	defaultGitDeps,
} from './git.ts';
import type { RunLogger } from './logging.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExec(responses: Record<string, { exitCode: number; stdout: string; stderr: string }>) {
	return async (cmd: string[]) => {
		const key = cmd.join(' ');
		for (const [pattern, resp] of Object.entries(responses)) {
			if (key.includes(pattern)) return resp;
		}
		return { exitCode: 0, stdout: '', stderr: '' };
	};
}

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

function makeDeps(overrides: Partial<GitDeps> = {}): GitDeps {
	return {
		exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
		fs: makeFs(),
		env: {},
		claude: async (_opts: RunClaudeOpts) => ({ ok: false, output: '' }),
		prompt: async () => '',
		...overrides,
	};
}

function makeLogger(): RunLogger {
	return {
		worktreeCreated: mock(() => {}),
		worktreeRemoved: mock(() => {}),
		branchCreated: mock(() => {}),
		issueStart: mock(() => {}),
		issueComplete: mock(() => {}),
		issueFailed: mock(() => {}),
		issueSplit: mock(() => {}),
		agentOutput: mock(() => {}),
		verifyPass: mock(() => {}),
		verifyFail: mock(() => {}),
		prCreated: mock(() => {}),
		runStart: mock(() => {}),
		runComplete: mock(() => {}),
		log: mock(() => {}),
		path: '/tmp/test.jsonl',
	} as unknown as RunLogger;
}

// ---------------------------------------------------------------------------
// localBranchExists — mock path
// ---------------------------------------------------------------------------

describe('localBranchExists — mock deps', () => {
	test('returns true when exec succeeds', async () => {
		const deps = makeDeps({ exec: async () => ({ exitCode: 0, stdout: 'abc123', stderr: '' }) });
		expect(await localBranchExists('main', '/repo', deps)).toBe(true);
	});

	test('returns false when exec fails', async () => {
		const deps = makeDeps({ exec: async () => ({ exitCode: 1, stdout: '', stderr: 'not found' }) });
		expect(await localBranchExists('ghost', '/repo', deps)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// deleteLocalBranch — mock path
// ---------------------------------------------------------------------------

describe('deleteLocalBranch — mock deps', () => {
	test('calls branch -D when branch exists', async () => {
		const calls: string[][] = [];
		const deps = makeDeps({
			exec: async (cmd) => {
				calls.push(cmd);
				// rev-parse succeeds (branch exists), branch -D succeeds
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		});
		await deleteLocalBranch('feat/x', '/repo', deps);
		expect(calls.some(c => c.includes('-D'))).toBe(true);
	});

	test('skips branch -D when branch does not exist', async () => {
		const calls: string[][] = [];
		const deps = makeDeps({
			exec: async (cmd) => {
				calls.push(cmd);
				return { exitCode: 1, stdout: '', stderr: '' };
			},
		});
		await deleteLocalBranch('no-branch', '/repo', deps);
		expect(calls.some(c => c.includes('-D'))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// detectConflicts — mock path
// ---------------------------------------------------------------------------

describe('detectConflicts — mock deps', () => {
	test('returns empty array when stdout is empty', async () => {
		const deps = makeDeps({ exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
		expect(await detectConflicts('/repo', deps)).toEqual([]);
	});

	test('returns conflict list from stdout', async () => {
		const deps = makeDeps({ exec: async () => ({ exitCode: 0, stdout: 'src/a.ts\nsrc/b.ts\n', stderr: '' }) });
		const result = await detectConflicts('/repo', deps);
		expect(result).toHaveLength(2);
		expect(result[0].file).toBe('src/a.ts');
		expect(result[1].file).toBe('src/b.ts');
	});
});

// ---------------------------------------------------------------------------
// rebaseBranch — mock path
// ---------------------------------------------------------------------------

describe('rebaseBranch — mock deps', () => {
	test('returns ok:true when checkout and rebase both succeed', async () => {
		const deps = makeDeps({ exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
		const result = await rebaseBranch('feat/x', 'main', '/repo', deps);
		expect(result.ok).toBe(true);
		expect(result.conflicts).toBeUndefined();
	});

	test('returns ok:false when checkout fails', async () => {
		const deps = makeDeps({ exec: async () => ({ exitCode: 1, stdout: '', stderr: 'error' }) });
		const result = await rebaseBranch('feat/x', 'main', '/repo', deps);
		expect(result.ok).toBe(false);
	});

	test('returns conflicts when rebase fails with conflict markers', async () => {
		let callCount = 0;
		const deps = makeDeps({
			exec: async (cmd) => {
				callCount++;
				// checkout succeeds, rebase fails, diff returns conflict file, abort succeeds
				if (cmd.includes('checkout') && !cmd.includes('--ours') && !cmd.includes('--theirs')) {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (cmd.includes('rebase') && !cmd.includes('--abort')) {
					return { exitCode: 1, stdout: '', stderr: 'conflict' };
				}
				if (cmd.includes('diff')) {
					return { exitCode: 0, stdout: 'README.md', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		});
		const result = await rebaseBranch('feat/x', 'main', '/repo', deps);
		expect(result.ok).toBe(false);
		expect(result.conflicts).toBeDefined();
		expect(result.conflicts![0].file).toBe('README.md');
	});

	test('returns ok:false with no conflicts when rebase fails non-conflict', async () => {
		let aborted = false;
		const deps = makeDeps({
			exec: async (cmd) => {
				if (cmd.includes('checkout') && !cmd.includes('--ours') && !cmd.includes('--theirs')) {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (cmd.includes('rebase') && cmd.includes('--abort')) {
					aborted = true;
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (cmd.includes('rebase')) {
					return { exitCode: 1, stdout: '', stderr: 'unrelated error' };
				}
				// diff returns empty — no conflicts
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		});
		const result = await rebaseBranch('feat/x', 'main', '/repo', deps);
		expect(result.ok).toBe(false);
		expect(result.conflicts).toBeUndefined();
		expect(aborted).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// createWorktree — mock path
// ---------------------------------------------------------------------------

describe('createWorktree — mock deps', () => {
	const config = { worktreeDir: '.pait/worktrees', baseBranch: 'main' };

	test('returns ok:true on success with no dep branches', async () => {
		const logger = makeLogger();
		const deps = makeDeps({ exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
		const result = await createWorktree('feat/1', [], config, '/repo', logger, 1, deps);
		expect(result.ok).toBe(true);
		expect(result.baseBranch).toBe('main');
	});

	test('uses first existing dep branch as base', async () => {
		const logger = makeLogger();
		const deps = makeDeps({
			exec: async (cmd) => {
				// rev-parse for feat/dep succeeds
				if (cmd.includes('rev-parse') && cmd.some(a => a.includes('feat/dep'))) {
					return { exitCode: 0, stdout: 'abc', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		});
		const result = await createWorktree('feat/1', ['feat/dep'], config, '/repo', logger, 1, deps);
		expect(result.ok).toBe(true);
		expect(result.baseBranch).toBe('feat/dep');
	});

	test('returns ok:false when worktree add fails', async () => {
		const logger = makeLogger();
		const deps = makeDeps({
			exec: async (cmd) => {
				if (cmd.includes('add') && !cmd.includes('add') || cmd.join(' ').includes('worktree add')) {
					return { exitCode: 1, stdout: '', stderr: 'cannot create' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		});
		// Simulate worktree add failure
		const failDeps = makeDeps({
			exec: async (cmd) => {
				if (cmd.includes('worktree') && cmd.includes('add')) {
					return { exitCode: 1, stdout: '', stderr: 'cannot create worktree' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		});
		const result = await createWorktree('feat/1', [], config, '/repo', logger, 1, failDeps);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Failed to create worktree');
	});

	test('removes stale directory when it exists before creation', async () => {
		const logger = makeLogger();
		let rmrfCalled = false;
		const deps = makeDeps({
			exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
			fs: makeFs({
				fileExists: () => true,
				rmrf: () => { rmrfCalled = true; },
			}),
		});
		await createWorktree('feat/1', [], config, '/repo', logger, 1, deps);
		expect(rmrfCalled).toBe(true);
	});

	test('returns ok:false and removes worktree when dep merge fails', async () => {
		const logger = makeLogger();
		let removeCalled = false;
		const deps = makeDeps({
			exec: async (cmd) => {
				// Both dep branches exist
				if (cmd.includes('rev-parse')) return { exitCode: 0, stdout: 'abc', stderr: '' };
				// worktree add succeeds
				if (cmd.includes('worktree') && cmd.includes('add')) return { exitCode: 0, stdout: '', stderr: '' };
				// merge fails
				if (cmd.includes('merge') && !cmd.includes('--abort')) return { exitCode: 1, stdout: '', stderr: 'conflict' };
				// worktree remove for cleanup — track it
				if (cmd.includes('worktree') && cmd.includes('remove')) {
					removeCalled = true;
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		});
		const result = await createWorktree('feat/1', ['dep/a', 'dep/b'], config, '/repo', logger, 1, deps);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Merge conflict');
		expect(removeCalled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// removeWorktree — mock path
// ---------------------------------------------------------------------------

describe('removeWorktree — mock deps', () => {
	test('calls logger.worktreeRemoved on success', async () => {
		const logger = makeLogger();
		const deps = makeDeps({ exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
		await removeWorktree('/wt/path', 'feat/1', '/repo', logger, 1, deps);
		expect((logger.worktreeRemoved as ReturnType<typeof mock>).mock.calls.length).toBe(1);
	});

	test('falls back to rmrf when git worktree remove fails and path exists', async () => {
		const logger = makeLogger();
		let rmrfCalled = false;
		let pruneCalled = false;
		const deps = makeDeps({
			exec: async (cmd) => {
				if (cmd.includes('worktree') && cmd.includes('remove')) return { exitCode: 1, stdout: '', stderr: 'err' };
				if (cmd.includes('worktree') && cmd.includes('prune')) { pruneCalled = true; return { exitCode: 0, stdout: '', stderr: '' }; }
				return { exitCode: 0, stdout: '', stderr: '' };
			},
			fs: makeFs({
				fileExists: () => true,
				rmrf: () => { rmrfCalled = true; },
			}),
		});
		await removeWorktree('/wt/path', 'feat/1', '/repo', logger, 1, deps);
		expect(rmrfCalled).toBe(true);
		expect(pruneCalled).toBe(true);
	});

	test('skips rmrf when path does not exist', async () => {
		const logger = makeLogger();
		let rmrfCalled = false;
		const deps = makeDeps({
			exec: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
			fs: makeFs({
				fileExists: () => false,
				rmrf: () => { rmrfCalled = true; },
			}),
		});
		await removeWorktree('/wt/path', 'feat/1', '/repo', logger, 1, deps);
		expect(rmrfCalled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// presentConflicts
// ---------------------------------------------------------------------------

describe('presentConflicts — empty list', () => {
	test('returns empty map for zero conflicts', async () => {
		const deps = makeDeps();
		const result = await presentConflicts([], deps);
		expect(result instanceof Map).toBe(true);
		expect(result.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// resolveConflicts — mock path
// ---------------------------------------------------------------------------

describe('resolveConflicts — mock deps', () => {
	test('resolves "ours" strategy — calls checkout --ours and add', async () => {
		const calls: string[][] = [];
		const deps = makeDeps({
			exec: async (cmd) => { calls.push(cmd); return { exitCode: 0, stdout: '', stderr: '' }; },
		});
		const intents = new Map([['src/a.ts', 'ours']]);
		const result = await resolveConflicts([{ file: 'src/a.ts' }], intents, '/repo', deps);
		expect(result).toBe(true);
		expect(calls.some(c => c.includes('--ours'))).toBe(true);
	});

	test('resolves "theirs" strategy — calls checkout --theirs and add', async () => {
		const calls: string[][] = [];
		const deps = makeDeps({
			exec: async (cmd) => { calls.push(cmd); return { exitCode: 0, stdout: '', stderr: '' }; },
		});
		const intents = new Map([['src/a.ts', 'theirs']]);
		const result = await resolveConflicts([{ file: 'src/a.ts' }], intents, '/repo', deps);
		expect(result).toBe(true);
		expect(calls.some(c => c.includes('--theirs'))).toBe(true);
	});

	test('returns false when rebase --continue fails', async () => {
		const deps = makeDeps({
			exec: async (cmd) => {
				if (cmd.includes('--continue')) return { exitCode: 1, stdout: '', stderr: 'conflict remains' };
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		});
		const intents = new Map([['src/a.ts', 'ours']]);
		const result = await resolveConflicts([{ file: 'src/a.ts' }], intents, '/repo', deps);
		expect(result).toBe(false);
	});

	test('uses default "ours" when intent is missing from map', async () => {
		const calls: string[][] = [];
		const deps = makeDeps({
			exec: async (cmd) => { calls.push(cmd); return { exitCode: 0, stdout: '', stderr: '' }; },
		});
		const result = await resolveConflicts([{ file: 'src/a.ts' }], new Map(), '/repo', deps);
		expect(result).toBe(true);
		expect(calls.some(c => c.includes('--ours'))).toBe(true);
	});

	test('custom intent: returns false when claude returns empty output', async () => {
		const deps = makeDeps({
			exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
			fs: makeFs({ readFile: () => '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feat' }),
			claude: async () => ({ ok: false, output: '' }),
		});
		const intents = new Map([['src/a.ts', 'keep both changes']]);
		const result = await resolveConflicts([{ file: 'src/a.ts' }], intents, '/repo', deps);
		expect(result).toBe(false);
	});

	test('custom intent: returns false when validated content has conflict markers', async () => {
		const deps = makeDeps({
			exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
			fs: makeFs({ readFile: () => 'content' }),
			claude: async () => ({ ok: true, output: '<<<<<<< HEAD\nstill conflicted\n=======\n>>>>>>> feat' }),
		});
		const intents = new Map([['src/a.ts', 'keep both changes']]);
		const result = await resolveConflicts([{ file: 'src/a.ts' }], intents, '/repo', deps);
		expect(result).toBe(false);
	});

	test('custom intent: writes resolved content and adds file on success', async () => {
		let written = '';
		const calls: string[][] = [];
		const deps = makeDeps({
			exec: async (cmd) => { calls.push(cmd); return { exitCode: 0, stdout: '', stderr: '' }; },
			fs: makeFs({
				readFile: () => 'content',
				writeFile: (_p: string, d: string) => { written = d; },
			}),
			claude: async () => ({ ok: true, output: 'resolved content' }),
		});
		const intents = new Map([['src/a.ts', 'keep both changes']]);
		const result = await resolveConflicts([{ file: 'src/a.ts' }], intents, '/repo', deps);
		expect(result).toBe(true);
		expect(written).toBe('resolved content');
		expect(calls.some(c => c.includes('add'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// autoResolveConflicts — mock path
// ---------------------------------------------------------------------------

describe('autoResolveConflicts — mock deps', () => {
	test('returns false when claude call fails', async () => {
		const deps = makeDeps({
			exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
			fs: makeFs({ readFile: () => '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feat' }),
			claude: async () => ({ ok: false, output: '' }),
		});
		const result = await autoResolveConflicts([{ file: 'src/a.ts' }], '/repo', deps);
		expect(result).toBe(false);
	});

	test('returns false when claude returns content with conflict markers', async () => {
		const deps = makeDeps({
			exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
			fs: makeFs({ readFile: () => 'content' }),
			claude: async () => ({ ok: true, output: '<<<<<<< HEAD\nstill bad\n=======\n>>>>>>> feat' }),
		});
		const result = await autoResolveConflicts([{ file: 'src/a.ts' }], '/repo', deps);
		expect(result).toBe(false);
	});

	test('writes resolved file and adds it on success', async () => {
		let written = '';
		const calls: string[][] = [];
		const deps = makeDeps({
			exec: async (cmd) => { calls.push(cmd); return { exitCode: 0, stdout: '', stderr: '' }; },
			fs: makeFs({
				readFile: () => 'conflict content',
				writeFile: (_p: string, d: string) => { written = d; },
			}),
			claude: async () => ({ ok: true, output: 'clean resolved' }),
		});
		const result = await autoResolveConflicts([{ file: 'src/a.ts' }], '/repo', deps);
		expect(result).toBe(true);
		expect(written).toBe('clean resolved');
		expect(calls.some(c => c.includes('add'))).toBe(true);
	});

	test('returns true when no conflicts to resolve', async () => {
		const deps = makeDeps({ exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
		// Empty conflict list — goes straight to rebase --continue
		const result = await autoResolveConflicts([], '/repo', deps);
		expect(result).toBe(true);
	});

	test('returns false when rebase --continue fails after resolution', async () => {
		const deps = makeDeps({
			exec: async (cmd) => {
				if (cmd.includes('--continue')) return { exitCode: 1, stdout: '', stderr: 'failed' };
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		});
		const result = await autoResolveConflicts([], '/repo', deps);
		expect(result).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// defaultGitDeps.exec — exercise the real Bun.spawnSync path
// ---------------------------------------------------------------------------

describe('defaultGitDeps — built-in dep implementations', () => {
	test('exec runs a real command and returns stdout', async () => {
		const result = await defaultGitDeps.exec(['echo', 'hello']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe('hello');
	});

	test('exec returns non-zero exit code for failing command', async () => {
		const result = await defaultGitDeps.exec(['false']);
		expect(result.exitCode).not.toBe(0);
	});

	test('claude dep is a function wrapping runClaude', () => {
		// Verify the dep is properly wired — it's an arrow function delegating to runClaude.
		expect(typeof defaultGitDeps.claude).toBe('function');
	});

	test('prompt dep is a function wrapping promptLine', () => {
		// Verify the dep is properly wired — it's an arrow function delegating to promptLine.
		expect(typeof defaultGitDeps.prompt).toBe('function');
	});
});

// ---------------------------------------------------------------------------
// createWorktree — successful multi-dep merge (covers the closing } on line 161)
// ---------------------------------------------------------------------------

describe('createWorktree — successful multi-dep merge', () => {
	test('merges second dep branch successfully and returns ok:true', async () => {
		const logger = makeLogger();
		const deps = makeDeps({
			exec: async (cmd) => {
				// Both dep branches exist
				if (cmd.includes('rev-parse')) return { exitCode: 0, stdout: 'abc', stderr: '' };
				// All git commands succeed including merge
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		});
		const config = { worktreeDir: '.pait/worktrees', baseBranch: 'main' };
		const result = await createWorktree('feat/1', ['dep/a', 'dep/b'], config, '/repo', logger, 1, deps);
		expect(result.ok).toBe(true);
		expect(result.baseBranch).toBe('dep/a');
	});
});

// ---------------------------------------------------------------------------
// presentConflicts — with actual conflicts to cover the inner loop
// ---------------------------------------------------------------------------

describe('presentConflicts — with conflicts', () => {
	test('logs each conflict file and returns map with default ours for empty input', async () => {
		const logged: string[] = [];
		const orig = console.log;
		console.log = (...args: unknown[]) => logged.push(String(args[0]));
		const deps = makeDeps({ prompt: async () => '' });
		const result = await presentConflicts([{ file: 'README.md' }], deps);
		console.log = orig;
		expect(result.get('README.md')).toBe('ours');
		expect(logged.some(l => l.includes('README.md'))).toBe(true);
	});

	test('uses provided answer as intent', async () => {
		const deps = makeDeps({ prompt: async () => 'theirs' });
		const result = await presentConflicts([{ file: 'src/a.ts' }], deps);
		expect(result.get('src/a.ts')).toBe('theirs');
	});

	test('handles multiple conflicts', async () => {
		let callCount = 0;
		const answers = ['ours', 'keep both changes'];
		const deps = makeDeps({ prompt: async () => answers[callCount++] ?? '' });
		const result = await presentConflicts([{ file: 'a.ts' }, { file: 'b.ts' }], deps);
		expect(result.get('a.ts')).toBe('ours');
		expect(result.get('b.ts')).toBe('keep both changes');
	});
});

// ---------------------------------------------------------------------------
// validateResolvedContent — prose rejection and fence stripping
// (private function, tested indirectly via resolveConflicts/autoResolveConflicts)
// ---------------------------------------------------------------------------

describe('validateResolvedContent — fence stripping and prose rejection', () => {
	test('resolveConflicts: strips markdown fences and accepts clean content', async () => {
		const fenced = '```typescript\nconst x = 1;\n```';
		let written = '';
		const deps = makeDeps({
			exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
			fs: makeFs({
				readFile: () => 'content',
				writeFile: (_p: string, d: string) => { written = d; },
			}),
			claude: async () => ({ ok: true, output: fenced }),
		});
		const intents = new Map([['src/a.ts', 'merge carefully']]);
		const result = await resolveConflicts([{ file: 'src/a.ts' }], intents, '/repo', deps);
		expect(result).toBe(true);
		expect(written).toBe('const x = 1;');
	});

	test('resolveConflicts: rejects prose output for code files', async () => {
		const deps = makeDeps({
			exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
			fs: makeFs({ readFile: () => 'content' }),
			claude: async () => ({ ok: true, output: 'The resolved content merges both changes.' }),
		});
		const intents = new Map([['src/a.ts', 'keep both']]);
		const result = await resolveConflicts([{ file: 'src/a.ts' }], intents, '/repo', deps);
		expect(result).toBe(false);
	});

	test('autoResolveConflicts: strips markdown fences and writes clean content', async () => {
		const fenced = '```js\nconsole.log("ok");\n```';
		let written = '';
		const deps = makeDeps({
			exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
			fs: makeFs({
				readFile: () => 'content',
				writeFile: (_p: string, d: string) => { written = d; },
			}),
			claude: async () => ({ ok: true, output: fenced }),
		});
		const result = await autoResolveConflicts([{ file: 'src/a.js' }], '/repo', deps);
		expect(result).toBe(true);
		expect(written).toBe('console.log("ok");');
	});
});
