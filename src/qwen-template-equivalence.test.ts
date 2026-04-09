import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { atifTrajectoryToQwen35Record } from './atif-to-qwen.js';
import { renderQwen35Body } from './qwen-plain-text.js';
import {
  buildQwenFixture,
  buildQwenStressFixture,
  canonicalAtifFixture,
  canonicalAtifStressFixture,
} from './roundtrip-fixtures.js';

type OfficialRenderOptions = {
  addVisionId?: boolean;
  addGenerationPrompt?: boolean;
  enableThinking?: boolean;
};

function renderOfficialTemplate(payload: { messages: unknown; tools: unknown }, options: OfficialRenderOptions = {}) {
  const templatePath = path.resolve('fixtures/qwen3.5-chat_template.jinja');
  const script = [
    'import json, sys',
    'from pathlib import Path',
    'from jinja2 import Environment',
    'template_path = Path(sys.argv[1])',
    'payload = json.load(sys.stdin)',
    'env = Environment(trim_blocks=False, lstrip_blocks=False)',
    'def raise_exception(message):',
    '    raise Exception(message)',
    "env.globals['raise_exception'] = raise_exception",
    'template = env.from_string(template_path.read_text())',
    "render_kwargs = dict(messages=payload['messages'], tools=payload.get('tools', []), add_vision_id=payload['options'].get('addVisionId', False), add_generation_prompt=payload['options'].get('addGenerationPrompt', False))",
    "if 'enableThinking' in payload['options']:",
    "    render_kwargs['enable_thinking'] = payload['options']['enableThinking']",
    "print(template.render(**render_kwargs), end='')",
  ].join('\n');

  return execFileSync('python', ['-c', script, templatePath], {
    input: JSON.stringify({ ...payload, options }),
    encoding: 'utf8',
  });
}

describe('Qwen body renderer', () => {
  it('matches the official Qwen 3.5 chat template for native Qwen records', () => {
    const record = buildQwenFixture();
    const official = renderOfficialTemplate({ messages: record.messages, tools: record.tools });
    expect(renderQwen35Body(record)).toBe(official);
  });

  it('matches the official Qwen 3.5 chat template for ATIF-projected Qwen records', () => {
    const record = atifTrajectoryToQwen35Record(canonicalAtifFixture());
    const official = renderOfficialTemplate({ messages: record.messages, tools: record.tools });
    expect(renderQwen35Body(record)).toBe(official);
  });

  it('matches the official template for a stress fixture with multiple tool calls and empty assistant content', () => {
    const record = buildQwenStressFixture();
    const official = renderOfficialTemplate({ messages: record.messages, tools: record.tools });
    expect(renderQwen35Body(record)).toBe(official);
  });

  it('matches the official template when add_generation_prompt is enabled', () => {
    const record = buildQwenStressFixture();
    const options = { addGenerationPrompt: true, enableThinking: false };
    const official = renderOfficialTemplate({ messages: record.messages, tools: record.tools }, options);
    expect(renderQwen35Body(record, options)).toBe(official);
  });

  it('matches the official template when vision ids are enabled across multiple images and videos', () => {
    const record = buildQwenStressFixture();
    const options = { addVisionId: true };
    const official = renderOfficialTemplate({ messages: record.messages, tools: record.tools }, options);
    expect(renderQwen35Body(record, options)).toBe(official);
  });

  it('matches the official template for a stress ATIF projection', () => {
    const record = atifTrajectoryToQwen35Record(canonicalAtifStressFixture());
    const official = renderOfficialTemplate({ messages: record.messages, tools: record.tools });
    expect(renderQwen35Body(record)).toBe(official);
  });
});
