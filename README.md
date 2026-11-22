# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dentybaiq/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dentybaiq/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

A command-line tool that applies AI-written edits in four formats — unified diffs (with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON tool calls — to a tree of text files, all or nothing. Practice score 1,000/1,000 (100 of 100 checks).

Run it: `node main.ts [options] [PATCH]`

- `--format=NAME` reads the patch as `unified`, `search-replace`, `v4a` or `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file changed.
- `--strict` matches lines exactly (tier 0 only).
- PATCH is a patch file, or `-` / absent to read from standard input.

Edits are found at the first of three matching tiers (exact, trailing whitespace, leading + trailing whitespace), so a hunk still lands when the model drifted its indentation. Every file changes or none does; failures are reported per edit with `failed: <k> of <n> edits`.

See [SPEC.md](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) for the full contract — this entry was written from the spec shipped in the kit.
