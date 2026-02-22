# pait refactor

AI-powered file structure analyzer. Identifies files that need decomposition using a two-tier approach: fast heuristics followed by Claude semantic analysis.

## How It Works

### Tier 1: Heuristic Analysis (free, instant)

Scans every source file for structural signals:

- **Line count** against per-language soft/hard thresholds
- **Function density** (>15 functions = likely multiple responsibilities)
- **Export density** (>10 exports = mixed concerns or barrel file)
- **Class count** (>1 class per file = strong SRP violation)
- **Import fan-in** (>20 imports = high coupling risk)

Files exceeding thresholds are flagged as candidates for Tier 2.

### Tier 2: AI Semantic Analysis (Claude Sonnet)

Flagged files are sent individually to Claude for deeper analysis:

- Detects distinct **responsibilities** with line ranges
- Identifies **SRP violations** — names the two actors/reasons driving separate changes
- Identifies **DIP violations** — names concrete dependencies that should be abstractions
- Suggests concrete **file splits** with filenames, responsibility mapping, and rationale
- Estimates **refactoring effort** (low/medium/high)

## Principles

The analysis is grounded in Robert C. Martin's SOLID principles:

| Principle | Definition | What the tool looks for |
|-----------|-----------|----------------------|
| **SRP** | A module should have one, and only one, reason to change | Multiple unrelated function groups, mixed concerns (business logic + I/O), functions changing for different reasons |
| **DIP** | High-level modules should not depend on low-level modules; both should depend on abstractions | Direct imports of concrete implementations, high-level policy mixed with low-level I/O, tight library coupling |
| **DRY** | Don't repeat yourself | Duplicated logic indicating parallel handling of mixed concerns |
| **YAGNI** | You aren't gonna need it | Over-engineered abstractions adding complexity without value |

## Usage

```bash
# Full two-tier analysis
pait refactor ./src

# Heuristics only — free, instant, no AI calls
pait refactor ./src --tier1-only

# Create GitHub issues for flagged files
pait refactor ./src --issues

# Preview issues without creating them
pait refactor ./src --issues --dry-run

# JSON output (for CI pipelines)
pait refactor ./src --format json

# Custom line threshold
pait refactor ./src --threshold 150

# Limit AI analysis calls
pait refactor ./src --budget 10

# Show all files, not just flagged
pait refactor ./src --verbose

# Analyze a single file
pait refactor ./src/big-file.ts
```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--threshold <N>` | auto per language | Override soft line threshold |
| `--tier1-only` | false | Skip AI analysis |
| `--issues` | false | Create GitHub issues via `gh` CLI |
| `--dry-run` | false | Preview issues without creating |
| `--format <type>` | terminal | Output: `terminal` or `json` |
| `--budget <N>` | 50 | Max AI analysis calls |
| `--include <glob>` | all source files | Only analyze matching files |
| `--verbose` | false | Show all files, not just flagged |

## Language Thresholds

Thresholds are auto-detected from file extensions:

| Language | Soft | Hard | Extensions |
|----------|------|------|------------|
| TypeScript | 200 | 400 | `.ts`, `.tsx` |
| JavaScript | 200 | 400 | `.js`, `.jsx`, `.mjs`, `.cjs` |
| Python | 250 | 500 | `.py` |
| Go | 300 | 600 | `.go` |
| Rust | 300 | 600 | `.rs` |
| Java | 250 | 500 | `.java` |
| C# | 250 | 500 | `.cs` |
| Ruby | 200 | 400 | `.rb` |
| PHP | 200 | 400 | `.php` |
| Swift | 250 | 500 | `.swift` |

**Soft threshold:** File is flagged as a warning. Candidate for AI analysis.
**Hard threshold:** File is flagged as critical. Strong signal for decomposition.

## Per-Project Config

Create `.pait/refactor.json` in any project repo root:

```json
{
  "softThreshold": 200,
  "hardThreshold": 400,
  "ignore": ["generated/", "vendor/"]
}
```

## GitHub Issue Format

When using `--issues`, each flagged file gets an issue:

- **Title:** `refactor(filename): split into N focused modules`
- **Body:** Heuristic signals, detected responsibilities, suggested splits, principle violations, effort estimate
- **Labels:** `refactor`, `ai-suggested`, `priority:high` (for critical)

## Output Example

```
REFACTOR ANALYSIS
────────────────────────────────────────────────────────────
Target:   ./src
Files:    47 discovered, 47 analyzed, 3 flagged
AI:       3 files sent to Claude
────────────────────────────────────────────────────────────

  [!!!] src/api/handlers.ts
       TypeScript | 892 lines  ████████████████████░░░░
       fn:24 exp:8 cls:0 imp:14
       → 892 lines exceeds hard threshold (400)
       → High function count: 24 functions
       → Elevated import count: 14 imports
       AI: 4 responsibilities detected
         • Route Handlers: HTTP request/response handling
         • Validation: Input validation and sanitization
         • DB Queries: Direct database access
         • Error Formatting: Error response construction
       Suggested split:
         → handlers.ts (Route Handlers)
         → validation.ts (Validation)
         → queries.ts (DB Queries)
         → errors.ts (Error Formatting)
       Effort: medium | SRP violation: 4 distinct reasons to change...

SUMMARY
  Critical: 1  Warnings: 2  OK: 44
```
