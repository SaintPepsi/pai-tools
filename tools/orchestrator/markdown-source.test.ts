import { describe, test, expect } from 'bun:test';
import { parseMarkdownContent } from './markdown-source.ts';

// ---------------------------------------------------------------------------
// parseMarkdownContent
// ---------------------------------------------------------------------------

describe('parseMarkdownContent', () => {
	test('returns empty array for empty content', () => {
		expect(parseMarkdownContent('')).toEqual([]);
	});

	test('returns empty array for content with no checklist items', () => {
		const md = `# Title\n\nSome paragraph text.\n\n## Section\n\nMore text.`;
		expect(parseMarkdownContent(md)).toEqual([]);
	});

	test('returns empty array when all items are checked', () => {
		const md = `- [x] Done task\n- [x] Another done task`;
		expect(parseMarkdownContent(md)).toEqual([]);
	});

	test('parses a single unchecked item', () => {
		const md = `- [ ] Implement login`;
		const result = parseMarkdownContent(md);
		expect(result).toHaveLength(1);
		expect(result[0].number).toBe(1);
		expect(result[0].title).toBe('Implement login');
		expect(result[0].state).toBe('open');
	});

	test('skips checked items and returns only unchecked', () => {
		const md = `- [x] Already done\n- [ ] Still open\n- [x] Also done`;
		const result = parseMarkdownContent(md);
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe('Still open');
	});

	test('numbering accounts for checked items', () => {
		const md = `- [x] First\n- [ ] Second\n- [x] Third\n- [ ] Fourth`;
		const result = parseMarkdownContent(md);
		expect(result).toHaveLength(2);
		expect(result[0].number).toBe(2);
		expect(result[0].title).toBe('Second');
		expect(result[1].number).toBe(4);
		expect(result[1].title).toBe('Fourth');
	});

	test('case insensitive checked marker', () => {
		const md = `- [X] Done with uppercase\n- [ ] Open`;
		const result = parseMarkdownContent(md);
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe('Open');
	});
});

// ---------------------------------------------------------------------------
// Sections and labels
// ---------------------------------------------------------------------------

describe('sections and labels', () => {
	test('assigns section as label', () => {
		const md = `## Backend\n- [ ] Add API endpoint`;
		const result = parseMarkdownContent(md);
		expect(result[0].labels).toEqual([{ name: 'Backend' }]);
	});

	test('items before any section get empty labels', () => {
		const md = `- [ ] Top-level task`;
		const result = parseMarkdownContent(md);
		expect(result[0].labels).toEqual([]);
	});

	test('section resets sub-section', () => {
		const md = [
			'## Backend',
			'### Auth',
			'- [ ] Auth task',
			'## Frontend',
			'- [ ] UI task',
		].join('\n');
		const result = parseMarkdownContent(md);
		expect(result[0].body).toContain('### Auth');
		expect(result[1].body).not.toContain('### Auth');
		expect(result[1].labels).toEqual([{ name: 'Frontend' }]);
	});

	test('sub-section header included in body', () => {
		const md = `## Core\n### Validation\n- [ ] Add input check`;
		const result = parseMarkdownContent(md);
		expect(result[0].body).toContain('## Core');
		expect(result[0].body).toContain('### Validation');
	});

	test('does not confuse ### with ##', () => {
		const md = `### Sub Only\n- [ ] Task under sub`;
		const result = parseMarkdownContent(md);
		// No ## section, so no section label
		expect(result[0].labels).toEqual([]);
		expect(result[0].body).toContain('### Sub Only');
	});
});

// ---------------------------------------------------------------------------
// Markdown stripping
// ---------------------------------------------------------------------------

describe('markdown stripping', () => {
	test('strips bold from title', () => {
		const md = `- [ ] **Important** task`;
		const result = parseMarkdownContent(md);
		expect(result[0].title).toBe('Important task');
	});

	test('strips inline code from title', () => {
		const md = '- [ ] Fix `parseFlags` function';
		const result = parseMarkdownContent(md);
		expect(result[0].title).toBe('Fix parseFlags function');
	});

	test('strips both bold and inline code', () => {
		const md = '- [ ] **Refactor** the `config` module';
		const result = parseMarkdownContent(md);
		expect(result[0].title).toBe('Refactor the config module');
	});
});

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

describe('dependencies', () => {
	test('preserves depends on marker in body', () => {
		const md = `- [ ] Build auth depends on #1`;
		const result = parseMarkdownContent(md);
		expect(result[0].body).toContain('> Depends on #1');
	});

	test('preserves multiple dependency references', () => {
		const md = `- [ ] Integration test depends on #3, #5`;
		const result = parseMarkdownContent(md);
		expect(result[0].body).toContain('> Depends on #3, #5');
	});

	test('case insensitive dependency matching', () => {
		const md = `- [ ] Task Depends On #7`;
		const result = parseMarkdownContent(md);
		expect(result[0].body).toContain('> Depends on');
	});

	test('no dependency marker when absent', () => {
		const md = `- [ ] Simple task`;
		const result = parseMarkdownContent(md);
		expect(result[0].body).not.toContain('Depends on');
	});
});

