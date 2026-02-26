/**
 * Generic retry-with-fixer helper for the orchestrator.
 *
 * Runs `fn` up to `maxAttempts` times. After each failure (except the last),
 * calls `fixer(attempt)` to attempt a repair before retrying. `fn` must
 * return an object with an `ok: boolean` discriminant.
 *
 * Returns `{ ok: true, value }` on the first success, or `{ ok: false }` once
 * all attempts are exhausted.
 */
export async function withRetries<T extends { ok: boolean }>(
	fn: () => Promise<T>,
	fixer: (attempt: number) => Promise<void>,
	maxAttempts: number
): Promise<{ ok: true; value: T } | { ok: false }> {
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const result = await fn();
		if (result.ok) {
			return { ok: true, value: result };
		}

		// Run the fixer on every failed attempt except the last
		if (attempt < maxAttempts - 1) {
			await fixer(attempt);
		}
	}

	return { ok: false };
}
