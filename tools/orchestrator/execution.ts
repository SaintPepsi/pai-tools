/**
 * Orchestrator execution loop — implements issues sequentially via Claude agents.
 *
 * Contains the main orchestration loop (runMainLoop) and the PR body builder.
 * Extracted from index.ts to keep the entry point focused on config and routing.
 */

import { log } from '../../shared/log.ts';
import { saveState } from '../../shared/state.ts';
import { createWorktree, removeWorktree } from '../../shared/git.ts';
import { fetchOpenIssues, createSubIssues, createPR } from '../../shared/github.ts';
import { buildGraph, topologicalSort } from './dependency-graph.ts';
import { runVerify } from '../verify/index.ts';
import { assessIssueSize, implementIssue, fixVerificationFailure } from './agent-runner.ts';
import { printExecutionPlan, printStatus } from './display.ts';
import { getIssueState } from './state-helpers.ts';
import { withRetries } from './retry.ts';
import type {
	GitHubIssue,
	DependencyNode,
	OrchestratorState,
	OrchestratorConfig,
	OrchestratorFlags
} from './types.ts';
import type { RunLogger } from '../../shared/logging.ts';

// ---------------------------------------------------------------------------
// PR body builder
// ---------------------------------------------------------------------------

export function buildPRBody(
	issue: GitHubIssue,
	config: OrchestratorConfig,
	flags: OrchestratorFlags
): string {
	const verifyChecklist = config.verify
		.map((v) => `- [x] \`${v.cmd}\` passes`)
		.join('\n');
	const e2eLine = config.e2e
		? (flags.skipE2e ? '- [ ] E2E (skipped)' : `- [x] \`${config.e2e.run}\` passes`)
		: '';

	return `## Summary

Closes #${issue.number}

## Changes

See issue #${issue.number} for full specification.

## Verification

${verifyChecklist}
${e2eLine}

---
Automated by pai orchestrate`;
}

// ---------------------------------------------------------------------------
// Main orchestration loop
// ---------------------------------------------------------------------------

