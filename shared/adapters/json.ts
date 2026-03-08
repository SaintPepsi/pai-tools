/**
 * Adapter: safe JSON parsing behind an injectable interface.
 * This file is exempt from the raw-import coding standard (adapters/ directory).
 */

export type JsonParseResult = { ok: true; value: unknown } | { ok: false };

/** Parse JSON text, returning an explicit ok/fail result instead of throwing. */
export function safeJsonParse(text: string): JsonParseResult {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}
