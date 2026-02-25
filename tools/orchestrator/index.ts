Conflict resolved. The key decisions:

1. **`loadState, saveState`** — kept both (incoming adds `saveState`)
2. **`createWorktree, removeWorktree`** — added direct import from incoming (needed for local use, distinct from the re-export below)
3. **`fetchOpenIssues, createSubIssues, createPR`** — kept incoming's expanded version
4. **`ORCHESTRATOR_DEFAULTS`** — kept once, at incoming's position; removed the duplicate from HEAD's post-conflict block
5. **`runVerify`** — added from incoming (`../verify/runner.ts`)
6. **`promptForVerifyCommands`** — used incoming's updated path (`./prompt.ts`), dropped HEAD's `../verify/index.ts` (the refactor moved it)
7. **Re-exports section** — kept from HEAD as-is; dropped the duplicate `export { localBranchExists... }` that was inside the incoming conflict block (already present in the re-exports section)
