import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_CASES } from '../src/cases/index.ts';
import {
  allowedToolsOf,
  DefinitionError,
  loadAgentDefinitions,
  parseAgentDefinition,
} from '../src/definitions.ts';
import { REPO_ROOT, SKIPPED_SCENARIOS } from '../src/types.ts';

const GOOD = `---
name: fleet-demo
description: 演示：一句话，里面有冒号: 也行
model: claude-haiku-5-5
effort: low
maxTurns: 15
tools: Read, Grep, mcp__codegraph__codegraph_explore, mcp__context7__*
color: cyan
---
你是 fleet-demo。

做法：先读再答。
`;

describe('parseAgentDefinition：认得出的', () => {
  it('读出 name、model、tools、maxTurns、effort 和正文', () => {
    const d = parseAgentDefinition(GOOD, 'demo.md');
    expect(d.name).toBe('fleet-demo');
    expect(d.model).toBe('claude-haiku-5-5');
    expect(d.tools).toEqual(['Read', 'Grep', 'mcp__codegraph__codegraph_explore', 'mcp__context7__*']);
    expect(d.maxTurns).toBe(15);
    expect(d.effort).toBe('low');
    expect(d.description).toContain('冒号: 也行');
    expect(d.body).toBe('你是 fleet-demo。\n\n做法：先读再答。');
  });

  it('maxTurns、effort 没写就是 undefined；CRLF 也认', () => {
    const d = parseAgentDefinition(
      GOOD.replace(/effort: low\n|maxTurns: 15\n/g, '').replace(/\n/g, '\r\n'),
      'demo.md',
    );
    expect(d.maxTurns).toBeUndefined();
    expect(d.effort).toBeUndefined();
    expect(d.name).toBe('fleet-demo');
  });

  it('allowedToolsOf 去掉 mcp__ 开头的', () => {
    expect(allowedToolsOf(parseAgentDefinition(GOOD, 'demo.md'))).toEqual(['Read', 'Grep']);
  });

  it('frontmatter 里的列表（skills:）认得，不影响别的键', () => {
    const d = parseAgentDefinition(
      GOOD.replace('color: cyan', 'skills:\n  - frontend-design\ncolor: cyan'),
      'demo.md',
    );
    expect(d.tools).toContain('Read');
  });
});

describe('parseAgentDefinition：认不出的报错，不猜', () => {
  const bad: [string, string, RegExp][] = [
    ['没有 frontmatter', '你好', /第一行不是 ---/],
    ['frontmatter 没收尾', '---\nname: x\n', /没有结尾/],
    ['缺 model', GOOD.replace(/model: .*\n/, ''), /缺 model/],
    ['缺 tools', GOOD.replace(/tools: .*\n/, ''), /缺 tools/],
    ['model 是别名不是完整 id', GOOD.replace('claude-haiku-5-5', 'haiku'), /不是完整 id/],
    ['maxTurns 不是正整数', GOOD.replace('maxTurns: 15', 'maxTurns: many'), /maxTurns 不是正整数/],
    ['行不是「键: 值」', GOOD.replace('color: cyan', 'color cyan'), /不是「键: 值」/],
    ['同一个键写了两次', GOOD.replace('color: cyan', 'effort: high'), /effort 写了两次/],
    ['正文是空的', GOOD.slice(0, GOOD.indexOf('你是')), /正文是空的/],
  ];
  for (const [name, text, re] of bad) {
    it(name, () => {
      expect(() => parseAgentDefinition(text, 'bad.md')).toThrow(DefinitionError);
      expect(() => parseAgentDefinition(text, 'bad.md')).toThrow(re);
    });
  }
});

describe('仓里真实的 .claude/agents', () => {
  const defs = loadAgentDefinitions(join(REPO_ROOT, '.claude', 'agents'));

  it('每一份都认得出，模型都是完整 id', () => {
    expect(defs.length).toBeGreaterThan(0);
    for (const d of defs) expect(d.model).toMatch(/^claude-(haiku|sonnet|opus)-/);
  });

  it('每道题的子代理都有定义；要浏览器的两个不出题', () => {
    const names = new Set(defs.map((d) => d.name));
    for (const c of ALL_CASES) expect(names.has(c.agent), `${c.id} 的 ${c.agent}`).toBe(true);
    for (const k of SKIPPED_SCENARIOS) {
      expect(names.has(k.agent)).toBe(true);
      expect(ALL_CASES.some((c) => c.agent === k.agent)).toBe(false);
    }
  });
});
