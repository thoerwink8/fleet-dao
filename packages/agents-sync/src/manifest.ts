// 清单：本脚本往各家 skill 目录、Claude Code 的用户级子代理目录里装过哪些。只有清单里记着的，它才会撤掉；
// 别的（Mirasim 插件链进来的、claude.ai 同步来的、旧仓链进来的、机器上手写的子代理）一律不碰。清单读不懂就是读不懂，
// 不当成空的——当成空的，仓里删掉的 skill 就永远撤不掉，而检查照样说没事。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Platform, placeOn, STATE_DIR } from './targets.ts';

export interface Manifest {
  /** skill 目录（相对家目录、/ 分隔，如 .claude/skills）→ 装过的 skill 名 */
  skills: Record<string, string[]>;
  /** 子代理目录（相对家目录、/ 分隔，如 .claude/agents）→ 装过的定义文件名（haiku55.md）；旧清单没有这一项，当成空的 */
  subagents: Record<string, string[]>;
}

export function manifestPath(home: string, platform: Platform): string {
  return join(home, placeOn(STATE_DIR, platform), 'agents-sync.json');
}

export type ManifestRead = { ok: true; value: Manifest } | { ok: false; why: string };

/** 目录 → 名字列表；名字只认单个文件或目录名。读不懂返回为什么 */
function nameLists(
  field: string,
  value: unknown,
): { ok: true; lists: Record<string, string[]> } | { ok: false; why: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, why: `${field} 不是「目录 → 名字列表」` };
  }
  const out: Record<string, string[]> = {};
  for (const [dir, names] of Object.entries(value)) {
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
      return { ok: false, why: `${field}["${dir}"] 不是名字列表` };
    }
    // 名字会拼到目录后面去撤、去删：只认单个名字，带路径的（../../.ssh）一律读不懂
    const bad = names.find((n) => !isPlainName(n));
    if (bad !== undefined) return { ok: false, why: `${field}["${dir}"] 里的「${bad}」不是单个名字` };
    out[dir] = [...names];
  }
  return { ok: true, lists: out };
}

export function readManifest(file: string): ManifestRead {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { ok: true, value: { skills: {}, subagents: {} } };
    return { ok: false, why: `读不了（${(err as NodeJS.ErrnoException).code ?? String(err)}）` };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, why: '不是 JSON' };
  }
  const doc = data as { skills?: unknown; subagents?: unknown } | null;
  const skills = doc?.skills;
  if (typeof skills !== 'object' || skills === null || Array.isArray(skills)) {
    return { ok: false, why: '没有 skills 这一项' };
  }
  const s = nameLists('skills', skills);
  if (!s.ok) return s;
  // 子代理这一项是后加的（#1393）：旧清单没有它是正常的，当成什么都没装过；有了就得读得懂
  const a =
    doc?.subagents === undefined ? { ok: true as const, lists: {} } : nameLists('subagents', doc.subagents);
  if (!a.ok) return a;
  return { ok: true, value: { skills: s.lists, subagents: a.lists } };
}

function isPlainName(n: string): boolean {
  return n !== '' && n !== '.' && n !== '..' && !/[\\/\0]/.test(n);
}

function sortedLists(lists: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const dir of Object.keys(lists).sort()) {
    const names = [...new Set(lists[dir])].sort();
    if (names.length) out[dir] = names;
  }
  return out;
}

export function renderManifest(m: Manifest): string {
  const subagents = sortedLists(m.subagents);
  const doc = {
    说明: 'fleet-dao 的同步脚本（packages/agents-sync）装进各家 skill 目录、Claude Code 用户级子代理目录的东西。只有这里记着的它才会撤掉，别的一律不碰。别手改。',
    skills: sortedLists(m.skills),
    // 没装过子代理就不写这一项，旧清单读进来再写出去原样不变
    ...(Object.keys(subagents).length ? { subagents } : {}),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** 内容没变就不写（第二遍零改动）；还没有清单、也没装过东西，就不建；返回写没写 */
export function writeManifest(file: string, m: Manifest): boolean {
  const text = renderManifest(m);
  try {
    if (readFileSync(file, 'utf8') === text) return false;
  } catch {
    const empty = (lists: Record<string, string[]>) =>
      Object.values(lists).every((names) => names.length === 0);
    if (empty(m.skills) && empty(m.subagents)) return false;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
  return true;
}
