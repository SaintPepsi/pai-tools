/**
 * Types for the deps (issue dependency management) tool.
 */

// ─── Core Domain Types ───────────────────────────────────────────────────────

/** Minimal reference to a GitHub issue. */
export interface IssueRef {
	number: number;
	title: string;
	state: string;
}

/** Full relationship graph for a single issue. */
export interface IssueRelationships {
	id: number;
	number: number;
	title: string;
	state: string;
	/** Issue numbers this issue is blocked by. */
	blockedBy: number[];
	/** Issue numbers this issue is blocking. */
	blocking: number[];
	/** Parent issue number, if this is a sub-issue. */
	parent: number | null;
	/** Sub-issue numbers owned by this issue. */
	subIssues: number[];
}

// ─── Service Interface ───────────────────────────────────────────────────────

/** CRUD interface for managing issue dependency relationships. */
export interface RelationshipService {
	/** Fetch relationships for a single issue. */
	getRelationships(issueNumber: number): Promise<IssueRelationships>;
	/** Mark issueNumber as blocked by blockerNumber. */
	addBlockedBy(issueNumber: number, blockerNumber: number): Promise<void>;
	/** Remove blocked-by relationship between issueNumber and blockerNumber. */
	removeBlockedBy(issueNumber: number, blockerNumber: number): Promise<void>;
	/** Set the parent issue for a sub-issue (null removes the parent). */
	setParent(issueNumber: number, parentNumber: number | null): Promise<void>;
	/** Add subIssueNumber as a sub-issue of issueNumber. */
	addSubIssue(issueNumber: number, subIssueNumber: number): Promise<void>;
	/** Remove subIssueNumber from issueNumber's sub-issues. */
	removeSubIssue(issueNumber: number, subIssueNumber: number): Promise<void>;
}

// ─── CLI Types ───────────────────────────────────────────────────────────────

/** Valid subcommands for the deps tool. */
export type DepsSubcommand = 'add' | 'remove' | 'list' | 'tree' | 'validate' | 'sync';

/** Parsed CLI flags for the deps tool. */
export interface DepsFlags {
	subcommand: DepsSubcommand | null;
	/** Target issue number (--issue <N>). */
	issue: number | null;
	/** Issue number this issue blocks (--blocks <N>). */
	blocks: number | null;
	/** Issue number this issue is blocked by (--blocked-by <N>). */
	blockedBy: number | null;
	/** Parent issue number (--parent <N>). */
	parent: number | null;
	/** Child/sub-issue number (--child <N>). */
	child: number | null;
	/** Apply pending changes without prompting. */
	apply: boolean;
	/** Output as JSON instead of terminal format. */
	json: boolean;
	help: boolean;
}

// ─── Dependency Injection ────────────────────────────────────────────────────

/** Injected dependencies for the deps tool (for testability). */
export interface DepsDeps {
	/** Fetch relationships for an issue. */
	getRelationships: RelationshipService['getRelationships'];
	/** Add a blocked-by relationship. */
	addBlockedBy: RelationshipService['addBlockedBy'];
	/** Remove a blocked-by relationship. */
	removeBlockedBy: RelationshipService['removeBlockedBy'];
	/** Set the parent of an issue. */
	setParent: RelationshipService['setParent'];
	/** Add a sub-issue relationship. */
	addSubIssue: RelationshipService['addSubIssue'];
	/** Remove a sub-issue relationship. */
	removeSubIssue: RelationshipService['removeSubIssue'];
	/** Write a line to stdout. */
	stdout: (line: string) => void;
	/** Write a line to stderr. */
	stderr: (line: string) => void;
}
