/**
 * Claude CLI helper — pipes prompt via stdin to avoid ARG_MAX / shell escaping.
 */

export interface RunClaudeOpts {
	prompt: string;
	model: string;
	cwd: string;
	permissionMode?: string;
	allowedTools?: string;
	onChunk?: (chunk: string) => void;
}

export interface RunClaudeDeps {
	spawn: typeof Bun.spawn;
	env: Record<string, string | undefined>;
}

const defaultDeps: RunClaudeDeps = {
	spawn: Bun.spawn,
	env: process.env,
};

export async function runClaude(
	opts: RunClaudeOpts,
	deps: RunClaudeDeps = defaultDeps,
): Promise<{ ok: boolean; output: string }> {
	const args = ['-p', '--model', opts.model];
	if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
	if (opts.allowedTools) args.push('--allowedTools', opts.allowedTools);

	const proc = deps.spawn(['claude', ...args], {
		cwd: opts.cwd,
		stdin: new Blob([opts.prompt]),
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...deps.env, CLAUDECODE: '' },
	});

	const decoder = new TextDecoder();
	let output = '';

	for await (const chunk of proc.stdout) {
		const text = decoder.decode(chunk);
		output += text;
		opts.onChunk?.(text);
	}

	const exitCode = await proc.exited;

	return { ok: exitCode === 0, output };
}
