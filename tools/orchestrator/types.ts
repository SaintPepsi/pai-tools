/**
 * All TypeScript interfaces for the issue orchestrator.
 */

export interface GitHubIssue {
	number: number;
	title: string;
	body: string;
	state: string;
	labels: { name: string }[];
}

export interface DependencyNode {
	issue: GitHubIssue;
	dependsOn: number[];
	branch: string;
}

export type IssueStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'split';

export interface IssueState {
	number: number;
	title: string | null;
	status: IssueStatus;
	branch: string | null;
	baseBranch: string | null;
	prNumber: number | null;
	error: string | null;
	completedAt: string | null;
	subIssues: number[] | null;
}

export interface OrchestratorState {
	version: 1;
	startedAt: string;
	updatedAt: string;
	issues: Record<number, IssueState>;
}

export interface VerifyCommand {
	name: string;
	cmd: string;
}

export interface E2EConfig {
	run: string;
	update: string;
	snapshotGlob: string;
}

export interface OrchestratorConfig {
	branchPrefix: string;
	baseBranch: string;
	worktreeDir: string;
	models: {
		implement: string;
		assess: string;
	};
	retries: {
		implement: number;
		verify: number;
	};
	allowedTools: string;
	verify: VerifyCommand[];
	e2e?: E2EConfig;
}

export interface OrchestratorFlags {
	dryRun: boolean;
	reset: boolean;
	statusOnly: boolean;
	skipE2e: boolean;
	skipSplit: boolean;
	noVerify: boolean;
	singleMode: boolean;
	singleIssue: number | null;
	fromIssue: number | null;
}
