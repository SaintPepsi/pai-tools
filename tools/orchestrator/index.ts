/**
 * Issue Orchestrator — main logic.
 *
 * Reads open GitHub issues, topologically sorts by dependencies,
 * optionally splits large issues into sub-issues, then implements
 * each via Claude agents with full verification.
 */

import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../../shared/log.ts';
import { RunLogger } from '../../shared/logging.ts';
import { findRepoRoot, loadToolConfig, saveToolConfig, getStateFilePath, migrateStateIfNeeded } from '../../shared/config.ts';
import { loadState } from '../../shared/state.ts';
import { fetchOpenIssues } from '../../shared/github.ts';
import { buildGraph, topologicalSort } from './dependency-graph.ts';
import { printExecutionPlan, printStatus } from './display.ts';
import { promptForVerifyCommands } from '../verify/index.ts';
import { runDryRun } from './dry-run.ts';
import { runMainLoop } from './execution.ts';
import { initState } from './state-helpers.ts';
import { ORCHESTRATOR_DEFAULTS } from './defaults.ts';
import type {
	OrchestratorConfig,
	OrchestratorFlags
} from './types.ts';

// ---------------------------------------------------------------------------
// Re-exports (backward compatibility)
// ---------------------------------------------------------------------------

export { loadState, saveState } from '../../shared/state.ts';
export { localBranchExists, deleteLocalBranch, createWorktree, removeWorktree } from '../../shared/git.ts';
export { parseDependencies, toKebabSlug, buildGraph, topologicalSort } from './dependency-graph.ts';
export { assessIssueSize, buildImplementationPrompt, fixVerificationFailure, implementIssue } from './agent-runner.ts';
export { printExecutionPlan, printStatus } from './display.ts';
export { buildPRBody, runMainLoop } from './execution.ts';
export { runDryRun } from './dry-run.ts';
export { initState, getIssueState } from './state-helpers.ts';

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

	printExecutionPlan(executionOrder, graph, config.baseBranch);

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
