/**
 * Colored terminal logging utilities.
 */

export const log = {
	info: (msg: string) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
	ok: (msg: string) => console.log(`\x1b[32m[OK]\x1b[0m ${msg}`),
	warn: (msg: string) => console.log(`\x1b[33m[WARN]\x1b[0m ${msg}`),
	error: (msg: string) => console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
	step: (msg: string) => console.log(`\n\x1b[35m━━━ ${msg} ━━━\x1b[0m`),
	dim: (msg: string) => console.log(`\x1b[2m${msg}\x1b[0m`)
};
