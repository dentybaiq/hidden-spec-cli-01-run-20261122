# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dentybaiq/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dentybaiq/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is one command-line patch tool for every edit format an AI model
writes: unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks,
V4A patches, and JSON text-editor tool calls. It finds the lines an edit
names through three tiers of whitespace-tolerant matching, and it changes
every file or none — a failed edit reports why and nothing is written.

Built for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
"Build mend, one patch tool for every AI edit format".

## Run

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file, or `-` / omitted to read from standard input.
`--format` picks one of `unified`, `search-replace`, `v4a`, `json`, or
`auto` (the default, which detects the format). `--check` reports what
would change without writing anything. `--strict` matches lines exactly.

## Behaviour

- Exit `0` prints one line per changed path (`A`, `D`, `M`, or `R old -> new`)
  and a final `ok: <n> files` line.
- Exit `1` prints one `error: <code> <path>` line per failed edit
  (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`) and a
  `failed: <k> of <n> edits` line; no file is written.
- Exit `2` prints a single `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>` line.

Matching tries exact lines first, then lines equal after trimming trailing
whitespace, then lines equal after trimming both ends, re-indenting added
lines at the loosest tier. Unified hunks take the occurrence nearest the
(line-numbered) position the patch claims. See `SPEC.md` for the full
contract.

## Layout

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the kit's trial runner, unchanged.
- `check.ts` — runs the 100 public practice checks (in the kit, not here).

## License

MIT — see `LICENSE`.
