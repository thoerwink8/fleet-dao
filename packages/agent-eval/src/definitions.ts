// 读子代理定义：.claude/agents/*.md 的 frontmatter（name、model、tools、maxTurns、effort 等）和正文。
// 认不出就报错，不猜：缺必填项、行不是「键: 值」、maxTurns 不是正整数、model 不是完整 id，都抛 DefinitionError。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export class DefinitionError extends Error {
  constructor(file: string, why: string) {
    super(`${file}：${why}`);
    this.name = 'DefinitionError';
  }
}

export interface AgentDefinition {
  name: string;
  description: string;
  /** 定义里写的完整模型 id（探查时会被 --model 覆盖，三档各跑一遍）。 */
  model: string;
  tools: string[];
  maxTurns: number | undefined;
  effort: string | undefined;
  /** 正文：探查时原样当 --append-system-prompt。 */
  body: string;
  file: string;
}

/** 解析一份定义。file 只用来报错。 */
export function parseAgentDefinition(text: string, file: string): AgentDefinition {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') throw new DefinitionError(file, '第一行不是 ---，认不出 frontmatter');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new DefinitionError(file, 'frontmatter 没有结尾的 ---');
  const fields = new Map<string, string>();
  // 值为空、后面跟 `  - 项` 的是列表（如 skills:）：项用逗号接起来当这个键的值。
  let listKey: string | undefined;
  for (const [i, raw] of lines.slice(1, end).entries()) {
    if (!raw.trim()) continue;
    const item = /^\s+-\s+(.+?)\s*$/.exec(raw);
    if (item && listKey !== undefined) {
      const prev = fields.get(listKey);
      fields.set(listKey, prev ? `${prev}, ${item[1] as string}` : (item[1] as string));
      continue;
    }
    listKey = undefined;
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(raw);
    if (!m) throw new DefinitionError(file, `frontmatter 第 ${i + 1} 行不是「键: 值」：${raw.slice(0, 40)}`);
    const key = m[1] as string;
    if (fields.has(key)) throw new DefinitionError(file, `frontmatter 里 ${key} 写了两次`);
    fields.set(key, (m[2] ?? '').trim());
    if (!(m[2] ?? '').trim()) listKey = key;
  }
  const need = (key: string): string => {
    const v = fields.get(key);
    if (!v) throw new DefinitionError(file, `缺 ${key}`);
    return v;
  };
  const name = need('name');
  const description = need('description');
  const model = need('model');
  if (!/^claude-[a-z0-9.-]+$/.test(model)) throw new DefinitionError(file, `model 不是完整 id：${model}`);
  const tools = need('tools')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tools.length === 0) throw new DefinitionError(file, 'tools 是空的');
  const mt = fields.get('maxTurns');
  let maxTurns: number | undefined;
  if (mt !== undefined) {
    if (!/^[1-9]\d*$/.test(mt)) throw new DefinitionError(file, `maxTurns 不是正整数：${mt}`);
    maxTurns = Number(mt);
  }
  const body = lines
    .slice(end + 1)
    .join('\n')
    .trim();
  if (!body) throw new DefinitionError(file, '正文是空的');
  return { name, description, model, tools, maxTurns, effort: fields.get('effort'), body, file };
}

/** 读一个目录下所有 *.md 定义，按文件名排序；任何一份认不出就整个抛错。 */
export function loadAgentDefinitions(dir: string): AgentDefinition[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  if (files.length === 0) throw new DefinitionError(dir, '目录里没有 .md 定义');
  return files.map((f) => parseAgentDefinition(readFileSync(join(dir, f), 'utf8'), join(dir, f)));
}

/** 起会话时给 --allowedTools 的工具：去掉 mcp__ 开头的（探查会话带 --strict-mcp-config，没有 MCP）。 */
export function allowedToolsOf(def: AgentDefinition): string[] {
  return def.tools.filter((t) => !t.startsWith('mcp__'));
}