// ---------------------------------------------------------------------------
// Sub-items (indented checklists)
// ---------------------------------------------------------------------------

describe('sub-items', () => {
	test('folds unchecked sub-item into parent body', () => {
		const md = `- [ ] Parent task\n  - [ ] Sub-task A\n  - [ ] Sub-task B`;
		const result = parseMarkdownContent(md);
		expect(result).toHaveLength(1);
		expect(result[0].body).toContain('- [ ] Sub-task A');
		expect(result[0].body).toContain('- [ ] Sub-task B');
	});

	test('folds checked sub-item with [x] marker', () => {
		const md = `- [ ] Parent\n  - [x] Done sub\n  - [ ] Open sub`;
		const result = parseMarkdownContent(md);
		expect(result[0].body).toContain('- [x] Done sub');
		expect(result[0].body).toContain('- [ ] Open sub');
	});

	test('sub-items do not become separate issues', () => {
		const md = `- [ ] Parent\n  - [ ] Child 1\n  - [ ] Child 2\n- [ ] Other`;
		const result = parseMarkdownContent(md);
		expect(result).toHaveLength(2);
		expect(result[0].title).toBe('Parent');
		expect(result[1].title).toBe('Other');
	});

	test('strips markdown from sub-item text', () => {
		const md = `- [ ] Parent\n  - [ ] **Bold** sub`;
		const result = parseMarkdownContent(md);
		expect(result[0].body).toContain('- [ ] Bold sub');
	});

	test('sub-items with case insensitive checked marker', () => {
		const md = `- [ ] Parent\n  - [X] Done sub`;
		const result = parseMarkdownContent(md);
		expect(result[0].body).toContain('- [x] Done sub');
	});
});

// ---------------------------------------------------------------------------
// Parent tracking reset
// ---------------------------------------------------------------------------

describe('parent tracking', () => {
	test('non-checklist non-blank line resets parent tracking', () => {
		const md = [
			'- [ ] First task',
			'Some random paragraph',
			'  - [ ] Orphaned sub-item',
			'- [ ] Second task',
		].join('\n');
		const result = parseMarkdownContent(md);
		// Orphaned sub-item should not attach to First task
		// because the paragraph reset the parent tracking
		expect(result).toHaveLength(2);
		expect(result[0].body).not.toContain('Orphaned');
	});

	test('blank lines do not reset parent tracking', () => {
		const md = `- [ ] Parent task\n\n  - [ ] Sub after blank`;
		const result = parseMarkdownContent(md);
		expect(result[0].body).toContain('Sub after blank');
	});

	test('indented content does not reset parent tracking', () => {
		const md = `- [ ] Parent task\n  some indented text\n  - [ ] Sub-item`;
		const result = parseMarkdownContent(md);
		expect(result[0].body).toContain('Sub-item');
	});
});

// ---------------------------------------------------------------------------
// Full integration scenario
// ---------------------------------------------------------------------------

describe('full document parsing', () => {
	test('parses realistic markdown plan', () => {
		const md = [
			'# Migration Plan',
			'',
			'## Database',
			'- [x] Create migration script',
			'- [ ] Run migration on staging',
			'  - [ ] Backup existing data',
			'  - [ ] Execute migration',
			'  - [ ] Verify row counts',
			'- [ ] Run migration on production depends on #2',
			'',
			'## API',
			'### Endpoints',
			'- [ ] Update user endpoint',
			'- [x] Update auth endpoint',
			'- [ ] Add health check depends on #4',
			'',
			'## Frontend',
			'- [ ] Update dashboard',
		].join('\n');

		const result = parseMarkdownContent(md);

		// 5 open items (items 1 and 5 are checked)
		expect(result).toHaveLength(5);

		// Item 2: Run migration on staging (number=2 because checked item 1 counts)
		expect(result[0].number).toBe(2);
		expect(result[0].title).toBe('Run migration on staging');
		expect(result[0].labels).toEqual([{ name: 'Database' }]);
		expect(result[0].body).toContain('- [ ] Backup existing data');
		expect(result[0].body).toContain('- [ ] Execute migration');
		expect(result[0].body).toContain('- [ ] Verify row counts');

		// Item 3: Run migration on production (depends on #2)
		expect(result[1].number).toBe(3);
		expect(result[1].body).toContain('> Depends on #2');

		// Item 4: Update user endpoint (under API > Endpoints)
		expect(result[2].number).toBe(4);
		expect(result[2].title).toBe('Update user endpoint');
		expect(result[2].labels).toEqual([{ name: 'API' }]);
		expect(result[2].body).toContain('### Endpoints');

		// Item 6: Add health check (depends on #4)
		expect(result[3].number).toBe(6);
		expect(result[3].body).toContain('> Depends on #4');

		// Item 7: Update dashboard (Frontend section, no sub-section)
		expect(result[4].number).toBe(7);
		expect(result[4].labels).toEqual([{ name: 'Frontend' }]);
	});
});
