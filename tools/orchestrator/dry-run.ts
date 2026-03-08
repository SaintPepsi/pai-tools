/**
 * Orchestrator dry-run mode — previews execution plan without making changes.
 *
 * Assesses each issue for split decisions and prints a summary of what would happen.
 */

import { log } from '@shared/log.ts';
import { assessIssueSize } from '@tools/orchestrator/agent-runner.ts';
import type {
	DependencyNode,
	OrchestratorState,
	OrchestratorConfig,
	OrchestratorFlags
} from '@tools/orchestrator/types.ts';

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface DryRunDeps {
	log: typeof log;
	consolelog: (...args: unknown[]) => void;
	exit: (code: number) => never;
	assessIssueSize: typeof assessIssueSize;
}

export const defaultDryRunDeps: DryRunDeps = {
	log,
	consolelog: console.log,
	exit: process.exit as (code: number) => never,
	assessIssueSize,
};

export async function runDryRun(
	executionOrder: number[],
	graph: Map<number, DependencyNode>,
	state: OrchestratorState,
	config: OrchestratorConfig,
	flags: OrchestratorFlags,
	repoRoot: string,
	deps: DryRunDeps = defaultDryRunDeps
): Promise<void> {
	let startIdx = 0;
	let endIdx = executionOrder.length;

	if (flags.singleMode) {
		if (flags.singleIssue !== null) {
			startIdx = executionOrder.indexOf(flags.singleIssue);
			if (startIdx === -1) {
				deps.log.error(`Issue #${flags.singleIssue} not found in execution order`);
				deps.exit(1);
			}
		} else {
			for (let i = 0; i < executionOrder.length; i++) {
				const issueState = state.issues[executionOrder[i]];
				if (!issueState || issueState.status !== 'completed') {
					startIdx = i;
					break;
				}
			}
		}
		endIdx = startIdx + 1;
	}

	deps.log.step('DRY RUN — FULL PATH ASSESSMENT');
	deps.log.info(
		flags.singleMode
			? `Assessing issue #${executionOrder[startIdx]} only`
			: `Assessing all ${executionOrder.length} issues for split decisions...`
	);

	let splitCount = 0;
	let directCount = 0;

	for (let i = startIdx; i < endIdx; i++) {
		const issueNum = executionOrder[i];
		const node = graph.get(issueNum);
		if (!node) continue;

		const issueState = state.issues[issueNum];
		if (issueState?.status === 'completed') {
			deps.log.dim(`  ✓ #${issueNum} ${node.issue.title} — already completed`);
			continue;
		}

		const depBranches =
			node.dependsOn.length > 0
				? node.dependsOn.map((d: number) => `#${d}`).join(', ')
				: config.baseBranch;

		deps.consolelog('');
		deps.log.info(`#${issueNum} ${node.issue.title}`);
		deps.log.dim(`  Branch: ${node.branch}`);
		deps.log.dim(`  Base: ${depBranches}`);
		deps.log.dim(`  Position: ${i + 1}/${executionOrder.length}`);

		if (!flags.skipSplit) {
			deps.log.dim('  Assessing size...');
			const assessment = await deps.assessIssueSize(node.issue, config, repoRoot);
			if (assessment.shouldSplit) {
				splitCount++;
				deps.log.warn(`  WOULD SPLIT into ${assessment.proposedSplits.length} sub-issues:`);
				deps.log.dim(`  Reason: ${assessment.reasoning}`);
				for (const split of assessment.proposedSplits) {
					deps.log.dim(`    → ${split.title}`);
				}
			} else {
				directCount++;
				deps.log.ok('  Direct implementation (no split needed)');
				deps.log.dim(`  Reason: ${assessment.reasoning}`);
			}
		} else {
			directCount++;
			deps.log.dim('  Split assessment skipped (--skip-split)');
		}

		const verifySteps = config.verify.map((v) => v.name).join(' → ');
		const e2eLabel = config.e2e && !flags.skipE2e ? ' → e2e' : '';
		deps.log.dim(`  Verify: ${verifySteps || '(none configured)'}${e2eLabel}`);
	}

	deps.consolelog('');
	deps.log.step('DRY RUN SUMMARY');
	deps.consolelog(`  Total issues: ${endIdx - startIdx}`);
	deps.consolelog(`  Direct implementation: ${directCount}`);
	deps.consolelog(`  Would be split: ${splitCount}`);
	const verifyNames = config.verify.map((v) => v.name).join(' + ');
	const e2eLabel = config.e2e && !flags.skipE2e ? ' + e2e' : '';
	deps.consolelog(`  Verification: ${verifyNames || '(none)'}${e2eLabel}`);
	deps.log.info('Dry run complete. No changes made.');
}
