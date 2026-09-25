// 清单：本脚本往各家 skill 目录里装过哪些。只有清单里记着的，它才会更新或撤掉；别的（Mirasim 插件链进来的、
// claude.ai 同步来的、旧仓链进来的）一律不碰。清单读不懂就是读不懂，不当成空的——当成空的，
// 仓里删掉的 skill 就永远撤不掉，而检查照样说没事。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Platform, placeOn, STATE_DIR } from './targets.ts';

export interface Manifest {
  /** skill 目录（相对家目录、/ 分隔，如 .claude/skills）→ 装过的 skill 名 */
  skills: Record<string, string[]>;
}

export function manifestPath(home: string, platform: Platform): string {
  return join(home, placeOn(STATE_DIR, platform), 'agents-sync.json');
}

export type ManifestRead = { ok: true; value: Manifest } | { ok: false; why: string };

export function readManifest(file: string): ManifestRead {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, value: { skills: {} } };
    return { ok: false, why: `读不了（${(err as NodeJS.ErrnoException).code ?? String(err)}）` };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, why: '不是 JSON' };
  }
  const skills = (data as { skills?: unknown } | null)?.skills;
  if (typeof skills !== 'object' || skills === null || Array.isArray(skills)) {
    return { ok: false, why: '没有 skills 这一项' };
  }
  const out: Record<string, string[]> = {};
  for (const [dir, names] of Object.entries(skills)) {
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
      return { ok: false, why: `skills["${dir}"] 不是名字列表` };
    }
    // 名字会拼到 skill 目录后面去撤、去删：只认单个目录名，带路径的（../../.ssh）一律读不懂
    const bad = names.find((n) => !isPlainName(n));
    if (bad !== undefined) return { ok: false, why: `skills["${dir}"] 里的「${bad}」不是单个目录名` };
    out[dir] = [...names];
  }
  return { ok: true, value: { skills: out } };
}

function isPlainName(n: string): boolean {
  return n !== '' && n !== '.' && n !== '..' && !/[\\/\0]/.test(n);
}

export function renderManifest(m: Manifest): string {
  const skills: Record<string, string[]> = {};
  for (const dir of Object.keys(m.skills).sort()) {
    const names = [...new Set(m.skills[dir])].sort();
    if (names.length) skills[dir] = names;
  }
  const doc = {
    说明: 'fleet-dao 的同步脚本（packages/agents-sync）装进各家 skill 目录的东西。只有这里记着的它才会更新或撤掉，别的一律不碰。别手改。',
    skills,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** 内容没变就不写（第二遍零改动）；还没有清单、也没装过东西，就不建；返回写没写 */
export function writeManifest(file: string, m: Manifest): boolean {
  const text = renderManifest(m);
  try {
    if (readFileSync(file, 'utf8') === text) return false;
  } catch {
    if (Object.values(m.skills).every((names) => names.length === 0)) return false;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
  return true;
}
