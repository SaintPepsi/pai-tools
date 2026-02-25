Manual Test Plan — pait verify + pait finalize

Phase 0: Set up fixture repo

## Reset script (for re-running tests)

To reset the fixture repo to a clean state between test runs:

```bash
cd pai-tools-test-fixture

# Close all open issues and PRs
gh pr list --state open --json number -q '.[].number' | xargs -I{} gh pr close {}
gh issue list --state open --json number -q '.[].number' | xargs -I{} gh issue close {}

# Delete all feat/* branches (remote)
git fetch --prune
git branch -r | grep 'origin/feat/' | sed 's|origin/||' | xargs -I{} git push origin --delete {}

# Reset main to initial commit
git checkout main
git log --oneline | tail -1 | awk '{print $1}' | xargs git reset --hard
git push --force-with-lease

# Clean local state
rm -rf .pait/state/
```

## Initial setup

# Clone the fixture

git clone git@github.com:SaintPepsi/pai-tools-test-fixture.git
cd pai-tools-test-fixture

# Add source files

mkdir -p src
cat > src/math.ts << 'EOF'
export function add(a: number, b: number): number { return a + b; }
export function subtract(a: number, b: number): number { return a - b; }
export function multiply(a: number, b: number): number { return a \* b; }
EOF

cat > src/utils.ts << 'EOF'
export function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
export function slugify(s: string): string { return s.toLowerCase().replace(/\s+/g, '-'); }
EOF

cat > src/index.ts << 'EOF'
export { add, subtract, multiply } from './math.ts';
export { capitalize, slugify } from './utils.ts';
EOF

# Add package.json

cat > package.json << 'EOF'
{
"name": "pai-tools-test-fixture",
"version": "0.1.0",
"scripts": { "test": "bun test" }
}
EOF

# Add a test

cat > src/math.test.ts << 'EOF'
import { test, expect } from 'bun:test';
import { add, subtract, multiply } from './math.ts';
test('add', () => expect(add(1, 2)).toBe(3));
test('subtract', () => expect(subtract(5, 3)).toBe(2));
test('multiply', () => expect(multiply(2, 3)).toBe(6));
EOF

# Add orchestrator config with verify steps

mkdir -p .pait
cat > .pait/orchestrator.json << 'EOF'
{
"branchPrefix": "feat/",
"baseBranch": "master",
"verify": [
{ "name": "test", "cmd": "bun test" }
]
}
EOF

# Commit and push

git add -A && git commit -m "chore: add source files, tests, and pait config"
git push

Phase 1: Test pait verify standalone

cd pai-tools-test-fixture

# 1a. Should pass — tests are green

pait verify

# EXPECT: "[OK] All 1 verification step(s) passed"

# 1b. JSON output

pait verify --json

# EXPECT: JSON with ok:true, steps array with timing

# 1c. Named step filter

pait verify --name test

# EXPECT: Only "test" step runs

# 1d. Named step filter (nonexistent)

pait verify --name nonexistent

# EXPECT: ok:true, 0 steps (nothing matches)

# 1e. Break the tests, verify catches it

echo 'test("fail", () => expect(1).toBe(2));' >> src/math.test.ts
pait verify

# EXPECT: "[ERROR] Verification failed at test"

git checkout src/math.test.ts # restore

Phase 2: Create GitHub issues (mimicking pait analyze)

gh issue create --title "Add divide function to math.ts" \
 --body "Add a divide(a, b) function. Handle division by zero (throw). Add test."

gh issue create --title "Add reverse function to utils.ts" \
 --body "Add reverse(s: string): string. Add test."

gh issue create --title "Add isEven helper to math.ts" \
 --body "Add isEven(n: number): boolean. Add test.

> **Depends on** #1"

gh issue create --title "Add truncate function to utils.ts" \
 --body "Add truncate(str: string, max: number): string that truncates with '...' if longer than max. Add test."

gh issue create --title "Update index.ts re-exports" \
 --body "Update src/index.ts to re-export all new functions from math.ts and utils.ts.

> **Depends on** #1
> **Depends on** #2
> **Depends on** #4"

Phase 3: Test pait orchestrate

pait orchestrate --dry-run

# EXPECT: 5 issues in execution plan
# #3 after #1 (depends on #1)
# #5 after #1, #2, and #4 (depends on all three)

pait orchestrate

# EXPECT: Implements all 5 issues in dependency order
# Creates branch + PR for each, verification passes

Phase 4: Test pait finalize --dry-run

pait finalize --dry-run

# EXPECT: Shows merge plan with 5 PRs in dependency order

Phase 5: Test pait finalize --single

