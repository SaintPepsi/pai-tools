/**
 * Issue Orchestrator — main logic.
 *
 * Reads open GitHub issues, topologically sorts by dependencies,
 * optionally splits large issues into sub-issues, then implements
 * each via Claude agents with full verification.
 */

import { join } from 'node:path';
import { log } from '@shared/log.ts';
import { RunLogger } from '@shared/logging.ts';
import { findRepoRoot, loadToolConfig, saveToolConfig, getStateFilePath, migrateStateIfNeeded } from '@shared/config.ts';
import { loadState, clearState } from '@shared/state.ts';
import { fetchOpenIssues } from '@shared/github.ts';
import { parseMarkdownContent } from '@tools/orchestrator/markdown-source.ts';
import { buildGraph, topologicalSort, computeTiers } from '@tools/orchestrator/dependency-graph.ts';
import { printExecutionPlan, printStatus, printParallelPlan } from '@tools/orchestrator/display.ts';
import { promptForVerifyCommands } from '@tools/orchestrator/prompt.ts';
import { runDryRun } from '@tools/orchestrator/dry-run.ts';
import { runMainLoop } from '@tools/orchestrator/execution.ts';
import { runParallelLoop } from '@tools/orchestrator/parallel.ts';
import { initState } from '@tools/orchestrator/state-helpers.ts';
import { ORCHESTRATOR_DEFAULTS } from '@tools/orchestrator/defaults.ts';
import type {
	OrchestratorConfig,
	OrchestratorFlags
} from '@tools/orchestrator/types.ts';
import type { OrchestratorState, DependencyNode } from '@tools/orchestrator/types.ts';
import type { VerifyCommand } from '@tools/verify/types.ts';
import type { GitHubIssue } from '@shared/github.ts';
import type { RunParallelLoopOptions } from '@tools/orchestrator/parallel.ts';
import type { RunMainLoopOptions } from '@tools/orchestrator/execution.ts';

