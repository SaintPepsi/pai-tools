# Agent Log Streaming Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stream Claude's stdout to the terminal in real-time during all pait agent calls, replacing the spinner-only feedback.

**Architecture:** Add a streaming tee to `runClaude()` that reads stdout chunk-by-chunk, writing each chunk to the terminal immediately while accumulating a buffer. Call sites remove their spinner usage since the streaming output is the live feedback. The `stream` option defaults to `true`.

**Tech Stack:** TypeScript, Bun runtime, ReadableStream async iteration

---

### Task 1: Add streaming tee to `runClaude()`

**Files:**
- Modify: `shared/claude.ts`
- Test: `shared/claude.test.ts`

**Step 1: Write the failing test for streaming behavior**

Add to `shared/claude.test.ts`:

```typescript
test('streams output chunks to deps.stdout when stream is true', async () => {
	const chunks: Uint8Array[] = [];
	const mockStdout = { write: (chunk: Uint8Array) => { chunks.push(chunk); } };
	const deps = makeDeps('hello world', 0);
	deps.stdout = mockStdout;

	await runClaude({ prompt: 'p', model: 'haiku', cwd: '/tmp', stream: true }, deps);

	const streamed = new TextDecoder().decode(Buffer.concat(chunks));
	expect(streamed).toBe('hello world');
});

test('does not stream to stdout when stream is false', async () => {
	const chunks: Uint8Array[] = [];
	const mockStdout = { write: (chunk: Uint8Array) => { chunks.push(chunk); } };
	const deps = makeDeps('hello world', 0);
	deps.stdout = mockStdout;

	await runClaude({ prompt: 'p', model: 'haiku', cwd: '/tmp', stream: false }, deps);

	expect(chunks.length).toBe(0);
});

test('stream defaults to true', async () => {
	const chunks: Uint8Array[] = [];
	const mockStdout = { write: (chunk: Uint8Array) => { chunks.push(chunk); } };
	const deps = makeDeps('streamed by default', 0);
	deps.stdout = mockStdout;

	await runClaude({ prompt: 'p', model: 'haiku', cwd: '/tmp' }, deps);

	const streamed = new TextDecoder().decode(Buffer.concat(chunks));
	expect(streamed).toBe('streamed by default');
});

test('still returns full output when streaming', async () => {
	const deps = makeDeps('full output here', 0);
	deps.stdout = { write: () => {} };

	const result = await runClaude({ prompt: 'p', model: 'haiku', cwd: '/tmp' }, deps);

	expect(result.output).toBe('full output here');
});
```

**Step 2: Run test to verify it fails**

Run: `bun test shared/claude.test.ts`
Expected: FAIL — `stream` property doesn't exist on `RunClaudeOpts`, `stdout` doesn't exist on `ClaudeDeps`

**Step 3: Add `stream` to `RunClaudeOpts` and `stdout` to `ClaudeDeps`**

In `shared/claude.ts`, add `stream?: boolean` to `RunClaudeOpts`:

```typescript
export interface RunClaudeOpts {
	prompt: string;
	model: string;
	cwd: string;
	permissionMode?: string;
	allowedTools?: string;
	stream?: boolean;
}
```

Add `stdout` to `ClaudeDeps`:

```typescript
export interface ClaudeDeps {
	spawn: (cmd: string[], opts: {
		cwd: string;
		stdin: Blob;
		stdout: 'pipe';
		stderr: 'pipe';
		env: Record<string, string>;
	}) => ClaudeProcess;
	env: Record<string, string | undefined>;
	stdout: { write: (chunk: Uint8Array) => void };
}
```

Update `defaultDeps`:

```typescript
export const defaultDeps: ClaudeDeps = {
	spawn: (cmd, opts) => Bun.spawn(cmd, opts) as ClaudeProcess,
	env: process.env as Record<string, string | undefined>,
	stdout: process.stdout,
};
```

**Step 4: Replace the buffered read with a streaming tee**

Replace lines 56-57 of `runClaude()`:

```typescript
// OLD:
const output = await new Response(proc.stdout).text();
const exitCode = await proc.exited;

// NEW:
const stream = opts.stream !== false; // default true
const chunks: Uint8Array[] = [];

if (proc.stdout) {
	for await (const chunk of proc.stdout) {
		if (stream) deps.stdout.write(chunk);
		chunks.push(chunk);
	}
}

const output = new TextDecoder().decode(Buffer.concat(chunks));
const exitCode = await proc.exited;
```

**Step 5: Update `makeDeps` in test to include `stdout`**

In `shared/claude.test.ts`, update the `makeDeps` helper:

```typescript
function makeDeps(output: string, exitCode: number): ClaudeDeps & {
	calls: Array<{ cmd: string[]; opts: Parameters<ClaudeDeps['spawn']>[1] }>;
} {
	const calls: Array<{ cmd: string[]; opts: Parameters<ClaudeDeps['spawn']>[1] }> = [];
	return {
		spawn: (cmd, opts) => {
			calls.push({ cmd, opts });
			return makeProc(output, exitCode);
		},
		env: { HOME: '/home/test', PATH: '/usr/bin' },
		stdout: { write: () => {} },
		calls,
	};
}
```

