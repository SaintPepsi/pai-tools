/**
 * Issue Orchestrator — main logic.
 *
 * Reads open GitHub issues, topologically sorts by dependencies,
 * optionally splits large issues into sub-issues, then implements
 * each via Claude agents with full verification.
 */

import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { log, Spinner } from '../../shared/log.ts';
import { runClaude } from '../../shared/claude.ts';
import { RunLogger } from '../../shared/logging.ts';
import { findRepoRoot, loadToolConfig, saveToolConfig, getStateFilePath, migrateStateIfNeeded } from '../../shared/config.ts';
import { loadState, saveState } from '../../shared/state.ts';
import { createWorktree, removeWorktree } from '../../shared/git.ts';
export { localBranchExists, deleteLocalBranch, createWorktree, removeWorktree } from '../../shared/git.ts';
import { fetchOpenIssues, createSubIssues, createPR } from '../../shared/github.ts';
import { ORCHESTRATOR_DEFAULTS } from './defaults.ts';
import { runVerify, promptForVerifyCommands } from '../verify/index.ts';
import { buildGraph, topologicalSort } from './dependency-graph.ts';
export { parseDependencies, toKebabSlug, buildGraph, topologicalSort } from './dependency-graph.ts';
import { assessIssueSize, implementIssue } from './agent-runner.ts';
import { printExecutionPlan, printStatus } from './display.ts';
import type {
	GitHubIssue,
	DependencyNode,
	IssueState,
	OrchestratorState,
	OrchestratorConfig,
	OrchestratorFlags
} from './types.ts';

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

