# Orchestrator Verification & State Management Improvements — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 7 improvements to the orchestrator: zero-diff detection, agent prompt enforcement, split parent auto-close, state reconciliation, requirements verification (LLM gate), diff substance heuristic, and a `--skip-requirements` flag.

**Architecture:** Programmatic checks (zero-diff, split completion, state reconciliation) are pure functions with dependency injection. The requirements verification is a new module that calls Claude to assess diff vs acceptance criteria. All changes follow existing patterns: `Deps` interfaces, `withRetries`, and colocated tests.

**Tech Stack:** TypeScript, Bun runtime, `gh` CLI for GitHub operations, `git` CLI for diff checks, Claude CLI for LLM assessment.

---

### Task 1: Agent prompt enforcement

**Files:**
- Modify: `tools/orchestrator/agent-runner.ts:105-128`
- Modify: `tools/orchestrator/agent-runner.test.ts` (add test)

**Step 1: Write the failing test**

Add to `tools/orchestrator/agent-runner.test.ts`:

```typescript
test('buildImplementationPrompt includes anti-design enforcement', () => {
	const issue = { number: 1, title: 'Add auth', body: 'Build login page', state: 'open', labels: [] };
	const prompt = buildImplementationPrompt(issue, 'feat/1-auth', 'main', baseConfig, '/repo');
	expect(prompt).toContain('MUST write code and make commits');
	expect(prompt).toContain('Do not ask clarifying questions');
	expect(prompt).toContain('Do not propose designs');
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tools/orchestrator/agent-runner.test.ts -t 'anti-design'`
Expected: FAIL — prompt doesn't contain those strings yet.

**Step 3: Add enforcement text to the prompt**

In `tools/orchestrator/agent-runner.ts`, in `buildImplementationPrompt()`, add after the `Do NOT create a pull request` line:

```typescript
CRITICAL: You MUST write code and make commits. Do not ask clarifying questions.
Do not propose designs or alternatives. Do not output analysis without implementation.
If requirements are ambiguous, make reasonable assumptions and implement.
```

**Step 4: Run test to verify it passes**

Run: `bun test tools/orchestrator/agent-runner.test.ts -t 'anti-design'`
Expected: PASS

**Step 5: Commit**

```bash
git add tools/orchestrator/agent-runner.ts tools/orchestrator/agent-runner.test.ts
git commit -m "feat(orchestrator): enforce implementation-only agent prompt"
```

---

### Task 2: Zero-diff detection

**Files:**
- Modify: `tools/orchestrator/execution.ts` (add `checkForChanges` dep + call site)
- Modify: `tools/orchestrator/execution.test.ts` (add tests)

**Step 1: Write the failing tests**

Add to `tools/orchestrator/execution.test.ts`:

```typescript
describe('runMainLoop — zero-diff detection', () => {
	test('fails issue when agent produces no changes', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const { deps } = makeDeps({
			checkForChanges: async () => ({ hasChanges: false }),
		});

		await expect(
			runMainLoop(makeOpts([1], graph, state, {}, deps))
		).rejects.toThrow('exit(1)');
		expect(state.issues[1]?.status).toBe('failed');
		expect(state.issues[1]?.error).toContain('no changes');
	});

	test('proceeds to verification when agent produces changes', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const { deps, calls } = makeDeps({
			checkForChanges: async () => ({ hasChanges: true }),
		});

		await runMainLoop(makeOpts([1], graph, state, {}, deps));

		expect(calls.some(c => c.fn === 'runVerify')).toBe(true);
		expect(state.issues[1]?.status).toBe('completed');
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tools/orchestrator/execution.test.ts -t 'zero-diff'`
Expected: FAIL — `checkForChanges` not in deps interface.

**Step 3: Add `checkForChanges` to deps and execution flow**

In `tools/orchestrator/execution.ts`:

1. Add to `ExecutionAgentDeps`:
```typescript
checkForChanges: (worktreePath: string, baseBranch: string) => Promise<{ hasChanges: boolean }>;
```

2. Add default implementation in `defaultExecutionDeps`:
```typescript
checkForChanges: async (worktreePath: string, baseBranch: string) => {
	const proc = Bun.spawnSync(['git', '-C', worktreePath, 'diff', '--stat', baseBranch]);
	const output = proc.stdout?.toString().trim() ?? '';
	return { hasChanges: output.length > 0 };
},
```

3. Add zero-diff check between implementation and verification (after line 314, before line 316):
```typescript
// Zero-diff check — fail fast if agent produced no changes
const diffCheck = await d.checkForChanges(worktreePath, baseBranch);
if (!diffCheck.hasChanges) {
	d.log.error('Agent produced no changes — nothing to verify');
	issueState.status = 'failed';
	issueState.error = 'Agent produced no changes';
	d.saveState(state, stateFile);
	logger.issueFailed(issueNum, issueState.error);
	await d.removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);
	d.exit(1);
}
```

4. Update `makeDeps` in test file to include default `checkForChanges`:
```typescript
checkForChanges: async () => ({ hasChanges: true }),
```

**Step 4: Run tests to verify they pass**

Run: `bun test tools/orchestrator/execution.test.ts`
Expected: ALL PASS (new tests + existing tests still green).

**Step 5: Commit**

