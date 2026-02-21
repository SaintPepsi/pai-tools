/**
 * Claude CLI helper — pipes prompt via stdin to avoid ARG_MAX / shell escaping.
 */

export interface RunClaudeOpts {
	prompt: string;
	model: string;
	cwd: string;
	permissionMode?: string;
	allowedTools?: string;
}

export async function runClaude(opts: RunClaudeOpts): Promise<{ ok: boolean; output: string }> {
	const args = ['-p', '--model', opts.model];
	if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
	if (opts.allowedTools) args.push('--allowedTools', opts.allowedTools);

	const proc = Bun.spawn(['claude', ...args], {
		cwd: opts.cwd,
		stdin: new Blob([opts.prompt]),
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, CLAUDECODE: '' }
	});

	const output = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;

	return { ok: exitCode === 0, output };
}
