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

# NOTE: Issue numbers in this fixture repo are NOT sequential from #1.
# The repo retains closed issue history across test runs, so new issues
# get incrementing numbers (e.g. #111, #112, ...). Adjust dependency
# references accordingly — use the actual issue numbers from gh output.

DIVIDE=$(gh issue create --title "Add divide function to math.ts" \
 --body "Add a divide(a, b) function. Handle division by zero (throw). Add test." \
 | grep -o '[0-9]*$')

REVERSE=$(gh issue create --title "Add reverse function to utils.ts" \
 --body "Add reverse(s: string): string. Add test." \
 | grep -o '[0-9]*$')

TRUNCATE=$(gh issue create --title "Add truncate function to utils.ts" \
 --body "Add truncate(str: string, max: number): string that truncates with '...' if longer than max. Add test." \
 | grep -o '[0-9]*$')

gh issue create --title "Add isEven helper to math.ts" \
 --body "Add isEven(n: number): boolean. Add test.

Depends on #${DIVIDE}"

gh issue create --title "Update index.ts re-exports" \
 --body "Update src/index.ts to re-export all new functions from math.ts and utils.ts.

Depends on #${DIVIDE}
Depends on #${REVERSE}
Depends on #${TRUNCATE}"

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

# EXPECT: Merges first PR (merge commit), runs post-merge verify

# Check: gh pr list shows 4 remaining open PRs

# Check: main branch has the merged changes

# Check stacked PR retarget: if the merged PR was a dependency,
# verify dependent PRs had their base branch retargeted to main

gh pr list --json number,baseRefName,headRefName --jq '.[] | "\(.number) base:\(.baseRefName) head:\(.headRefName)"'

# EXPECT: All remaining PRs now target main (not the merged branch)

Phase 6: Test pait finalize (remaining PRs)

pait finalize

# EXPECT: Merges remaining 4 PRs in dependency order

# Dependent PRs rebase cleanly onto updated main

# Post-merge verify runs after each

# All 5 issues auto-closed on GitHub

# Explicit auto-close verification:

gh issue list --state closed --json number,title --jq '.[] | "#\(.number) \(.title)"'

# EXPECT: All 5 Phase 2 issues appear as CLOSED

gh issue list --state open --json number,title --jq '.[] | "#\(.number) \(.title)"'

# EXPECT: 0 open issues from Phase 2 (issues from later phases may be open)

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

Phase 11: Test --strategy squash (non-default)

# Create an issue for merge strategy testing

gh issue create --title "Add modulo function to math.ts" \
 --body "Add modulo(a, b) function. Add test."

pait orchestrate --single

# Finalize with squash strategy (non-default — default is now merge)

pait finalize --single --strategy squash

# EXPECT: PR merged via squash commit (not merge commit)

# Verify: git log --oneline shows squash, no merge commit

git log --oneline -5

# EXPECT: A single squash commit, NOT "Merge pull request #N ..."

Phase 12: First-PR rebase (main diverged)

# This tests the fix for the first-PR-no-rebase bug.
# When main has diverged since orchestration, even the first PR
# in the queue needs rebasing. Previously this was skipped.

# Create 2 independent issues

gh issue create --title "Add abs function to math.ts" \
  --body "Add abs(n: number): number. Add test."

gh issue create --title "Add repeat function to utils.ts" \
  --body "Add repeat(s: string, n: number): string. Add test."

pait orchestrate

# Merge the first one to advance main

pait finalize --single

# Now push a conflicting change to main so the second PR is stale

git checkout main && git pull
echo '// timestamp marker' >> src/math.ts
git add src/math.ts && git commit -m "chore: add timestamp marker"
git push

# The remaining PR is now first-in-queue AND main has diverged.
# It MUST rebase successfully (this is the regression scenario).

pait finalize --single --auto-resolve

# EXPECT: Rebase happens (not skipped), PR merges successfully
# EXPECT: No "Conflicts detected" or it auto-resolves cleanly

Phase 13: Resumability after partial failure

# This tests that finalize state persists and skips already-merged PRs.

# Create 3 issues

