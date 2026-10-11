# ai-usagebar docs

Index of the documentation in this fork, and the places where it departs from
the owner's cross-project conventions. Read by the owner and by agents before
changing layout, docs, scripts or tooling.

## What this fork is

A fork of the upstream GNOME Shell extension ai-usagebar (remote `upstream`).
The owner's work lives on branch `devel`, ahead of `upstream/main`. Upstream
changes are merged in regularly, so the upstream layout and files are kept as
they are; owner-specific additions are kept small and separate.

## Index

| Doc | What it holds |
|---|---|
| `docs/README.md` | this index and the exceptions below |
| `docs/conventions.md` | the owner's shared conventions, this fork's copy (synced from `~/.claude/project-conventions.md`) |
| `README.md` | what the extension is and how to install it (upstream's) |
| `CLAUDE.md` | agent guide: architecture, commands, testing rules (upstream's, plus a short owner section) |
| `CHANGELOG.md` | released changes (upstream's format) |

## Exceptions to conventions.md

Why: this is a fork. Renaming or moving upstream files would make every
upstream merge conflict, so the conventions are applied only where they do not
touch upstream's layout.

| Convention | Here | Reason |
|---|---|---|
| Scripts in `scripts/` (section 4) | `tools/` | upstream's folder name |
| `Makefile` only calls scripts | `Makefile` is the entry point (`make test`, `make lint`, ...) | upstream's workflow |
| 2-space shell indent (sections 4, 6) | 4-space | upstream's scripts |
| Runs write to `out/<YYMMDD_hhmmss>/`, `scripts/test/check.sh`, `.githooks/pre-push` (sections 4, 5) | not used; `make test` and `make lint` print to the terminal | upstream's tooling; no `check.sh` wrapper |
| JavaScript style (section 6) | ESLint, 4-space (`eslint.config.js`) | matches the convention's JS row; kept as upstream has it |
| Docs (section 3) | only this file for now | no plan or decisions worth a file yet |

Commit style already matches section 7 (`type(scope): subject`).

## What still applies

- Section 7 (git): conventional commits with a body that says why; no
  force-push or history rewrite without the owner's word.
- Section 9 (language): docs, code, comments and commit messages in English.
- No secrets in the repository: `*.credentials.json` is gitignored.
- `docs/` is never gitignored.
