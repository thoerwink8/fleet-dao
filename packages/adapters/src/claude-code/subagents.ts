// 把仓里 .claude/agents/*.md 的子代理定义（frontmatter + 正文）转成 `claude --agents <文件>` 要的 JSON（#1641 第 4 片）。
//
// 改这里之前必须知道：
// - 为什么要转：法国上引擎经 reclaude 起的会话带 `--setting-sources project`，只认分支上工作树里的那份定义；转成 --agents 以后
//   同名的压住工作树里的，发哪一版就用哪一版（方案 specs/1641-子代理分档/法国实装.md 第一节第 4 条）。
// - 去掉三样：isolation（会话已经在任务自己的工作树里，再嵌一层改动就不在交付分支上）、color（CLI 忽略它）、
//   mcp__ 开头的工具（引擎会话带 --strict-mcp-config，没有 MCP）。
// - 解析不了、缺 description 或 model、认不出的字段，一律抛错写清哪个文件哪一项：不悄悄跳过，不拿空定义冒充装上了。
// - 不引 yaml 包：adapters 没有这个依赖，这批定义的 frontmatter 只有「键: 值」和「- 项」列表两种写法。

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 这一版发布目录里的子代理定义：和 PRETOOL_SCRIPT 同一个找法（本文件往上四级是仓根；法国上在
 * /srv/fleet-dao-releases/<提交号>/，归 root、会话改不了）。
 */
export const SUBAGENTS_DIR = fileURLToPath(new URL('../../../../.claude/agents', import.meta.url));

/** --agents JSON 里一个子代理的样子（字段取自官方 sub-agents 文档 CLI 定义那一节）。 */
export interface SubagentDefinition {
  description: string;
  prompt: string;
  model: string;
  tools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  maxTurns?: number;
  skills?: string[];
  effort?: string;
  memory?: string;
  initialPrompt?: string;
  background?: boolean;
  omitClaudeMd?: boolean;
}

export type SubagentDefinitions = Record<string, SubagentDefinition>;

/** 读进来之后丢掉的键：name 是字典的键，color 是界面颜色，isolation 见文件头。 */
const DROPPED_KEYS = new Set(['name', 'color', 'isolation']);

type Kind = 'string' | 'number' | 'boolean' | 'list' | 'tools';

/** 认得的键和它的类型。不在这里也不在 DROPPED_KEYS 的键一律抛错。 */
const KEYS: Record<string, Kind> = {
  description: 'string',
  model: 'string',
  tools: 'tools',
  disallowedTools: 'tools',
  permissionMode: 'string',
  maxTurns: 'number',
  skills: 'list',
  effort: 'string',
  memory: 'string',
  initialPrompt: 'string',
  background: 'boolean',
  omitClaudeMd: 'boolean',
};

function fail(file: string, what: string): never {
  throw new Error(`子代理定义 ${file}：${what}`);
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** 拆出 frontmatter 的各行和正文。开头没有 --- 圈起来的一段就是认不出。 */
function splitFrontmatter(file: string, text: string): { lines: string[]; body: string } {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/.exec(src);
  if (!m) fail(file, '开头认不出 frontmatter（--- 圈起来的那几行）');
  return { lines: (m[1] ?? '').split('\n'), body: (m[2] ?? '').trim() };
}

/** 逐行读成 键 → 原始值（字符串或列表）。只认顶格的「键: 值」和缩进的「- 项」。 */
function readPairs(file: string, lines: readonly string[]): Map<string, string | string[]> {
  const out = new Map<string, string | string[]>();
  let listKey: string | undefined;
  for (const [i, line] of lines.entries()) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) {
      const cur = listKey === undefined ? undefined : out.get(listKey);
      if (!Array.isArray(cur)) fail(file, `frontmatter 第 ${i + 1} 行是列表项，上面却没有「键:」开头的列表`);
      cur.push(unquote(item[1] ?? ''));
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9_]*):(?:\s+(.*)|\s*)$/.exec(line);
    if (!kv) fail(file, `frontmatter 第 ${i + 1} 行认不出（只认「键: 值」和「- 项」）：${line.slice(0, 80)}`);
    const key = kv[1] ?? '';
    if (out.has(key)) fail(file, `frontmatter 里 ${key} 写了两遍`);
    const value = (kv[2] ?? '').trim();
    if (value === '') {
      out.set(key, []);
      listKey = key;
    } else {
      out.set(key, value);
      listKey = undefined;
    }
  }
  return out;
}

