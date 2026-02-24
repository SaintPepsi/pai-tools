# pait verify

Run configured verification commands against the current project.

## Usage

```
pait verify [flags]
```

## Flags

| Flag | Description |
|------|-------------|
| `--skip-e2e` | Skip E2E verification step |
| `--name <step>` | Run only the named verification step |
| `--json` | Output results as JSON |
| `--help`, `-h` | Show help message |

## Configuration

Reads verification commands from `.pait/orchestrator.json`:

```json
{
  "verify": [
    { "name": "typecheck", "cmd": "bun tsc --noEmit" },
    { "name": "test", "cmd": "bun test" }
  ],
  "e2e": {
    "run": "bun run e2e",
    "update": "bun run e2e:update",
    "snapshotGlob": "**/*.snap"
  }
}
```

## Programmatic API

```ts
import { runVerify } from './tools/verify/index.ts';

const result = await runVerify({
  verify: [{ name: 'test', cmd: 'bun test' }],
  cwd: '/path/to/project',
  skipE2e: true,
  logger: { verifyPass(n, s) {}, verifyFail(n, s, e) {} },
  issueNumber: 42
});

if (result.ok) {
  console.log('All steps passed');
} else {
  console.log(`Failed at: ${result.failedStep}`);
}
```

## Examples

```bash
# Run all verification steps
pait verify

# Run only the "test" step
pait verify --name test

# Skip E2E, output JSON
pait verify --skip-e2e --json
```
