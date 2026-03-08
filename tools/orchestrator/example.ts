/**
 * Writes an example markdown plan file for `pait orchestrate --file`.
 */

import { log } from '@shared/log.ts';

const EXAMPLE_CONTENT = `# Migration Plan
#
# This is an example plan file for \`pait orchestrate --file PLAN.md\`.
#
# Rules:
#   - [ ] Unchecked items become tasks (orchestrated in order)
#   - [x] Checked items are skipped (treated as already done)
#   - Indented sub-items fold into the parent task as acceptance criteria
#   - ## Headings become labels on the generated tasks
#   - "depends on #N" creates a dependency (N = sequential item number)
#   - Bold (**text**) and inline code (\`text\`) are stripped from titles

## Setup

- [x] Initialize project repository
- [ ] Configure CI pipeline
  - [ ] Add lint step
  - [ ] Add test step
  - [ ] Add build step

## Backend

- [ ] Create database schema (depends on #2)
  - [ ] Users table with id, email, name, created_at
  - [ ] Sessions table with foreign key to users
- [ ] Add authentication endpoints (depends on #3)
  - [ ] POST /auth/login returns JWT
  - [ ] POST /auth/logout invalidates session
  - [ ] GET /auth/me returns current user

## Frontend

- [ ] Build login page (depends on #4)
  - [ ] Email and password fields
  - [ ] Error message on invalid credentials
  - [ ] Redirect to dashboard on success
`;

export async function writeExample(output: string, force: boolean): Promise<void> {
	const file = Bun.file(output);

	if (await file.exists() && !force) {
		log.error(`${output} already exists. Use --force to overwrite.`);
		process.exit(1);
	}

	await Bun.write(file, EXAMPLE_CONTENT);
	log.ok(`Wrote example plan to ${output}`);
	log.info(`Run: pait orchestrate --file ${output}`);
}
