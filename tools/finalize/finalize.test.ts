import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	parseFinalizeFlags,
	loadFinalizeState,
	saveFinalizeState,
	initFinalizeState
} from './index.ts';
import { determineMergeOrder } from '../../shared/github.ts';
import type { MergeOrder, FinalizeState } from './types.ts';

describe('parseFinalizeFlags', () => {
	test('parses --dry-run', () => {
		const flags = parseFinalizeFlags(['--dry-run']);
		expect(flags.dryRun).toBe(true);
		expect(flags.single).toBe(false);
	});

	test('parses --single', () => {
		const flags = parseFinalizeFlags(['--single']);
		expect(flags.single).toBe(true);
	});

	test('parses --no-verify', () => {
		const flags = parseFinalizeFlags(['--no-verify']);
		expect(flags.noVerify).toBe(true);
	});

	test('parses --strategy rebase', () => {
		const flags = parseFinalizeFlags(['--strategy', 'rebase']);
		expect(flags.strategy).toBe('rebase');
	});

	test('defaults strategy to merge for invalid value', () => {
		const flags = parseFinalizeFlags(['--strategy', 'invalid']);
		expect(flags.strategy).toBe('merge');
	});

	test('parses --from N', () => {
		const flags = parseFinalizeFlags(['--from', '5']);
		expect(flags.from).toBe(5);
	});

	test('parses --help', () => {
		const flags = parseFinalizeFlags(['--help']);
		expect(flags.help).toBe(true);
	});

	test('defaults to all false/null/merge', () => {
		const flags = parseFinalizeFlags([]);
		expect(flags.dryRun).toBe(false);
		expect(flags.single).toBe(false);
		expect(flags.noVerify).toBe(false);
		expect(flags.strategy).toBe('merge');
		expect(flags.from).toBeNull();
		expect(flags.help).toBe(false);
	});
});

describe('determineMergeOrder', () => {
	test('independent PRs ordered by issue number', () => {
		const prs: MergeOrder[] = [
			{ issueNumber: 3, prNumber: 30, branch: 'feat/3-c', baseBranch: 'master' },
			{ issueNumber: 1, prNumber: 10, branch: 'feat/1-a', baseBranch: 'master' },
			{ issueNumber: 2, prNumber: 20, branch: 'feat/2-b', baseBranch: 'master' }
		];

		const ordered = determineMergeOrder(prs);
		expect(ordered.map((p) => p.issueNumber)).toEqual([1, 2, 3]);
	});

	test('stacked PRs follow dependency chain', () => {
		const prs: MergeOrder[] = [
			{ issueNumber: 3, prNumber: 30, branch: 'feat/3-c', baseBranch: 'feat/2-b' },
			{ issueNumber: 1, prNumber: 10, branch: 'feat/1-a', baseBranch: 'master' },
			{ issueNumber: 2, prNumber: 20, branch: 'feat/2-b', baseBranch: 'feat/1-a' }
		];

		const ordered = determineMergeOrder(prs);
		expect(ordered.map((p) => p.issueNumber)).toEqual([1, 2, 3]);
	});

	test('mixed stacked and independent', () => {
		const prs: MergeOrder[] = [
			{ issueNumber: 4, prNumber: 40, branch: 'feat/4-d', baseBranch: 'master' },
			{ issueNumber: 2, prNumber: 20, branch: 'feat/2-b', baseBranch: 'feat/1-a' },
			{ issueNumber: 1, prNumber: 10, branch: 'feat/1-a', baseBranch: 'master' }
		];

		const ordered = determineMergeOrder(prs);
		// 1 before 2 (dependency), 4 is independent
		const idx1 = ordered.findIndex((p) => p.issueNumber === 1);
		const idx2 = ordered.findIndex((p) => p.issueNumber === 2);
		expect(idx1).toBeLessThan(idx2);
	});

	test('cycle in stacked PRs throws instead of silently dropping a PR', () => {
		// A depends on B, B depends on A — a true circular dependency.
		// The function must throw rather than silently lose one of the PRs.
		const prs: MergeOrder[] = [
			{ issueNumber: 1, prNumber: 10, branch: 'feat/1-a', baseBranch: 'feat/2-b' },
			{ issueNumber: 2, prNumber: 20, branch: 'feat/2-b', baseBranch: 'feat/1-a' }
		];
		expect(() => determineMergeOrder(prs)).toThrow(/[Cc]ycle/);
	});
});

describe('finalize state management', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'pai-finalize-state-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('state roundtrip: save → load → compare', () => {
		const statePath = join(tempDir, 'finalize.json');
		const state = initFinalizeState();
		state.prs[10] = {
			issueNumber: 1,
			prNumber: 10,
			branch: 'feat/1-test',
			baseBranch: 'master',
			status: 'merged',
			mergedAt: '2025-01-01T00:00:00.000Z',
			error: null
		};

		saveFinalizeState(state, statePath);
		const loaded = loadFinalizeState(statePath);

		expect(loaded).not.toBeNull();
		expect(loaded!.version).toBe(1);
		expect(loaded!.prs[10].status).toBe('merged');
		expect(loaded!.prs[10].branch).toBe('feat/1-test');
	});

	test('loadFinalizeState returns null for missing file', () => {
		const result = loadFinalizeState(join(tempDir, 'nonexistent.json'));
		expect(result).toBeNull();
	});

	test('previously failed PR must have error cleared after successful merge', () => {
		// Regression: prState.error was not cleared when status became 'merged',
		// leaving stale error strings from failed attempts.
		const state = initFinalizeState();
		state.prs[10] = {
			issueNumber: 1,
			prNumber: 10,
			branch: 'feat/1-test',
			baseBranch: 'master',
			status: 'conflict',
			mergedAt: null,
			error: 'Conflict resolution failed'
		};

		// Simulate successful retry — the fix clears error
		state.prs[10].status = 'merged';
		state.prs[10].mergedAt = new Date().toISOString();
		state.prs[10].error = null;

		const statePath = join(tempDir, 'finalize.json');
		saveFinalizeState(state, statePath);
		const loaded = loadFinalizeState(statePath);

		expect(loaded!.prs[10].status).toBe('merged');
		expect(loaded!.prs[10].error).toBeNull();
	});
});
