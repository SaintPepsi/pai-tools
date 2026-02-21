/**
 * Issue Orchestrator — main logic.
 *
 * Reads open GitHub issues, topologically sorts by dependencies,
 * optionally splits large issues into sub-issues, then implements
 * each via Claude agents with full verification.
 */

import { $ } from 'bun';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../../shared/log.ts';
import { runClaude } from '../../shared/claude.ts';
import { findRepoRoot, loadToolConfig, getStateFilePath, migrateStateIfNeeded } from '../../shared/config.ts';
import { ORCHESTRATOR_DEFAULTS } from './defaults.ts';
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
		singleMode: args.includes('--single'),
		singleIssue,
		fromIssue
	};
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

function loadState(stateFile: string): OrchestratorState | null {
	try {
		const content = readFileSync(stateFile, 'utf-8');
		if (!content) return null;
		return JSON.parse(content);
	} catch {
		return null;
	}
}

function saveState(state: OrchestratorState, stateFile: string): void {
	state.updatedAt = new Date().toISOString();
	writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function initState(): OrchestratorState {
	return {
		version: 1,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		issues: {}
	};
}

function getIssueState(state: OrchestratorState, num: number): IssueState {
	if (!state.issues[num]) {
		state.issues[num] = {
			number: num,
			status: 'pending',
			branch: null,
			baseBranch: null,
			prNumber: null,
			error: null,
			completedAt: null,
			subIssues: null
		};
	}
	return state.issues[num];
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

async function fetchOpenIssues(): Promise<GitHubIssue[]> {
	const result =
		await $`gh issue list --state open --limit 200 --json number,title,body,state,labels`.text();
	return JSON.parse(result);
}

function parseDependencies(body: string): number[] {
	const depLine = body.split('\n').find((line) => /depends\s+on/i.test(line));
	if (!depLine) return [];

	const matches = depLine.matchAll(/#(\d+)/g);
	return [...matches].map((m) => Number(m[1]));
}

function toKebabSlug(title: string): string {
	return title
		.toLowerCase()
		.replace(/^\[\d+\]\s*/, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 50);
}

// ---------------------------------------------------------------------------
// Dependency graph + topological sort
// ---------------------------------------------------------------------------

function buildGraph(
	issues: GitHubIssue[],
	config: OrchestratorConfig
): Map<number, DependencyNode> {
	const graph = new Map<number, DependencyNode>();

	for (const issue of issues) {
		const deps = parseDependencies(issue.body);
		graph.set(issue.number, {
			issue,
			dependsOn: deps,
			branch: `${config.branchPrefix}${issue.number}-${toKebabSlug(issue.title)}`
		});
	}

	return graph;
}

function topologicalSort(graph: Map<number, DependencyNode>): number[] {
	const visited = new Set<number>();
	const visiting = new Set<number>();
	const result: number[] = [];

	function visit(num: number): void {
		if (visited.has(num)) return;
		if (visiting.has(num)) {
			throw new Error(`Circular dependency detected involving issue #${num}`);
		}

		visiting.add(num);

		const node = graph.get(num);
		if (node) {
			for (const dep of node.dependsOn) {
				if (graph.has(dep)) {
					visit(dep);
				}
			}
		}

		visiting.delete(num);
		visited.add(num);
		result.push(num);
	}

	for (const num of graph.keys()) {
		visit(num);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Issue size assessment + splitting
// ---------------------------------------------------------------------------

async function assessIssueSize(
	issue: GitHubIssue,
	config: OrchestratorConfig,
	repoRoot: string
): Promise<{
	shouldSplit: boolean;
	proposedSplits: { title: string; body: string }[];
	reasoning: string;
}> {
	const prompt = `You are assessing whether a GitHub issue is too large for a single Claude Code agent session to implement.

A single agent session can reliably handle:
- Up to ~3 new files
- Up to ~500 lines of new code
- One coherent feature or system

If the issue requires MORE than that, propose splitting it into smaller sub-issues that can each be done in one session.

ISSUE #${issue.number}: ${issue.title}

${issue.body}

Respond in EXACTLY this JSON format (no markdown, no code fences):
{
  "shouldSplit": true/false,
  "reasoning": "one sentence explanation",
  "proposedSplits": [
    {"title": "Sub-issue title", "body": "Sub-issue description with acceptance criteria"}
  ]
}

If shouldSplit is false, proposedSplits should be an empty array.
Be conservative — only split if it's genuinely too large. Most issues with clear acceptance criteria can be done in one pass.`;

	const { output: rawResult } = await runClaude({
		prompt,
		model: config.models.assess,
		cwd: repoRoot
	}).catch(() => ({
		ok: false,
		output: ''
	}));

	try {
		const jsonMatch: RegExpMatchArray | null = rawResult.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			return {
				shouldSplit: false,
				reasoning: 'No JSON found in assessment response',
				proposedSplits: []
			};
		}
		return JSON.parse(jsonMatch[0]);
	} catch {
		return { shouldSplit: false, reasoning: 'Failed to parse assessment', proposedSplits: [] };
	}
}

async function createSubIssues(
	parentIssue: GitHubIssue,
	splits: { title: string; body: string }[],
	parentDeps: number[]
): Promise<number[]> {
	const createdNumbers: number[] = [];
	let previousSubIssue: number | null = null;

	for (const split of splits) {
		const deps: number[] =
			previousSubIssue !== null
				? [previousSubIssue]
				: parentDeps.filter((d: number) => d !== parentIssue.number);

		const depsLine: string =
			deps.length > 0 ? `> **Depends on:** ${deps.map((d: number) => `#${d}`).join(', ')}\n\n` : '';

		const issueBody: string = `${depsLine}> **Part of** #${parentIssue.number}\n\n${split.body}`;
		const title: string = split.title;

		const result: string = (
			await $`gh issue create --title ${title} --body ${issueBody}`.text()
		).trim();
		const match: RegExpMatchArray | null = result.match(/(\d+)$/);
		if (match) {
			const num: number = Number(match[1]);
			createdNumbers.push(num);
			previousSubIssue = num;
			log.ok(`Created sub-issue #${num}: ${title}`);
		}
	}

	return createdNumbers;
}

// ---------------------------------------------------------------------------
// Branch management
// ---------------------------------------------------------------------------

async function branchExists(name: string, repoRoot: string): Promise<boolean> {
	try {
		await $`git -C ${repoRoot} rev-parse --verify ${name}`.quiet();
		return true;
	} catch {
		return false;
	}
}

async function createBranchFromDeps(
	branchName: string,
	depBranches: string[],
	config: OrchestratorConfig,
	repoRoot: string
): Promise<{ ok: boolean; error?: string }> {
	const existingDeps: string[] = [];
	for (const dep of depBranches) {
		if (await branchExists(dep, repoRoot)) {
			existingDeps.push(dep);
		}
	}

	const baseBranch = existingDeps.length > 0 ? existingDeps[0] : config.baseBranch;

	try {
		await $`git -C ${repoRoot} checkout -b ${branchName} ${baseBranch}`.quiet();

		for (let i = 1; i < existingDeps.length; i++) {
			try {
				await $`git -C ${repoRoot} merge ${existingDeps[i]} --no-edit -m ${'Merge dependency branch ' + existingDeps[i]}`.quiet();
			} catch {
				await $`git -C ${repoRoot} merge --abort`.quiet().catch(() => {});
				await $`git -C ${repoRoot} checkout ${config.baseBranch}`.quiet().catch(() => {});
				await $`git -C ${repoRoot} branch -D ${branchName}`.quiet().catch(() => {});
				return {
					ok: false,
					error: `Merge conflict merging ${existingDeps[i]} into ${branchName} (based on ${baseBranch})`
				};
			}
		}

		return { ok: true };
	} catch (err) {
		return { ok: false, error: `Failed to create branch ${branchName}: ${err}` };
	}
}

// ---------------------------------------------------------------------------
// Implementation via Claude agent
// ---------------------------------------------------------------------------

function buildImplementationPrompt(
	issue: GitHubIssue,
	branchName: string,
	baseBranch: string,
	config: OrchestratorConfig,
	repoRoot: string
): string {
	const verifyList = config.verify.length > 0
		? config.verify.map((v) => `- ${v.cmd}`).join('\n')
		: '(no verification commands configured)';

	return `You are implementing GitHub issue #${issue.number}: ${issue.title}

## Issue Description

${issue.body}

## Context

- You are on branch: ${branchName}
- Based on: ${baseBranch}
- Project root: ${repoRoot}

## Instructions

1. Read CLAUDE.md first for project conventions and quality requirements
2. Explore existing code related to this feature before writing new code
3. Implement the feature described in the issue
4. Write tests for new functionality (colocated with source files)
5. Follow existing patterns in the codebase — check similar features first
6. Make atomic commits with descriptive messages referencing #${issue.number}
7. Ensure all verification commands pass before finishing:
${verifyList}

Do NOT create a pull request. Just implement, test, and commit.`;
}

async function implementIssue(
	issue: GitHubIssue,
	branchName: string,
	baseBranch: string,
	config: OrchestratorConfig,
	repoRoot: string
): Promise<{ ok: boolean; error?: string }> {
	const prompt = buildImplementationPrompt(issue, branchName, baseBranch, config, repoRoot);

	log.info(`Launching Claude agent for #${issue.number}...`);

	const result = await runClaude({
		prompt,
		model: config.models.implement,
		cwd: repoRoot,
		permissionMode: 'acceptEdits',
		allowedTools: config.allowedTools
	});

	log.dim(result.output.slice(-500));

	if (!result.ok) {
		return { ok: false, error: 'Claude agent failed (exit non-zero)' };
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Verification pipeline
// ---------------------------------------------------------------------------

async function runVerification(
	config: OrchestratorConfig,
	flags: OrchestratorFlags,
	repoRoot: string,
	currentIssueNumber: number
): Promise<{ ok: boolean; failedStep?: string; error?: string }> {
	for (const step of config.verify) {
		log.info(`Running ${step.name}: ${step.cmd}`);
		try {
			await $`${{ raw: step.cmd }}`.cwd(repoRoot).quiet();
			log.ok(`${step.name} passed`);
		} catch (err) {
			const output = err instanceof Error ? err.message : String(err);
			return { ok: false, failedStep: step.name, error: output.slice(-2000) };
		}
	}

	// E2E (only if configured and not skipped)
	if (config.e2e && !flags.skipE2e) {
		log.info(`Running E2E: ${config.e2e.run}`);
		try {
			await $`${{ raw: config.e2e.run }}`.cwd(repoRoot).quiet();
			log.ok('E2E passed');
		} catch {
			log.warn('E2E failed — attempting snapshot update...');
			try {
				await $`${{ raw: config.e2e.update }}`.cwd(repoRoot).quiet();
				await $`${{ raw: config.e2e.run }}`.cwd(repoRoot).quiet();
				log.ok('E2E passed after snapshot update');
				// Stage updated snapshots
				const glob = config.e2e.snapshotGlob;
				await $`git -C ${repoRoot} add -A ${glob}`.quiet().catch(() => {});
				await $`git -C ${repoRoot} commit -m ${'test: update E2E snapshots for #' + currentIssueNumber}`
					.quiet()
					.catch(() => {});
			} catch (err) {
				const output = err instanceof Error ? err.message : String(err);
				return { ok: false, failedStep: 'e2e', error: output.slice(-2000) };
			}
		}
	}

	return { ok: true };
}

// ---------------------------------------------------------------------------
// PR creation
// ---------------------------------------------------------------------------

async function createPR(
	issue: GitHubIssue,
	branchName: string,
	baseBranch: string,
	config: OrchestratorConfig,
	flags: OrchestratorFlags,
	repoRoot: string
): Promise<{ ok: boolean; prNumber?: number; error?: string }> {
	try {
		await $`git -C ${repoRoot} push -u origin ${branchName}`.quiet();
	} catch (err) {
		return { ok: false, error: `Failed to push branch: ${err}` };
	}

	try {
		const verifyChecklist = config.verify
			.map((v) => `- [x] \`${v.cmd}\` passes`)
			.join('\n');
		const e2eLine = config.e2e
			? (flags.skipE2e ? '- [ ] E2E (skipped)' : `- [x] \`${config.e2e.run}\` passes`)
			: '';

		const prBody = `## Summary

Implements #${issue.number}

## Changes

See issue #${issue.number} for full specification.

## Verification

${verifyChecklist}
${e2eLine}

---
Automated by pai orchestrate`;

		const result =
			await $`gh pr create --title ${issue.title} --body ${prBody} --base ${baseBranch} --head ${branchName}`.text();
		const match = result.match(/(\d+)/);
		const prNumber = match ? Number(match[1]) : undefined;
		log.ok(`PR created: ${result.trim()}`);
		return { ok: true, prNumber };
	} catch (err) {
		return { ok: false, error: `Failed to create PR: ${err}` };
	}
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function printExecutionPlan(order: number[], graph: Map<number, DependencyNode>): void {
	log.step('EXECUTION PLAN');
	for (let i = 0; i < order.length; i++) {
		const num = order[i];
		const node = graph.get(num);
		if (!node) continue;

		const deps =
			node.dependsOn.length > 0
				? ` (deps: ${node.dependsOn.map((d) => `#${d}`).join(', ')})`
				: ' (no deps — branches from master)';
		console.log(`  ${(i + 1).toString().padStart(2)}. #${num} ${node.issue.title}${deps}`);
		log.dim(`      → branch: ${node.branch}`);
	}
	console.log(`\n  Total: ${order.length} issues`);
}

function printStatus(state: OrchestratorState): void {
	log.step('ORCHESTRATOR STATUS');
	const entries = Object.values(state.issues).sort((a, b) => a.number - b.number);
	const completed = entries.filter((e) => e.status === 'completed').length;
	const failed = entries.filter((e) => e.status === 'failed').length;
	const pending = entries.filter((e) => e.status === 'pending').length;

	console.log(`  Started: ${state.startedAt}`);
	console.log(`  Updated: ${state.updatedAt}`);
	console.log(`  Progress: ${completed} completed, ${failed} failed, ${pending} pending\n`);

	for (const entry of entries) {
		const icon =
			entry.status === 'completed'
				? '\x1b[32m✓\x1b[0m'
				: entry.status === 'failed'
					? '\x1b[31m✗\x1b[0m'
					: entry.status === 'split'
						? '\x1b[33m↔\x1b[0m'
						: '\x1b[2m○\x1b[0m';
		const extra = entry.prNumber ? ` → PR #${entry.prNumber}` : '';
		const errMsg = entry.error ? `\n      \x1b[31m${entry.error}\x1b[0m` : '';
		console.log(`  ${icon} #${entry.number} [${entry.status}]${extra}${errMsg}`);
	}
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
	repoRoot: string
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
	log.info(
		`Starting from issue #${executionOrder[startIdx]} (position ${startIdx + 1}/${executionOrder.length})${modeLabel}`
	);

	for (let i = startIdx; i < executionOrder.length; i++) {
		const issueNum = executionOrder[i];
		const node = graph.get(issueNum);
		if (!node) continue;

		const issueState = getIssueState(state, issueNum);
		if (issueState.status === 'completed') {
			log.dim(`Skipping #${issueNum} (already completed)`);
			continue;
		}
		if (issueState.status === 'split') {
			log.dim(`Skipping #${issueNum} (split into sub-issues)`);
			continue;
		}

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

				log.ok(`Split into: ${subIssueNumbers.map((n) => `#${n}`).join(', ')}`);
				log.info('Re-fetching issues and rebuilding graph...');

				const freshIssues = await fetchOpenIssues();
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

		// Create branch
		log.info('Creating branch...');
		const depBranches = node.dependsOn
			.map((dep) => {
				const depNode = graph.get(dep);
				if (depNode) return depNode.branch;
				const depState = state.issues[dep];
				if (depState?.branch) return depState.branch;
				return null;
			})
			.filter((b): b is string => b !== null);

		const baseBranch = depBranches.length > 0 ? depBranches[0] : config.baseBranch;

		if (await branchExists(node.branch, repoRoot)) {
			log.info(`Branch ${node.branch} already exists, checking it out`);
			await $`git -C ${repoRoot} checkout ${node.branch}`.quiet();
		} else {
			const branchResult = await createBranchFromDeps(node.branch, depBranches, config, repoRoot);
			if (!branchResult.ok) {
				log.error(branchResult.error ?? 'Unknown branch creation error');
				issueState.status = 'failed';
				issueState.error = branchResult.error ?? 'Branch creation failed';
				saveState(state, stateFile);
				process.exit(1);
			}
		}

		issueState.branch = node.branch;
		issueState.baseBranch = baseBranch;
		issueState.status = 'in_progress';
		saveState(state, stateFile);

		log.ok(`On branch ${node.branch} (base: ${baseBranch})`);

		// Implement
		let implementOk = false;
		for (let attempt = 0; attempt <= config.retries.implement; attempt++) {
			if (attempt > 0) {
				log.warn(`Implementation retry ${attempt}/${config.retries.implement}`);
			}

			const implResult = await implementIssue(node.issue, node.branch, baseBranch, config, repoRoot);
			if (implResult.ok) {
				implementOk = true;
				break;
			}

			log.error(`Implementation attempt ${attempt + 1} failed: ${implResult.error}`);

			if (attempt === config.retries.implement) {
				issueState.status = 'failed';
				issueState.error = `Implementation failed after ${config.retries.implement + 1} attempts: ${implResult.error}`;
				saveState(state, stateFile);
				log.error('HALTING — implementation failed');
				process.exit(1);
			}
		}

		if (!implementOk) continue;

		// Verify
		log.info('Running verification pipeline...');
		let verifyOk = false;
		for (let attempt = 0; attempt <= config.retries.verify; attempt++) {
			if (attempt > 0) {
				log.warn(
					`Verification retry ${attempt}/${config.retries.verify} — feeding errors back to agent`
				);
			}

			const verifyResult = await runVerification(config, flags, repoRoot, issueNum);
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

					await runClaude({
						prompt: fixPrompt,
						model: config.models.implement,
						cwd: repoRoot,
						permissionMode: 'acceptEdits',
						allowedTools: config.allowedTools
					}).catch(() => ({ ok: false, output: '' }));
				} else {
					issueState.status = 'failed';
					issueState.error = `Verification failed at ${verifyResult.failedStep} after ${config.retries.verify + 1} attempts: ${verifyResult.error}`;
					saveState(state, stateFile);
					log.error('HALTING — verification failed');
					process.exit(1);
				}
			}
		}

		if (!verifyOk) continue;

		log.ok('All verification gates passed');

		// Create PR
		log.info('Creating pull request...');
		const prResult = await createPR(node.issue, node.branch, baseBranch, config, flags, repoRoot);
		if (!prResult.ok) {
			log.error(prResult.error ?? 'PR creation failed');
			issueState.status = 'failed';
			issueState.error = prResult.error ?? 'PR creation failed';
			saveState(state, stateFile);
			process.exit(1);
		}

		// Mark complete
		issueState.status = 'completed';
		issueState.prNumber = prResult.prNumber ?? null;
		issueState.completedAt = new Date().toISOString();
		saveState(state, stateFile);

		log.ok(`Issue #${issueNum} completed → PR #${prResult.prNumber}`);

		if (flags.singleMode) {
			log.step('SINGLE ISSUE COMPLETE');
			log.info(`Finished #${issueNum}. Run again to process the next issue.`);
			printStatus(state);
			return;
		}
	}

	log.step('ALL ISSUES COMPLETED');
	printStatus(state);
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

	// Fetch issues and build graph
	log.step('FETCHING ISSUES');
	const issues = await fetchOpenIssues();
	log.ok(`Fetched ${issues.length} open issues`);

	const graph = buildGraph(issues, config);
	const executionOrder = topologicalSort(graph);

	printExecutionPlan(executionOrder, graph);

	if (flags.dryRun) {
		const state = loadState(stateFile) ?? initState();
		await runDryRun(executionOrder, graph, state, config, flags, repoRoot);
		return;
	}

	const state = loadState(stateFile) ?? initState();
	await runMainLoop(executionOrder, graph, state, config, flags, stateFile, repoRoot);
}