```bash
git add tools/orchestrator/execution.ts tools/orchestrator/execution.test.ts
git commit -m "feat(orchestrator): add zero-diff detection after agent implementation"
```

---

### Task 3: Types and config for requirements verification

**Files:**
- Modify: `tools/orchestrator/types.ts` (add `retries.requirements` + `skipRequirements` flag)
- Modify: `tools/orchestrator/defaults.ts` (add default value)
- Modify: `tools/orchestrator/flags.ts` (add `--skip-requirements` flag)
- Modify: `cli.ts` (add flag to HELP text)

**Step 1: Add `requirements` to retries in types**

In `tools/orchestrator/types.ts`, update the `retries` field:

```typescript
retries: {
	implement: number;
	verify: number;
	requirements: number;
};
```

Add to `OrchestratorFlags`:

```typescript
skipRequirements: boolean;
```

**Step 2: Update defaults**

In `tools/orchestrator/defaults.ts`:

```typescript
retries: {
	implement: 1,
	verify: 1,
	requirements: 1
},
```

**Step 3: Update flag parser**

In `tools/orchestrator/flags.ts`, add `skipRequirements` to the return:

```typescript
skipRequirements: args.includes('--skip-requirements'),
```

**Step 4: Update CLI HELP text**

In `cli.ts`, add under ORCHESTRATOR FLAGS:

```
  --skip-requirements  Skip LLM requirements verification
```

**Step 5: Update all test fixtures**

Update `baseConfig` in `execution.test.ts` and any other test files that construct `OrchestratorConfig` to include `requirements: 0` in retries, and `skipRequirements: false` in flags. Also update `baseFlags` in test files to include `skipRequirements: false`.

**Step 6: Run all tests**

Run: `bun test`
Expected: ALL PASS — no behavior changes, just type additions.

**Step 7: Commit**

```bash
git add tools/orchestrator/types.ts tools/orchestrator/defaults.ts tools/orchestrator/flags.ts cli.ts tools/orchestrator/execution.test.ts
git commit -m "feat(orchestrator): add requirements retry config and skip-requirements flag"
```

---

### Task 4: Requirements verification module

**Files:**
- Create: `tools/orchestrator/requirements-check.ts`
- Create: `tools/orchestrator/requirements-check.test.ts`

**Step 1: Write the failing tests**