gh issue create --title "Add floor function to math.ts" \
  --body "Add floor(n: number): number. Add test."

gh issue create --title "Add ceil function to math.ts" \
  --body "Add ceil(n: number): number. Add test."

gh issue create --title "Add round function to math.ts" \
  --body "Add round(n: number): number. Add test."

pait orchestrate

# Merge only the first one

pait finalize --single

# Simulate failure: break the tests so the next PR fails verification

echo 'test("fail", () => expect(1).toBe(2));' >> src/math.test.ts
git add src/math.test.ts && git commit -m "break tests" && git push

pait finalize --single

# EXPECT: Merge succeeds but post-merge verify FAILS

# Fix the tests

git checkout main && git pull
git checkout HEAD~1 -- src/math.test.ts
git add src/math.test.ts && git commit -m "fix tests" && git push

# Re-run finalize — should skip already-merged PRs and continue

pait finalize

# EXPECT: Skips already-merged PRs, merges remaining PR(s)
# EXPECT: Verify passes on the resumed run

Phase 14: Test --no-verify flag

# Create an issue for testing --no-verify

gh issue create --title "Add sign function to math.ts" \
  --body "Add sign(n: number): -1 | 0 | 1. Add test."

pait orchestrate --single

# Break tests deliberately

echo 'test("fail", () => expect(1).toBe(2));' >> src/math.test.ts
git add src/math.test.ts && git commit -m "break tests for no-verify test"
git push

# Without --no-verify: finalize should fail at verification

pait finalize --single

# EXPECT: Merge completes but post-merge verify FAILS

# Restore tests and create another issue to test --no-verify

git checkout main && git pull
git checkout HEAD~1 -- src/math.test.ts
git add src/math.test.ts && git commit -m "fix tests" && git push

gh issue create --title "Add clamp function to math.ts" \
  --body "Add clamp(n, min, max): number. Add test."

pait orchestrate --single

# Now break tests again

echo 'test("fail", () => expect(1).toBe(2));' >> src/math.test.ts
git add src/math.test.ts && git commit -m "break tests again"
git push

# With --no-verify: finalize should skip verification entirely

pait finalize --single --no-verify

# EXPECT: Merge completes, NO verification step runs
# EXPECT: No "Verification failed" output — verification was skipped

# Clean up: restore tests

git checkout main && git pull
git checkout HEAD~1 -- src/math.test.ts
git add src/math.test.ts && git commit -m "restore tests" && git push

Phase 8: Test --parallel flag

# Create 3 independent issues (no dependencies between them)

gh issue create --title "Add max function to math.ts" \
  --body "Add max(a: number, b: number): number. Add test."

gh issue create --title "Add min function to math.ts" \
  --body "Add min(a: number, b: number): number. Add test."

gh issue create --title "Add padStart function to utils.ts" \
  --body "Add padStart(s: string, len: number, fill: string): string. Add test."

# 8a. Dry run shows parallel tiers

pait orchestrate --dry-run --parallel 2

# EXPECT: Tier visualization (not linear execution plan)
# EXPECT: All 3 issues in tier 0 (no dependencies)
# EXPECT: Max concurrency shown as 2

# 8b. Parallel orchestration

pait orchestrate --parallel 2

# EXPECT: Up to 2 issues running concurrently
# EXPECT: [#N] prefixed log lines for each issue
# EXPECT: All 3 issues complete, PRs created
# EXPECT: "ALL PARALLEL WORK COMPLETE" at end

# 8c. Parallel ignored in single mode

pait orchestrate --parallel 3 --single

# EXPECT: --single takes precedence, runs only 1 issue sequentially

Phase 8b: Verify idempotency and state file

pait finalize

# EXPECT: "No mergeable PRs found." (all already merged)

pait verify

# EXPECT: All steps pass on final merged main

# Inspect finalize state file

cat .pait/state/finalize.json | jq .

# EXPECT: JSON with version, startedAt, completedAt fields
# EXPECT: prs object with entries for each merged PR
# EXPECT: Each PR entry has status: "merged", mergedAt timestamp, error: null
