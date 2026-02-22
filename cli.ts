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
 */

import { orchestrate, parseFlags } from './tools/orchestrator/index.ts';
import { setup } from './tools/setup.ts';

const HELP = `\x1b[36mpait\x1b[0m — PAI Tools CLI

\x1b[1mUSAGE\x1b[0m
  pait <command> [flags]

\x1b[1mCOMMANDS\x1b[0m
  orchestrate    Run the issue orchestrator
  setup          Register pait globally and configure PATH
  help           Show this help message

\x1b[1mORCHESTRATOR FLAGS\x1b[0m
  --dry-run        Show execution plan without acting
  --status         Show current progress
  --single [N]     Run only the next issue (or issue #N), then stop
  --from N         Start from issue #N
  --reset          Clear state and start fresh
  --skip-e2e       Skip E2E verification step
  --skip-split     Skip issue splitting assessment
`;

type CommandHandler = () => Promise<void>;

const commands = new Map<string, CommandHandler>([
	['orchestrate', async () => {
		const flags = parseFlags(process.argv.slice(3));
		await orchestrate(flags);
	}],
	['setup', setup],
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
