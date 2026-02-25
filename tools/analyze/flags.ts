import type { RefactorFlags } from './types.ts';

// ─── Help Text ──────────────────────────────────────────────────────────────

const REFACTOR_HELP = `\x1b[36mpait analyze\x1b[0m — AI-powered file structure analyzer

\x1b[1mUSAGE\x1b[0m
  pait analyze [path] [flags]

\x1b[1mARGUMENTS\x1b[0m
  path               Target directory or file (default: .)

\x1b[1mFLAGS\x1b[0m
  --threshold <N>    Soft line threshold override (default: auto per language)
  --tier1-only       Skip AI analysis, run heuristics only (free, instant)
  --issues           Create GitHub issues for flagged files
  --dry-run          Preview issues without creating them
  --format <type>    Output format: terminal (default) | json
  --budget <N>       Max AI analysis calls (default: 50)
  --include <glob>   Only analyze matching files
  --verbose          Show all files including OK ones (default)
  --quiet, -q        Show only flagged files
  --help, -h         Show this help message

\x1b[1mEXAMPLES\x1b[0m
  pait analyze ./src                        Full two-tier analysis
  pait analyze ./src --tier1-only           Heuristics only (free)
  pait analyze ./src --issues --dry-run     Preview GitHub issues
  pait analyze ./src --format json          JSON output for CI
  pait analyze . --threshold 150            Custom line threshold
  pait analyze ./src --budget 10            Limit AI calls to 10

\x1b[1mANALYSIS TIERS\x1b[0m
  \x1b[33mTier 1 (Heuristic)\x1b[0m  Free, instant. Line count, function/export/class
                       density, import fan-in. Flags candidates for Tier 2.
  \x1b[35mTier 2 (AI)\x1b[0m         Claude Sonnet semantic analysis. Detects SRP and DIP
                       violations, suggests concrete file splits with rationale.

\x1b[1mPRINCIPLES\x1b[0m
  SRP   A module should have one, and only one, reason to change (Martin)
  DIP   High-level modules should not depend on low-level modules;
        both should depend on abstractions (Martin)
  DRY   Don't repeat yourself — duplicated logic signals mixed concerns
  YAGNI You aren't gonna need it — don't over-abstract prematurely

\x1b[1mCONFIG\x1b[0m
  Per-project overrides in .pait/analyze.json:
  { "softThreshold": 200, "hardThreshold": 400, "ignore": ["generated/"] }

\x1b[90mhttps://github.com/SaintPepsi/pai-tools\x1b[0m
`;

// ─── Flag Parser ────────────────────────────────────────────────────────────

export function parseAnalyzeFlags(args: string[]): RefactorFlags {
	const flags: RefactorFlags = {
		path: '.',
		threshold: null,
		tier1Only: false,
		issues: false,
		dryRun: false,
		format: 'terminal',
		budget: 50,
		include: null,
		verbose: true,
	};

	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		switch (arg) {
			case '--help':
			case '-h':
				console.log(REFACTOR_HELP);
				process.exit(0);
			case '--threshold':
				flags.threshold = parseInt(args[++i], 10);
				break;
			case '--tier1-only':
				flags.tier1Only = true;
				break;
			case '--issues':
				flags.issues = true;
				break;
			case '--dry-run':
				flags.dryRun = true;
				break;
			case '--format':
				flags.format = args[++i] as 'terminal' | 'json';
				break;
			case '--budget':
				flags.budget = parseInt(args[++i], 10);
				break;
			case '--include':
				flags.include = args[++i];
				break;
			case '--verbose':
				flags.verbose = true;
				break;
			case '--quiet':
			case '-q':
				flags.verbose = false;
				break;
			default:
				if (!arg.startsWith('-')) {
					flags.path = arg;
				}
				break;
		}
		i++;
	}

	return flags;
}