export { parseFlags } from '@tools/orchestrator/flags.ts';

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface OrchestrateDeps {
	findRepoRoot: () => string;
	loadToolConfig: (repoRoot: string, toolName: string, defaults: OrchestratorConfig) => OrchestratorConfig;
	getStateFilePath: (repoRoot: string, toolName: string) => string;
	migrateStateIfNeeded: (repoRoot: string, toolName: string, legacyPath: string) => void;
	clearState: (repoRoot: string, toolName: string) => void;
	loadState: (file: string) => OrchestratorState | null;
	saveToolConfig: (repoRoot: string, toolName: string, partial: Partial<OrchestratorConfig>) => void;
	promptForVerifyCommands: () => Promise<VerifyCommand[]>;
	fetchOpenIssues: (allowedAuthors?: string[]) => Promise<GitHubIssue[]>;
	readFile: (path: string) => Promise<string>;
	parseMarkdownContent: (content: string) => GitHubIssue[];
	buildGraph: (issues: GitHubIssue[], config: OrchestratorConfig) => Map<number, DependencyNode>;
	topologicalSort: (graph: Map<number, DependencyNode>) => number[];
	computeTiers: (graph: Map<number, DependencyNode>) => number[][];
	printParallelPlan: (tiers: number[][], graph: Map<number, DependencyNode>, parallelN: number) => void;
	printExecutionPlan: (order: number[], graph: Map<number, DependencyNode>, baseBranch: string) => void;
	printStatus: (state: OrchestratorState) => void;
	makeLogger: (repoRoot: string) => RunLogger;
	runDryRun: (executionOrder: number[], graph: Map<number, DependencyNode>, state: OrchestratorState, config: OrchestratorConfig, flags: OrchestratorFlags, repoRoot: string) => Promise<void>;
	runParallelLoop: (opts: RunParallelLoopOptions) => Promise<void>;
	runMainLoop: (opts: RunMainLoopOptions) => Promise<void>;
	initState: () => OrchestratorState;
	log: typeof log;
	exit: (code: number) => never;
	consolelog: (...args: unknown[]) => void;
}
export const defaultOrchestrateDeps: OrchestrateDeps = {
	findRepoRoot,
	loadToolConfig: (r, t, d) => loadToolConfig<OrchestratorConfig>(r, t, d),
	getStateFilePath,
	migrateStateIfNeeded,
	clearState,
	loadState,
	saveToolConfig: (r, t, p) => saveToolConfig<OrchestratorConfig>(r, t, p),
	promptForVerifyCommands,
	fetchOpenIssues,
	readFile: (path) => Bun.file(path).text(),
	parseMarkdownContent,
	buildGraph,
	topologicalSort,
	computeTiers,
	printParallelPlan,
	printExecutionPlan,
	printStatus,
	makeLogger: (repoRoot) => new RunLogger(repoRoot),
	runDryRun,
	runParallelLoop,
	runMainLoop,
	initState,
	log,
	exit: (code) => process.exit(code),
	consolelog: (...args) => console.log(...args),
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function orchestrate(flags: OrchestratorFlags, deps: OrchestrateDeps = defaultOrchestrateDeps): Promise<void> {
	deps.consolelog('\n\x1b[36m╔══════════════════════════════════════════════╗\x1b[0m');
	deps.consolelog('\x1b[36m║         PAI Issue Orchestrator                ║\x1b[0m');
	deps.consolelog('\x1b[36m╚══════════════════════════════════════════════╝\x1b[0m\n');

	const repoRoot = deps.findRepoRoot();
	const config = deps.loadToolConfig(repoRoot, 'orchestrator', ORCHESTRATOR_DEFAULTS);
	const stateFile = deps.getStateFilePath(repoRoot, 'orchestrator');

	// Auto-migrate legacy state
	const legacyStatePath = join(repoRoot, 'scripts', '.orchestrator-state.json');
	deps.migrateStateIfNeeded(repoRoot, 'orchestrator', legacyStatePath);

	// Handle --reset
	if (flags.reset) {
		deps.clearState(repoRoot, 'orchestrator');
		deps.log.ok('State cleared');
		const hasOtherFlags = flags.dryRun || flags.statusOnly || flags.singleMode || flags.fromIssue !== null;
		if (!hasOtherFlags) return;
	}

	// Handle --status
	if (flags.statusOnly) {
		const state = deps.loadState(stateFile);
		if (!state) {
			deps.log.info('No state file found. Nothing has been run yet.');
			return;
		}
		deps.printStatus(state);
		return;
	}

	// Require verification unless --no-verify
	if (config.verify.length === 0 && !config.e2e && !flags.noVerify) {
		const commands = await deps.promptForVerifyCommands();
		if (commands.length === 0) {
			deps.log.error('No verification commands provided. Use --no-verify to skip verification.');
			deps.exit(1);
		}
		config.verify = commands;

		// Save to project config so future runs don't re-prompt
		deps.saveToolConfig(repoRoot, 'orchestrator', { verify: commands });
		deps.log.ok(`Saved ${commands.length} verification step(s) to .pait/orchestrator.json`);
	}

	// Fetch issues (from GitHub or markdown file)
	const issues = await (async () => {
		if (flags.file) {
			deps.log.step(`READING TASKS FROM ${flags.file}`);
			const content = await deps.readFile(flags.file);
			const tasks = deps.parseMarkdownContent(content);
			deps.log.ok(`Parsed ${tasks.length} open tasks from markdown`);
			return tasks;
		}
		deps.log.step('FETCHING ISSUES');
		const ghIssues = await deps.fetchOpenIssues(config.allowedAuthors);
		deps.log.ok(`Fetched ${ghIssues.length} open issues`);
		return ghIssues;
	})();

	const graph = deps.buildGraph(issues, config);
	const executionOrder = deps.topologicalSort(graph);

	// Show tier visualization when running in parallel mode
	if (flags.parallel > 1 && !flags.singleMode) {
		const tiers = deps.computeTiers(graph);
		deps.printParallelPlan(tiers, graph, flags.parallel);
	} else {
		deps.printExecutionPlan(executionOrder, graph, config.baseBranch);
	}

	// Initialize run logger
	const logger = deps.makeLogger(repoRoot);
	deps.log.info(`Run log: ${logger.path}`);

	if (flags.dryRun) {
		const state = deps.loadState(stateFile) ?? deps.initState();
		logger.runStart({ mode: 'dry-run', issueCount: executionOrder.length });
		await deps.runDryRun(executionOrder, graph, state, config, flags, repoRoot);
		logger.runComplete({ mode: 'dry-run' });
		return;
	}

	const useParallel = flags.parallel > 1 && !flags.singleMode;
	const runMode = flags.singleMode ? 'single' : useParallel ? `parallel:${flags.parallel}` : 'full';

	const state = deps.loadState(stateFile) ?? deps.initState();
	logger.runStart({
		mode: runMode,
		issueCount: executionOrder.length,
		singleIssue: flags.singleIssue,
		fromIssue: flags.fromIssue
	});

	if (useParallel) {
		await deps.runParallelLoop({ executionOrder, graph, state, config, flags, startIdx: 0, stateFile, repoRoot, logger });
	} else {
		await deps.runMainLoop({ executionOrder, graph, state, config, flags, stateFile, repoRoot, logger });
	}
	logger.runComplete({ issueCount: executionOrder.length });
}