function asList(raw: string | string[]): string[] {
  if (Array.isArray(raw)) return raw;
  const inline = /^\[(.*)\]$/.exec(raw.trim());
  return (inline ? (inline[1] ?? '') : raw)
    .split(',')
    .map((s) => unquote(s))
    .filter((s) => s !== '');
}

/** 把一份 .md 转成一个子代理定义。name 取 frontmatter 的 name，必须和文件名（去掉 .md）一致。 */
export function parseSubagent(file: string, text: string): { name: string; definition: SubagentDefinition } {
  const { lines, body } = splitFrontmatter(file, text);
  const pairs = readPairs(file, lines);
  const rawName = pairs.get('name');
  const name = typeof rawName === 'string' ? unquote(rawName) : '';
  if (!name) fail(file, '缺 name');
  if (file.replace(/\.md$/, '') !== name) fail(file, `name「${name}」和文件名对不上`);
  const fields: Record<string, unknown> = {};
  for (const [key, raw] of pairs) {
    if (DROPPED_KEYS.has(key)) continue;
    const kind = KEYS[key];
    if (kind === undefined)
      fail(file, `不认识的字段 ${key}（--agents 不一定支持它，不悄悄带上也不悄悄丢掉）`);
    if (kind === 'list' || kind === 'tools') {
      let items = asList(raw);
      if (kind === 'tools') {
        // 引擎会话没有 MCP（--strict-mcp-config）：mcp__ 开头的工具带上去也用不了
        items = items.filter((t) => !t.startsWith('mcp__'));
        if (items.length === 0)
          fail(file, `${key} 去掉 mcp__ 开头的工具之后一个不剩（空列表等于不给工具，不替它定）`);
      }
      fields[key] = items;
      continue;
    }
    if (Array.isArray(raw)) fail(file, `${key} 应该是一个值，写成了列表`);
    const value = unquote(raw);
    if (kind === 'number') {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) fail(file, `${key} 要是正整数：${value}`);
      fields[key] = n;
    } else if (kind === 'boolean') {
      if (value !== 'true' && value !== 'false') fail(file, `${key} 要写 true 或 false：${value}`);
      fields[key] = value === 'true';
    } else {
      fields[key] = value;
    }
  }
  if (typeof fields.description !== 'string' || fields.description === '') fail(file, '缺 description');
  if (typeof fields.model !== 'string' || fields.model === '') fail(file, '缺 model');
  if (body === '') fail(file, '正文是空的（正文就是子代理的提示词）');
  return { name, definition: { ...fields, prompt: body } as unknown as SubagentDefinition };
}

/** 读一个目录里所有 *.md，转成 --agents 要的对象（按名字排序，同样的输入出同样的字节）。目录读不了、一个都没有也抛错。 */
export async function loadSubagents(dir: string = SUBAGENTS_DIR): Promise<SubagentDefinitions> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort();
  } catch (error) {
    throw new Error(
      `子代理定义的目录读不了：${dir}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  if (names.length === 0) throw new Error(`子代理定义的目录里一份 .md 都没有：${dir}`);
  const out: SubagentDefinitions = {};
  for (const file of names) {
    const text = await readFile(join(dir, file), 'utf8').catch((error: unknown) => {
      throw new Error(
        `子代理定义 ${file}：读不了（${error instanceof Error ? error.message : String(error)}）`,
      );
    });
    const { name, definition } = parseSubagent(file, text);
    out[name] = definition;
  }
  return out;
}

/** 带 isolation: worktree 的那几个子代理的名字（引擎写 settings.local.json 时用它们拼 deny）。 */
export async function isolatedSubagentNames(dir: string = SUBAGENTS_DIR): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort();
  const out: string[] = [];
  for (const file of names) {
    const text = await readFile(join(dir, file), 'utf8');
    const { lines } = splitFrontmatter(file, text);
    const iso = readPairs(file, lines).get('isolation');
    if (typeof iso === 'string' && unquote(iso) === 'worktree') out.push(file.replace(/\.md$/, ''));
  }
  return out;
}

/** 文件里的字节：缩进两格、末尾换行；引擎拿它算内容哈希、写盘。 */
export function renderAgentsJson(defs: SubagentDefinitions): string {
  return `${JSON.stringify(defs, null, 2)}\n`;
}
