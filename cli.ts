#!/usr/bin/env bun
/**
 * pait — PAI Tools CLI
 *
 * Usage:
 *   paitorchestrate [flags]    Run the issue orchestrator
 *   paithelp                   Show this help message
 *
 * Orchestrator flags:
 *   --dry-run        Show execution plan without acting
 *   --status         Show current progress
 *   --single [N]     Run only the next issue (or issue #N), then stop
 *   --from N         Start from issue #N
 *   --reset          Clear state and start fresh
 *   --skip-e2e       Skip E2E verification step
 *   --skip-split     Skip issue splitting assessment
 *   --no-verify      Skip verification requirement
 */

import { orchestrate, parseFlags } from './tools/orchestrator/index.ts';
import { analyze, parseAnalyzeFlags } from './tools/analyze/index.ts';
import { verify, parseVerifyFlags } from './tools/verify/index.ts';
import { finalize, parseFinalizeFlags } from './tools/finalize/index.ts';
import { setup } from './tools/setup.ts';
import { $ } from 'bun';
import { join } from 'node:path';

async function getVersion(): Promise<string> {
	const pkg = await Bun.file(join(import.meta.dir, 'package.json')).json();
	return pkg.version;
}

const HELP = `\x1b[36mpait\x1b[0m — PAI Tools CLI

\x1b[1mUSAGE\x1b[0m
  pait <command> [flags]

\x1b[1mCOMMANDS\x1b[0m
  orchestrate    Run the issue orchestrator
  analyze        Analyze file structure, suggest splits (AI-powered)
  verify         Run verification commands
  finalize       Merge orchestrated PRs
  update         Pull latest pai-tools from remote
  version        Show current version
  setup          Register pait globally and configure PATH
  help           Show this help message

\x1b[1mANALYZE FLAGS\x1b[0m
  <path>           Target directory or file (default: .)
  --threshold <N>  Soft line threshold (default: auto per language)
  --tier1-only     Skip AI analysis, heuristics only
  --issues         Create GitHub issues for recommendations
  --dry-run        Show what issues would be created
  --format <type>  Output: terminal (default) | json
  --budget <N>     Max AI analysis calls (default: 50)
  --include <glob> Additional glob patterns to include
  --quiet, -q     Show only flagged files (default: show all)
  --verbose        Show detailed analysis output

\x1b[1mORCHESTRATOR FLAGS\x1b[0m
  --dry-run        Show execution plan without acting
  --status         Show current progress
  --single [N]     Run only the next issue (or issue #N), then stop
  --from N         Start from issue #N
  --reset          Clear state and start fresh
  --skip-e2e       Skip E2E verification step
  --skip-split     Skip issue splitting assessment
  --no-verify      Skip verification requirement
  --parallel <N>   Run N issues concurrently (default: 1 = sequential)

\x1b[1mVERIFY FLAGS\x1b[0m
  --skip-e2e       Skip E2E verification step
  --name <step>    Run only the named step
  --json           Output results as JSON

\x1b[1mFINALIZE FLAGS\x1b[0m
  --dry-run           Show merge plan without acting
  --single            Merge only the next PR, then stop
  --no-verify         Skip post-merge verification
  --strategy <type>   Merge strategy: squash (default) | merge | rebase
  --from <N>          Start from issue #N
  --auto-resolve      Resolve conflicts via Claude (non-interactive)

\x1b[90mhttps://github.com/SaintPepsi/pai-tools\x1b[0m
`;

type CommandHandler = () => Promise<void>;

const commands = new Map<string, CommandHandler>([
	['orchestrate', async () => {
		const flags = parseFlags(process.argv.slice(3));
		await orchestrate(flags);
	}],
	['analyze', async () => {
		const flags = parseAnalyzeFlags(process.argv.slice(3));
		await analyze(flags);
	}],
	['verify', async () => {
		const flags = parseVerifyFlags(process.argv.slice(3));
		await verify(flags);
	}],
	['finalize', async () => {
		const flags = parseFinalizeFlags(process.argv.slice(3));
		await finalize(flags);
	}],
	['setup', setup],
	['update', async () => {
		const repoRoot = import.meta.dir;
		const before = await getVersion();
		console.log(`\x1b[36m[INFO]\x1b[0m Updating pai-tools from v${before}...`);

		const currentBranch = (await $`git -C ${repoRoot} rev-parse --abbrev-ref HEAD`.text()).trim();
		const needSwitch = currentBranch !== 'master';
		let didStash = false;

		if (needSwitch) {
			const status = (await $`git -C ${repoRoot} status --porcelain`.text()).trim();
			if (status) {
				await $`git -C ${repoRoot} stash push -m "pait-update-autostash"`.quiet();
				didStash = true;
			}
			await $`git -C ${repoRoot} checkout master`.quiet();
		}

		const result = await $`git -C ${repoRoot} pull --ff-only`.text();
		console.log(result.trim());
		const after = await getVersion();

		if (needSwitch) {
			await $`git -C ${repoRoot} checkout ${currentBranch}`.quiet();
			if (didStash) await $`git -C ${repoRoot} stash pop`.quiet().nothrow();
		}

		if (before === after) {
			console.log(`\x1b[32m[OK]\x1b[0m pai-tools v${after} is up to date`);
		} else {
			console.log(`\x1b[32m[OK]\x1b[0m pai-tools updated: v${before} → v${after}`);
		}
	}],
	['version', async () => {
		const v = await getVersion();
		console.log(`pait v${v}`);
	}],
	['help', async () => {
		console.log(HELP);
	}]
]);

async function main(): Promise<void> {
	const subcommand = process.argv[2];

	if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
		console.log(HELP);
		return;
	}

	if (subcommand === '--version' || subcommand === '-V') {
		const v = await getVersion();
		console.log(`pait v${v}`);
		return;
	}

	const handler = commands.get(subcommand);
	if (!handler) {
		console.error(`Unknown command: ${subcommand}\n`);
		console.log(HELP);
		process.exit(1);
	}

	await handler();
}

main().catch((err) => {
	console.error(`\x1b[31m[FATAL]\x1b[0m ${err}`);
	process.exit(1);
});
