import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { RunLogger } from './logging.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('RunLogger', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'pai-log-test-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('creates log file in .pait/logs/', () => {
		const logger = new RunLogger(tempDir);
		expect(logger.path).toContain('.pait/logs/');
		expect(logger.path).toEndWith('.jsonl');
	});

	test('runStart writes valid JSONL event', () => {
		const logger = new RunLogger(tempDir);
		logger.runStart({ mode: 'test' });

		const content = readFileSync(logger.path, 'utf-8').trim();
		const event = JSON.parse(content);
		expect(event.event).toBe('run_start');
		expect(event.timestamp).toBeTruthy();
		expect(event.metadata).toEqual({ mode: 'test' });
	});

	test('multiple events produce multiple lines', () => {
		const logger = new RunLogger(tempDir);
		logger.runStart({ mode: 'test' });
		logger.issueStart(42, 'Test issue', 'feat/42-test', 'main');
		logger.agentOutput(42, 'some output');
		logger.verifyPass(42, 'typecheck');
		logger.issueComplete(42, 100, 5000);
		logger.runComplete({});

		const lines = readFileSync(logger.path, 'utf-8').trim().split('\n');
		expect(lines.length).toBe(6);

		// Each line is valid JSON
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}

		// Verify event types
		const events = lines.map(l => JSON.parse(l));
		expect(events[0].event).toBe('run_start');
		expect(events[1].event).toBe('issue_start');
		expect(events[1].issueNumber).toBe(42);
		expect(events[1].branch).toBe('feat/42-test');
		expect(events[2].event).toBe('agent_output');
		expect(events[2].output).toBe('some output');
		expect(events[3].event).toBe('verify_pass');
		expect(events[3].verifyStep).toBe('typecheck');
		expect(events[4].event).toBe('issue_complete');
		expect(events[4].prNumber).toBe(100);
		expect(events[4].durationMs).toBe(5000);
		expect(events[5].event).toBe('run_complete');
	});

	test('issueFailed logs error', () => {
		const logger = new RunLogger(tempDir);
		logger.issueFailed(7, 'build broke');

		const event = JSON.parse(readFileSync(logger.path, 'utf-8').trim());
		expect(event.event).toBe('issue_failed');
		expect(event.issueNumber).toBe(7);
		expect(event.error).toBe('build broke');
	});

	test('verifyFail logs step and error', () => {
		const logger = new RunLogger(tempDir);
		logger.verifyFail(3, 'lint', 'eslint found 5 errors');

		const event = JSON.parse(readFileSync(logger.path, 'utf-8').trim());
		expect(event.event).toBe('verify_fail');
		expect(event.verifyStep).toBe('lint');
		expect(event.error).toBe('eslint found 5 errors');
	});

	test('worktree events log path and branch', () => {
		const logger = new RunLogger(tempDir);
		logger.worktreeCreated(1, '/tmp/wt-1', 'feat/1-test');
		logger.worktreeRemoved(1, '/tmp/wt-1');

		const lines = readFileSync(logger.path, 'utf-8').trim().split('\n');
		const created = JSON.parse(lines[0]);
		const removed = JSON.parse(lines[1]);

		expect(created.event).toBe('worktree_created');
		expect(created.worktreePath).toBe('/tmp/wt-1');
		expect(created.branch).toBe('feat/1-test');
		expect(removed.event).toBe('worktree_removed');
	});

	test('issueSplit logs sub-issues in metadata', () => {
		const logger = new RunLogger(tempDir);
		logger.issueSplit(5, [10, 11, 12]);

		const event = JSON.parse(readFileSync(logger.path, 'utf-8').trim());
		expect(event.event).toBe('issue_split');
		expect(event.metadata.subIssues).toEqual([10, 11, 12]);
	});
});
