/**
 * Types for the finalize (PR merge) tool.
 */

export type MergeStrategy = 'squash' | 'merge' | 'rebase';

export type PRStatus = 'pending' | 'merged' | 'failed' | 'conflict' | 'skipped';

export interface FinalizeFlags {
	dryRun: boolean;
	single: boolean;
	noVerify: boolean;
	strategy: MergeStrategy;
	from: number | null;
	autoResolve: boolean;
	help: boolean;
}

export interface PRMergeState {
	issueNumber: number;
	prNumber: number;
	branch: string;
	baseBranch: string;
	status: PRStatus;
	mergedAt: string | null;
	error: string | null;
}

export interface FinalizeState {
	version: 1;
	startedAt: string;
	updatedAt: string;
	prs: Record<number, PRMergeState>;
}

export interface ConflictInfo {
	file: string;
}

export interface MergeOrder {
	issueNumber: number;
	prNumber: number;
	branch: string;
	baseBranch: string;
}
