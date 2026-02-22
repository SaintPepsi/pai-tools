/**
 * Structured JSONL logging for orchestrator runs.
 *
 * Each run gets a timestamped log file in `.pait/logs/`.
 * Events are appended as one JSON object per line (JSONL).
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type LogEventType =
	| 'run_start'
	| 'run_complete'
	| 'issue_start'
	| 'issue_split'
	| 'issue_complete'
	| 'issue_failed'
	| 'agent_output'
	| 'verify_pass'
	| 'verify_fail'
	| 'branch_created'
	| 'worktree_created'
	| 'worktree_removed'
	| 'pr_created';

export interface LogEvent {
	timestamp: string;
	event: LogEventType;
	issueNumber?: number;
	issueTitle?: string;
	branch?: string;
	worktreePath?: string;
	baseBranch?: string;
	prNumber?: number;
	verifyStep?: string;
	output?: string;
	error?: string;
	durationMs?: number;
	metadata?: Record<string, unknown>;
}

export class RunLogger {
	private logPath: string;

	constructor(repoRoot: string) {
		const logsDir = join(repoRoot, '.pait', 'logs');
		if (!existsSync(logsDir)) {
			mkdirSync(logsDir, { recursive: true });
		}

		const now = new Date();
		const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
		this.logPath = join(logsDir, `${ts}.jsonl`);
	}

	log(event: LogEvent): void {
		const line = JSON.stringify({ ...event, timestamp: event.timestamp || new Date().toISOString() });
		appendFileSync(this.logPath, line + '\n');
	}

	get path(): string {
		return this.logPath;
	}

	runStart(metadata?: Record<string, unknown>): void {
		this.log({ timestamp: new Date().toISOString(), event: 'run_start', metadata });
	}

	runComplete(metadata?: Record<string, unknown>): void {
		this.log({ timestamp: new Date().toISOString(), event: 'run_complete', metadata });
	}

	issueStart(issueNumber: number, issueTitle: string, branch: string, baseBranch: string): void {
		this.log({
			timestamp: new Date().toISOString(),
			event: 'issue_start',
			issueNumber,
			issueTitle,
			branch,
			baseBranch
		});
	}

	issueComplete(issueNumber: number, prNumber?: number, durationMs?: number): void {
		this.log({
			timestamp: new Date().toISOString(),
			event: 'issue_complete',
			issueNumber,
			prNumber,
			durationMs
		});
	}

	issueFailed(issueNumber: number, error: string): void {
		this.log({
			timestamp: new Date().toISOString(),
			event: 'issue_failed',
			issueNumber,
			error
		});
	}

	issueSplit(issueNumber: number, subIssues: number[]): void {
		this.log({
			timestamp: new Date().toISOString(),
			event: 'issue_split',
			issueNumber,
			metadata: { subIssues }
		});
	}

	agentOutput(issueNumber: number, output: string): void {
		this.log({
			timestamp: new Date().toISOString(),
			event: 'agent_output',
			issueNumber,
			output
		});
	}

	verifyPass(issueNumber: number, verifyStep: string): void {
		this.log({
			timestamp: new Date().toISOString(),
			event: 'verify_pass',
			issueNumber,
			verifyStep
		});
	}

	verifyFail(issueNumber: number, verifyStep: string, error: string): void {
		this.log({
			timestamp: new Date().toISOString(),
			event: 'verify_fail',
			issueNumber,
			verifyStep,
			error
		});
	}

	worktreeCreated(issueNumber: number, worktreePath: string, branch: string): void {
		this.log({
			timestamp: new Date().toISOString(),
			event: 'worktree_created',
			issueNumber,
			worktreePath,
			branch
		});
	}

	worktreeRemoved(issueNumber: number, worktreePath: string): void {
		this.log({
			timestamp: new Date().toISOString(),
			event: 'worktree_removed',
			issueNumber,
			worktreePath
		});
	}

	branchCreated(issueNumber: number, branch: string, baseBranch: string): void {
		this.log({
			timestamp: new Date().toISOString(),
			event: 'branch_created',
			issueNumber,
			branch,
			baseBranch
		});
	}

	prCreated(issueNumber: number, prNumber: number): void {
		this.log({
			timestamp: new Date().toISOString(),
			event: 'pr_created',
			issueNumber,
			prNumber
		});
	}
}
