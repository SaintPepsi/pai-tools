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

export interface ClaudeProcess {
	stdout: ReadableStream<Uint8Array> | null;
	exited: Promise<number>;
}

export interface ClaudeDeps {
	spawn: (cmd: string[], opts: {
		cwd: string;
		stdin: Blob;
		stdout: 'pipe';
		stderr: 'pipe';
		env: Record<string, string>;
	}) => ClaudeProcess;
	env: Record<string, string | undefined>;
}

export const defaultDeps: ClaudeDeps = {
	spawn: (cmd, opts) => Bun.spawn(cmd, opts) as ClaudeProcess,
	env: process.env as Record<string, string | undefined>,
};

export async function runClaude(
	opts: RunClaudeOpts,
	deps: ClaudeDeps = defaultDeps
): Promise<{ ok: boolean; output: string }> {
	const args = ['-p', '--model', opts.model];
	if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
	if (opts.allowedTools) args.push('--allowedTools', opts.allowedTools);

	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(deps.env)) {
		if (v !== undefined) env[k] = v;
	}
	env['CLAUDECODE'] = '';

	const proc = deps.spawn(['claude', ...args], {
		cwd: opts.cwd,
		stdin: new Blob([opts.prompt]),
		stdout: 'pipe',
		stderr: 'pipe',
		env,
	});

	const output = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;

	return { ok: exitCode === 0, output };
}