pait finalize --single

# EXPECT: Merges first PR (squash), runs post-merge verify

# Check: gh pr list shows 4 remaining open PRs

# Check: main branch has the merged changes

Phase 6: Test pait finalize (remaining PRs)

pait finalize

# EXPECT: Merges remaining 4 PRs in dependency order

# Dependent PRs rebase cleanly onto updated main

# Post-merge verify runs after each

# All 5 issues auto-closed on GitHub

# Check: gh issue list --state open shows 0 issues from Phase 2

Phase 7: Test conflict resolution (deliberate conflict)

# Reset: create a fresh issue

gh issue create --title "Update add function signature" \
 --body "Change add to accept optional third argument. Update test."

# Run orchestrate for this one issue

pait orchestrate --single

# Now manually create a conflicting change on master

git checkout master

# Edit the same lines the PR touched in src/math.ts

sed -i '' 's/export function add/export const add =/' src/math.ts
git add src/math.ts && git commit -m "refactor: arrow function style"
git push

# Now finalize — should hit conflict

pait finalize --single

# EXPECT: "Conflicts detected during rebase"

# EXPECT: Prompted for each conflicted file

# Type "keep the orchestrated version but use arrow function style"

# EXPECT: Claude resolves, rebase continues, merge completes

Phase 7b: Auto-resolve conflict (non-interactive)

# Create another issue that will conflict

gh issue create --title "Refactor subtract to use arrow syntax" \
 --body "Change subtract to arrow function style. Update test."

pait orchestrate --single

# Create a conflicting change on master

git checkout master
sed -i '' 's/export function subtract/export const subtract =/' src/math.ts
git add src/math.ts && git commit -m "refactor: subtract arrow style"
git push

# Now finalize with --auto-resolve — no prompts expected

pait finalize --single --auto-resolve

# EXPECT: "Auto-resolving conflicts via Claude..."

# EXPECT: "Auto-resolved: src/math.ts"

# EXPECT: Merge completes without any interactive prompt

Phase 9: Multi-file conflict

# Create an issue that touches multiple files

gh issue create --title "Add format functions to math and utils" \
 --body "Add formatNumber(n) to math.ts and formatSlug(s) to utils.ts. Add tests for both."

pait orchestrate --single

# Create conflicting changes on master in BOTH files

git checkout master

# Conflict in math.ts
sed -i '' 's/export function multiply/export const multiply =/' src/math.ts
git add src/math.ts && git commit -m "refactor: multiply arrow style"

# Conflict in utils.ts
sed -i '' 's/export function capitalize/export const capitalize =/' src/utils.ts
git add src/utils.ts && git commit -m "refactor: capitalize arrow style"
git push

# 9a. Test interactive resolution (both files prompted)

pait finalize --single

# EXPECT: "2 file(s) have conflicts:"

# EXPECT: Prompted for src/math.ts AND src/utils.ts

# Type "theirs" for math.ts and "ours" for utils.ts

# EXPECT: Both resolved, merge completes

# 9b. (Alternative) Test auto-resolve on multi-file conflict
# Reset and re-run with:

pait finalize --single --auto-resolve

# EXPECT: "Auto-resolved: src/math.ts" and "Auto-resolved: src/utils.ts"

Phase 10: Test --from flag

# Ensure there are 2+ open PRs from orchestration
# (create issues if needed)

gh issue create --title "Add power function to math.ts" \
 --body "Add power(base, exp) function. Add test."

gh issue create --title "Add trim function to utils.ts" \
 --body "Add trimAll(s: string): string that trims and collapses whitespace. Add test."

pait orchestrate

# Verify both PRs exist

pait finalize --dry-run

# EXPECT: Shows both PRs in merge plan

# Use --from to skip the first issue and start from the second

pait finalize --single --from <SECOND_ISSUE_NUMBER>

# EXPECT: Skips first PR, merges only the second

# EXPECT: First PR still open (gh pr list confirms)

Phase 11: Test --strategy merge

# Create an issue for merge strategy testing

gh issue create --title "Add modulo function to math.ts" \
 --body "Add modulo(a, b) function. Add test."

pait orchestrate --single

# Finalize with merge strategy (no squash)

pait finalize --single --strategy merge

# EXPECT: PR merged via merge commit (not squash)

# Verify: git log --oneline shows merge commit, not squash

git log --oneline -5

# EXPECT: A merge commit like "Merge pull request #N ..."

Phase 8: Verify idempotency

pait finalize

# EXPECT: "No mergeable PRs found." (all already merged)

pait verify

# EXPECT: All steps pass on final merged master
