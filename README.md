# Agentic Dataset Builder

Pure TypeScript CLI for building one merged parquet dataset from local Pi, Codex, and Claude Code history.

## Requirements

- Node 18+

## Install and run

Without installing globally:

```bash
npx agentic-dataset-builder@0.2.0 --output-root ./out
```

Local development:

```bash
npm install
npm run build
node dist/cli.js --output-root ./out
```

## Examples

```bash
# Pi + Codex
npx agentic-dataset-builder@0.2.0 --output-root ./out --include-sources pi,codex --include-labels cot_eligible,agent_only

# Codex + Claude prompt-only
npx agentic-dataset-builder@0.2.0 --output-root ./out --include-sources codex,claude --include-labels agent_only,prompt_only

# Pi only
npx agentic-dataset-builder@0.2.0 --output-root ./out --include-sources pi --include-labels cot_eligible,agent_only
```

## Output

Each run creates a directory like:

```text
out/agentic-dataset-<timestamp>/
  dataset.parquet
  manifest.json
  run.log
```

- `dataset.parquet`: final merged dataset
- `manifest.json`: source roots, counts, labels, and summary stats
- `run.log`: step-by-step execution log

## Source support

- `pi`: full agent trace with visible reasoning when available
- `codex`: agent trace, often without visible reasoning
- `claude`: prompt-history only for now, labeled `prompt_only`

## Notes

- default source roots are auto-detected for Linux, macOS, and Windows
- override paths with `--pi-root`, `--codex-root`, and `--claude-root`
- Claude is intentionally low-fidelity right now: user prompt history only, not full assistant/tool trace
