/**
 * Tests for agent-runner.ts — Claude agent invocations for the orchestrator.
 *
 * buildImplementationPrompt is a pure string-building function and is fully
 * unit-testable. fixVerificationFailure and implementIssue invoke the Claude
 * CLI and are not tested here (they require a live agent).
 */

import { describe, test, expect } from 'bun:test';
import { buildImplementationPrompt } from './agent-runner.ts';
import type { OrchestratorConfig, GitHubIssue } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(number: number, title: string, body: string): GitHubIssue {
	return { number, title, body, state: 'open', labels: [] };
}

const minimalConfig: OrchestratorConfig = {
	branchPrefix: 'feat/',
	baseBranch: 'main',
	worktreeDir: '.pait/worktrees',
	models: { implement: 'sonnet', assess: 'haiku' },
	retries: { implement: 1, verify: 1 },
	allowedTools: 'Bash Edit Write Read',
	verify: []
};

// ---------------------------------------------------------------------------
// buildImplementationPrompt
// ---------------------------------------------------------------------------

describe('buildImplementationPrompt', () => {
	test('includes issue number and title', () => {
		const issue = makeIssue(42, 'Add logging middleware', 'Log all requests.');
		const prompt = buildImplementationPrompt(issue, 'feat/42-add-logging', 'main', minimalConfig, '/repo');

		expect(prompt).toContain('#42');
		expect(prompt).toContain('Add logging middleware');
	});

	test('includes full issue body', () => {
		const body = 'This feature should log every incoming HTTP request including headers.';
		const issue = makeIssue(10, 'Request logging', body);
		const prompt = buildImplementationPrompt(issue, 'feat/10-request-logging', 'main', minimalConfig, '/repo');

		expect(prompt).toContain(body);
	});

	test('includes branch name', () => {
		const issue = makeIssue(7, 'Fix cache', '');
		const prompt = buildImplementationPrompt(issue, 'feat/7-fix-cache', 'main', minimalConfig, '/repo');

		expect(prompt).toContain('feat/7-fix-cache');
	});

	test('includes base branch', () => {
		const issue = makeIssue(5, 'Feature', '');
		const prompt = buildImplementationPrompt(issue, 'feat/5-feature', 'feat/3-depends-on', minimalConfig, '/repo');

		expect(prompt).toContain('feat/3-depends-on');
	});

	test('includes project root path', () => {
		const issue = makeIssue(1, 'Init', '');
		const prompt = buildImplementationPrompt(issue, 'feat/1-init', 'main', minimalConfig, '/home/user/myproject');

		expect(prompt).toContain('/home/user/myproject');
	});

	test('lists verify commands when configured', () => {
		const config: OrchestratorConfig = {
			...minimalConfig,
			verify: [
				{ name: 'test', cmd: 'bun test' },
				{ name: 'typecheck', cmd: 'bun run typecheck' }
			]
		};
		const issue = makeIssue(3, 'Add tests', '');
		const prompt = buildImplementationPrompt(issue, 'feat/3-add-tests', 'main', config, '/repo');

		expect(prompt).toContain('bun test');
		expect(prompt).toContain('bun run typecheck');
	});

	test('shows placeholder when no verify commands configured', () => {
		const issue = makeIssue(2, 'Quick fix', '');
		const prompt = buildImplementationPrompt(issue, 'feat/2-quick-fix', 'main', minimalConfig, '/repo');

		expect(prompt).toContain('(no verification commands configured)');
	});

	test('instructs agent not to create a pull request', () => {
		const issue = makeIssue(99, 'Some work', '');
		const prompt = buildImplementationPrompt(issue, 'feat/99-some-work', 'main', minimalConfig, '/repo');

		expect(prompt).toContain('Do NOT create a pull request');
	});

	test('references issue number in commit instruction', () => {
		const issue = makeIssue(55, 'Critical fix', '');
		const prompt = buildImplementationPrompt(issue, 'feat/55-critical-fix', 'main', minimalConfig, '/repo');

		expect(prompt).toContain('#55');
	});

	test('instructs agent to read CLAUDE.md first', () => {
		const issue = makeIssue(8, 'New feature', '');
		const prompt = buildImplementationPrompt(issue, 'feat/8-new-feature', 'main', minimalConfig, '/repo');

		expect(prompt).toContain('CLAUDE.md');
	});

	test('returns a string', () => {
		const issue = makeIssue(1, 'Test', 'body');
		const result = buildImplementationPrompt(issue, 'feat/1-test', 'main', minimalConfig, '/repo');

		expect(typeof result).toBe('string');
		expect(result.length).toBeGreaterThan(100);
	});
});
