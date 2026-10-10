// 子代理定义（.claude/agents/*.md）转 `--agents` 的 JSON（claude-code/subagents.ts，#1641 第 4a 片）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isolatedSubagentNames,
  loadSubagents,
  parseSubagent,
  renderAgentsJson,
  SUBAGENTS_DIR,
} from '../src/claude-code/subagents.ts';

const GOOD = `---
name: fleet-demo
description: 演示用（Haiku，只读）
model: claude-haiku-5-5
effort: low
maxTurns: 12
omitClaudeMd: true
isolation: worktree
skills:
  - frontend-design
tools: Read, Grep, mcp__codegraph__codegraph_explore, mcp__playwright__*, Bash
color: cyan
---
你是 fleet-demo。
第二行。
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-subagents-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseSubagent', () => {
  it('转成 --agents 的字段：去掉 isolation、color 和 mcp__ 开头的工具，数字和布尔转成真类型，正文就是 prompt', () => {
    const { name, definition } = parseSubagent('fleet-demo.md', GOOD);
    expect(name).toBe('fleet-demo');
    expect(definition).toEqual({
      description: '演示用（Haiku，只读）',
      model: 'claude-haiku-5-5',
      effort: 'low',
      maxTurns: 12,
      omitClaudeMd: true,
      skills: ['frontend-design'],
      tools: ['Read', 'Grep', 'Bash'],
      prompt: '你是 fleet-demo。\n第二行。',
    });
    expect(definition).not.toHaveProperty('isolation');
    expect(definition).not.toHaveProperty('color');
    expect(JSON.stringify(definition)).not.toContain('mcp__');
  });

  it('【故意造出的失败】缺 description：抛错写明哪个文件、缺哪一项', () => {
    expect(() => parseSubagent('fleet-demo.md', GOOD.replace(/^description:.*\n/m, ''))).toThrow(
      '子代理定义 fleet-demo.md：缺 description',
    );
  });

  it('【故意造出的失败】缺 model：抛错', () => {
    expect(() => parseSubagent('fleet-demo.md', GOOD.replace(/^model:.*\n/m, ''))).toThrow(
      '子代理定义 fleet-demo.md：缺 model',
    );
  });

  it('【故意造出的失败】开头不是 frontmatter：抛错，不当成空定义', () => {
    expect(() => parseSubagent('fleet-demo.md', '随便一段话\n')).toThrow('认不出 frontmatter');
  });

  it('【故意造出的失败】name 和文件名对不上、不认识的字段、数字写成文字、工具去掉 mcp__ 后一个不剩：都抛错', () => {
    expect(() => parseSubagent('fleet-other.md', GOOD)).toThrow('name「fleet-demo」和文件名对不上');
    expect(() => parseSubagent('fleet-demo.md', GOOD.replace('color: cyan', 'weird: 1'))).toThrow(
      '不认识的字段 weird',
    );
    expect(() => parseSubagent('fleet-demo.md', GOOD.replace('maxTurns: 12', 'maxTurns: many'))).toThrow(
      'maxTurns 要是正整数',
    );
    expect(() =>
      parseSubagent('fleet-demo.md', GOOD.replace(/^tools:.*$/m, 'tools: mcp__codegraph__codegraph_explore')),
    ).toThrow('去掉 mcp__ 开头的工具之后一个不剩');
  });

  it('【故意造出的失败】正文是空的：抛错（正文就是子代理的提示词）', () => {
    expect(() =>
      parseSubagent('fleet-demo.md', '---\nname: fleet-demo\ndescription: x\nmodel: claude-haiku-5-5\n---\n'),
    ).toThrow('正文是空的');
  });
});

describe('loadSubagents', () => {
  it('读目录里的 *.md，按名字排序；别的文件不读', async () => {
    writeFileSync(join(dir, 'fleet-b.md'), GOOD.replace('fleet-demo', 'fleet-b'));
    writeFileSync(join(dir, 'fleet-a.md'), GOOD.replace('fleet-demo', 'fleet-a'));
    writeFileSync(join(dir, 'README.txt'), '不是定义');
    const defs = await loadSubagents(dir);
    expect(Object.keys(defs)).toEqual(['fleet-a', 'fleet-b']);
    expect(renderAgentsJson(defs)).toBe(`${JSON.stringify(defs, null, 2)}\n`);
  });

  it('【故意造出的失败】目录不在、目录里没有 .md、有一份坏的：都抛错并带上路径或文件名', async () => {
    await expect(loadSubagents(join(dir, '不在'))).rejects.toThrow('子代理定义的目录读不了');
    mkdirSync(join(dir, 'empty'));
    await expect(loadSubagents(join(dir, 'empty'))).rejects.toThrow('一份 .md 都没有');
    writeFileSync(join(dir, 'fleet-bad.md'), '---\nname: fleet-bad\n---\n正文\n');
    await expect(loadSubagents(dir)).rejects.toThrow('fleet-bad.md：缺 description');
  });

  it('isolatedSubagentNames：只列带 isolation: worktree 的', async () => {
    writeFileSync(join(dir, 'fleet-demo.md'), GOOD);
    writeFileSync(
      join(dir, 'fleet-plain.md'),
      GOOD.replace('fleet-demo', 'fleet-plain').replace('isolation: worktree\n', ''),
    );
    expect(await isolatedSubagentNames(dir)).toEqual(['fleet-demo']);
  });
});

describe('仓里真的那 16 份', () => {
  it('全部转得出来：16 个键、都有 description、model、prompt，没有 isolation、color、mcp__；带 isolation 的恰好是那 5 个', async () => {
    const defs = await loadSubagents(SUBAGENTS_DIR);
    const names = Object.keys(defs);
    expect(names).toHaveLength(16);
    expect(names.every((n) => n.startsWith('fleet-'))).toBe(true);
    for (const def of Object.values(defs)) {
      expect(def.description).not.toBe('');
      expect(def.model).toMatch(/^claude-(haiku|sonnet|opus)-5-5$/);
      expect(def.prompt).not.toBe('');
      expect(Object.keys(def)).not.toContain('isolation');
      expect(Object.keys(def)).not.toContain('color');
    }
    // 正文里提到 mcp__ 工具名是文字，不算；工具清单里不许有
    expect(
      Object.values(defs)
        .flatMap((d) => d.tools ?? [])
        .filter((t) => t.startsWith('mcp__')),
    ).toEqual([]);
    expect(await isolatedSubagentNames(SUBAGENTS_DIR)).toEqual([
      'fleet-builder',
      'fleet-debugger',
      'fleet-fixer',
      'fleet-standard-editor',
      'fleet-ui-builder',
    ]);
  });
});