Create `tools/orchestrator/requirements-check.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import {
	checkRequirements,
	extractAcceptanceCriteria,
	computeDiffMetrics,
	type RequirementsCheckDeps,
} from '@tools/orchestrator/requirements-check.ts';
import type { GitHubIssue } from '@shared/github.ts';
import type { OrchestratorConfig } from '@tools/orchestrator/types.ts';
import type { RunLogger } from '@shared/logging.ts';

const noopLogger = {
	log: () => {}, path: '/dev/null', runStart: () => {},
	runComplete: () => {}, issueStart: () => {}, issueComplete: () => {},
	issueFailed: () => {}, issueSplit: () => {}, agentOutput: () => {},
	verifyPass: () => {}, verifyFail: () => {}, worktreeCreated: () => {},
	worktreeRemoved: () => {}, branchCreated: () => {}, prCreated: () => {},
} as unknown as RunLogger;

const baseConfig: OrchestratorConfig = {
	branchPrefix: 'feat/', baseBranch: 'main', worktreeDir: '.pait/worktrees',
	models: { implement: 'sonnet', assess: 'haiku' },
	retries: { implement: 0, verify: 0, requirements: 0 },
	allowedTools: 'Bash Edit Write Read', verify: [],
};

function makeIssue(body: string): GitHubIssue {
	return { number: 1, title: 'Test issue', body, state: 'open', labels: [] };
}

// ---------------------------------------------------------------------------
// extractAcceptanceCriteria
// ---------------------------------------------------------------------------

describe('extractAcceptanceCriteria', () => {
	test('extracts checkbox items from issue body', () => {
		const body = '## Acceptance Criteria\n- [ ] Add login page\n- [ ] Add logout button\n- [ ] Write tests';
		expect(extractAcceptanceCriteria(body)).toEqual([
			'Add login page', 'Add logout button', 'Write tests'
		]);
	});

	test('extracts numbered list items', () => {
		const body = '## Requirements\n1. Create store\n2. Add component\n3. Style it';
		expect(extractAcceptanceCriteria(body)).toEqual([
			'Create store', 'Add component', 'Style it'
		]);
	});

	test('returns empty array when no criteria found', () => {
		expect(extractAcceptanceCriteria('Just do the thing')).toEqual([]);
	});

	test('handles mixed checkbox and numbered items', () => {
		const body = '- [ ] First item\n1. Second item\n- [x] Already done';
		const result = extractAcceptanceCriteria(body);
		expect(result.length).toBeGreaterThanOrEqual(2);
	});
});

// ---------------------------------------------------------------------------
// computeDiffMetrics
// ---------------------------------------------------------------------------

describe('computeDiffMetrics', () => {
	test('counts lines added and removed', () => {
		const diff = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,5 @@
+import { x } from 'y';
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;`;
		const metrics = computeDiffMetrics(diff);
		expect(metrics.linesAdded).toBe(3);
		expect(metrics.linesRemoved).toBe(1);
		expect(metrics.filesChanged).toBe(1);
	});

	test('counts multiple files', () => {
		const diff = `diff --git a/foo.ts b/foo.ts
+new line
diff --git a/bar.ts b/bar.ts
+another line`;
		const metrics = computeDiffMetrics(diff);
		expect(metrics.filesChanged).toBe(2);
	});

	test('identifies file types', () => {
		const diff = `diff --git a/foo.ts b/foo.ts
+line
diff --git a/bar.d.ts b/bar.d.ts
+line
diff --git a/baz.test.ts b/baz.test.ts
+line`;
		const metrics = computeDiffMetrics(diff);
		expect(metrics.fileTypes).toContain('.ts');
		expect(metrics.fileTypes).toContain('.d.ts');
		expect(metrics.fileTypes).toContain('.test.ts');
	});

	test('returns zeros for empty diff', () => {
		const metrics = computeDiffMetrics('');
		expect(metrics.linesAdded).toBe(0);
		expect(metrics.linesRemoved).toBe(0);
		expect(metrics.filesChanged).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// checkRequirements — LLM assessment
// ---------------------------------------------------------------------------

describe('checkRequirements', () => {
	test('returns satisfied when LLM says requirements met', async () => {
		const deps: RequirementsCheckDeps = {
			exec: async () => ({ exitCode: 0, stdout: 'diff output here\n+new code', stderr: '' }),
			runClaude: async () => ({ ok: true, output: JSON.stringify({
				satisfied: true,
				criteria: [{ criterion: 'Add login page', met: true, evidence: 'LoginPage.tsx created' }],
				summary: 'All criteria met',
			}) }),
		};

		const result = await checkRequirements({
			issue: makeIssue('- [ ] Add login page'),
			baseBranch: 'main',
			worktreePath: '/wt',
			config: baseConfig,
			logger: noopLogger,
		}, deps);

		expect(result.ok).toBe(true);
	});

	test('returns not satisfied when LLM says requirements unmet', async () => {
		const deps: RequirementsCheckDeps = {
			exec: async () => ({ exitCode: 0, stdout: 'diff output\n+type Foo = string;', stderr: '' }),
			runClaude: async () => ({ ok: true, output: JSON.stringify({
				satisfied: false,
				criteria: [{ criterion: 'Add login page', met: false, evidence: 'Only type definitions added' }],
				summary: 'Implementation incomplete',
			}) }),
		};

		const result = await checkRequirements({
			issue: makeIssue('- [ ] Add login page'),
			baseBranch: 'main',
			worktreePath: '/wt',
			config: baseConfig,
			logger: noopLogger,
		}, deps);

		expect(result.ok).toBe(false);
		expect(result.summary).toContain('incomplete');
	});

	test('returns not satisfied when diff is empty', async () => {
		const deps: RequirementsCheckDeps = {
			exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
			runClaude: async () => ({ ok: true, output: '{}' }),
		};

		const result = await checkRequirements({
			issue: makeIssue('- [ ] Add feature'),
			baseBranch: 'main',
			worktreePath: '/wt',
			config: baseConfig,
			logger: noopLogger,
		}, deps);

		expect(result.ok).toBe(false);
	});

	test('includes substance warning in LLM prompt when diff is small relative to criteria', async () => {
		let capturedPrompt = '';
		const deps: RequirementsCheckDeps = {
			exec: async () => ({ exitCode: 0, stdout: 'diff --git a/foo.ts b/foo.ts\n+type X = string;', stderr: '' }),
			runClaude: async (opts) => {
				capturedPrompt = opts.prompt;
				return { ok: true, output: JSON.stringify({ satisfied: true, criteria: [], summary: 'ok' }) };
			},
		};

		await checkRequirements({
			issue: makeIssue('- [ ] A\n- [ ] B\n- [ ] C\n- [ ] D\n- [ ] E\n- [ ] F'),
			baseBranch: 'main',
			worktreePath: '/wt',
			config: baseConfig,
			logger: noopLogger,
		}, deps);

		expect(capturedPrompt).toContain('unusually small');
	});

	test('handles malformed LLM response gracefully', async () => {
		const deps: RequirementsCheckDeps = {
			exec: async () => ({ exitCode: 0, stdout: 'diff\n+code', stderr: '' }),
			runClaude: async () => ({ ok: true, output: 'not valid json at all' }),
		};

		const result = await checkRequirements({
			issue: makeIssue('- [ ] Do thing'),
			baseBranch: 'main',
			worktreePath: '/wt',
			config: baseConfig,
			logger: noopLogger,
		}, deps);

		expect(result.ok).toBe(false);
		expect(result.summary).toBeDefined();
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tools/orchestrator/requirements-check.test.ts`
Expected: FAIL — module doesn't exist yet.

**Step 3: Implement the requirements-check module**

Create `tools/orchestrator/requirements-check.ts`:

```typescript
/**
 * Requirements verification — LLM-based assessment of whether a diff
 * satisfies the issue's acceptance criteria.
 *
 * This is a post-verify gate: mechanical checks (tsc, lint, test) pass first,
 * then this module checks whether the implementation actually addresses the
 * issue's requirements.
 */

import { log } from '@shared/log.ts';
import { runClaude } from '@shared/claude.ts';
import type { RunClaudeOpts } from '@shared/claude.ts';
import type { RunLogger } from '@shared/logging.ts';
import type { GitHubIssue } from '@shared/github.ts';
import type { OrchestratorConfig } from '@tools/orchestrator/types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RequirementsCheckResult {
	ok: boolean;
	summary: string;
	criteria: { criterion: string; met: boolean; evidence: string }[];
}

export interface DiffMetrics {
	linesAdded: number;
	linesRemoved: number;
	filesChanged: number;
	fileTypes: string[];
}

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface RequirementsCheckDeps {
	exec: (cmd: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
	runClaude: (opts: RunClaudeOpts) => Promise<{ ok: boolean; output: string }>;
}

export const defaultRequirementsCheckDeps: RequirementsCheckDeps = {
	exec: async (cmd) => {
		const proc = Bun.spawnSync(cmd);
		return {
			exitCode: proc.exitCode ?? 1,
			stdout: proc.stdout?.toString() ?? '',
			stderr: proc.stderr?.toString() ?? '',
		};
	},
	runClaude,
};

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

export function extractAcceptanceCriteria(body: string): string[] {
	const criteria: string[] = [];

	// Match checkbox items: - [ ] text or - [x] text
	for (const match of body.matchAll(/^-\s+\[[ x]\]\s+(.+)$/gm)) {
		criteria.push(match[1].trim());
	}

	// Match numbered list items: 1. text, 2. text
	for (const match of body.matchAll(/^\d+\.\s+(.+)$/gm)) {
		criteria.push(match[1].trim());
	}

	return criteria;
}

export function computeDiffMetrics(diff: string): DiffMetrics {
	if (!diff.trim()) {
		return { linesAdded: 0, linesRemoved: 0, filesChanged: 0, fileTypes: [] };
	}

	let linesAdded = 0;
	let linesRemoved = 0;
	const files = new Set<string>();
	const types = new Set<string>();

	for (const line of diff.split('\n')) {
		if (line.startsWith('diff --git')) {
			const fileMatch = line.match(/b\/(.+)$/);
			if (fileMatch) {
				const file = fileMatch[1];
				files.add(file);
				// Extract file extension, handling .d.ts and .test.ts specially
				if (file.endsWith('.test.ts')) types.add('.test.ts');
				else if (file.endsWith('.d.ts')) types.add('.d.ts');
				else {
					const extMatch = file.match(/(\.[^.]+)$/);
					if (extMatch) types.add(extMatch[1]);
				}
			}
		} else if (line.startsWith('+') && !line.startsWith('+++')) {
			linesAdded++;
		} else if (line.startsWith('-') && !line.startsWith('---')) {
			linesRemoved++;
		}
	}

	return {
		linesAdded,
		linesRemoved,
		filesChanged: files.size,
		fileTypes: [...types],
	};
}

// ---------------------------------------------------------------------------
// Main check function
// ---------------------------------------------------------------------------

export interface CheckRequirementsOpts {
	issue: GitHubIssue;
	baseBranch: string;
	worktreePath: string;
	config: OrchestratorConfig;
	logger: RunLogger;
}

export async function checkRequirements(
	opts: CheckRequirementsOpts,
	deps: RequirementsCheckDeps = defaultRequirementsCheckDeps,
): Promise<RequirementsCheckResult> {
	const { issue, baseBranch, worktreePath, config, logger } = opts;

	// Get the diff
	const diffResult = await deps.exec([
		'git', '-C', worktreePath, 'diff', `${baseBranch}...HEAD`,
	]);
	const diff = diffResult.stdout.trim();

	// Fail fast on empty diff
	if (!diff) {
		return {
			ok: false,
			summary: 'No diff found — nothing was implemented',
			criteria: [],
		};
	}

	// Compute metrics
	const metrics = computeDiffMetrics(diff);
	const acceptanceCriteria = extractAcceptanceCriteria(issue.body);

	// Build substance warning
	let substanceWarning = '';
	if (acceptanceCriteria.length >= 5 && metrics.linesAdded < 20) {
		substanceWarning = '\n\nWARNING: The diff is unusually small relative to the issue scope ' +
			`(${metrics.linesAdded} lines added, ${acceptanceCriteria.length} acceptance criteria). ` +
			'Assess critically whether this is a complete implementation or a stub/placeholder.';
	}

	// Build LLM prompt
	const criteriaList = acceptanceCriteria.length > 0
		? `\n\nExtracted acceptance criteria:\n${acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
		: '';

	const prompt = `You are reviewing whether a git diff satisfies the requirements of a GitHub issue.

## Issue #${issue.number}: ${issue.title}

${issue.body}
${criteriaList}

## Diff Summary

- Files changed: ${metrics.filesChanged}
- Lines added: ${metrics.linesAdded}
- Lines removed: ${metrics.linesRemoved}
- File types: ${metrics.fileTypes.join(', ') || 'none'}

## Full Diff

${diff}
${substanceWarning}

## Task

Assess whether this diff satisfies the issue's requirements. For each requirement or acceptance criterion, determine if it was implemented.

Respond in EXACTLY this JSON format (no markdown, no code fences):
{
  "satisfied": true/false,
  "criteria": [
    {"criterion": "description", "met": true/false, "evidence": "what in the diff shows this"}
  ],
  "summary": "one sentence overall assessment"
}`;

	log.info(`Checking requirements for #${issue.number}...`);

	const result = await deps.runClaude({
		prompt,
		model: config.models.assess,
		cwd: worktreePath,
	}).catch(() => ({ ok: false, output: '' }));

	logger.agentOutput(issue.number, `[requirements-check] ${result.output}`);

	// Parse response
	const jsonMatch = result.output.match(/\{[\s\S]*\}/);
	if (!jsonMatch) {
		return {
			ok: false,
			summary: 'Failed to parse requirements assessment — treating as failed',
			criteria: [],
		};
	}

	try {
		const parsed = JSON.parse(jsonMatch[0]) as {
			satisfied?: boolean;
			criteria?: { criterion: string; met: boolean; evidence: string }[];
			summary?: string;
		};

		return {
			ok: parsed.satisfied === true,
			summary: parsed.summary ?? 'No summary provided',
			criteria: parsed.criteria ?? [],
		};
	} catch {
		return {
			ok: false,
			summary: 'Failed to parse requirements assessment JSON — treating as failed',
			criteria: [],
		};
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test tools/orchestrator/requirements-check.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add tools/orchestrator/requirements-check.ts tools/orchestrator/requirements-check.test.ts
git commit -m "feat(orchestrator): add LLM-based requirements verification module"
```

---

### Task 5: Wire requirements check into execution pipeline

**Files:**
- Modify: `tools/orchestrator/execution.ts` (add requirements check call site + deps)
- Modify: `tools/orchestrator/execution.test.ts` (add tests)

**Step 1: Write the failing tests**

Add to `tools/orchestrator/execution.test.ts`:

```typescript
describe('runMainLoop — requirements check', () => {
	test('fails issue when requirements check says not satisfied', async () => {
		const issue1 = makeIssue(1, 'Add feature', '- [ ] Build the thing');
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const config: OrchestratorConfig = { ...baseConfig, retries: { implement: 0, verify: 0, requirements: 0 } };
		const { deps } = makeDeps({
			checkRequirements: async () => ({ ok: false, summary: 'Incomplete', criteria: [] }),
		});

		await expect(
			runMainLoop({ ...makeOpts([1], graph, state, {}, deps), config })
		).rejects.toThrow('exit(1)');
		expect(state.issues[1]?.status).toBe('failed');
		expect(state.issues[1]?.error).toContain('requirements');
	});

	test('proceeds to PR when requirements check passes', async () => {
		const issue1 = makeIssue(1, 'Add feature', '- [ ] Build it');
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const config: OrchestratorConfig = { ...baseConfig, retries: { implement: 0, verify: 0, requirements: 0 } };
		const { deps, calls } = makeDeps({
			checkRequirements: async () => ({ ok: true, summary: 'All good', criteria: [] }),
		});

		await runMainLoop({ ...makeOpts([1], graph, state, {}, deps), config });

		expect(calls.some(c => c.fn === 'createPR')).toBe(true);
		expect(state.issues[1]?.status).toBe('completed');
	});

	test('skips requirements check when --skip-requirements flag is set', async () => {
		const issue1 = makeIssue(1);
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		let checkCalled = false;
		const { deps } = makeDeps({
			checkRequirements: async () => { checkCalled = true; return { ok: true, summary: '', criteria: [] }; },
		});

		await runMainLoop(makeOpts([1], graph, state, { skipRequirements: true }, deps));

		expect(checkCalled).toBe(false);
		expect(state.issues[1]?.status).toBe('completed');
	});

	test('invokes requirements fixer on failure before retry', async () => {
		const issue1 = makeIssue(1, 'Add feature', '- [ ] Build it');
		const graph = makeGraph(makeNode(issue1));
		const state = makeState();
		const config: OrchestratorConfig = { ...baseConfig, retries: { implement: 0, verify: 0, requirements: 1 } };
		let checkCount = 0;
		let fixerCalled = false;
		const { deps } = makeDeps({
			checkRequirements: async () => {
				checkCount++;
				if (checkCount === 1) return { ok: false, summary: 'Missing login page', criteria: [] };
				return { ok: true, summary: 'All good', criteria: [] };
			},
			fixRequirements: async () => { fixerCalled = true; },
		});

		await runMainLoop({ ...makeOpts([1], graph, state, {}, deps), config });

		expect(fixerCalled).toBe(true);
		expect(state.issues[1]?.status).toBe('completed');
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tools/orchestrator/execution.test.ts -t 'requirements check'`
Expected: FAIL — `checkRequirements` and `fixRequirements` not in deps.

**Step 3: Add requirements check to execution deps and pipeline**

In `tools/orchestrator/execution.ts`:

1. Import the requirements module:
```typescript
import { checkRequirements } from '@tools/orchestrator/requirements-check.ts';
import type { RequirementsCheckResult } from '@tools/orchestrator/requirements-check.ts';
```

2. Add to `ExecutionAgentDeps`:
```typescript
checkRequirements: (opts: {
	issue: GitHubIssue; baseBranch: string; worktreePath: string;
	config: OrchestratorConfig; logger: RunLogger;
}) => Promise<RequirementsCheckResult>;
fixRequirements: (opts: {
	issue: GitHubIssue; summary: string; criteria: RequirementsCheckResult['criteria'];
	config: OrchestratorConfig; worktreePath: string; logger: RunLogger;
}) => Promise<void>;
```

3. Add defaults:
```typescript
checkRequirements: async (opts) => checkRequirements(opts),
fixRequirements: async (opts) => {
	// Invoke Claude to fix based on requirements assessment feedback
	const { issue, summary, criteria, config, worktreePath, logger } = opts;
	const unmetList = criteria
		.filter(c => !c.met)
		.map(c => `- ${c.criterion}: ${c.evidence}`)
		.join('\n');

	const prompt = `The requirements check for issue #${issue.number} found unmet criteria.

Assessment: ${summary}

Unmet requirements:
${unmetList}

Please implement the missing requirements and commit your changes referencing #${issue.number}.`;

	const { RollingWindow } = await import('@shared/log.ts');
	const window = new RollingWindow({ header: `Agent fixing requirements for #${issue.number}`, logPath: logger.path });
	await runClaude({
		prompt,
		model: config.models.implement,
		cwd: worktreePath,
		permissionMode: 'acceptEdits',
		allowedTools: config.allowedTools,
		onChunk: (chunk) => window.update(chunk),
	}).catch(() => ({ ok: false, output: '' }));
	window.clear();
},
```

4. Add requirements check block after verification passes (after "All verification gates passed" log, before PR creation):
```typescript
// Requirements check (LLM gate) — skip if flag set
if (!flags.skipRequirements) {
	d.log.info('Running requirements verification...');
	let lastReqResult: RequirementsCheckResult | undefined;
	const reqRetryResult = await d.withRetries(
		async () => {
			const r = await d.checkRequirements({
				issue: node.issue, baseBranch, worktreePath, config, logger,
			});
			lastReqResult = r;
			return r;
		},
		async (attempt) => {
			if (lastReqResult && !lastReqResult.ok) {
				d.log.warn(
					`Requirements retry ${attempt + 1}/${config.retries.requirements} — feeding assessment back to agent`
				);
				await d.fixRequirements({
					issue: node.issue,
					summary: lastReqResult.summary,
					criteria: lastReqResult.criteria,
					config,
					worktreePath,
					logger,
				});
			}
		},
		config.retries.requirements + 1,
	);

	if (!reqRetryResult.ok) {
		const summary = lastReqResult?.summary ?? 'unknown';
		issueState.status = 'failed';
		issueState.error = `Requirements check failed after ${config.retries.requirements + 1} attempts: ${summary}`;
		d.saveState(state, stateFile);
		logger.issueFailed(issueNum, issueState.error);
		await d.removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);
		d.log.error('HALTING — requirements not satisfied');
		d.exit(1);
	}
	d.log.ok('Requirements verification passed');
}
```

5. Update `makeDeps` in test file:
```typescript
checkRequirements: async () => ({ ok: true, summary: 'All good', criteria: [] }),
fixRequirements: async () => {},
```

**Step 4: Run all tests**

Run: `bun test tools/orchestrator/execution.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add tools/orchestrator/execution.ts tools/orchestrator/execution.test.ts
git commit -m "feat(orchestrator): wire requirements check into execution pipeline"
```

---

### Task 6: Split parent auto-close

**Files:**
- Modify: `tools/orchestrator/state-helpers.ts` (add `checkSplitParentCompletion`)
- Modify: `tools/orchestrator/orchestrator.state.test.ts` (add tests)
- Modify: `tools/orchestrator/execution.ts` (add call site + dep)

**Step 1: Write the failing tests**

Add to `tools/orchestrator/orchestrator.state.test.ts`:

```typescript
import { checkSplitParentCompletion } from '@tools/orchestrator/state-helpers.ts';

describe('checkSplitParentCompletion', () => {
	test('marks parent completed when all sub-issues are completed', () => {
		const state = initState();
		// Parent issue 1 was split into 10, 11
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

	test('handles multiple split parents — finds the correct one', () => {
		const state = initState();
		getIssueState(state, 1, 'Parent A').status = 'split';
		state.issues[1].subIssues = [10, 11];
		getIssueState(state, 2, 'Parent B').status = 'split';
		state.issues[2].subIssues = [20, 21];

		getIssueState(state, 10).status = 'completed';
		getIssueState(state, 11).status = 'completed';
		getIssueState(state, 20).status = 'completed';
		getIssueState(state, 21).status = 'in_progress';

		const result = checkSplitParentCompletion(state, 11);
		expect(result).toEqual({ parentNumber: 1, allComplete: true });
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tools/orchestrator/orchestrator.state.test.ts -t 'checkSplitParentCompletion'`
Expected: FAIL — function doesn't exist.

**Step 3: Implement `checkSplitParentCompletion`**

In `tools/orchestrator/state-helpers.ts`:

```typescript
export interface SplitCompletionResult {
	parentNumber: number;
	allComplete: boolean;
}

export function checkSplitParentCompletion(
	state: OrchestratorState,
	completedIssueNumber: number
): SplitCompletionResult | null {
	// Find a split parent whose subIssues array contains this issue
	for (const [numStr, issueState] of Object.entries(state.issues)) {
		if (
			issueState.status === 'split' &&
			issueState.subIssues?.includes(completedIssueNumber)
		) {
			const parentNumber = Number(numStr);
			const allComplete = issueState.subIssues.every(
				(sub) => state.issues[sub]?.status === 'completed'
			);

			if (allComplete) {
				issueState.status = 'completed';
				issueState.completedAt = new Date().toISOString();
			}

			return { parentNumber, allComplete };
		}
	}

	return null;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test tools/orchestrator/orchestrator.state.test.ts`
Expected: ALL PASS

**Step 5: Wire into execution loop**

In `tools/orchestrator/execution.ts`, add import:
```typescript
import { checkSplitParentCompletion } from '@tools/orchestrator/state-helpers.ts';
```

Add a new dep to `ExecutionStateDeps`:
```typescript
checkSplitParentCompletion: typeof checkSplitParentCompletion;
closeGitHubIssue: (issueNumber: number) => Promise<void>;
```

Add defaults:
```typescript
checkSplitParentCompletion,
closeGitHubIssue: async (issueNumber: number) => {
	Bun.spawnSync(['gh', 'issue', 'close', String(issueNumber)]);
},
```

After the `issueState.status = 'completed'` block (line ~389), add:
```typescript
// Check if this completes a split parent
const splitResult = d.checkSplitParentCompletion(state, issueNum);
if (splitResult?.allComplete) {
	d.log.ok(`All sub-issues of #${splitResult.parentNumber} complete — closing parent`);
	await d.closeGitHubIssue(splitResult.parentNumber);
	d.saveState(state, stateFile);
}
```

Add test to `execution.test.ts`:
```typescript
test('closes split parent when last sub-issue completes', async () => {
	const issue10 = makeIssue(10, 'Sub A');
	const graph = makeGraph(makeNode(issue10));
	const state = makeState();
	// Set up parent as split with sub-issues [10]
	getIssueState(state, 1, 'Parent').status = 'split';
	state.issues[1].subIssues = [10];

	let closedIssue: number | null = null;
	const { deps } = makeDeps({
		closeGitHubIssue: async (num) => { closedIssue = num; },
	});

	await runMainLoop(makeOpts([10], graph, state, {}, deps));

	expect(state.issues[1]?.status).toBe('completed');
	expect(closedIssue).toBe(1);
});
```

Update `makeDeps` default:
```typescript
checkSplitParentCompletion,
closeGitHubIssue: async () => {},
```

**Step 6: Run all tests**

Run: `bun test tools/orchestrator/execution.test.ts tools/orchestrator/orchestrator.state.test.ts`
Expected: ALL PASS

**Step 7: Commit**

```bash
git add tools/orchestrator/state-helpers.ts tools/orchestrator/orchestrator.state.test.ts tools/orchestrator/execution.ts tools/orchestrator/execution.test.ts
git commit -m "feat(orchestrator): auto-close split parent when all sub-issues complete"
```

---

### Task 7: State reconciliation at startup

**Files:**
- Modify: `tools/orchestrator/state-helpers.ts` (add `reconcileWithGitHub`)
- Create: `tools/orchestrator/state-helpers.test.ts` (add tests for reconciliation)
- Modify: `tools/orchestrator/index.ts` (call at startup)

**Step 1: Write the failing tests**

Create/extend `tools/orchestrator/state-helpers.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { reconcileWithGitHub, type ReconciliationDeps } from '@tools/orchestrator/state-helpers.ts';
import { initState, getIssueState } from '@tools/orchestrator/state-helpers.ts';

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
			log: { info: () => {}, warn: () => {}, ok: () => {} },
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
			log: { info: () => {}, warn: () => {}, ok: () => {} },
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
			log: { info: () => {}, warn: () => {}, ok: () => {} },
		};

		const corrections = await reconcileWithGitHub(state, '/repo', deps);

		expect(state.issues[1].status).toBe('completed');
		expect(corrections.length).toBeGreaterThanOrEqual(1);
	});

	test('resets in_progress to pending when branch does not exist', async () => {
		const state = initState();
		const is = getIssueState(state, 1, 'Feature');
		is.status = 'in_progress';
		is.branch = 'feat/1-feature';

		const deps: ReconciliationDeps = {
			exec: async (cmd) => {
				if (cmd.includes('branch') && cmd.includes('--list')) {
					return { exitCode: 0, stdout: '', stderr: '' }; // empty = branch doesn't exist
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			},
			log: { info: () => {}, warn: () => {}, ok: () => {} },
		};

		const corrections = await reconcileWithGitHub(state, '/repo', deps);

		expect(state.issues[1].status).toBe('pending');
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
			log: { info: () => {}, warn: () => {}, ok: () => {} },
		};

		const corrections = await reconcileWithGitHub(state, '/repo', deps);

		expect(state.issues[1].status).toBe('in_progress');
		expect(corrections.length).toBe(0);
	});

	test('handles gh CLI failures gracefully', async () => {
		const state = initState();
		const is = getIssueState(state, 1, 'Feature');
		is.status = 'completed';
		is.prNumber = 42;

		const deps: ReconciliationDeps = {
			exec: async () => ({ exitCode: 1, stdout: '', stderr: 'network error' }),
			log: { info: () => {}, warn: () => {}, ok: () => {} },
		};

		// Should not throw, should leave state unchanged
		const corrections = await reconcileWithGitHub(state, '/repo', deps);
		expect(state.issues[1].status).toBe('completed');
		expect(corrections.length).toBe(0);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tools/orchestrator/state-helpers.test.ts`
Expected: FAIL — `reconcileWithGitHub` doesn't exist.

**Step 3: Implement `reconcileWithGitHub`**

In `tools/orchestrator/state-helpers.ts`:

```typescript
export interface ReconciliationDeps {
	exec: (cmd: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
	log: { info: (msg: string) => void; warn: (msg: string) => void; ok: (msg: string) => void };
}

export const defaultReconciliationDeps: ReconciliationDeps = {
	exec: async (cmd) => {
		const proc = Bun.spawnSync(cmd);
		return {
			exitCode: proc.exitCode ?? 1,
			stdout: proc.stdout?.toString() ?? '',
			stderr: proc.stderr?.toString() ?? '',
		};
	},
	log: {
		info: (msg) => console.log(msg),
		warn: (msg) => console.warn(msg),
		ok: (msg) => console.log(msg),
	},
};

export async function reconcileWithGitHub(
	state: OrchestratorState,
	repoRoot: string,
	deps: ReconciliationDeps = defaultReconciliationDeps,
): Promise<string[]> {
	const corrections: string[] = [];

	for (const [numStr, issueState] of Object.entries(state.issues)) {
		const num = Number(numStr);

		// Check completed issues: is the PR still valid?
		if (issueState.status === 'completed' && issueState.prNumber) {
			const r = await deps.exec([
				'gh', 'pr', 'view', String(issueState.prNumber), '--json', 'state', '--jq', '.state',
			]);
			if (r.exitCode !== 0) continue; // gh failed, skip

			const prState = r.stdout.trim().toUpperCase();
			if (prState === 'CLOSED') {
				issueState.status = 'failed';
				issueState.error = 'PR was closed without merge — reset by reconciliation';
				const msg = `#${num}: PR #${issueState.prNumber} closed without merge → reset to failed`;
				deps.log.warn(msg);
				corrections.push(msg);
			}
		}

		// Check split parents: are all sub-issues closed on GitHub?
		if (issueState.status === 'split' && issueState.subIssues?.length) {
			let allClosed = true;
			for (const sub of issueState.subIssues) {
				const r = await deps.exec([
					'gh', 'issue', 'view', String(sub), '--json', 'state', '--jq', '.state',
				]);
				if (r.exitCode !== 0) { allClosed = false; break; }
				if (r.stdout.trim().toLowerCase() !== 'closed') { allClosed = false; break; }
			}

			if (allClosed) {
				issueState.status = 'completed';
				issueState.completedAt = new Date().toISOString();
				const msg = `#${num}: all sub-issues closed → parent marked completed`;
				deps.log.ok(msg);
				corrections.push(msg);
			}
		}

		// Check in_progress: does the branch still exist?
		if (issueState.status === 'in_progress' && issueState.branch) {
			const r = await deps.exec([
				'git', '-C', repoRoot, 'branch', '--list', issueState.branch,
			]);
			if (r.exitCode !== 0) continue;

			if (!r.stdout.trim()) {
				issueState.status = 'pending';
				issueState.branch = null;
				issueState.baseBranch = null;
				const msg = `#${num}: branch ${issueState.branch} gone → reset to pending`;
				deps.log.warn(msg);
				corrections.push(msg);
			}
		}
	}

	if (corrections.length > 0) {
		deps.log.info(`Reconciliation made ${corrections.length} correction(s)`);
	}

	return corrections;
}
```

**Step 4: Run tests**

Run: `bun test tools/orchestrator/state-helpers.test.ts`
Expected: ALL PASS

**Step 5: Wire into orchestrator startup**

In `tools/orchestrator/index.ts`, after state is loaded/initialized and before the execution loop, add:

```typescript
import { reconcileWithGitHub } from '@tools/orchestrator/state-helpers.ts';

// After state load, before execution:
if (state && !flags.reset) {
	log.info('Reconciling state with GitHub...');
	const corrections = await reconcileWithGitHub(state, repoRoot);
	if (corrections.length > 0) {
		saveState(state, stateFile);
	}
}
```

**Step 6: Run all tests**

Run: `bun test`
Expected: ALL PASS

**Step 7: Commit**

```bash
git add tools/orchestrator/state-helpers.ts tools/orchestrator/state-helpers.test.ts tools/orchestrator/index.ts
git commit -m "feat(orchestrator): add state reconciliation with GitHub at startup"
```

---

### Task 8: Update CLI help test

**Files:**
- Modify: `cli.test.ts` (ensure `--skip-requirements` is covered)

**Step 1: Run the CLI help test to see if it fails**

Run: `bun test cli.test.ts`

If it fails because `--skip-requirements` is in `parseFlags` but not in HELP, that was fixed in Task 3. Verify it passes.

**Step 2: Commit if needed**

If any fix was required:
```bash
git add cli.ts cli.test.ts
git commit -m "fix: sync CLI help with new --skip-requirements flag"
```

---

### Task 9: Full integration test run

**Step 1: Run all tests**

Run: `bun test`
Expected: ALL PASS

**Step 2: Type check**

Run: `bun build --target bun --outfile /tmp/pai-tools-check.js cli.ts`
Expected: Build succeeds with no type errors.

**Step 3: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: resolve any integration issues from verification improvements"
```
