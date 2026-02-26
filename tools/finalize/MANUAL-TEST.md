Manual Test — Finalize Stale Master Rebase Fix

Validates that `pait finalize` pulls the latest base branch before every rebase,
preventing commits from being lost when CI pushes version bumps between merges.

## Bug Description

Before the fix, finalize pulled master once at startup, then rebased each PR
branch onto the (stale) local master. If GitHub CI pushed version bump commits
between merges, the rebase was based on outdated master, causing rebased branches
to miss intermediate commits or produce corrupt merge results.

Phase 0: Setup fixture repo

## Reset script (for re-running this test)

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

cd pai-tools-test-fixture

# Ensure orchestrator config has verify steps

mkdir -p .pait
cat > .pait/orchestrator.json << 'EOF'
{
  "branchPrefix": "feat/",
  "baseBranch": "main",
  "verify": [
    { "name": "test", "cmd": "bun test" }
  ]
}
EOF

git add -A && git commit -m "chore: ensure pait config" && git push

Phase 1: Verify the source fix is present

## Step 1a: Pre-rebase pull exists in merge loop

```bash
grep -n 'Pre-rebase pull' ../pai-tools/tools/finalize/index.ts
```

# EXPECT: A line containing "Pre-rebase pull of ${baseBranch}" inside the merge
# loop, BEFORE the rebaseBranch call (around lines 207-215)

## Step 1b: No silent error swallowing on pull commands

```bash
grep -A1 'pull --ff-only' ../pai-tools/tools/finalize/index.ts
```

# EXPECT: Every pull --ff-only is followed by .catch((e) => { with log.warn
# No empty .catch(() => {}) should appear near any pull command

## Step 1c: Post-merge pull also has error handling

```bash
grep -B2 -A2 'Post-merge pull' ../pai-tools/tools/finalize/index.ts
```

# EXPECT: Post-merge pull followed by .catch((e) => { with log.warn

Phase 2: Create issues for multi-PR merge scenario

gh issue create --title "Add divide function to math.ts" \
  --body "Add a divide(a, b) function. Handle division by zero (throw). Add test."

gh issue create --title "Add reverse function to utils.ts" \
  --body "Add reverse(s: string): string. Add test."

gh issue create --title "Add isEven helper to math.ts" \
  --body "Add isEven(n: number): boolean. Add test.

> **Depends on** #1"

Phase 3: Orchestrate all issues

pait orchestrate

# EXPECT: Implements all 3 issues in dependency order
# Creates branch + PR for each, verification passes

# Verify PRs exist

gh pr list --state open --json number,title,headRefName

# EXPECT: 3 open PRs

Phase 4: Test finalize with CI-simulated master divergence

## Step 4a: Merge only the first PR

pait finalize --single --auto-resolve

# EXPECT: First PR merged, rebased onto current main

## Step 4b: Simulate a CI version bump on master

# This simulates what happens when CI pushes a version bump after the merge

git checkout main && git pull
echo '{"version": "0.2.0"}' > package.json
git add package.json && git commit -m "chore: bump version to 0.2.0 [skip ci]"
git push

## Step 4c: Verify local master includes the simulated bump

git log --oneline main -3

# EXPECT: Top commit is the version bump, followed by the merge commit

## Step 4d: Merge the second PR — this is the critical test

pait finalize --single --auto-resolve

# EXPECT: Finalize pulls latest main BEFORE rebasing
# EXPECT: The rebase includes the version bump commit
# EXPECT: PR merges cleanly — no stale base artifacts

## Step 4e: Verify no commits lost

git checkout main && git pull
git log --oneline main -5

# EXPECT: Version bump commit (0.2.0) is present in history
# between the first and second PR merge commits

## Step 4f: Simulate another CI bump and merge the third PR

echo '{"version": "0.3.0"}' > package.json
git add package.json && git commit -m "chore: bump version to 0.3.0 [skip ci]"
git push

pait finalize --single --auto-resolve

# EXPECT: Third PR rebases onto main that includes 0.3.0 bump
# EXPECT: Clean merge, version bump preserved in history

Phase 5: Final consistency verification

## Step 5a: Local matches remote

git fetch origin
git diff main origin/main

# EXPECT: Empty diff — local main is fully in sync with remote

## Step 5b: All version bumps preserved

git log --oneline main | grep "bump version"

# EXPECT: Both bump commits (0.2.0 and 0.3.0) appear in history
# They should NOT be squashed away or lost during rebase

## Step 5c: All issues closed

gh issue list --state closed --json number,title --jq '.[] | "#\(.number) \(.title)"'

# EXPECT: All 3 issues from Phase 2 appear as CLOSED

gh issue list --state open --json number,title --jq '.[] | "#\(.number) \(.title)"'

# EXPECT: 0 open issues from Phase 2

## Step 5d: No orphaned branches

git branch -r | grep feat/

# EXPECT: No feat/* remote branches remain (deleted after merge)

Phase 6: Regression signals

If ANY of these occur, the fix has regressed:

- `git log` shows the rebased branch is based on a commit older than the latest
  main (missing version bump commits between PRs)
- `git diff main origin/main` shows differences after finalize completes
- Version bump commits disappear from history after merge
- Merge conflicts caused by rebasing onto stale base (rather than true conflicts)
- Silent failures — finalize completes "successfully" but main is behind remote
- The agent's conflict resolution text appears in a source file instead of code
