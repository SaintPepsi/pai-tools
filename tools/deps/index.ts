/**
 * CLI entry point for the deps (issue dependency management) tool.
 *
 * Routes subcommands to handler functions and wires up default deps via
 * GitHubRelationshipService. All handlers accept DepsHandlerDeps for testability.
 *
 * USAGE:
 *   pait deps <subcommand> [flags]
 *
 * SUBCOMMANDS:
 *   add        Add a dependency relationship between issues
 *   remove     Remove a dependency relationship between issues
 *   list       List dependency relationships for an issue
 *   tree       Show the full dependency tree for all open issues
 *   validate   Check for cycles or inconsistencies in the graph
 *   sync       Sync text-based dep mentions to native GitHub relationships
 *
 * EXAMPLES:
 *   pait deps add --issue 12 --blocked-by 10
 *   pait deps list --issue 12
 *   pait deps tree
 *   pait deps validate
 *   pait deps sync --apply
 */

import type { DepsFlags, DepsDeps, IssueRelationships } from 'tools/deps/types.ts';
import { GitHubRelationshipService } from 'tools/deps/service.ts';
import { formatList, formatTree, formatValidation } from 'tools/deps/display.ts';
import { buildDepsGraph, validateGraph, computeTiers } from 'tools/deps/graph.ts';

export { parseDepsFlags } from 'tools/deps/flags.ts';
export type { DepsFlags } from 'tools/deps/types.ts';

// ─── Extended Deps Interface ──────────────────────────────────────────────────

/** Extended deps for handlers that need all-issue access or sync operations. */
export interface DepsHandlerDeps extends DepsDeps {
	/** Fetch relationships for all open issues. */
	getAllRelationships: () => Promise<IssueRelationships[]>;
	/** List all open issues with body text (for sync pattern detection). */
	listIssuesWithBodies: () => Promise<Array<{ number: number; title: string; body: string }>>;
}

// ─── Default Deps ─────────────────────────────────────────────────────────────

async function defaultListIssuesWithBodies(): Promise<Array<{ number: number; title: string; body: string }>> {
	const proc = Bun.spawn(
		['gh', 'issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,body'],
		{ stdout: 'pipe', stderr: 'pipe' },
	);
	const output = await new Response(proc.stdout).text();
	await proc.exited;
	return JSON.parse(output) as Array<{ number: number; title: string; body: string }>;
}

