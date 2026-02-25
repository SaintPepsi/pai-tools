/**
 * Orchestrator dry-run mode — previews execution plan without making changes.
 *
 * Assesses each issue for split decisions and prints a summary of what would happen.
 */

import { log } from '../../shared/log.ts';
import { assessIssueSize } from './agent-runner.ts';
import type {
	DependencyNode,
	OrchestratorState,
	OrchestratorConfig,
	OrchestratorFlags
} from './types.ts';

export async function runDryRun(
	executionOrder: number[],
	graph: Map<number, DependencyNode>,
	state: OrchestratorState,
	config: OrchestratorConfig,
	flags: OrchestratorFlags,
	repoRoot: string
): Promise<void> {
	let startIdx = 0;
	let endIdx = executionOrder.length;

	if (flags.singleMode) {
		if (flags.singleIssue !== null) {
			startIdx = executionOrder.indexOf(flags.singleIssue);
			if (startIdx === -1) {
				log.error(`Issue #${flags.singleIssue} not found in execution order`);
				process.exit(1);
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

	log.step('DRY RUN — FULL PATH ASSESSMENT');
	log.info(
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
			log.dim(`  ✓ #${issueNum} ${node.issue.title} — already completed`);
			continue;
		}

		const depBranches =
			node.dependsOn.length > 0
				? node.dependsOn.map((d: number) => `#${d}`).join(', ')
				: config.baseBranch;

		console.log('');
		log.info(`#${issueNum} ${node.issue.title}`);
		log.dim(`  Branch: ${node.branch}`);
		log.dim(`  Base: ${depBranches}`);
		log.dim(`  Position: ${i + 1}/${executionOrder.length}`);

		if (!flags.skipSplit) {
			log.dim('  Assessing size...');
			const assessment = await assessIssueSize(node.issue, config, repoRoot);
			if (assessment.shouldSplit) {
				splitCount++;
				log.warn(`  WOULD SPLIT into ${assessment.proposedSplits.length} sub-issues:`);
				log.dim(`  Reason: ${assessment.reasoning}`);
				for (const split of assessment.proposedSplits) {
					log.dim(`    → ${split.title}`);
				}
			} else {
				directCount++;
				log.ok('  Direct implementation (no split needed)');
				log.dim(`  Reason: ${assessment.reasoning}`);
			}
		} else {
			directCount++;
			log.dim('  Split assessment skipped (--skip-split)');
		}

		const verifySteps = config.verify.map((v) => v.name).join(' → ');
		const e2eLabel = config.e2e && !flags.skipE2e ? ' → e2e' : '';
		log.dim(`  Verify: ${verifySteps || '(none configured)'}${e2eLabel}`);
	}

	console.log('');
	log.step('DRY RUN SUMMARY');
	console.log(`  Total issues: ${endIdx - startIdx}`);
	console.log(`  Direct implementation: ${directCount}`);
	console.log(`  Would be split: ${splitCount}`);
	const verifyNames = config.verify.map((v) => v.name).join(' + ');
	const e2eLabel = config.e2e && !flags.skipE2e ? ' + e2e' : '';
	console.log(`  Verification: ${verifyNames || '(none)'}${e2eLabel}`);
	log.info('Dry run complete. No changes made.');
}
