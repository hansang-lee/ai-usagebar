# Project conventions

Synced from the template of 2026-10-11 (`~/.claude/project-conventions.md`
on the owner's machine). This copy governs in this repository; its
exceptions are in [README.md](README.md).

One set of conventions for every project the owner keeps under
`/home/hslee/workspace/` (cling, kairos, quadranti, ai-usagebar, and new
ones). Adopted 2026-10-11 (owner). Agents read it before changing a
project's layout, docs, scripts or tooling.

**Copies.** Each project keeps its own copy as `docs/conventions.md`
(decided 2026-10-11: the projects are separate, so each carries its rules
with it). This file, `~/.claude/project-conventions.md`, is the template the
copies are synced from. In a project, its copy governs; its
`docs/README.md` lists that project's exceptions, with the reason. A change
meant for every project is made here first and then copied into each
project (one commit each, `docs(conventions): sync from the template`); a
change meant for one project only goes into that project's exceptions, not
into its copy. Each copy names the template date it was synced from:

    Synced from the template of 2026-10-11.

Where a project differs today, it moves to this when it is next tidied, one
project and one commit series at a time.

What is shared is everything that does not depend on the language. Code
style inside a language follows that language's standard tool, configured
in the repository (section 6): forcing one style across Go, Dart, C++ and
JavaScript would fight the tools.

## 1. Names

| What | Style | Examples |
|---|---|---|
| Docs, scripts, config, folders that are not code | lowercase words joined by hyphens | `docs/release.md`, `scripts/export-local.sh`, `scripts/test/` |
| Source files | the language's own rule | Dart and Python `snake_case.dart` / `.py` (a Python module cannot have a hyphen); Go `lowercase.go`, `_test.go`; C++ `snake_case.cpp/.hpp`; JS `camelCase.js` or `kebab-case.js` as the project already has |
| Conventional root files | upper case, as everyone expects | `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `LICENSE`, `Dockerfile`, `Makefile` |
| Dated records | ISO date | `docs/reviews/2026-10-04.md` |

A rename updates every reference in the same commit (`git grep` the old
name: code, scripts, configs, workflows, systemd units and crontabs on the
machine). Applied migrations and other immutable records keep the names of
their day.

## 2. Repository root

Every project has: `README.md` (what it is, how to run it, for a person),
`CLAUDE.md` (for agents, section 8), `.gitignore` (with `/out/`),
`.editorconfig`, and `.githooks/pre-push` enabled with
`git config core.hooksPath .githooks`. A project with secrets has
`.env.example` (committed) and `.env` (ignored). A project shipped to users
as a versioned artifact (an extension, a library) has `CHANGELOG.md`.

Nothing generated is committed: `out/`, `build/`, caches, logs, local data.

## 3. Documentation (`docs/`)

English, kept current in the same commit as the change it describes; a
stale doc is deleted, not left to mislead. One kind of document per file
(Diátaxis).

| File | Kind | Holds |
|---|---|---|
| `docs/README.md` | index | every doc with one line, then this project's exceptions to these conventions |
| `docs/conventions.md` | reference | this project's copy of these conventions, synced from the template |
| `docs/plan.md` | status | the current state, known gaps, what is next, open tasks by phase with ids (`PLAN 5.39`) |
| `docs/decisions.md` | decision | one table, `D1`, `D2`, …: the question, the decision, who decided, the date; a row is never rewritten, a new row supersedes it |
| `docs/history.md` | record | finished tasks moved from plan.md, verbatim; only grows |
| `docs/development.md` | how-to | a fresh machine to a running project |
| `docs/testing.md` | how-to | the test layers, how to run each, what they cover |
| `docs/release.md` or `docs/operations.md` | how-to | shipping, or running in production, and recovery |
| `docs/research/`, `docs/reviews/`, `docs/reference/` | research / record / reference | appended; findings marked superseded, not rewritten |

A small project may start with `README.md` and `CLAUDE.md` only and add
`docs/` when it has a plan or decisions worth keeping; `docs/` is never
gitignored.

Inside a document: one `#` title; the first paragraph says what it is for
and who reads it; lead with the point; say why, and what went wrong before;
dates as `2026-10-11`; tables for things compared on several attributes,
numbered lists for steps; refer to tasks and decisions by id.

## 4. Scripts (`scripts/`)

- Everything run by hand lives in `scripts/`; test runners in
  `scripts/test/`; shared shell code in `scripts/lib/common.sh` (sourced,
  never run). A `Makefile`, where a toolchain expects one, only calls
  scripts.
- `scripts/README.md` has a table per group: script, what it does, usage. A
  new script gets its row in the same commit.
- Bash scripts start with `#!/usr/bin/env bash`, then a comment block that
  says what the script does and how to call it; that block is its `--help`
  (`usage_of "$0"` from common.sh), so help and header never drift.
- `set -euo pipefail`. A runner that must go on after a failure to report
  every result uses `set -uo pipefail` and says so in a comment.
- 2-space indent (`.editorconfig`); `shellcheck` clean.
- Output in English. Run from anywhere: a script `cd`s to the repository
  root itself.
- A test or check run writes into `out/<YYMMDD_hhmmss>/` (one folder per run,
  a `summary.txt`, logs and artifacts in subfolders), through `new_run_dir`;
  the newest 30 are kept (`<PROJECT>_KEEP_RUNS`).
- Destructive or outward-facing steps are opt-in flags (`--force`,
  `--data`, `--live`), never defaults, and say what they will touch.

Every project with local state has `scripts/export-local.sh` and
`scripts/import-local.sh`: the secrets and local data in one gpg-encrypted
archive, restored without overwriting unless `--force` (old copies moved to
`restore-replaced-<date>/`, gitignored).

## 5. Checks and tests

- `scripts/test/check.sh` is what CI would run (format check, lint/analyze,
  the fast tests) and ends with one line: `All checks passed.` or a failure.
- `check.sh` also refuses a real-looking secret (a private key, a known
  token prefix, a JWT, a long key-like string, an account number) in any
  committed `.env*.example`, commented lines included; a deliberate example
  ends with `# example-ok`. cling's `scripts/test/env_example_check.py` is
  the reference implementation, copied as is.
- `.githooks/pre-push` runs it; a docs-only push may skip it. Never push with
  `--no-verify`.
- Test layers are named by what they exercise (unit, widget, scenario …)
  and listed in `docs/testing.md`; tests never touch the network or a real
  account unless the layer exists for that and says so.

## 6. Code style

| Language | Tool (config in the repo) | Indent | Width |
|---|---|---|---|
| Go | `gofmt`, `go vet` | tabs | — |
| Dart | `flutter analyze` (`analysis_options.yaml`); format only the lines touched | 2 | 120 |
| C++ | `clang-format` (`.clang-format`) | 4 | 120 |
| JavaScript | ESLint (`eslint.config.js`) | 4 | 120 |
| Python | `ruff format` / `ruff check` | 4 | 120 |
| Shell | `shellcheck` | 2 | 120 |

The project's `check.sh` runs its formatters in check mode. Comments say
why, and what went wrong before; not what the next line does.

## 7. Git

- Commit subject: `type(scope): what changed`, imperative, ≤ 72 characters;
  types `feat fix refactor test docs build ops chore`; the scope is the area
  (`backend`, `app`, `scripts`, `seed`). Example:
  `feat(app): show the four intros on a person's profile`.
- The body says why, and names the task or decision (`PLAN 5.39`, `D35`).
  Trailers as the session requires (`Co-Authored-By`, `Claude-Session`).
- One commit per finished unit of work, pushed straight away on projects
  that work on `main`. No force-push or history rewrite without the
  owner's word.

## 8. `CLAUDE.md`

The same headings in every project, in this order (a section with nothing
to say is left out):

1. **What this is** — two or three sentences, the stack, where it runs.
2. **Where things are written down** — the docs table.
3. **How we work** — commits, plan-driven work, decisions, verification.
4. **Running and checking** — the everyday commands; `check.sh` before push.
5. **Safety** — what must never happen (live orders, real accounts,
   secrets, production) and what needs the owner's confirmation.
6. **Things that bite** — project-specific traps, each with its why.

## 9. Language

Docs, code, comments, commit messages and script output are in English.
The owner is answered in Korean. Korean in the product (UI strings,
content) stays Korean.

## 10. Where these come from

Kept so a later change can be weighed against the reason a rule exists.

| Rule | Source |
|---|---|
| Docs live in the repo, change with the code, stale docs deleted (§3) | Google documentation guide ("docs as code") |
| One kind of document per file: how-to, reference, record (§3) | Diátaxis |
| Lowercase-hyphen file names (§1) | Google developer documentation style guide |
| Bash: `set -euo pipefail`, 2-space indent, header comment (§4) | Google Shell Style Guide; shellcheck |
| `type(scope): subject`, ≤ 72 characters, why in the body (§7) | Conventional Commits; the git project's commit guidance |
| Decisions as dated, never-rewritten rows (§3) | Architecture Decision Records, kept as one table |
| Formatters per language (§6) | gofmt, Dart/Flutter lints, clang-format, ESLint, ruff — each language's own |
| `.editorconfig`, `.env.example` committed with placeholders (§2) | common open-source practice |
| plan/decisions/history, `out/<stamp>/` runs, export/import scripts (§3, §4) | the owner's projects (cling, kairos), 2026-09/10 |
| Width 120 (§6) | the existing code; Google's guides use 80–100 |

