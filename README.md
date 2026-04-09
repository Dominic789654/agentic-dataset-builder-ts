# Agentic Dataset Builder

Pure TypeScript toolkit for two related jobs:

1. strict lossless `ATIF <-> QwenRecord <-> QwenPlainText` conversion
2. building validated parquet datasets from local Pi, Codex, and Claude Code history

## Headline feature

This repo now treats the reversible codec as the core feature:

- `ATIF`
  - Harbor-style trajectory format for agentic sessions
  - best when you want explicit steps, tool calls, observations, metrics, and subagent refs
- `QwenRecord`
  - structured Qwen 3.5 compatible chat record
  - best when you want message-level training data with tools and reasoning separated
- `QwenPlainText`
  - canonical plain-text rendering derived from Qwen 3.5's `chat_template.jinja`
  - best when you need the exact text form that a Qwen-style template would consume

The conversion guarantees are strict for codec-generated artifacts:

- `ATIF -> QwenRecord -> ATIF`
  - exact round-trip
- `QwenRecord -> ATIF -> QwenRecord`
  - exact round-trip
- `QwenRecord -> QwenPlainText -> QwenRecord`
  - exact round-trip
- `QwenPlainText -> QwenRecord -> QwenPlainText`
  - exact round-trip
- `ATIF -> QwenRecord -> QwenPlainText -> QwenRecord -> ATIF`
  - exact full-chain round-trip

## How the reversible codec works

The plain-text body alone is not enough to recover every structured field exactly, so the codec uses explicit metadata for reversibility.

`QwenPlainText` is:

1. a canonical Qwen-3.5-style rendered body
2. followed by a sentinel-delimited metadata trailer

Structure:

```text
<canonical qwen body>
<<<AGENTIC_DATASET_BUILDER_QWEN_PLAINTEXT_METADATA_BEGIN>>>
{"body_sha256":"...","codec_version":"agentic-dataset-builder/qwen-plain-text-v1","qwen_record_json":"..."}
<<<AGENTIC_DATASET_BUILDER_QWEN_PLAINTEXT_METADATA_END>>>
```

The parser is intentionally strict:

- it only accepts the repo's canonical plaintext form
- it verifies the trailer payload
- it verifies the body hash
- it re-renders the embedded `QwenRecord`
- it requires the body to match exactly

For `ATIF <-> QwenRecord`, exact reconstruction is preserved through explicit round-trip payloads:

- `ATIF -> QwenRecord`
  - stores the exact ATIF trajectory in `record.meta.roundtrip.atif_trajectory_json`
- `QwenRecord -> ATIF`
  - stores the exact Qwen record in `trajectory.extra.roundtrip.qwen35_record_json`

That means the human-readable projection can stay useful while the metadata keeps the conversion fully reversible and idempotent.

## Why this matters

Most dataset pipelines force you to choose between:

- trajectory fidelity
- chat-model compatibility
- plain-text prompt compatibility

This repo keeps all three:

- `ATIF` keeps the agent trajectory intact
- `QwenRecord` keeps the structured chat view intact
- `QwenPlainText` keeps the model-facing rendered prompt intact
- metadata carries the exact information needed to move back without loss

## Source of the Qwen plaintext rendering

The plaintext renderer is derived from the official Qwen 3.5 chat template semantics:

- system/tool preamble behavior
- assistant `<think>` sections
- `<tool_call>` XML blocks
- user-side `<tool_response>` blocks for tool outputs
- vision placeholder tokens for image/video content

Reference template:

- `https://huggingface.co/Qwen/Qwen3.5-9B/resolve/main/chat_template.jinja`

## What is in the repo today

Core codec files:

- `src/schemas/atif.ts`
- `schemas/atif.schema.json`
- `schemas/atif_pydantic.py`
- `src/schemas/qwen35.ts`
- `src/atif-to-qwen.ts`
- `src/qwen-to-atif.ts`
- `src/qwen-plain-text.ts`

Validation coverage includes:

- reasoning content
- tool calls and tool results
- subagent trajectory refs
- ATIF metrics and extras
- Qwen image/video blocks
- full end-to-end round-trip chains

## Dataset builder CLI

The same repo still provides the original CLI for turning local agent history into a validated parquet dataset.

The CLI will:

- detect local session roots for `pi`, `codex`, and `claude`
- normalize supported histories into the local Qwen35-compatible schema
- label records by training use
- write one final parquet dataset
- write a manifest and a run log

## Fastest path

If the package is published on npm:

```bash
npx --registry=https://registry.npmjs.org/ agentic-dataset-builder@0.2.0 --output-root ./out
```

If working from this repo locally:

```bash
npm install
npm run build
node dist/cli.js --output-root ./out
```

## Default source behavior

- `pi`
  - full agent traces
  - can produce `cot_eligible` or `agent_only`
- `codex`
  - full agent traces
  - usually produces `agent_only`
- `claude`
  - reconstructs main session traces from Claude project JSONL
  - can produce `prompt_only`, `agent_only`, or `cot_eligible`

Note on scope:

- the reversible codec is strict once data is inside `ATIF`, `QwenRecord`, or `QwenPlainText`
- some upstream importers, especially Claude reconstruction, can still be lossy before normalization

## Default output

Each CLI run creates one directory:

```text
<output-root>/agentic-dataset-<timestamp>/
  dataset.parquet
  manifest.json
  run.log
```

Files:

- `dataset.parquet`
  - final merged dataset
- `manifest.json`
  - source roots, source counts, labels kept, output path
- `run.log`
  - step-by-step execution log for debugging

## Recommended commands

Pi + Codex:

```bash
node dist/cli.js --output-root ./out --include-sources pi,codex --include-labels cot_eligible,agent_only
```

Codex + Claude prompt-only:

```bash
node dist/cli.js --output-root ./out --include-sources codex,claude --include-labels agent_only,prompt_only
```

Pi only:

```bash
node dist/cli.js --output-root ./out --include-sources pi --include-labels cot_eligible,agent_only
```

## Important flags

- `--output-root <dir>`
  - required output root
- `--include-sources <csv>`
  - any of: `pi,codex,claude`
- `--include-labels <csv>`
  - any of: `cot_eligible,agent_only,prompt_only,discard`
- `--pi-root <dir>`
  - override detected Pi session path
- `--codex-root <dir>`
  - override detected Codex session path
- `--claude-root <dir>`
  - override detected Claude project-history path
- `--help`
  - print CLI help

## Auto-detected paths

Typical paths:

- Pi: `~/.pi/agent/sessions`
- Codex: `~/.codex/sessions`
- Claude: `~/.claude/projects`

On Windows the CLI also checks `APPDATA` and `LOCALAPPDATA` variants.

## Verification checklist

After a CLI run, verify these three things:

1. `dataset.parquet` exists
2. `manifest.json` exists
3. `run.log` does not end with an uncaught error

Typical quick check:

```bash
ls ./out/agentic-dataset-*/
```

## Development

Useful development commands:

```bash
npm run check
npm run test
npm run build
```
