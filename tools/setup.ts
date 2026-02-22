/**
 * pait setup — Register pait globally via shell alias or bun link.
 *
 * Detects the user's shell config, checks for an existing pait alias,
 * and offers to add one pointing directly at the repo's cli.ts.
 * Falls back to bun link + PATH setup if the user declines.
 * Idempotent — safe to run multiple times.
 */

import { $ } from 'bun';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../shared/log.ts';

const BUN_BIN = join(process.env.HOME ?? '', '.bun', 'bin');
const PATH_EXPORT_LINE = 'export PATH="$HOME/.bun/bin:$PATH"';

function detectShellConfig(): string | null {
	const home = process.env.HOME ?? '';
	const shell = process.env.SHELL ?? '';

	if (shell.includes('zsh')) {
		const zshrc = join(home, '.zshrc');
		if (existsSync(zshrc)) return zshrc;
	}

	if (shell.includes('bash')) {
		for (const name of ['.bashrc', '.bash_profile', '.profile']) {
			const path = join(home, name);
			if (existsSync(path)) return path;
		}
	}

	for (const name of ['.zshrc', '.bashrc', '.bash_profile', '.profile']) {
		const path = join(home, name);
		if (existsSync(path)) return path;
	}

	return null;
}

function hasPaitAlias(configPath: string): boolean {
	const content = readFileSync(configPath, 'utf-8');
	return /alias pait=/.test(content);
}

function hasBunBinInPath(configPath: string): boolean {
	const content = readFileSync(configPath, 'utf-8');
	return /\.bun\/bin/.test(content) && /PATH/.test(content);
}

async function prompt(question: string): Promise<string> {
	process.stdout.write(`\x1b[36m?\x1b[0m ${question} `);
	for await (const line of console) {
		return line.trim();
	}
	return '';
}

export async function setup(): Promise<void> {
	log.step('PAI TOOLS SETUP');

	const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
	const cliPath = join(repoRoot, 'cli.ts');

	// Step 1: Detect shell config
	const configPath = detectShellConfig();
	if (!configPath) {
		log.warn('Could not detect shell config file (.zshrc, .bashrc, etc.)');
		log.info(`Manually add to your shell config:\n  alias pait='bun ${cliPath}'`);
		return;
	}

	log.info(`Shell config: ${configPath}`);

	// Step 2: Check for existing pait alias
	if (hasPaitAlias(configPath)) {
		log.ok('pait alias already exists in shell config');
		log.ok('Setup complete. Run `pait help` to verify.');
		return;
	}

	// Step 3: Ask user which method they prefer
	const aliasLine = `alias pait='bun ${cliPath}'`;

	console.log('');
	console.log('  How should pait be registered globally?\n');
	console.log('  \x1b[1m1)\x1b[0m Shell alias (recommended)');
	console.log(`     Adds \x1b[2m${aliasLine}\x1b[0m to ${configPath}`);
	console.log('');
	console.log('  \x1b[1m2)\x1b[0m bun link + PATH');
	console.log('     Registers via bun link and ensures ~/.bun/bin is in PATH');
	console.log('');

	const answer = await prompt('Choice [1/2]:');

	if (answer === '2') {
		await setupBunLink(repoRoot, configPath);
	} else {
		await setupAlias(aliasLine, configPath);
	}

	log.ok('Setup complete. Run `pait help` to verify.');
}

async function setupAlias(aliasLine: string, configPath: string): Promise<void> {
	log.info('Adding pait alias...');
	appendFileSync(configPath, `\n# pai-tools CLI\n${aliasLine}\n`);
	log.ok(`Added to ${configPath}`);
	log.info('Run `source ~/.zshrc` or open a new terminal for it to take effect');
}

async function setupBunLink(repoRoot: string, configPath: string): Promise<void> {
	// bun link
	log.info('Registering pait binary via bun link...');
	try {
		const result = await $`bun link`.cwd(repoRoot).text();
		log.ok('bun link complete');
		log.dim(`  ${result.trim().split('\n')[0]}`);
	} catch (err) {
		log.error(`bun link failed: ${err}`);
		process.exit(1);
	}

	// Ensure ~/.bun/bin exists
	if (!existsSync(BUN_BIN)) {
		log.warn(`${BUN_BIN} does not exist — bun may not be fully installed`);
		return;
	}

	// Ensure PATH includes .bun/bin
	if (hasBunBinInPath(configPath)) {
		log.ok('~/.bun/bin is already in PATH');
	} else {
		log.info('Adding ~/.bun/bin to PATH...');
		appendFileSync(configPath, `\n# bun global binaries\n${PATH_EXPORT_LINE}\n`);
		log.ok(`Added to ${configPath}`);
		log.info('Run `source ~/.zshrc` or open a new terminal for it to take effect');
	}

	// Verify binary
	const paitPath = join(BUN_BIN, 'pait');
	if (existsSync(paitPath)) {
		log.ok(`pait binary found at ${paitPath}`);
	} else {
		log.warn('pait binary not found in ~/.bun/bin — try running again');
	}
}