export async function runMainLoop(
	executionOrder: number[],
	graph: Map<number, DependencyNode>,
	state: OrchestratorState,
	config: OrchestratorConfig,
	flags: OrchestratorFlags,
	stateFile: string,
	repoRoot: string,
	logger: RunLogger
): Promise<void> {
	let startIdx = 0;
	if (flags.singleIssue !== null) {
		startIdx = executionOrder.indexOf(flags.singleIssue);
		if (startIdx === -1) {
			log.error(`Issue #${flags.singleIssue} not found in execution order`);
			process.exit(1);
		}
	} else if (flags.fromIssue !== null) {
		startIdx = executionOrder.indexOf(flags.fromIssue);
		if (startIdx === -1) {
			log.error(`Issue #${flags.fromIssue} not found in execution order`);
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

	const modeLabel = flags.singleMode ? ' (single issue mode)' : '';
	const startNode = graph.get(executionOrder[startIdx]);
	const startTitle = startNode ? `: ${startNode.issue.title}` : '';
	log.info(
		`Starting from issue #${executionOrder[startIdx]}${startTitle} (position ${startIdx + 1}/${executionOrder.length})${modeLabel}`
	);

	for (let i = startIdx; i < executionOrder.length; i++) {
		const issueNum = executionOrder[i];
		const node = graph.get(issueNum);
		if (!node) continue;

		const issueState = getIssueState(state, issueNum, node.issue.title);
		if (issueState.status === 'completed') {
			log.dim(`Skipping #${issueNum} (already completed)`);
			continue;
		}
		if (issueState.status === 'split') {
			log.dim(`Skipping #${issueNum} (split into sub-issues)`);
			continue;
		}

		const issueStartTime = Date.now();
		log.step(`ISSUE #${issueNum}: ${node.issue.title} (${i + 1}/${executionOrder.length})`);

		// Check dependencies
		const unmetDeps = node.dependsOn.filter((dep) => {
			if (!graph.has(dep)) return false;
			const depState = state.issues[dep];
			return !depState || depState.status !== 'completed';
		});

		if (unmetDeps.length > 0) {
			log.error(`Unmet dependencies: ${unmetDeps.map((d) => `#${d}`).join(', ')}`);
			log.error('Cannot proceed — dependencies must be completed first');
			issueState.status = 'failed';
			issueState.error = `Unmet dependencies: ${unmetDeps.join(', ')}`;
			saveState(state, stateFile);
			logger.issueFailed(issueNum, issueState.error);
			process.exit(1);
		}

		// Assess splitting
		if (!flags.skipSplit) {
			log.info('Assessing issue size...');
			const assessment = await assessIssueSize(node.issue, config, repoRoot);
			log.dim(`Assessment: ${assessment.reasoning}`);

			if (assessment.shouldSplit && assessment.proposedSplits.length > 0) {
				log.warn(
					`Issue #${issueNum} needs splitting into ${assessment.proposedSplits.length} sub-issues`
				);

				const subIssueNumbers = await createSubIssues(
					node.issue,
					assessment.proposedSplits,
					node.dependsOn
				);

				issueState.status = 'split';
				issueState.subIssues = subIssueNumbers;
				saveState(state, stateFile);
				logger.issueSplit(issueNum, subIssueNumbers);

				log.ok(`Split into: ${subIssueNumbers.map((n) => `#${n}`).join(', ')}`);
				log.info('Re-fetching issues and rebuilding graph...');

				const freshIssues = await fetchOpenIssues(config.allowedAuthors);
				const freshGraph = buildGraph(freshIssues, config);
				const freshOrder = topologicalSort(freshGraph);

				graph.clear();
				for (const [k, v] of freshGraph) graph.set(k, v);
				executionOrder.length = 0;
				executionOrder.push(...freshOrder);

				printExecutionPlan(executionOrder, graph, config.baseBranch);

				const firstSubIdx = executionOrder.findIndex((n) => subIssueNumbers.includes(n));
				if (firstSubIdx !== -1) {
					i = firstSubIdx - 1;
				}
				continue;
			}
		}

		// Create worktree with fresh branch
		log.info('Creating worktree...');
		const depBranches = node.dependsOn
			.map((dep) => {
				const depNode = graph.get(dep);
				if (depNode) return depNode.branch;
				const depState = state.issues[dep];
				if (depState?.branch) return depState.branch;
				return null;
			})
			.filter((b): b is string => b !== null);

		const wtResult = await createWorktree(node.branch, depBranches, config, repoRoot, logger, issueNum);
		if (!wtResult.ok) {
			log.error(wtResult.error ?? 'Unknown worktree creation error');
			issueState.status = 'failed';
			issueState.error = wtResult.error ?? 'Worktree creation failed';
			saveState(state, stateFile);
			logger.issueFailed(issueNum, issueState.error);
			process.exit(1);
		}

		const { worktreePath, baseBranch } = wtResult;
		issueState.branch = node.branch;
		issueState.baseBranch = baseBranch;
		issueState.status = 'in_progress';
		saveState(state, stateFile);
		logger.issueStart(issueNum, node.issue.title, node.branch, baseBranch);

		log.ok(`Worktree at ${worktreePath} on branch ${node.branch} (base: ${baseBranch})`);

		// Implement (inside worktree)
		let lastImplError: string | undefined;
		const implRetryResult = await withRetries(
			async () => {
				const r = await implementIssue(node.issue, node.branch, baseBranch, config, worktreePath, logger);
				if (!r.ok) lastImplError = r.error;
				return r;
			},
			async (attempt) => {
				log.warn(`Implementation retry ${attempt + 1}/${config.retries.implement}`);
			},
			config.retries.implement + 1
		);

		if (!implRetryResult.ok) {
			log.error(`Implementation attempt failed: ${lastImplError}`);
			issueState.status = 'failed';
			issueState.error = `Implementation failed after ${config.retries.implement + 1} attempts: ${lastImplError}`;
			saveState(state, stateFile);
			logger.issueFailed(issueNum, issueState.error);
			await removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);
			log.error('HALTING — implementation failed');
			process.exit(1);
		}

		// Verify (inside worktree)
		log.info('Running verification pipeline...');
		let lastVerifyResult: Awaited<ReturnType<typeof runVerify>> | undefined;
		const verifyRetryResult = await withRetries(
			async () => {
				const r = await runVerify({
					verify: config.verify,
					e2e: config.e2e,
					cwd: worktreePath,
					skipE2e: flags.skipE2e,
					logger,
					issueNumber: issueNum
				});
				lastVerifyResult = r;
				return r;
			},
			async (attempt) => {
				const failedStep = lastVerifyResult?.failedStep;
				if (failedStep) {
					log.error(`Verification failed at ${failedStep}`);
					log.warn(
						`Verification retry ${attempt + 1}/${config.retries.verify} — feeding errors back to agent`
					);
					await fixVerificationFailure(
						issueNum,
						failedStep,
						lastVerifyResult?.error ?? '',
						config,
						worktreePath,
						logger
					);
				}
			},
			config.retries.verify + 1
		);

		if (!verifyRetryResult.ok) {
			const failedStep = lastVerifyResult?.failedStep ?? 'unknown';
			issueState.status = 'failed';
			issueState.error = `Verification failed at ${failedStep} after ${config.retries.verify + 1} attempts: ${lastVerifyResult?.error}`;
			saveState(state, stateFile);
			logger.issueFailed(issueNum, issueState.error);
			await removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);
			log.error('HALTING — verification failed');
			process.exit(1);
		}

		log.ok('All verification gates passed');

		// Create PR (push from worktree)
		log.info('Creating pull request...');
		const prBody = buildPRBody(node.issue, config, flags);
		const prResult = await createPR(node.issue.title, prBody, baseBranch, node.branch, worktreePath);
		if (!prResult.ok) {
			log.error(prResult.error ?? 'PR creation failed');
			issueState.status = 'failed';
			issueState.error = prResult.error ?? 'PR creation failed';
			saveState(state, stateFile);
			logger.issueFailed(issueNum, issueState.error);
			await removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);
			process.exit(1);
		}
		if (prResult.prNumber) logger.prCreated(issueNum, prResult.prNumber);

		// Clean up worktree (branch stays for the PR)
		await removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);

		// Mark complete
		const durationMs = Date.now() - issueStartTime;
		issueState.status = 'completed';
		issueState.error = null;
		issueState.prNumber = prResult.prNumber ?? null;
		issueState.completedAt = new Date().toISOString();
		saveState(state, stateFile);
		logger.issueComplete(issueNum, prResult.prNumber, durationMs);

		log.ok(`Issue #${issueNum} completed → PR #${prResult.prNumber}`);

		if (flags.singleMode) {
			log.step('SINGLE ISSUE COMPLETE');
			log.info(`Finished #${issueNum}. Run again to process the next issue.`);
			printStatus(state);
			break;
		}
	}

	if (!flags.singleMode) {
		log.step('ALL ISSUES COMPLETED');
		printStatus(state);
	}
}