**Step 6: Run tests to verify they pass**

Run: `bun test shared/claude.test.ts`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add shared/claude.ts shared/claude.test.ts
git commit -m "feat: add streaming tee to runClaude for live agent output"
```

---

### Task 2: Remove spinner from `agent-runner.ts`

**Files:**
- Modify: `tools/orchestrator/agent-runner.ts`
- Test: `tools/orchestrator/agent-runner.coverage.test.ts`

**Step 1: Update the test — remove spinner assertions, remove `makeSpinner` from deps**

In `agent-runner.coverage.test.ts`:

- Remove the `makeSpinner` field from the `AgentRunnerDeps` mock builder (`makeDeps`)
- Remove the `spinnerCalls` tracking from `makeDeps`
- Delete the test `'starts and stops spinner'` in the `assessIssueSize` describe block
- Delete the test `'starts and stops spinner'` in the `implementIssue` describe block
- Delete the test `'calls logDim with last 500 chars of output'` in the `implementIssue` describe block
- Delete the `'makeSpinner returns an object with start and stop'` test
- Delete the `'logDim calls log.dim without throwing'` test
- Remove `makeSpinner` from all inline deps objects that construct `AgentRunnerDeps` directly (the ones that don't use the `makeDeps` helper)

Also add a new test to verify `log.info` is called with an agent header before the Claude call:

```typescript
test('logs info header before calling runClaude for assess', async () => {
	const infoCalls: string[] = [];
	const { deps } = makeDeps({
		runClaudeOutput: JSON.stringify({ shouldSplit: false, reasoning: 'ok', proposedSplits: [] }),
	});
	deps.logInfo = (msg: string) => { infoCalls.push(msg); };

	await assessIssueSize(makeIssue(42), baseConfig, '/repo', deps);

	expect(infoCalls.some(m => m.includes('#42'))).toBe(true);
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tools/orchestrator/agent-runner.coverage.test.ts`
Expected: FAIL — `makeSpinner` still referenced in source, `logInfo` not on deps

**Step 3: Remove spinner and logDim from `agent-runner.ts`**

In `tools/orchestrator/agent-runner.ts`:

Remove `Spinner` from the import on line 8:
```typescript
// OLD:
import { log, Spinner } from '@shared/log.ts';
// NEW:
import { log } from '@shared/log.ts';
```

Update `AgentRunnerDeps` — remove `makeSpinner` and `logDim`, add `logInfo`:

```typescript
export interface AgentRunnerDeps {
	runClaude: (opts: RunClaudeOpts) => Promise<{ ok: boolean; output: string }>;
	logInfo: (msg: string) => void;
	parseJson: (text: string) => { ok: true; value: unknown } | { ok: false };
}
```

Update `defaultAgentRunnerDeps`:

```typescript
export const defaultAgentRunnerDeps: AgentRunnerDeps = {
	runClaude,
	logInfo: (msg: string) => log.info(msg),
	parseJson: (text: string) => {
		const result = defaultFsAdapter.parseJson(text);
		if (result === null) return { ok: false as const };
		return { ok: true as const, value: result };
	}
};
```

Update `assessIssueSize` — replace spinner with info log:

```typescript
// OLD:
const spinner = deps.makeSpinner();
spinner.start(`Assessing #${issue.number} size`);

const { output: rawResult } = await deps.runClaude({...}).catch(...);

spinner.stop();

// NEW:
deps.logInfo(`Assessing #${issue.number} size`);

const { output: rawResult } = await deps.runClaude({...}).catch(...);
```

Update `implementIssue` — replace spinner + logDim with info log:

```typescript
// OLD:
const spinner = deps.makeSpinner();
spinner.start(`Agent implementing #${issue.number}`);

const result = await deps.runClaude({...});

spinner.stop();
deps.logDim(result.output.slice(-500));

// NEW:
deps.logInfo(`Agent implementing #${issue.number}`);

const result = await deps.runClaude({...});
```

**Step 4: Run tests to verify they pass**

Run: `bun test tools/orchestrator/agent-runner.coverage.test.ts`
Expected: All tests PASS

**Step 5: Also run the unit tests**

Run: `bun test tools/orchestrator/agent-runner.test.ts`
Expected: All tests PASS (these only test `buildImplementationPrompt`, should be unaffected)

**Step 6: Commit**

```bash
git add tools/orchestrator/agent-runner.ts tools/orchestrator/agent-runner.coverage.test.ts
git commit -m "refactor: remove spinner from agent-runner, use streaming output"
```

---

### Task 3: Remove spinner from `verify-fixer.ts`

**Files:**
- Modify: `tools/orchestrator/verify-fixer.ts`
- Test: `tools/orchestrator/verify-fixer.coverage.test.ts`

**Step 1: Update tests — remove spinner assertions, remove `makeSpinner` from deps**

In `verify-fixer.coverage.test.ts`:

- Remove `makeSpinner` from `VerifyFixerDeps` mock builder
- Remove `spinnerCalls` tracking
- Delete the entire `'fixVerificationFailure — spinner behavior'` describe block (4 tests)
- Delete the `'makeSpinner returns an object with start and stop'` test
- Remove `makeSpinner` from all inline deps objects
- Remove the `spinnerLabel` test (since it's spinner-specific)

Add a test for the info log:

```typescript
test('logs info header with issue number before calling runClaude', async () => {
	const infoCalls: string[] = [];
	const deps: VerifyFixerDeps = {
		runClaude: async () => ({ ok: true, output: 'fixed' }),
		logInfo: (msg: string) => { infoCalls.push(msg); },
	};

	await fixVerificationFailure({
		issueNumber: 42,
		failedStep: 'test',
		errorOutput: '',
		config: baseConfig,
		worktreePath: '/wt',
		logger: noopLogger,
	}, deps);

	expect(infoCalls.some(m => m.includes('#42'))).toBe(true);
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tools/orchestrator/verify-fixer.coverage.test.ts`
Expected: FAIL — `makeSpinner` still in source, `logInfo` not on deps

**Step 3: Remove spinner from `verify-fixer.ts`**

Remove `Spinner` import:
```typescript
// OLD:
import { Spinner } from '@shared/log.ts';
// NEW:
import { log } from '@shared/log.ts';
```

Update `VerifyFixerDeps`:
```typescript
export interface VerifyFixerDeps {
	runClaude: (opts: RunClaudeOpts) => Promise<{ ok: boolean; output: string }>;
	logInfo: (msg: string) => void;
}
```

Update `defaultVerifyFixerDeps`:
```typescript
export const defaultVerifyFixerDeps: VerifyFixerDeps = {
	runClaude,
	logInfo: (msg: string) => log.info(msg),
};
```

Remove `spinnerLabel` from `FixVerificationOptions`:
```typescript
export interface FixVerificationOptions {
	issueNumber: number;
	failedStep: string;
	errorOutput: string;
	config: OrchestratorConfig;
	worktreePath: string;
	logger: RunLogger;
}
```

Update `fixVerificationFailure` body:
```typescript
// OLD:
const label = spinnerLabel ?? `Agent fixing verification for #${issueNumber}`;
const spinner = deps.makeSpinner();
spinner.start(label);

const fixResult = await deps.runClaude({...}).catch(...);

spinner.stop();

// NEW:
deps.logInfo(`Agent fixing verification for #${issueNumber}`);

const fixResult = await deps.runClaude({...}).catch(...);
```

**Step 4: Run tests to verify they pass**

Run: `bun test tools/orchestrator/verify-fixer.coverage.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add tools/orchestrator/verify-fixer.ts tools/orchestrator/verify-fixer.coverage.test.ts
git commit -m "refactor: remove spinner from verify-fixer, use streaming output"
```

---

### Task 4: Clean up any remaining `spinnerLabel` references

**Files:**
- Modify: `tools/orchestrator/agent-runner.ts` (the `fixVerificationFailure` re-export wrapper, if it passes `spinnerLabel`)
- Check: any other callers of `fixVerificationFailure` that pass `spinnerLabel`

**Step 1: Search for `spinnerLabel` references**

Run: `grep -r 'spinnerLabel' --include='*.ts'`

If any callers pass `spinnerLabel`, remove that property from their call. The `FixVerificationOptions` interface no longer has it.

**Step 2: Check for remaining `Spinner` imports**

Run: `grep -r "import.*Spinner" --include='*.ts'`

Ensure only `shared/log.ts` defines `Spinner`. No orchestrator files should import it anymore.

**Step 3: Run full test suite**

Run: `bun test`
Expected: All tests PASS

**Step 4: Commit if changes were needed**

```bash
git add -A
git commit -m "chore: clean up remaining spinnerLabel and Spinner references"
```

---

### Task 5: Verify git.ts works with streaming (no changes needed)

**Files:**
- Check: `shared/git.ts` — its `deps.claude` calls `runClaude` which now streams by default. No spinner to remove.

**Step 1: Verify `git.ts` doesn't use Spinner for Claude calls**

Read `shared/git.ts` and confirm: `autoResolveConflicts` and `resolveConflicts` call `deps.claude()` directly with no spinner wrapping. The streaming happens inside `runClaude()` automatically.

**Step 2: Run git tests**

Run: `bun test shared/git.test.ts`
Expected: All tests PASS — the git tests mock `deps.claude` so streaming doesn't affect them.

No commit needed unless something was broken.

---

### Task 6: End-to-end smoke test

**Step 1: Run the full test suite**

Run: `bun test`
Expected: All tests PASS

**Step 2: Typecheck**

Run: `bun build --target bun --outfile /tmp/pait-check cli.ts`
Expected: No type errors

**Step 3: Manual verification**

Run a real pait command against a test repo to see streaming in action:
```bash
bun run cli.ts orchestrate --single 1
```
Expected: Claude's output streams to terminal in real-time instead of showing a spinner.
