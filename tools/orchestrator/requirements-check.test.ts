/**
 * Tests for requirements-check.ts — LLM-based requirements verification.
 *
 * Pure functions (extractAcceptanceCriteria, computeDiffMetrics) are fully
 * unit-testable. checkRequirements uses injected deps for isolation.
 */

import { describe, test, expect } from 'bun:test';
import {
	extractAcceptanceCriteria,
	computeDiffMetrics,
	checkRequirements,
} from '@tools/orchestrator/requirements-check.ts';
import type {
	RequirementsCheckDeps,
	CheckRequirementsOpts,
} from '@tools/orchestrator/requirements-check.ts';
import type { OrchestratorConfig } from '@tools/orchestrator/types.ts';
import type { GitHubIssue } from '@shared/github.ts';
import type { RunLogger } from '@shared/logging.ts';
import type { RunClaudeOpts } from '@shared/claude.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(body: string, number = 42): GitHubIssue {
	return { number, title: 'Test issue', body, state: 'open', labels: [] };
}

function makeConfig(): OrchestratorConfig {
	return {
		branchPrefix: 'feat/',
		baseBranch: 'main',
		worktreeDir: '.pait/worktrees',
		models: { implement: 'sonnet', assess: 'haiku' },
		retries: { implement: 1, verify: 1, requirements: 1 },
		allowedTools: 'Bash Edit Write Read',
		verify: [{ name: 'test', cmd: 'bun test' }],
	};
}

function makeLogger(): RunLogger {
	return {
		path: '/tmp/test-run.jsonl',
		log: () => {},
		runStart: () => {},
		runComplete: () => {},
		issueStart: () => {},
		issueComplete: () => {},
		issueFailed: () => {},
		issueSplit: () => {},
		agentOutput: () => {},
		verifyPass: () => {},
		verifyFail: () => {},
		worktreeCreated: () => {},
		worktreeRemoved: () => {},
		branchCreated: () => {},
		prCreated: () => {},
	} as unknown as RunLogger;
}

function makeOpts(overrides: Partial<CheckRequirementsOpts> = {}): CheckRequirementsOpts {
	return {
		issue: makeIssue('- [ ] Add login\n- [ ] Add logout'),
		baseBranch: 'main',
		worktreePath: '/tmp/worktree-42',
		config: makeConfig(),
		logger: makeLogger(),
		...overrides,
	};
}

const SAMPLE_DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index abc1234..def5678 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,10 @@
+import { hash } from 'crypto';
+
 export function login(user: string, pass: string) {
-  return false;
+  const hashed = hash(pass);
+  return validate(user, hashed);
+}
+
+export function logout() {
+  return true;
 }
