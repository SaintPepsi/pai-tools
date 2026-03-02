/**
 * Shared git infrastructure helpers.
 *
 * Branch operations, worktree management, and conflict resolution
 * used by both the orchestrator and finalize tools.
 */

import { join, resolve } from 'node:path';
import { log } from './log.ts';
import { promptLine, defaultPromptDeps } from './prompt.ts';
import { runClaude, defaultDeps as defaultClaudeDeps } from './claude.ts';
import type { RunClaudeOpts } from './claude.ts';
import type { RunLogger } from './logging.ts';
import type { FsAdapter } from './adapters/fs.ts';
import { defaultFsAdapter } from './adapters/fs.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal config required for worktree operations. */
export interface WorktreeConfig {
	worktreeDir: string;
	baseBranch: string;
}

export interface ConflictInfo {
	file: string;
}

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface GitDeps {
	/** Run a shell command, returning exit code + captured stdout/stderr. */
	exec: (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
	/** Filesystem operations. */
	fs: FsAdapter;
	/** Current process environment variables (injected so callers can override). */
	env: Record<string, string | undefined>;
	/** Invoke the Claude CLI to resolve conflicts. */
	claude: (opts: RunClaudeOpts) => Promise<{ ok: boolean; output: string }>;
	/** Prompt the user for a single line of input. */
	prompt: (question: string) => Promise<string>;
}

async function defaultExec(cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
	const proc = Bun.spawnSync(cmd, { cwd: opts?.cwd, env: opts?.env });
	return {
		exitCode: proc.exitCode ?? 1,
		stdout: proc.stdout?.toString() ?? '',
		stderr: proc.stderr?.toString() ?? '',
	};
}

const defaultDeps: GitDeps = {
	exec: defaultExec,
	fs: defaultFsAdapter,
	env: process.env as Record<string, string | undefined>,
	claude: runClaude,
	prompt: promptLine,
};

export const defaultGitDeps: GitDeps = defaultDeps;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Run a git command, return ok + trimmed stdout/stderr. */
async function git(
	args: string[],
	cwd: string,
	deps: GitDeps,
	extraEnv?: Record<string, string>
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const r = await deps.exec(['git', ...args], { cwd, env: extraEnv });
	return { ok: r.exitCode === 0, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

// ---------------------------------------------------------------------------
// Branch operations
// ---------------------------------------------------------------------------

export async function localBranchExists(name: string, repoRoot: string, deps: GitDeps = defaultDeps): Promise<boolean> {
	const r = await git(['-C', repoRoot, 'rev-parse', '--verify', `refs/heads/${name}`], repoRoot, deps);
	return r.ok;
}

export async function deleteLocalBranch(name: string, repoRoot: string, deps: GitDeps = defaultDeps): Promise<void> {
	if (await localBranchExists(name, repoRoot, deps)) {
		await git(['-C', repoRoot, 'branch', '-D', name], repoRoot, deps);
	}
}

// ---------------------------------------------------------------------------
// Worktree operations
// ---------------------------------------------------------------------------

export async function createWorktree(
	branchName: string,
	depBranches: string[],
	config: WorktreeConfig,
	repoRoot: string,
	logger: RunLogger,
	issueNumber: number,
	deps: GitDeps = defaultDeps
): Promise<{ ok: boolean; worktreePath: string; baseBranch: string; error?: string }> {
	const worktreeDir = resolve(repoRoot, config.worktreeDir);
	const slug = branchName.replace(/\//g, '-');
	const worktreePath = join(worktreeDir, slug);

	// Clean up any leftover worktree from a previous run (ignore failure)
	await git(['-C', repoRoot, 'worktree', 'remove', '--force', worktreePath], repoRoot, deps);
	if (deps.fs.fileExists(worktreePath)) {
		deps.fs.rmrf(worktreePath);
	}

	// Delete stale local branch if it exists
	await deleteLocalBranch(branchName, repoRoot, deps);

	// Determine base branch from dependencies
	const existingDeps: string[] = [];
	for (const dep of depBranches) {
		if (await localBranchExists(dep, repoRoot, deps)) {
			existingDeps.push(dep);
		}
	}
	const baseBranch = existingDeps.length > 0 ? existingDeps[0] : config.baseBranch;

	const created = await git(
		['-C', repoRoot, 'worktree', 'add', '-b', branchName, worktreePath, baseBranch],
		repoRoot,
		deps
	);
	if (!created.ok) {
		return {
			ok: false,
			worktreePath,
			baseBranch,
			error: `Failed to create worktree for ${branchName}: ${created.stderr}`
		};
	}

	logger.worktreeCreated(issueNumber, worktreePath, branchName);
	logger.branchCreated(issueNumber, branchName, baseBranch);

	// Merge additional dependency branches inside the worktree
	for (let i = 1; i < existingDeps.length; i++) {
		const mergeMsg = `Merge dependency branch ${existingDeps[i]}`;
		const merged = await git(
			['-C', worktreePath, 'merge', existingDeps[i], '--no-edit', '-m', mergeMsg],
			worktreePath,
			deps
		);
		if (!merged.ok) {
			await git(['-C', worktreePath, 'merge', '--abort'], worktreePath, deps);
			await removeWorktree(worktreePath, branchName, repoRoot, logger, issueNumber, deps);
			return {
				ok: false,
				worktreePath,
				baseBranch,
				error: `Merge conflict merging ${existingDeps[i]} into ${branchName} (based on ${baseBranch})`
			};
		}
	}

	return { ok: true, worktreePath, baseBranch };
}

export async function removeWorktree(
	worktreePath: string,
	branchName: string,
	repoRoot: string,
	logger: RunLogger,
	issueNumber: number,
	deps: GitDeps = defaultDeps
): Promise<void> {
	const removed = await git(['-C', repoRoot, 'worktree', 'remove', '--force', worktreePath], repoRoot, deps);
	if (!removed.ok) {
		// Force-remove the directory if git worktree remove fails
		if (deps.fs.fileExists(worktreePath)) {
			deps.fs.rmrf(worktreePath);
		}
		// Prune stale worktree entries
		await git(['-C', repoRoot, 'worktree', 'prune'], repoRoot, deps);
	}
	logger.worktreeRemoved(issueNumber, worktreePath);
}

// ---------------------------------------------------------------------------
// Rebase operations
// ---------------------------------------------------------------------------

export async function rebaseBranch(
	branch: string,
	onto: string,
	repoRoot: string,
	deps: GitDeps = defaultDeps
): Promise<{ ok: boolean; conflicts?: ConflictInfo[] }> {
	const co = await git(['-C', repoRoot, 'checkout', branch], repoRoot, deps);
	if (!co.ok) {
		return { ok: false };
	}

	const rb = await git(['-C', repoRoot, 'rebase', onto], repoRoot, deps);
	if (rb.ok) {
		return { ok: true };
	}

	// Check for conflicts
	const conflicts = await detectConflicts(repoRoot, deps);
	if (conflicts.length > 0) {
		return { ok: false, conflicts };
	}
	// Abort failed rebase that isn't a conflict
	await git(['-C', repoRoot, 'rebase', '--abort'], repoRoot, deps);
	return { ok: false };
}

export async function detectConflicts(repoRoot: string, deps: GitDeps = defaultDeps): Promise<ConflictInfo[]> {
	const r = await git(['-C', repoRoot, 'diff', '--name-only', '--diff-filter=U'], repoRoot, deps);
	if (!r.stdout) return [];
	return r.stdout.split('\n').filter(Boolean).map((file) => ({ file }));
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

export async function presentConflicts(
	conflicts: ConflictInfo[],
	deps: GitDeps = defaultDeps
): Promise<Map<string, string>> {
	const intents = new Map<string, string>();

	log.warn(`${conflicts.length} file(s) have conflicts:`);
	for (const c of conflicts) {
		console.log(`  - ${c.file}`);
	}
	console.log('');

	for (const c of conflicts) {
		log.info(`Conflict in: ${c.file}`);
		const answer = await deps.prompt('  Resolution (ours/theirs/describe intent): ');
		intents.set(c.file, answer.trim() || 'ours');
	}

	return intents;
}

export async function resolveConflicts(
	conflicts: ConflictInfo[],
	intents: Map<string, string>,
	repoRoot: string,
	deps: GitDeps = defaultDeps
): Promise<boolean> {
	for (const c of conflicts) {
		const intent = intents.get(c.file) ?? 'ours';

		if (intent === 'ours') {
			await git(['-C', repoRoot, 'checkout', '--ours', c.file], repoRoot, deps);
			await git(['-C', repoRoot, 'add', c.file], repoRoot, deps);
		} else if (intent === 'theirs') {
			await git(['-C', repoRoot, 'checkout', '--theirs', c.file], repoRoot, deps);
			await git(['-C', repoRoot, 'add', c.file], repoRoot, deps);
		} else {
			// Custom intent: use Claude to resolve
			const conflictContent = deps.fs.readFile(join(repoRoot, c.file));
			const prompt = `You are resolving a git merge conflict in the file "${c.file}".

The user's intent for resolving this conflict is: "${intent}"

Here is the file with conflict markers:

${conflictContent}

Output ONLY the resolved file content. No explanation, no code fences, just the file content.`;

			const result = await deps.claude({ prompt, model: 'sonnet', cwd: repoRoot });

			if (result.ok && result.output.trim()) {
				const validated = validateResolvedContent(result.output, c.file);
				if (!validated) {
					log.error(`Resolution validation failed for ${c.file}`);
					return false;
				}
				deps.fs.writeFile(join(repoRoot, c.file), validated);
				await git(['-C', repoRoot, 'add', c.file], repoRoot, deps);
			} else {
				log.error(`Failed to resolve ${c.file} via Claude`);
				return false;
			}
		}
	}

	// Continue rebase (GIT_EDITOR=true prevents editor from opening in non-interactive context)
	const editorEnv = { ...(deps.env as Record<string, string>), GIT_EDITOR: 'true' };
	const cont = await git(['-C', repoRoot, 'rebase', '--continue'], repoRoot, deps, editorEnv);
	if (cont.ok) {
		return true;
	}
	log.error('Rebase continue failed after conflict resolution');
	await git(['-C', repoRoot, 'rebase', '--abort'], repoRoot, deps);
	return false;
}

/**
 * Sanitize and validate Claude's conflict resolution output before writing.
 * Returns the cleaned content, or null if the output is invalid.
 */
function validateResolvedContent(raw: string, filePath: string): string | null {
	let content = raw;

	// Strip markdown code fences if Claude wrapped the output
	const fenceMatch = content.match(/^```[\w]*\n([\s\S]*?)\n```\s*$/);
	if (fenceMatch) {
		content = fenceMatch[1];
	}

	// Reject if conflict markers are still present (unresolved)
	if (/^<{7}\s|^={7}$|^>{7}\s/m.test(content)) {
		log.error(`Resolved content for ${filePath} still contains conflict markers`);
		return null;
	}

	// For code files, reject output that is clearly prose explanation instead of code
	const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html', '.sh', '.yaml', '.yml', '.toml'];
	const isCodeFile = codeExtensions.some((ext) => filePath.endsWith(ext));

	if (isCodeFile) {
		const firstLine = content.trim().split('\n')[0].trim();
		const prosePatterns = [
			/^(The |Here |I |This |Let me |Below |Above |Note |Sure |Okay |Ok )/i,
			/^(To resolve|The conflict|I've |I have |The resolved|The result)/i,
			/^\*\*/  // markdown bold (e.g. **Conflict 1**)
		];
		if (prosePatterns.some((p) => p.test(firstLine))) {
			log.error(`Resolved content for ${filePath} appears to be prose, not code: "${firstLine.slice(0, 60)}..."`);
			return null;
		}
	}

	return content;
}

export async function autoResolveConflicts(
	conflicts: ConflictInfo[],
	repoRoot: string,
	deps: GitDeps = defaultDeps
): Promise<boolean> {
	for (const c of conflicts) {
		const conflictContent = deps.fs.readFile(join(repoRoot, c.file));
		const prompt = `You are resolving a git merge conflict in the file "${c.file}".

Resolve this conflict by keeping both changes where possible. If the changes are incompatible, prefer the incoming (feature branch) version marked with >>>>>>> but integrate any non-conflicting parts from the current branch marked with <<<<<<<.

Here is the file with conflict markers:

${conflictContent}

Output ONLY the resolved file content. No explanation, no code fences, just the file content.`;

		const result = await deps.claude({ prompt, model: 'sonnet', cwd: repoRoot });

		if (!result.ok || !result.output.trim()) {
			log.error(`Failed to auto-resolve ${c.file}`);
			return false;
		}

		const validated = validateResolvedContent(result.output, c.file);
		if (!validated) {
			log.error(`Auto-resolve validation failed for ${c.file} — aborting`);
			return false;
		}

		deps.fs.writeFile(join(repoRoot, c.file), validated);
		await git(['-C', repoRoot, 'add', c.file], repoRoot, deps);
		log.ok(`Auto-resolved: ${c.file}`);
	}

	// Continue rebase (GIT_EDITOR=true prevents editor from opening in non-interactive context)
	const editorEnv = { ...(deps.env as Record<string, string>), GIT_EDITOR: 'true' };
	const cont = await git(['-C', repoRoot, 'rebase', '--continue'], repoRoot, deps, editorEnv);
	if (cont.ok) {
		return true;
	}
	log.error('Rebase continue failed after auto-resolution');
	await git(['-C', repoRoot, 'rebase', '--abort'], repoRoot, deps);
	return false;
}