function makeDefaultDeps(): DepsHandlerDeps {
	const service = new GitHubRelationshipService();
	return {
		getRelationships: (n) => service.getRelationships(n),
		addBlockedBy: (n, b) => service.addBlockedBy(n, b),
		removeBlockedBy: (n, b) => service.removeBlockedBy(n, b),
		setParent: (n, p) => service.setParent(n, p),
		addSubIssue: (n, s) => service.addSubIssue(n, s),
		removeSubIssue: (n, s) => service.removeSubIssue(n, s),
		getAllRelationships: () => service.getAllRelationships(),
		listIssuesWithBodies: defaultListIssuesWithBodies,
		stdout: (line) => console.log(line),
		stderr: (line) => process.stderr.write(line + '\n'),
	};
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * Add a dependency relationship.
 * Requires --issue and one of: --blocked-by, --blocks, --parent, --child.
 */
export async function handleAdd(flags: DepsFlags, d: DepsHandlerDeps): Promise<void> {
	const { issue, blockedBy, blocks, parent, child } = flags;

	if (issue === null) {
		d.stderr('Error: --issue <N> is required for add');
		process.exit(1);
	}

	if (blockedBy !== null) {
		await d.addBlockedBy(issue, blockedBy);
		d.stdout(`Added: #${issue} is blocked by #${blockedBy}`);
	} else if (blocks !== null) {
		// issue blocks another issue → the other is blocked by issue
		await d.addBlockedBy(blocks, issue);
		d.stdout(`Added: #${issue} blocks #${blocks}`);
	} else if (parent !== null) {
		await d.setParent(issue, parent);
		d.stdout(`Added: #${issue} is a sub-issue of #${parent}`);
	} else if (child !== null) {
		await d.addSubIssue(issue, child);
		d.stdout(`Added: #${child} is a sub-issue of #${issue}`);
	} else {
		d.stderr('Error: specify one of --blocked-by, --blocks, --parent, or --child');
		process.exit(1);
	}
}

/**
 * Remove a dependency relationship.
 * Requires --issue and one of: --blocked-by, --blocks, --parent, --child.
 */
export async function handleRemove(flags: DepsFlags, d: DepsHandlerDeps): Promise<void> {
	const { issue, blockedBy, blocks, parent, child } = flags;

	if (issue === null) {
		d.stderr('Error: --issue <N> is required for remove');
		process.exit(1);
	}

	if (blockedBy !== null) {
		await d.removeBlockedBy(issue, blockedBy);
		d.stdout(`Removed: #${issue} blocked by #${blockedBy}`);
	} else if (blocks !== null) {
		await d.removeBlockedBy(blocks, issue);
		d.stdout(`Removed: #${issue} blocks #${blocks}`);
	} else if (parent !== null) {
		await d.setParent(issue, null);
		d.stdout(`Removed: parent of #${issue}`);
	} else if (child !== null) {
		await d.removeSubIssue(issue, child);
		d.stdout(`Removed: #${child} as sub-issue of #${issue}`);
	} else {
		d.stderr('Error: specify one of --blocked-by, --blocks, --parent, or --child');
		process.exit(1);
	}
}

/**
 * List dependency relationships for a single issue.
 */
export async function handleList(flags: DepsFlags, d: DepsHandlerDeps): Promise<void> {
	if (flags.issue === null) {
		d.stderr('Error: --issue <N> is required for list');
		process.exit(1);
	}

	const rel = await d.getRelationships(flags.issue);

	if (flags.json) {
		d.stdout(JSON.stringify(rel, null, 2));
	} else {
		d.stdout(formatList(rel));
	}
}

/**
 * Show the full dependency tree across all open issues, grouped into tiers.
 */
export async function handleTree(flags: DepsFlags, d: DepsHandlerDeps): Promise<void> {
	const all = await d.getAllRelationships();
	const graph = buildDepsGraph(all);
	const tiers = computeTiers(graph);
	const issueMap = new Map(all.map(r => [r.number, r]));

	if (flags.json) {
		d.stdout(JSON.stringify({ tiers, issues: all }, null, 2));
	} else {
		d.stdout(formatTree(tiers, issueMap));
	}
}

/**
 * Validate the dependency graph for cycles and missing dependencies.
 * Exits with code 1 when the graph is invalid.
 */
export async function handleValidate(flags: DepsFlags, d: DepsHandlerDeps): Promise<void> {
	const all = await d.getAllRelationships();
	const graph = buildDepsGraph(all);
	const validation = validateGraph(graph);

	if (flags.json) {
		d.stdout(JSON.stringify(validation, null, 2));
	} else {
		d.stdout(formatValidation(validation));
	}

	if (!validation.valid) {
		process.exit(1);
	}
}

// ─── Sync: Text Pattern Detection ────────────────────────────────────────────

const DEP_PATTERNS = [
	/depends\s+on\s+#(\d+)/gi,
	/blocked\s+by\s+#(\d+)/gi,
	/requires\s+#(\d+)/gi,
];

function parseTextDeps(body: string): number[] {
	const found = new Set<number>();
	for (const pattern of DEP_PATTERNS) {
		for (const match of body.matchAll(pattern)) {
			found.add(parseInt(match[1], 10));
		}
	}
	return [...found];
}

/**
 * Sync text-based dependency mentions in issue bodies to native GitHub relationships.
 * Scans open issue bodies for "Depends on #N", "Blocked by #N", "Requires #N" and
 * creates any missing native relationships. Dry-runs unless --apply is set.
 */
export async function handleSync(flags: DepsFlags, d: DepsHandlerDeps): Promise<void> {
	const [issues, nativeRels] = await Promise.all([
		d.listIssuesWithBodies(),
		d.getAllRelationships(),
	]);

	// Map issue number → set of native blockers
	const nativeBlockers = new Map<number, Set<number>>();
	for (const rel of nativeRels) {
		nativeBlockers.set(rel.number, new Set(rel.blockedBy));
	}

	// Find text-based deps not yet recorded as native relationships
	const toAdd: Array<{ issue: number; blockedBy: number }> = [];
	for (const issue of issues) {
		const textDeps = parseTextDeps(issue.body);
		const existingNative = nativeBlockers.get(issue.number) ?? new Set();
		for (const dep of textDeps) {
			if (!existingNative.has(dep)) {
				toAdd.push({ issue: issue.number, blockedBy: dep });
			}
		}
	}

	if (toAdd.length === 0) {
		d.stdout('All text-based dependencies are already synced to native relationships.');
		return;
	}

	d.stdout(`Found ${toAdd.length} relationship(s) to sync:`);
	for (const { issue, blockedBy } of toAdd) {
		d.stdout(`  #${issue} blocked by #${blockedBy}`);
	}

	if (!flags.apply) {
		d.stdout('\nRun with --apply to create these relationships.');
		return;
	}

	d.stdout('\nApplying...');
	for (const { issue, blockedBy } of toAdd) {
		await d.addBlockedBy(issue, blockedBy);
		d.stdout(`  Added: #${issue} blocked by #${blockedBy}`);
	}
	d.stdout(`Synced ${toAdd.length} relationship(s).`);
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function deps(flags: DepsFlags, d: DepsHandlerDeps = makeDefaultDeps()): Promise<void> {
	switch (flags.subcommand) {
		case 'add':
			await handleAdd(flags, d);
			break;
		case 'remove':
			await handleRemove(flags, d);
			break;
		case 'list':
			await handleList(flags, d);
			break;
		case 'tree':
			await handleTree(flags, d);
			break;
		case 'validate':
			await handleValidate(flags, d);
			break;
		case 'sync':
			await handleSync(flags, d);
			break;
		default:
			d.stderr('Error: specify a subcommand: add | remove | list | tree | validate | sync');
			d.stderr('Run `pait deps --help` for usage.');
			process.exit(1);
	}
}