`;

// Build the multi-file diff programmatically to avoid the linter
// flagging the relative import inside the diff fixture as a real import.
const MULTI_FILE_DIFF = [
	'diff --git a/src/auth.ts b/src/auth.ts',
	'index abc..def 100644',
	'--- a/src/auth.ts',
	'+++ b/src/auth.ts',
	'@@ -1,2 +1,3 @@',
	"+import { hash } from 'crypto';",
	' export function login() {}',
	'diff --git a/src/auth.test.ts b/src/auth.test.ts',
	'index abc..def 100644',
	'--- a/src/auth.test.ts',
	'+++ b/src/auth.test.ts',
	'@@ -1,2 +1,5 @@',
	`+import { login } from ${"'./auth'"};`,
	"+test('login works', () => {",
	'+  expect(login()).toBe(true);',
	'+});',
	'diff --git a/types/auth.d.ts b/types/auth.d.ts',
	'index abc..def 100644',
	'--- a/types/auth.d.ts',
	'+++ b/types/auth.d.ts',
	'@@ -1 +1,2 @@',
	'+export declare function login(): boolean;',
].join('\n');

function makeSatisfiedResponse(): string {
	return JSON.stringify({
		ok: true,
		summary: 'All requirements are met',
		criteria: [
			{ criterion: 'Add login', met: true, evidence: 'login function implemented in auth.ts' },
			{ criterion: 'Add logout', met: true, evidence: 'logout function implemented in auth.ts' },
		],
	});
}

function makeUnsatisfiedResponse(): string {
	return JSON.stringify({
		ok: false,
		summary: 'Missing logout implementation',
		criteria: [
			{ criterion: 'Add login', met: true, evidence: 'login function exists' },
			{ criterion: 'Add logout', met: false, evidence: 'No logout function found' },
		],
	});
}

function makeDeps(overrides: Partial<RequirementsCheckDeps> = {}): RequirementsCheckDeps {
	return {
		exec: async () => ({ exitCode: 0, stdout: SAMPLE_DIFF, stderr: '' }),
		runClaude: async () => ({ ok: true, output: makeSatisfiedResponse() }),
		parseJson: (text: string) => {
			const value = JSON.parse(text);
			return { ok: true as const, value };
		},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// extractAcceptanceCriteria
// ---------------------------------------------------------------------------

describe('extractAcceptanceCriteria', () => {
	test('extracts unchecked checkbox items', () => {
		const body = '- [ ] Add login\n- [ ] Add logout';
		const criteria = extractAcceptanceCriteria(body);
		expect(criteria).toEqual(['Add login', 'Add logout']);
	});

	test('extracts checked checkbox items', () => {
		const body = '- [x] Add login\n- [x] Add logout';
		const criteria = extractAcceptanceCriteria(body);
		expect(criteria).toEqual(['Add login', 'Add logout']);
	});

	test('extracts numbered list items', () => {
		const body = '1. Add login\n2. Add logout\n3. Add session management';
		const criteria = extractAcceptanceCriteria(body);
		expect(criteria).toEqual(['Add login', 'Add logout', 'Add session management']);
	});

	test('returns empty array when no criteria found', () => {
		const body = 'This is just a description without any criteria.';
		const criteria = extractAcceptanceCriteria(body);
		expect(criteria).toEqual([]);
	});

	test('handles mixed format (checkboxes and numbered)', () => {
		const body = '- [ ] Add login\n1. Add logout\n- [x] Add session';
		const criteria = extractAcceptanceCriteria(body);
		expect(criteria).toEqual(['Add login', 'Add logout', 'Add session']);
	});
});

// ---------------------------------------------------------------------------
// computeDiffMetrics
// ---------------------------------------------------------------------------

describe('computeDiffMetrics', () => {
	test('counts lines added and removed correctly', () => {
		const metrics = computeDiffMetrics(SAMPLE_DIFF);
		// Lines starting with + (not +++): import, blank, const hashed, return validate,
		// blank, export function logout, return true, closing brace = 8
		expect(metrics.linesAdded).toBe(8);
		// Lines starting with - (not ---): return false = 1
		expect(metrics.linesRemoved).toBe(1);
	});

	test('counts files changed', () => {
		const metrics = computeDiffMetrics(MULTI_FILE_DIFF);
		expect(metrics.filesChanged).toBe(3);
	});

	test('identifies file types including .test.ts and .d.ts', () => {
		const metrics = computeDiffMetrics(MULTI_FILE_DIFF);
		expect(metrics.fileTypes).toContain('.ts');
		expect(metrics.fileTypes).toContain('.test.ts');
		expect(metrics.fileTypes).toContain('.d.ts');
	});

	test('returns zeros for empty diff', () => {
		const metrics = computeDiffMetrics('');
		expect(metrics.linesAdded).toBe(0);
		expect(metrics.linesRemoved).toBe(0);
		expect(metrics.filesChanged).toBe(0);
		expect(metrics.fileTypes).toEqual([]);
	});

	test('counts single file', () => {
		const metrics = computeDiffMetrics(SAMPLE_DIFF);
		expect(metrics.filesChanged).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// checkRequirements
// ---------------------------------------------------------------------------

describe('checkRequirements', () => {
	test('returns satisfied when LLM says yes', async () => {
		const deps = makeDeps();
		const result = await checkRequirements(makeOpts(), deps);
		expect(result.ok).toBe(true);
		expect(result.summary).toBe('All requirements are met');
		expect(result.criteria).toHaveLength(2);
		expect(result.criteria[0].met).toBe(true);
	});

	test('returns not satisfied when LLM says no', async () => {
		const deps = makeDeps({
			runClaude: async () => ({ ok: true, output: makeUnsatisfiedResponse() }),
		});
		const result = await checkRequirements(makeOpts(), deps);
		expect(result.ok).toBe(false);
		expect(result.criteria.some((c) => !c.met)).toBe(true);
	});

	test('returns not satisfied on empty diff', async () => {
		const deps = makeDeps({
			exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
		});
		const result = await checkRequirements(makeOpts(), deps);
		expect(result.ok).toBe(false);
		expect(result.summary).toBe('No diff found');
		expect(result.criteria).toEqual([]);
	});

	test('includes substance warning when diff is small relative to criteria count', async () => {
		let capturedPrompt = '';
		const manyCheckboxes = Array.from({ length: 6 }, (_, i) => `- [ ] Criterion ${i + 1}`).join('\n');
		// Small diff: only a few lines added
		const smallDiff = [
			'diff --git a/src/x.ts b/src/x.ts',
			'index abc..def 100644',
			'--- a/src/x.ts',
			'+++ b/src/x.ts',
			'@@ -1,2 +1,4 @@',
			'+const a = 1;',
			'+const b = 2;',
		].join('\n');
		const deps = makeDeps({
			exec: async () => ({ exitCode: 0, stdout: smallDiff, stderr: '' }),
			runClaude: async (opts) => {
				capturedPrompt = opts.prompt;
				return { ok: true, output: makeSatisfiedResponse() };
			},
		});
		const opts = makeOpts({ issue: makeIssue(manyCheckboxes) });
		await checkRequirements(opts, deps);
		expect(capturedPrompt).toContain('substance');
	});

	test('does not include substance warning when diff is large enough', async () => {
		let capturedPrompt = '';
		// Only 2 criteria, large diff
		const deps = makeDeps({
			runClaude: async (opts) => {
				capturedPrompt = opts.prompt;
				return { ok: true, output: makeSatisfiedResponse() };
			},
		});
		await checkRequirements(makeOpts(), deps);
		expect(capturedPrompt).not.toContain('substance');
	});

	test('handles malformed LLM response gracefully', async () => {
		const deps = makeDeps({
			runClaude: async () => ({ ok: true, output: 'This is not JSON at all' }),
		});
		const result = await checkRequirements(makeOpts(), deps);
		expect(result.ok).toBe(false);
		expect(result.summary).toContain('Failed to parse');
		expect(result.criteria).toEqual([]);
	});

	test('calls git diff with correct worktree path and base branch', async () => {
		let capturedCmd: string[] = [];
		const deps = makeDeps({
			exec: async (cmd) => {
				capturedCmd = cmd;
				return { exitCode: 0, stdout: SAMPLE_DIFF, stderr: '' };
			},
		});
		await checkRequirements(
			makeOpts({ worktreePath: '/tmp/wt-99', baseBranch: 'develop' }),
			deps,
		);
		expect(capturedCmd).toContain('-C');
		expect(capturedCmd).toContain('/tmp/wt-99');
		expect(capturedCmd).toContain('develop...HEAD');
	});

	test('uses config.models.assess for the LLM call', async () => {
		let capturedModel = '';
		const deps = makeDeps({
			runClaude: async (opts) => {
				capturedModel = opts.model;
				return { ok: true, output: makeSatisfiedResponse() };
			},
		});
		await checkRequirements(makeOpts(), deps);
		expect(capturedModel).toBe('haiku');
	});

	test('handles JSON embedded in markdown code fence', async () => {
		const wrappedResponse = '```json\n' + makeSatisfiedResponse() + '\n```';
		const deps = makeDeps({
			runClaude: async () => ({ ok: true, output: wrappedResponse }),
		});
		const result = await checkRequirements(makeOpts(), deps);
		expect(result.ok).toBe(true);
		expect(result.criteria).toHaveLength(2);
	});
});
