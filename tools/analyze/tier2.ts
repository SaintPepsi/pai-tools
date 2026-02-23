import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { log } from '../../shared/log.ts';
import { runClaude } from '../../shared/claude.ts';
import type { Tier2Result } from './types.ts';
import { getLanguageProfile } from './discovery.ts';

// ─── Tier 2: AI Semantic Analysis ───────────────────────────────────────────

export const ANALYSIS_PROMPT = `You are a code structure analyst specializing in SOLID principles. Analyze this file using these precise definitions:

## Single Responsibility Principle (SRP)
Robert C. Martin: "A module should have one, and only one, reason to change."
A "reason to change" means one actor or stakeholder. If two different actors (e.g., the CFO and the CTO) would request changes to the same file for different reasons, that file violates SRP. The test: "If I describe what this file does, do I need the word 'and'?" If yes, it likely has multiple responsibilities.

Look for:
- Multiple unrelated groups of functions that serve different stakeholders
- Mixed concerns: business logic alongside I/O, formatting alongside computation, parsing alongside rendering
- Functions that change for different reasons at different times

## Dependency Inversion Principle (DIP)
Robert C. Martin: "High-level modules should not depend on low-level modules. Both should depend on abstractions. Abstractions should not depend on details. Details should depend on abstractions."
The test: Does this file import concrete implementations directly (database drivers, HTTP clients, file system calls, specific API clients) when it could depend on an interface or abstraction instead? High-level policy code should not know about low-level implementation details.

Look for:
- Direct imports of concrete implementations where an interface/type would allow swapping
- High-level orchestration code mixed with low-level I/O or infrastructure details
- Tight coupling to specific libraries that makes testing or replacement difficult

## Additional Principles
- DRY: Is there duplicated logic that indicates mixed concerns being handled in parallel?
- YAGNI: Are there unused abstractions or over-engineered patterns that add complexity without value?

Respond in this exact JSON format (no markdown, no code fences, just raw JSON):
{
  "responsibilities": [
    {"name": "short name", "description": "what this responsibility does", "lineRanges": "e.g. 1-50, 120-180"}
  ],
  "suggestions": [
    {"filename": "suggested-file-name.ts", "responsibilities": ["responsibility name"], "rationale": "why this split makes sense"}
  ],
  "principles": ["SRP: explanation of specific violation", "DIP: explanation of specific violation"],
  "effort": "low|medium|high",
  "summary": "One paragraph summary of the file's structure problems and recommended refactoring approach"
}

Rules:
- Only suggest splits that genuinely improve the codebase
- Each suggested file should have a clear, single responsibility (one reason to change)
- For each SRP violation, name the two distinct actors/reasons that would drive changes
- For each DIP violation, name the concrete dependency and what abstraction would replace it
- If the file is actually well-structured despite its size, say so — size alone is not a violation
- "effort" reflects the difficulty of the refactoring, not the file's badness
- Keep responsibility names short (2-4 words)`;

export async function analyzeTier2(filePath: string, repoRoot: string): Promise<Tier2Result | null> {
	let content: string;
	try {
		content = readFileSync(filePath, 'utf-8');
	} catch {
		return null;
	}

	// Truncate very large files to avoid overwhelming the model
	const maxChars = 32_000;
	const truncated = content.length > maxChars
		? content.slice(0, maxChars) + '\n\n[... truncated ...]'
		: content;

	const userPrompt = `File: ${basename(filePath)}\nLanguage: ${getLanguageProfile(filePath).name}\n\n${truncated}`;

	const result = await runClaude({
		prompt: `${ANALYSIS_PROMPT}\n\n${userPrompt}`,
		model: 'sonnet',
		cwd: repoRoot,
	});

	if (!result.ok) {
		log.warn(`AI analysis failed for ${basename(filePath)}: ${result.output.slice(0, 100)}`);
		return null;
	}

	try {
		// Extract JSON from response (handle potential markdown wrapping)
		const jsonMatch = result.output.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			log.warn(`No JSON in AI response for ${basename(filePath)}`);
			return null;
		}
		const parsed = JSON.parse(jsonMatch[0]) as Tier2Result;
		return { ...parsed, file: filePath };
	} catch (e) {
		log.warn(`Failed to parse AI response for ${basename(filePath)}`);
		return null;
	}
}
