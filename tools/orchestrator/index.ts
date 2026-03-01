/**
 * Issue Orchestrator — main logic.
 *
 * Reads open GitHub issues, topologically sorts by dependencies,
 * optionally splits large issues into sub-issues, then implements
 * each via Claude agents with full verification.
 */

import { join } from 'node:path';
import { log } from '../../shared/log.ts';
import { RunLogger } from '../../shared/logging.ts';
import { findRepoRoot, loadToolConfig, saveToolConfig, getStateFilePath, migrateStateIfNeeded } from '../../shared/config.ts';
import { loadState, clearState } from '../../shared/state.ts';
import { fetchOpenIssues } from '../../shared/github.ts';
import { parseMarkdownContent } from './markdown-source.ts';
import { buildGraph, topologicalSort, computeTiers } from './dependency-graph.ts';
import { printExecutionPlan, printStatus, printParallelPlan } from './display.ts';
import { promptForVerifyCommands } from './prompt.ts';
import { runDryRun } from './dry-run.ts';
import { runMainLoop } from './execution.ts';
import { runParallelLoop } from './parallel.ts';
import { initState } from './state-helpers.ts';
import { ORCHESTRATOR_DEFAULTS } from './defaults.ts';
import type {
	OrchestratorConfig,
	OrchestratorFlags
} from './types.ts';

// ---------------------------------------------------------------------------
// Re-exports (backward compatibility)
// ---------------------------------------------------------------------------

export { loadState, saveState, clearState } from '../../shared/state.ts';
export { localBranchExists, deleteLocalBranch, createWorktree, removeWorktree } from '../../shared/git.ts';
export { parseDependencies, toKebabSlug, buildGraph, topologicalSort, computeTiers } from './dependency-graph.ts';
export { parseMarkdownContent } from './markdown-source.ts';
export { assessIssueSize, buildImplementationPrompt, fixVerificationFailure, implementIssue } from './agent-runner.ts';
export { printExecutionPlan, printStatus, printParallelPlan } from './display.ts';
export { runParallelLoop } from './parallel.ts';
export { buildPRBody, runMainLoop } from './execution.ts';
export { runDryRun } from './dry-run.ts';
export { initState, getIssueState } from './state-helpers.ts';

// ---------------------------------------------------------------------------
// Flag parsing (re-export for backward compatibility)
// ---------------------------------------------------------------------------

export { parseFlags } from './flags.ts';

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
		clearState(repoRoot, 'orchestrator');
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

	// Fetch issues (from GitHub or markdown file)
	const issues = await (async () => {
		if (flags.file) {
			log.step(`READING TASKS FROM ${flags.file}`);
			const content = await Bun.file(flags.file).text();
			const tasks = parseMarkdownContent(content);
			log.ok(`Parsed ${tasks.length} open tasks from markdown`);
			return tasks;
		}
		log.step('FETCHING ISSUES');
		const ghIssues = await fetchOpenIssues(config.allowedAuthors);
		log.ok(`Fetched ${ghIssues.length} open issues`);
		return ghIssues;
	})();

	const graph = buildGraph(issues, config);
	const executionOrder = topologicalSort(graph);

	// Show tier visualization when running in parallel mode
	if (flags.parallel > 1 && !flags.singleMode) {
		const tiers = computeTiers(graph);
		printParallelPlan(tiers, graph, flags.parallel);
	} else {
		printExecutionPlan(executionOrder, graph, config.baseBranch);
	}

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

	const useParallel = flags.parallel > 1 && !flags.singleMode;
	const runMode = flags.singleMode ? 'single' : useParallel ? `parallel:${flags.parallel}` : 'full';

	const state = loadState(stateFile) ?? initState();
	logger.runStart({
		mode: runMode,
		issueCount: executionOrder.length,
		singleIssue: flags.singleIssue,
		fromIssue: flags.fromIssue
	});

	if (useParallel) {
		await runParallelLoop(executionOrder, graph, state, config, flags, 0, stateFile, repoRoot, logger);
	} else {
		await runMainLoop(executionOrder, graph, state, config, flags, stateFile, repoRoot, logger);
	}
	logger.runComplete({ issueCount: executionOrder.length });
}
