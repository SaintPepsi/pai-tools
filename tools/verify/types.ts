/**
 * Types for the standalone verification tool.
 */

export interface VerifyCommand {
	name: string;
	cmd: string;
}

export interface E2EConfig {
	run: string;
	update: string;
	snapshotGlob: string;
}

export interface VerifyStepResult {
	name: string;
	ok: boolean;
	durationMs: number;
	error?: string;
}

export interface VerifyResult {
	ok: boolean;
	steps: VerifyStepResult[];
	failedStep?: string;
	error?: string;
}

/** Duck-typed logger — any object with these methods works. */
export interface VerifyLogger {
	verifyPass(issueNumber: number, step: string): void;
	verifyFail(issueNumber: number, step: string, error: string): void;
}

export interface VerifyOptions {
	verify: VerifyCommand[];
	e2e?: E2EConfig;
	cwd: string;
	skipE2e?: boolean;
	filterName?: string;
	logger?: VerifyLogger;
	issueNumber?: number;
}

export interface VerifyFlags {
	skipE2e: boolean;
	filterName: string | null;
	json: boolean;
	help: boolean;
}
