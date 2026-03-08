# Agent Log Streaming Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show a rolling 10-line window of Claude's live output during pait agent calls, with a link to the full log file. Replaces the spinner.

**Architecture:** `runClaude()` gets an `onChunk` callback for streaming. A new `RollingWindow` class in `shared/log.ts` maintains a ring buffer of the last N lines and redraws them via ANSI escapes. Call sites wire the two together and pass the log file path for the footer.

**Tech Stack:** TypeScript, Bun runtime, ReadableStream async iteration, ANSI escape codes

---

### Task 1: Add `onChunk` callback to `runClaude()`

**Files:**
- Modify: `shared/claude.ts`
- Test: `shared/claude.test.ts`

**Step 1: Write the failing tests**

Add to `shared/claude.test.ts`:

```typescript
test('calls onChunk with decoded text for each stdout chunk', async () => {
	const receivedChunks: string[] = [];
	const deps = makeDeps('hello world', 0);

	await runClaude({
		prompt: 'p', model: 'haiku', cwd: '/tmp',
		onChunk: (chunk) => { receivedChunks.push(chunk); },
	}, deps);

	expect(receivedChunks.join('')).toBe('hello world');
});

test('does not error when onChunk is not provided', async () => {
	const deps = makeDeps('output', 0);
	const result = await runClaude({ prompt: 'p', model: 'haiku', cwd: '/tmp' }, deps);
	expect(result.output).toBe('output');
});

test('still returns full buffered output when onChunk is provided', async () => {
	const deps = makeDeps('full output', 0);
	const result = await runClaude({
		prompt: 'p', model: 'haiku', cwd: '/tmp',
		onChunk: () => {},
	}, deps);
	expect(result.output).toBe('full output');
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test shared/claude.test.ts`
Expected: FAIL — `onChunk` not recognized on `RunClaudeOpts`

**Step 3: Add `onChunk` to `RunClaudeOpts` and implement streaming read**

In `shared/claude.ts`:

Add `onChunk` to the interface:

```typescript
export interface RunClaudeOpts {
	prompt: string;
	model: string;
	cwd: string;
	permissionMode?: string;
	allowedTools?: string;
	onChunk?: (chunk: string) => void;
}
```

Replace the buffered read (line 56) with a streaming read:

```typescript
// OLD:
const output = await new Response(proc.stdout).text();
const exitCode = await proc.exited;

// NEW:
const decoder = new TextDecoder();
const chunks: Uint8Array[] = [];

if (proc.stdout) {
	for await (const chunk of proc.stdout) {
		chunks.push(chunk);
		if (opts.onChunk) opts.onChunk(decoder.decode(chunk, { stream: true }));
	}
}

const output = new TextDecoder().decode(Buffer.concat(chunks));
const exitCode = await proc.exited;
```

**Step 4: Run tests to verify they pass**

Run: `bun test shared/claude.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add shared/claude.ts shared/claude.test.ts
git commit -m "feat: add onChunk callback to runClaude for streaming output"
```

---

### Task 2: Create `RollingWindow` class in `shared/log.ts`

**Files:**
- Modify: `shared/log.ts`
- Test: `shared/log.test.ts`

**Step 1: Write the failing tests**

Add to `shared/log.test.ts` (create if needed):

