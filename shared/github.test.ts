import { describe, test, expect, beforeAll } from 'bun:test';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module export verification
// ---------------------------------------------------------------------------

describe('shared/github.ts exports', () => {
	let source!: string;

	beforeAll(async () => {
		source = await Bun.file(join(import.meta.dir, 'github.ts')).text();
	});

	test('exports fetchOpenIssues', () => {
		expect(source).toContain('export async function fetchOpenIssues');
	});

	test('exports createSubIssues', () => {
		expect(source).toContain('export async function createSubIssues');
	});

	test('exports createPR', () => {
		expect(source).toContain('export async function createPR');
	});

	test('exports discoverMergeablePRs', () => {
		expect(source).toContain('export async function discoverMergeablePRs');
	});

	test('exports mergePR', () => {
		expect(source).toContain('export async function mergePR');
	});

	test('exports GitHubIssue type', () => {
		expect(source).toContain('export interface GitHubIssue');
	});

	test('exports MergeOrder type', () => {
		expect(source).toContain('export interface MergeOrder');
	});

	test('exports MergeStrategy type', () => {
		expect(source).toContain("export type MergeStrategy");
	});
});

// ---------------------------------------------------------------------------
// Source guard: orchestrator imports from shared
// ---------------------------------------------------------------------------

// Matches either the path alias (@shared/github) or any path ending in shared/github[.ts]
const githubImportPattern = /from ['"](?:@shared\/github|[^'"]*shared\/github(?:\.ts)?)['"]/;

describe('orchestrator imports from shared/github.ts', () => {
	let indexSource!: string;
	let executionSource!: string;

	beforeAll(async () => {
		indexSource = await Bun.file(join(import.meta.dir, '../tools/orchestrator/index.ts')).text();
		executionSource = await Bun.file(join(import.meta.dir, '../tools/orchestrator/execution.ts')).text();
	});

	test('imports fetchOpenIssues from shared/github.ts', () => {
		expect(indexSource).toMatch(githubImportPattern);
		expect(indexSource).toContain('fetchOpenIssues');
	});

	test('imports createSubIssues from shared/github.ts', () => {
		expect(executionSource).toMatch(githubImportPattern);
		expect(executionSource).toContain('createSubIssues');
	});

	test('imports createPR from shared/github.ts', () => {
		expect(executionSource).toMatch(githubImportPattern);
		expect(executionSource).toContain('createPR');
	});

	test('does not define fetchOpenIssues locally', () => {
		expect(indexSource).not.toContain('async function fetchOpenIssues');
		expect(executionSource).not.toContain('async function fetchOpenIssues');
	});

	test('does not define createSubIssues locally', () => {
		expect(indexSource).not.toContain('async function createSubIssues');
		expect(executionSource).not.toContain('async function createSubIssues');
	});

	test('does not define createPR locally', () => {
		expect(indexSource).not.toContain('async function createPR');
		expect(executionSource).not.toContain('async function createPR');
	});
});

// ---------------------------------------------------------------------------
// Source guard: finalize imports from shared
// ---------------------------------------------------------------------------

describe('finalize imports from shared/github.ts', () => {
	let source!: string;

	beforeAll(async () => {
		source = await Bun.file(join(import.meta.dir, '../tools/finalize/index.ts')).text();
	});

	test('imports discoverMergeablePRs from shared/github.ts', () => {
		expect(source).toMatch(githubImportPattern);
		expect(source).toContain('discoverMergeablePRs');
	});

	test('imports mergePR from shared/github.ts', () => {
		expect(source).toContain('mergePR');
	});

	test('does not define discoverMergeablePRs locally', () => {
		expect(source).not.toContain('async function discoverMergeablePRs');
	});

	test('does not define mergePR locally', () => {
		expect(source).not.toContain('async function mergePR');
	});
});

// ---------------------------------------------------------------------------
// Source guard: no gh CLI duplication in tool files
// ---------------------------------------------------------------------------

describe('no duplicated gh CLI operations in tool-specific files', () => {
	test('orchestrator has no gh issue list command', async () => {
		for (const file of ['index.ts', 'execution.ts', 'dry-run.ts', 'state-helpers.ts']) {
			const src = await Bun.file(join(import.meta.dir, `../tools/orchestrator/${file}`)).text();
			expect(src).not.toContain('gh issue list');
		}
	});

	test('orchestrator has no gh issue create command', async () => {
		for (const file of ['index.ts', 'execution.ts', 'dry-run.ts', 'state-helpers.ts']) {
			const src = await Bun.file(join(import.meta.dir, `../tools/orchestrator/${file}`)).text();
			expect(src).not.toContain('gh issue create');
		}
	});

	test('orchestrator has no gh pr create command', async () => {
		for (const file of ['index.ts', 'execution.ts', 'dry-run.ts', 'state-helpers.ts']) {
			const src = await Bun.file(join(import.meta.dir, `../tools/orchestrator/${file}`)).text();
			expect(src).not.toContain('gh pr create');
		}
	});

	test('finalize has no gh pr view command locally', async () => {
		const src = await Bun.file(join(import.meta.dir, '../tools/finalize/index.ts')).text();
		expect(src).not.toContain('gh pr view');
	});

	test('finalize has no gh pr merge command locally', async () => {
		const src = await Bun.file(join(import.meta.dir, '../tools/finalize/index.ts')).text();
		expect(src).not.toContain('gh pr merge');
	});
});
