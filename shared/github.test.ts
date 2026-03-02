import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module export verification
// ---------------------------------------------------------------------------

describe('shared/github.ts exports', () => {
	const source = Bun.file(join(import.meta.dir, 'github.ts'));

	test('exports fetchOpenIssues', async () => {
		expect(await source.text()).toContain('export async function fetchOpenIssues');
	});

	test('exports createSubIssues', async () => {
		expect(await source.text()).toContain('export async function createSubIssues');
	});

	test('exports createPR', async () => {
		expect(await source.text()).toContain('export async function createPR');
	});

	test('exports discoverMergeablePRs', async () => {
		expect(await source.text()).toContain('export async function discoverMergeablePRs');
	});

	test('exports mergePR', async () => {
		expect(await source.text()).toContain('export async function mergePR');
	});

	test('exports GitHubIssue type', async () => {
		expect(await source.text()).toContain('export interface GitHubIssue');
	});

	test('exports MergeOrder type', async () => {
		expect(await source.text()).toContain('export interface MergeOrder');
	});

	test('exports MergeStrategy type', async () => {
		expect(await source.text()).toContain("export type MergeStrategy");
	});
});

// ---------------------------------------------------------------------------
// Source guard: orchestrator imports from shared
// ---------------------------------------------------------------------------

describe('orchestrator imports from shared/github.ts', () => {
	const indexSource = Bun.file(join(import.meta.dir, '../tools/orchestrator/index.ts'));
	const executionSource = Bun.file(join(import.meta.dir, '../tools/orchestrator/execution.ts'));

	test('imports fetchOpenIssues from shared/github.ts', async () => {
		const src = await indexSource.text();
		expect(src).toContain("from '../../shared/github.ts'");
		expect(src).toContain('fetchOpenIssues');
	});

	test('imports createSubIssues from shared/github.ts', async () => {
		const src = await executionSource.text();
		expect(src).toContain("from '../../shared/github.ts'");
		expect(src).toContain('createSubIssues');
	});

	test('imports createPR from shared/github.ts', async () => {
		const src = await executionSource.text();
		expect(src).toContain("from '../../shared/github.ts'");
		expect(src).toContain('createPR');
	});

	test('does not define fetchOpenIssues locally', async () => {
		expect(await indexSource.text()).not.toContain('async function fetchOpenIssues');
		expect(await executionSource.text()).not.toContain('async function fetchOpenIssues');
	});

	test('does not define createSubIssues locally', async () => {
		expect(await indexSource.text()).not.toContain('async function createSubIssues');
		expect(await executionSource.text()).not.toContain('async function createSubIssues');
	});

	test('does not define createPR locally', async () => {
		expect(await indexSource.text()).not.toContain('async function createPR');
		expect(await executionSource.text()).not.toContain('async function createPR');
	});
});

// ---------------------------------------------------------------------------
// Source guard: finalize imports from shared
// ---------------------------------------------------------------------------

describe('finalize imports from shared/github.ts', () => {
	const source = Bun.file(join(import.meta.dir, '../tools/finalize/index.ts'));

	test('imports discoverMergeablePRs from shared/github.ts', async () => {
		const src = await source.text();
		expect(src).toContain("from '../../shared/github.ts'");
		expect(src).toContain('discoverMergeablePRs');
	});

	test('imports mergePR from shared/github.ts', async () => {
		expect(await source.text()).toContain('mergePR');
	});

	test('does not define discoverMergeablePRs locally', async () => {
		expect(await source.text()).not.toContain('async function discoverMergeablePRs');
	});

	test('does not define mergePR locally', async () => {
		expect(await source.text()).not.toContain('async function mergePR');
	});
});

// ---------------------------------------------------------------------------
// Source guard: no gh CLI duplication in tool files
// ---------------------------------------------------------------------------

describe('no duplicated gh CLI operations in tool-specific files', () => {
	const orchestratorFiles = ['index.ts', 'execution.ts', 'dry-run.ts', 'state-helpers.ts'];

	test('orchestrator has no gh issue list command', async () => {
		for (const file of orchestratorFiles) {
			const src = await Bun.file(join(import.meta.dir, `../tools/orchestrator/${file}`)).text();
			expect(src).not.toContain('gh issue list');
		}
	});

	test('orchestrator has no gh issue create command', async () => {
		for (const file of orchestratorFiles) {
			const src = await Bun.file(join(import.meta.dir, `../tools/orchestrator/${file}`)).text();
			expect(src).not.toContain('gh issue create');
		}
	});

	test('orchestrator has no gh pr create command', async () => {
		for (const file of orchestratorFiles) {
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