```typescript
import { describe, test, expect } from 'bun:test';
import { RollingWindow } from '@shared/log.ts';

function makeTestDeps() {
	const writes: string[] = [];
	return {
		deps: { stdout: { write: (s: string) => { writes.push(s); } } },
		writes,
	};
}

describe('RollingWindow', () => {
	test('update adds lines to the buffer', () => {
		const { deps, writes } = makeTestDeps();
		const win = new RollingWindow({ header: 'Test', logPath: '/tmp/log.jsonl', lines: 3 }, deps);
		win.update('line one');
		win.update('line two');
		// Should have written something to stdout
		expect(writes.length).toBeGreaterThan(0);
	});

	test('buffer only keeps the last N lines', () => {
		const { deps } = makeTestDeps();
		const win = new RollingWindow({ header: 'Test', logPath: '/tmp/log.jsonl', lines: 2 }, deps);
		win.update('line 1');
		win.update('line 2');
		win.update('line 3');
		// Internal buffer should have dropped line 1
		expect(win.getLines()).toEqual(['line 2', 'line 3']);
	});

	test('multi-line chunks are split into individual lines', () => {
		const { deps } = makeTestDeps();
		const win = new RollingWindow({ header: 'Test', logPath: '/tmp/log.jsonl', lines: 5 }, deps);
		win.update('line 1\nline 2\nline 3');
		expect(win.getLines()).toEqual(['line 1', 'line 2', 'line 3']);
	});

	test('renders header and footer in output', () => {
		const { deps, writes } = makeTestDeps();
		const win = new RollingWindow({ header: 'Agent #42', logPath: '/logs/test.jsonl', lines: 3 }, deps);
		win.update('hello');
		const output = writes.join('');
		expect(output).toContain('Agent #42');
		expect(output).toContain('/logs/test.jsonl');
	});

	test('clear removes the window from terminal', () => {
		const { deps, writes } = makeTestDeps();
		const win = new RollingWindow({ header: 'Test', logPath: '/tmp/log.jsonl', lines: 3 }, deps);
		win.update('line');
		writes.length = 0;
		win.clear();
		// Should write cursor-up + clear sequences
		expect(writes.length).toBeGreaterThan(0);
	});

	test('defaults to 10 lines when lines not specified', () => {
		const { deps } = makeTestDeps();
		const win = new RollingWindow({ header: 'Test', logPath: '/tmp/log.jsonl' }, deps);
		for (let i = 0; i < 15; i++) win.update(`line ${i}`);
		expect(win.getLines().length).toBe(10);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test shared/log.test.ts`
Expected: FAIL — `RollingWindow` not exported from `shared/log.ts`

**Step 3: Implement `RollingWindow`**

Add to `shared/log.ts`:

```typescript
export interface RollingWindowOpts {
	header: string;
	logPath: string;
	lines?: number;
}

export interface RollingWindowDeps {
	stdout: { write: (s: string) => void };
}

const defaultWindowDeps: RollingWindowDeps = { stdout: process.stdout };

export class RollingWindow {
	private buffer: string[] = [];
	private maxLines: number;
	private header: string;
	private logPath: string;
	private deps: RollingWindowDeps;
	private rendered = false;
	private partial = '';

	constructor(opts: RollingWindowOpts, deps: RollingWindowDeps = defaultWindowDeps) {
		this.maxLines = opts.lines ?? 10;
		this.header = opts.header;
		this.logPath = opts.logPath;
		this.deps = deps;
	}

	getLines(): string[] {
		return [...this.buffer];
	}

	update(text: string): void {
		// Accumulate partial line from previous chunk
		const combined = this.partial + text;
		const parts = combined.split('\n');

		// Last element is either empty (text ended with \n) or a partial line
		this.partial = parts.pop() ?? '';

		for (const line of parts) {
			if (line.trim() === '') continue;
			this.buffer.push(line);
			if (this.buffer.length > this.maxLines) {
				this.buffer.shift();
			}
		}

		this.render();
	}

	clear(): void {
		if (!this.rendered) return;
		// Move up past header + lines + footer and clear each line
		const totalLines = this.maxLines + 2;
		this.deps.stdout.write(`\x1b[${totalLines}A`);
		for (let i = 0; i < totalLines; i++) {
			this.deps.stdout.write('\x1b[2K\n');
		}
		this.deps.stdout.write(`\x1b[${totalLines}A`);
		this.rendered = false;
	}

	private render(): void {
		if (this.rendered) {
			// Move cursor up to redraw
			const totalLines = this.maxLines + 2;
			this.deps.stdout.write(`\x1b[${totalLines}A`);
		}

		// Header
		this.deps.stdout.write(`\x1b[2K\x1b[36m┌─ ${this.header} ${'─'.repeat(Math.max(0, 50 - this.header.length))}\x1b[0m\n`);

		// Body lines (pad to maxLines so window size is stable)
		for (let i = 0; i < this.maxLines; i++) {
			const line = this.buffer[i] ?? '';
			// Truncate long lines to terminal width (assume 80 as safe default)
			const truncated = line.length > 120 ? line.slice(0, 117) + '...' : line;
			this.deps.stdout.write(`\x1b[2K\x1b[2m│\x1b[0m ${truncated}\n`);
		}

		// Footer
		this.deps.stdout.write(`\x1b[2K\x1b[36m└─ Full log: \x1b[4m${this.logPath}\x1b[0m\n`);

		this.rendered = true;
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test shared/log.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add shared/log.ts shared/log.test.ts
git commit -m "feat: add RollingWindow class for live agent output display"
```

---

### Task 3: Wire rolling window into `agent-runner.ts`

**Files:**
- Modify: `tools/orchestrator/agent-runner.ts`
- Test: `tools/orchestrator/agent-runner.coverage.test.ts`

**Step 1: Update tests — replace spinner assertions with rolling window assertions**

In `agent-runner.coverage.test.ts`:

Remove `makeSpinner` from the `AgentRunnerDeps` interface mock and all inline deps.
Remove spinner-related tests (`'starts and stops spinner'` in both assess and implement blocks).
Remove `'calls logDim with last 500 chars of output'` test.
Remove `'makeSpinner returns an object with start and stop'` and `'logDim calls log.dim without throwing'` tests.

Update `AgentRunnerDeps` mock to match new interface:

```typescript
const deps: AgentRunnerDeps = {
	runClaude: ...,
	makeWindow: () => ({ update: () => {}, clear: () => {} }),
	parseJson: ...,
};
```

Add test:

```typescript
test('creates window with issue number in header for implement', async () => {
	const windowHeaders: string[] = [];
	const { deps } = makeDeps({
		runClaudeOk: true,
		runClaudeOutput: 'done',
		makeWindow: (header: string) => {
			windowHeaders.push(header);
			return { update: () => {}, clear: () => {} };
		},
	});

	await implementIssue({
		issue: makeIssue(42),
		branchName: 'feat/42-thing',
		baseBranch: 'main',
		config: baseConfig,
		worktreePath: '/wt/42',
		logger: noopLogger,
	}, deps);

	expect(windowHeaders.some(h => h.includes('#42'))).toBe(true);
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tools/orchestrator/agent-runner.coverage.test.ts`
Expected: FAIL — `makeWindow` not on `AgentRunnerDeps`

**Step 3: Replace spinner with rolling window in `agent-runner.ts`**

Update imports:

```typescript
// OLD:
import { log, Spinner } from '@shared/log.ts';
// NEW:
import { log, RollingWindow } from '@shared/log.ts';
```

Update `AgentRunnerDeps`:

```typescript
export interface AgentRunnerDeps {
	runClaude: (opts: RunClaudeOpts) => Promise<{ ok: boolean; output: string }>;
	makeWindow: (header: string, logPath: string) => { update: (text: string) => void; clear: () => void };
	parseJson: (text: string) => { ok: true; value: unknown } | { ok: false };
}

export const defaultAgentRunnerDeps: AgentRunnerDeps = {
	runClaude,
	makeWindow: (header: string, logPath: string) =>
		new RollingWindow({ header, logPath }),
	parseJson: (text: string) => {
		const result = defaultFsAdapter.parseJson(text);
		if (result === null) return { ok: false as const };
		return { ok: true as const, value: result };
	}
};
```

Update `assessIssueSize`:

```typescript
// OLD:
const spinner = deps.makeSpinner();
spinner.start(`Assessing #${issue.number} size`);

const { output: rawResult } = await deps.runClaude({
	prompt,
	model: config.models.assess,
	cwd: repoRoot
}).catch(() => ({ ok: false, output: '' }));

spinner.stop();

// NEW:
const window = deps.makeWindow(`Assessing #${issue.number} size`, '');

const { output: rawResult } = await deps.runClaude({
	prompt,
	model: config.models.assess,
	cwd: repoRoot,
	onChunk: (chunk) => window.update(chunk),
}).catch(() => ({ ok: false, output: '' }));

window.clear();
```

Update `implementIssue`:

```typescript
// OLD:
const spinner = deps.makeSpinner();
spinner.start(`Agent implementing #${issue.number}`);

const result = await deps.runClaude({
	prompt,
	model: config.models.implement,
	cwd: worktreePath,
	permissionMode: 'acceptEdits',
	allowedTools: config.allowedTools
});

spinner.stop();
deps.logDim(result.output.slice(-500));

// NEW:
const window = deps.makeWindow(
	`Agent implementing #${issue.number}`,
	logger.path,
);

const result = await deps.runClaude({
	prompt,
	model: config.models.implement,
	cwd: worktreePath,
	permissionMode: 'acceptEdits',
	allowedTools: config.allowedTools,
	onChunk: (chunk) => window.update(chunk),
});

window.clear();
```

**Step 4: Run tests to verify they pass**

Run: `bun test tools/orchestrator/agent-runner.coverage.test.ts`
Expected: All tests PASS

Run: `bun test tools/orchestrator/agent-runner.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add tools/orchestrator/agent-runner.ts tools/orchestrator/agent-runner.coverage.test.ts
git commit -m "refactor: replace spinner with rolling window in agent-runner"
```

---

### Task 4: Wire rolling window into `verify-fixer.ts`

**Files:**
- Modify: `tools/orchestrator/verify-fixer.ts`
- Test: `tools/orchestrator/verify-fixer.coverage.test.ts`

**Step 1: Update tests — replace spinner with window mock**

In `verify-fixer.coverage.test.ts`:

Remove `makeSpinner` from deps, spinner tracking, the entire spinner behavior describe block, and the `spinnerLabel` test.

Update `VerifyFixerDeps` mock:

```typescript
const deps: VerifyFixerDeps = {
	runClaude: ...,
	makeWindow: () => ({ update: () => {}, clear: () => {} }),
};
```

Add test:

```typescript
test('creates window with issue number in header', async () => {
	const windowHeaders: string[] = [];
	const deps: VerifyFixerDeps = {
		runClaude: async () => ({ ok: true, output: 'fixed' }),
		makeWindow: (header: string) => {
			windowHeaders.push(header);
			return { update: () => {}, clear: () => {} };
		},
	};

	await fixVerificationFailure({
		issueNumber: 42,
		failedStep: 'test',
		errorOutput: '',
		config: baseConfig,
		worktreePath: '/wt',
		logger: noopLogger,
	}, deps);

	expect(windowHeaders.some(h => h.includes('#42'))).toBe(true);
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tools/orchestrator/verify-fixer.coverage.test.ts`
Expected: FAIL

**Step 3: Replace spinner with rolling window in `verify-fixer.ts`**

```typescript
// OLD:
import { Spinner } from '@shared/log.ts';

export interface VerifyFixerDeps {
	runClaude: (opts: RunClaudeOpts) => Promise<{ ok: boolean; output: string }>;
	makeSpinner: () => { start: (msg: string) => void; stop: () => void };
}

export const defaultVerifyFixerDeps: VerifyFixerDeps = {
	runClaude,
	makeSpinner: () => new Spinner()
};

// NEW:
import { RollingWindow } from '@shared/log.ts';

export interface VerifyFixerDeps {
	runClaude: (opts: RunClaudeOpts) => Promise<{ ok: boolean; output: string }>;
	makeWindow: (header: string, logPath: string) => { update: (text: string) => void; clear: () => void };
}

export const defaultVerifyFixerDeps: VerifyFixerDeps = {
	runClaude,
	makeWindow: (header: string, logPath: string) =>
		new RollingWindow({ header, logPath }),
};
```

Remove `spinnerLabel` from `FixVerificationOptions`.

Update `fixVerificationFailure` body:

```typescript
// OLD:
const label = spinnerLabel ?? `Agent fixing verification for #${issueNumber}`;
const spinner = deps.makeSpinner();
spinner.start(label);

const fixResult = await deps.runClaude({...}).catch(...);

spinner.stop();

// NEW:
const window = deps.makeWindow(
	`Agent fixing verification for #${issueNumber}`,
	logger.path,
);

const fixResult = await deps.runClaude({
	prompt: fixPrompt,
	model: config.models.implement,
	cwd: worktreePath,
	permissionMode: 'acceptEdits',
	allowedTools: config.allowedTools,
	onChunk: (chunk) => window.update(chunk),
}).catch(() => ({ ok: false, output: '' }));

window.clear();
```

**Step 4: Run tests to verify they pass**

Run: `bun test tools/orchestrator/verify-fixer.coverage.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add tools/orchestrator/verify-fixer.ts tools/orchestrator/verify-fixer.coverage.test.ts
git commit -m "refactor: replace spinner with rolling window in verify-fixer"
```

---

### Task 5: Wire rolling window into `shared/git.ts` conflict resolution

**Files:**
- Modify: `shared/git.ts`
- Test: `shared/git.test.ts`

**Step 1: Write the failing test**

Add to `shared/git.test.ts` (in the `resolveConflicts` and `autoResolveConflicts` describe blocks):

```typescript
test('passes onChunk to deps.claude for custom intent resolution', async () => {
	const capturedOpts: RunClaudeOpts[] = [];
	const deps = makeDeps({
		claude: async (opts: RunClaudeOpts) => {
			capturedOpts.push(opts);
			return { ok: true, output: 'resolved content' };
		},
	});

	// ... set up conflict with custom intent (not 'ours'/'theirs')
	await resolveConflicts(conflicts, intents, '/repo', deps);

	expect(capturedOpts[0].onChunk).toBeDefined();
});

test('passes onChunk to deps.claude for auto-resolve', async () => {
	const capturedOpts: RunClaudeOpts[] = [];
	const deps = makeDeps({
		claude: async (opts: RunClaudeOpts) => {
			capturedOpts.push(opts);
			return { ok: true, output: 'resolved content' };
		},
	});

	await autoResolveConflicts(conflicts, '/repo', deps);

	expect(capturedOpts[0].onChunk).toBeDefined();
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test shared/git.test.ts`
Expected: FAIL — `onChunk` not passed in current code

**Step 3: Add `onChunk` and `makeWindow` to git.ts Claude calls**

Add `RollingWindow` import:

```typescript
import { log, RollingWindow } from '@shared/log.ts';
```

Add `makeWindow` to `GitDeps`:

```typescript
export interface GitDeps {
	exec: ...;
	fs: FsAdapter;
	env: Record<string, string | undefined>;
	claude: (opts: RunClaudeOpts) => Promise<{ ok: boolean; output: string }>;
	prompt: (question: string) => Promise<string>;
	makeWindow: (header: string, logPath: string) => { update: (text: string) => void; clear: () => void };
}
```

Update `defaultDeps`:

```typescript
const defaultDeps: GitDeps = {
	exec: defaultExec,
	fs: defaultFsAdapter,
	env: process.env as Record<string, string | undefined>,
	claude: runClaude,
	prompt: promptLine,
	makeWindow: (header: string, logPath: string) =>
		new RollingWindow({ header, logPath }),
};
```

In `resolveConflicts` (the custom intent branch around line 281):

```typescript
// OLD:
const result = await deps.claude({ prompt, model: 'sonnet', cwd: repoRoot });

// NEW:
const window = deps.makeWindow(`Resolving conflict: ${c.file}`, '');
const result = await deps.claude({
	prompt, model: 'sonnet', cwd: repoRoot,
	onChunk: (chunk) => window.update(chunk),
});
window.clear();
```

In `autoResolveConflicts` (around line 365):

```typescript
// OLD:
const result = await deps.claude({ prompt, model: 'sonnet', cwd: repoRoot });

// NEW:
const window = deps.makeWindow(`Auto-resolving: ${c.file}`, '');
const result = await deps.claude({
	prompt, model: 'sonnet', cwd: repoRoot,
	onChunk: (chunk) => window.update(chunk),
});
window.clear();
```

**Step 4: Update git.test.ts mock deps to include `makeWindow`**

Add `makeWindow: () => ({ update: () => {}, clear: () => {} })` to all mock `GitDeps` objects.

**Step 5: Run tests to verify they pass**

Run: `bun test shared/git.test.ts`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add shared/git.ts shared/git.test.ts
git commit -m "feat: add rolling window to git conflict resolution Claude calls"
```

---

### Task 6: Clean up and full test suite

**Step 1: Search for stale references**

Run: `grep -r 'spinnerLabel\|makeSpinner' --include='*.ts'`
If any remain, fix them.

Run: `grep -r "import.*Spinner" --include='*.ts'`
Only `shared/log.ts` should define `Spinner`. No orchestrator files should import it.

**Step 2: Run full test suite**

Run: `bun test`
Expected: All tests PASS

**Step 3: Typecheck**

Run: `bun build --target bun --outfile /tmp/pait-check cli.ts`
Expected: No type errors

**Step 4: Commit any cleanup**

```bash
git add -A
git commit -m "chore: clean up stale spinner references after rolling window migration"
```