export function parseFlags(args: string[]): OrchestratorFlags {

	const singleIssue = (() => {
		const idx = args.indexOf('--single');
		if (idx === -1) return null;
		const next = args[idx + 1];
		if (next && !next.startsWith('--')) {
			const val = Number(next);
			if (!Number.isNaN(val)) return val;
		}
		return null;
	})();

	const fromIssue = (() => {
		const idx = args.indexOf('--from');
		if (idx === -1) return null;
		const val = Number(args[idx + 1]);
		if (Number.isNaN(val)) {
			console.error('--from requires a valid issue number');
			process.exit(1);
		}
		return val;
	})();

	return {
		dryRun: args.includes('--dry-run'),
		reset: args.includes('--reset'),
		statusOnly: args.includes('--status'),
		skipE2e: args.includes('--skip-e2e'),
		skipSplit: args.includes('--skip-split'),
		noVerify: args.includes('--no-verify'),
		singleMode: args.includes('--single'),
		singleIssue,
		fromIssue
	};
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

export { loadState, saveState } from '../../shared/state.ts';

export function initState(): OrchestratorState {
	return {
		version: 1,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		issues: {}
	};
}

export function getIssueState(state: OrchestratorState, num: number, title?: string): IssueState {
	if (!state.issues[num]) {
		state.issues[num] = {
			number: num,
			title: title ?? null,
			status: 'pending',
			branch: null,
			baseBranch: null,
			prNumber: null,
			error: null,
			completedAt: null,
			subIssues: null
		};
	} else if (title && !state.issues[num].title) {
		state.issues[num].title = title;
	}
	return state.issues[num];
}

// ---------------------------------------------------------------------------
// PR body builder
// ---------------------------------------------------------------------------

function buildPRBody(
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
// Dry run logic
// ---------------------------------------------------------------------------

async function runDryRun(
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

// ---------------------------------------------------------------------------
// Main orchestration loop
// ---------------------------------------------------------------------------

async function runMainLoop(
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

				printExecutionPlan(executionOrder, graph);

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
		let implementOk = false;
		for (let attempt = 0; attempt <= config.retries.implement; attempt++) {
			if (attempt > 0) {
				log.warn(`Implementation retry ${attempt}/${config.retries.implement}`);
			}

			const implResult = await implementIssue(node.issue, node.branch, baseBranch, config, worktreePath, logger);
			if (implResult.ok) {
				implementOk = true;
				break;
			}

			log.error(`Implementation attempt ${attempt + 1} failed: ${implResult.error}`);

			if (attempt === config.retries.implement) {
				issueState.status = 'failed';
				issueState.error = `Implementation failed after ${config.retries.implement + 1} attempts: ${implResult.error}`;
				saveState(state, stateFile);
				logger.issueFailed(issueNum, issueState.error);
				await removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);
				log.error('HALTING — implementation failed');
				process.exit(1);
			}
		}

		if (!implementOk) {
			await removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);
			continue;
		}

		// Verify (inside worktree)
		log.info('Running verification pipeline...');
		let verifyOk = false;
		for (let attempt = 0; attempt <= config.retries.verify; attempt++) {
			if (attempt > 0) {
				log.warn(
					`Verification retry ${attempt}/${config.retries.verify} — feeding errors back to agent`
				);
			}

			const verifyResult = await runVerify({
				verify: config.verify,
				e2e: config.e2e,
				cwd: worktreePath,
				skipE2e: flags.skipE2e,
				logger,
				issueNumber: issueNum
			});
			if (verifyResult.ok) {
				verifyOk = true;
				break;
			}

			if (!verifyResult.ok && verifyResult.failedStep) {
				log.error(`Verification failed at ${verifyResult.failedStep}`);

				if (attempt < config.retries.verify) {
					const verifyList = config.verify.map((v) => `- ${v.cmd}`).join('\n');
					const fixPrompt = `The verification step "${verifyResult.failedStep}" failed for issue #${issueNum}.

Error output:
${verifyResult.error}

Please fix the issues and ensure all verification commands pass:
${verifyList}

Commit your fixes referencing #${issueNum}.`;

					const fixSpinner = new Spinner();
					fixSpinner.start(`Agent fixing verification for #${issueNum}`);

					const fixResult = await runClaude({
						prompt: fixPrompt,
						model: config.models.implement,
						cwd: worktreePath,
						permissionMode: 'acceptEdits',
						allowedTools: config.allowedTools
					}).catch(() => ({ ok: false, output: '' }));

					fixSpinner.stop();
					logger.agentOutput(issueNum, fixResult.output);
				} else {
					issueState.status = 'failed';
					issueState.error = `Verification failed at ${verifyResult.failedStep} after ${config.retries.verify + 1} attempts: ${verifyResult.error}`;
					saveState(state, stateFile);
					logger.issueFailed(issueNum, issueState.error);
					await removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);
					log.error('HALTING — verification failed');
					process.exit(1);
				}
			}
		}

		if (!verifyOk) {
			await removeWorktree(worktreePath, node.branch, repoRoot, logger, issueNum);
			continue;
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function orchestrate(flags: OrchestratorFlags): Promise<void> {
	console.log('\n\x1b[36m╔══════════════════════════════════════════════╗\x1b[0m');
	console.log('\x1b[36m║         PAI Issue Orchestrator                ║\x1b[0m');
	console.log('\x1b[36m╚══════════════════════════════════════════════╝\x1b[0m\n');

	const repoRoot = findRepoRoot();
	const config = loadToolConfig<OrchestratorConfig>(repoRoot, 'orchestrator', ORCHESTRATOR_DEFAULTS);
	const stateFile = getStateFilePath(repoRoot, 'orchestrator');

	// Auto-migrate legacy state
	const legacyStatePath = join(repoRoot, 'scripts', '.orchestrator-state.json');
	migrateStateIfNeeded(repoRoot, 'orchestrator', legacyStatePath);

	// Handle --reset
	if (flags.reset) {
		try {
			unlinkSync(stateFile);
		} catch {
			/* ignore */
		}
		log.ok('State cleared');
		const hasOtherFlags = flags.dryRun || flags.statusOnly || flags.singleMode || flags.fromIssue !== null;
		if (!hasOtherFlags) return;
	}

	// Handle --status
	if (flags.statusOnly) {
		const state = loadState(stateFile);
		if (!state) {
			log.info('No state file found. Nothing has been run yet.');
			return;
		}
		printStatus(state);
		return;
	}

	// Require verification unless --no-verify
	if (config.verify.length === 0 && !config.e2e && !flags.noVerify) {
		const commands = await promptForVerifyCommands();
		if (commands.length === 0) {
			log.error('No verification commands provided. Use --no-verify to skip verification.');
			process.exit(1);
		}
		config.verify = commands;

		// Save to project config so future runs don't re-prompt
		saveToolConfig<OrchestratorConfig>(repoRoot, 'orchestrator', { verify: commands });
		log.ok(`Saved ${commands.length} verification step(s) to .pait/orchestrator.json`);
	}

	// Fetch issues and build graph
	log.step('FETCHING ISSUES');
	const issues = await fetchOpenIssues(config.allowedAuthors);
	log.ok(`Fetched ${issues.length} open issues`);

	const graph = buildGraph(issues, config);
	const executionOrder = topologicalSort(graph);

	printExecutionPlan(executionOrder, graph);

	// Initialize run logger
	const logger = new RunLogger(repoRoot);
	log.info(`Run log: ${logger.path}`);

	if (flags.dryRun) {
		const state = loadState(stateFile) ?? initState();
		logger.runStart({ mode: 'dry-run', issueCount: executionOrder.length });
		await runDryRun(executionOrder, graph, state, config, flags, repoRoot);
		logger.runComplete({ mode: 'dry-run' });
		return;
	}

	const state = loadState(stateFile) ?? initState();
	logger.runStart({
		mode: flags.singleMode ? 'single' : 'full',
		issueCount: executionOrder.length,
		singleIssue: flags.singleIssue,
		fromIssue: flags.fromIssue
	});
	await runMainLoop(executionOrder, graph, state, config, flags, stateFile, repoRoot, logger);
	logger.runComplete({ issueCount: executionOrder.length });
}
