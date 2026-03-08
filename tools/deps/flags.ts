import type { DepsFlags, DepsSubcommand } from 'tools/deps/types.ts';

// ─── Help Text ───────────────────────────────────────────────────────────────

const DEPS_HELP = `\x1b[36mpait deps\x1b[0m — Manage GitHub issue dependency relationships

\x1b[1mUSAGE\x1b[0m
  pait deps <subcommand> [flags]

\x1b[1mSUBCOMMANDS\x1b[0m
  add        Add a dependency relationship between issues
  remove     Remove a dependency relationship between issues
  list       List dependency relationships for an issue
  tree       Show the full dependency tree rooted at an issue
  validate   Check for cycles or inconsistencies in the graph
  sync       Sync dependency metadata to/from GitHub

\x1b[1mFLAGS\x1b[0m
  --issue <N>       Target issue number
  --blocks <N>      Issue number that the target issue blocks
  --blocked-by <N>  Issue number that blocks the target issue
  --parent <N>      Parent issue number (sets a sub-issue relationship)
  --child <N>       Child/sub-issue number
  --apply           Apply pending changes without prompting
  --json            Output as JSON instead of terminal format
  --help, -h        Show this help message

\x1b[1mEXAMPLES\x1b[0m
  pait deps add --issue 12 --blocked-by 10
  pait deps remove --issue 12 --blocked-by 10
  pait deps list --issue 12
  pait deps tree --issue 12
  pait deps validate
  pait deps sync --apply

\x1b[90mhttps://github.com/SaintPepsi/pai-tools\x1b[0m
`;

// ─── Subcommand Set ──────────────────────────────────────────────────────────

const SUBCOMMANDS = new Set<DepsSubcommand>(['add', 'remove', 'list', 'tree', 'validate', 'sync']);

function isSubcommand(value: string): value is DepsSubcommand {
	return SUBCOMMANDS.has(value as DepsSubcommand);
}

// ─── Flag Parser ─────────────────────────────────────────────────────────────

export function parseDepsFlags(args: string[]): DepsFlags {
	const flags: DepsFlags = {
		subcommand: null,
		issue: null,
		blocks: null,
		blockedBy: null,
		parent: null,
		child: null,
		apply: false,
		json: false,
		help: false,
	};

	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		switch (arg) {
			case '--help':
			case '-h':
				flags.help = true;
				console.log(DEPS_HELP);
				process.exit(0);
				break;
			case '--issue':
				flags.issue = parseInt(args[++i], 10);
				break;
			case '--blocks':
				flags.blocks = parseInt(args[++i], 10);
				break;
			case '--blocked-by':
				flags.blockedBy = parseInt(args[++i], 10);
				break;
			case '--parent':
				flags.parent = parseInt(args[++i], 10);
				break;
			case '--child':
				flags.child = parseInt(args[++i], 10);
				break;
			case '--apply':
				flags.apply = true;
				break;
			case '--json':
				flags.json = true;
				break;
			default:
				if (!arg.startsWith('-') && isSubcommand(arg)) {
					flags.subcommand = arg;
				}
				break;
		}
		i++;
	}

	return flags;
}
