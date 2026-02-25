import { describe, test, expect, mock } from 'bun:test';
import { CONSOLIDATION_PROMPT } from './tier3.ts';
import type { Tier3Result } from './types.ts';

// ─── CONSOLIDATION_PROMPT sanity checks ───────────────────────────────────

describe('CONSOLIDATION_PROMPT', () => {
	test('prompt requests JSON output with required fields', () => {
		expect(CONSOLIDATION_PROMPT).toContain('"consolidatedIssues"');
		expect(CONSOLIDATION_PROMPT).toContain('"dependencies"');
		expect(CONSOLIDATION_PROMPT).toContain('"summary"');
	});

	test('prompt includes shared extraction instruction', () => {
		expect(CONSOLIDATION_PROMPT).toContain('Shared extractions');
	});

	test('prompt mentions test file dependency rule', () => {
		expect(CONSOLIDATION_PROMPT).toContain('Test file splits depend on');
	});

	test('prompt instructs no markdown code fences', () => {
		expect(CONSOLIDATION_PROMPT).toContain('no markdown, no code fences');
	});
});

// ─── Tier3Result shape validation ─────────────────────────────────────────

describe('Tier3Result shape', () => {
	test('empty result is valid', () => {
		const result: Tier3Result = {
			consolidatedIssues: [],
			dependencies: [],
			summary: 'No cross-file patterns found.',
		};
		expect(result.consolidatedIssues).toHaveLength(0);
		expect(result.dependencies).toHaveLength(0);
		expect(typeof result.summary).toBe('string');
	});

	test('consolidated issue has required fields', () => {
		const result: Tier3Result = {
			consolidatedIssues: [
				{
					title: 'refactor: extract shared state persistence module',
					body: 'Both orchestrator.ts and finalize.ts implement JSON state handling.',
					files: ['tools/orchestrator/orchestrator.ts', 'tools/finalize/finalize.ts'],
					supersedes: ['tools/orchestrator/orchestrator.ts'],
				},
			],
			dependencies: [],
			summary: 'State persistence duplicated across tools.',
		};
		const ci = result.consolidatedIssues[0];
		expect(ci.title).toBeTruthy();
		expect(ci.body).toBeTruthy();
		expect(ci.files).toHaveLength(2);
		expect(ci.supersedes).toHaveLength(1);
	});

	test('dependency has required fields', () => {
		const result: Tier3Result = {
			consolidatedIssues: [],
			dependencies: [
				{
					prerequisite: 'tools/orchestrator/orchestrator.ts',
					dependent: 'tools/orchestrator/orchestrator.test.ts',
					reason: 'test file depends on source file split being complete first',
				},
			],
			summary: 'Found test-source dependency.',
		};
		const dep = result.dependencies[0];
		expect(dep.prerequisite).toBeTruthy();
		expect(dep.dependent).toBeTruthy();
		expect(dep.reason).toBeTruthy();
	});
});

// ─── JSON parsing resilience ───────────────────────────────────────────────

describe('Tier3 JSON parsing', () => {
	test('round-trips valid Tier3Result through JSON', () => {
		const original: Tier3Result = {
			consolidatedIssues: [
				{
					title: 'refactor: extract logging module',
					body: 'Both files log with the same pattern.',
					files: ['a.ts', 'b.ts'],
					supersedes: [],
				},
			],
			dependencies: [
				{
					prerequisite: 'a.ts',
					dependent: 'a.test.ts',
					reason: 'test depends on source',
				},
			],
			summary: 'Logging pattern duplicated.',
		};

		const roundTripped = JSON.parse(JSON.stringify(original)) as Tier3Result;
		expect(roundTripped.consolidatedIssues).toHaveLength(1);
		expect(roundTripped.dependencies).toHaveLength(1);
		expect(roundTripped.summary).toBe(original.summary);
	});

	test('extracting JSON from response with surrounding text', () => {
		// Simulate the regex extraction used in consolidateTier3
		const response = `Here is my analysis:\n\n${JSON.stringify({
			consolidatedIssues: [],
			dependencies: [],
			summary: 'No patterns.',
		})}\n\nThank you.`;

		const jsonMatch = response.match(/\{[\s\S]*\}/);
		expect(jsonMatch).not.toBeNull();

		const parsed = JSON.parse(jsonMatch![0]) as Tier3Result;
		expect(parsed.summary).toBe('No patterns.');
	});
});
