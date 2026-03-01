/**
 * Markdown checklist → GitHubIssue[] adapter.
 *
 * Parses markdown content with checkbox items and converts unchecked items
 * into GitHubIssue-compatible objects that the orchestrator can process.
 *
 * Supported format:
 *   ## Section Header
 *   ### Sub-section
 *   - [x] Completed item (skipped)
 *   - [ ] Open item (becomes an issue)
 *     - [ ] Sub-item (folded into parent body as acceptance criteria)
 *
 * Dependencies: "depends on #N" in item text is preserved for parseDependencies().
 * Numbering: all items (checked + unchecked) get sequential numbers; only unchecked
 * items are returned. This lets deps reference completed items without breaking.
 */

import type { GitHubIssue } from '../../shared/github.ts';

interface ParsedItem {
	number: number;
	title: string;
	body: string;
	checked: boolean;
	section: string;
	subSection: string;
}

/**
 * Parse markdown content string into GitHubIssue-compatible objects.
 * Pure function — no I/O.
 */
export function parseMarkdownContent(content: string): GitHubIssue[] {
	const lines = content.split('\n');

	const items: ParsedItem[] = [];
	let currentSection = '';
	let currentSubSection = '';
	let itemNumber = 0;
	let lastTopLevelItem: ParsedItem | null = null;

	for (const line of lines) {
		// ## Section header (but not ### sub-section)
		if (/^##\s+/.test(line) && !/^###/.test(line)) {
			const match = line.match(/^##\s+(.+)/);
			if (match) {
				currentSection = match[1].trim();
				currentSubSection = '';
			}
			continue;
		}

		// ### Sub-section header
		const subMatch = line.match(/^###\s+(.+)/);
		if (subMatch) {
			currentSubSection = subMatch[1].trim();
			continue;
		}

		// Indented checklist item → fold into parent body
		const indentedMatch = line.match(/^(\s{2,})-\s*\[(.)\]\s+(.+)/);
		if (indentedMatch && lastTopLevelItem) {
			const checked = indentedMatch[2].toLowerCase() === 'x';
			const text = stripMarkdown(indentedMatch[3]);
			const marker = checked ? '[x]' : '[ ]';
			lastTopLevelItem.body += `\n  - ${marker} ${text}`;
			continue;
		}

		// Top-level checklist item
		const itemMatch = line.match(/^-\s*\[(.)\]\s+(.+)/);
		if (itemMatch) {
			itemNumber++;
			const checked = itemMatch[1].toLowerCase() === 'x';
			const rawTitle = itemMatch[2].trim();
			const title = stripMarkdown(rawTitle);

			const bodyParts: string[] = [];
			if (currentSection) bodyParts.push(`## ${currentSection}`);
			if (currentSubSection) bodyParts.push(`### ${currentSubSection}`);
			bodyParts.push('', title);

			// Preserve dependency markers for parseDependencies()
			const depMatch = rawTitle.match(/depends\s+on\s+[#\d,\s]+/i);
			if (depMatch) {
				bodyParts.push('', `> Depends on ${depMatch[0].replace(/^depends\s+on\s+/i, '')}`);
			}

			const item: ParsedItem = {
				number: itemNumber,
				title,
				body: bodyParts.join('\n'),
				checked,
				section: currentSection,
				subSection: currentSubSection,
			};

			items.push(item);
			lastTopLevelItem = item;
			continue;
		}

		// Non-checklist line after a top-level item — reset parent tracking
		if (line.trim() !== '' && !line.startsWith('  ')) {
			lastTopLevelItem = null;
		}
	}

	// Return only unchecked items as open issues
	return items
		.filter((item) => !item.checked)
		.map((item) => ({
			number: item.number,
			title: item.title,
			body: item.body,
			state: 'open',
			labels: item.section ? [{ name: item.section }] : [],
		}));
}

/** Strip markdown formatting (bold, inline code) from text. */
function stripMarkdown(text: string): string {
	return text
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/`([^`]+)`/g, '$1')
		.trim();
}
