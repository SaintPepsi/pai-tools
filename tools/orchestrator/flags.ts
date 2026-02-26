import type { OrchestratorFlags } from './types.ts';

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

	const parallel = (() => {
		const idx = args.indexOf('--parallel');
		if (idx === -1) return 1;
		const val = Number(args[idx + 1]);
		if (Number.isNaN(val) || val < 1) {
			console.error('--parallel requires a positive integer (e.g. --parallel 3)');
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
		fromIssue,
		parallel
	};
}
