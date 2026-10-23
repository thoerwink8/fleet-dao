// 下发副本漂移提醒：fleet-dao 往对外仓下发的脚本（清单在 agents/downstream-copies.json）是对外仓自己原样拷进去的，
// 上游改了下游不知道。fleet-dao 不往对外仓里加检查、不写任何文件，只在本机开会话时（session-start.mjs）说一行。
// 和别的钩子一样被 agents-sync 整份拷进 ~/.fleet-dao/hooks/，只用 node 自带的模块和同目录的钩子脚本。
// - 清单：在仓里是本文件上一层的 downstream-copies.json；装到机器上之后从同步专用检出 ~/.fleet-dao/origin-main 读。
// - 找副本：当前仓里 git ls-files 按清单的「文件名」找已跟踪的同名文件，第一行以「开头」起头的才算副本
//   （fleet-dao 里上游本身那份不算）。不取远端、不扫工作树，开会话钩子有时间预算。
// - 比：和本机装的技能里那份（~/.claude/skills/<技能>/…，其次 ~/.agents/skills/<技能>/…）比全文，换行符统一成 \n 再比。
//   一样、没有副本不出声；不一样说一行「照哪个技能再拷一次」；读不到本机装的那份照实说没查成，不当成一致。
// 出错一律不抛给钩子，说一行没查成。

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBroken, gitOk as ok, gitWhy as why } from './git-run.mjs';

/** @typedef {import('./git-run.mjs').Git} Git */
/** @typedef {{ id: string, 技能: string, 技能里的路径: string, 文件名: string, 开头: string }} Item 下发清单的一项 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const LIST_FILE = 'downstream-copies.json';
/** 同步专用检出（和 sync-source.mjs 的 syncDirIn、repo-contract.mjs 的 ORIGIN_MAIN_DIR 同一个） */
export const ORIGIN_MAIN_DIR = join('.fleet-dao', 'origin-main');
/** 本机装技能的两处（agents-sync 的 targets.ts：Claude Code 一处，Codex 等别家一处），先找的在前 */
export const SKILL_DIRS = [join('.claude', 'skills'), join('.agents', 'skills')];
const NOT_CHECKED = '下发副本没查成';

/**
 * 清单的候选位置：仓里（本文件上一层）、装到机器上之后的同步专用检出
 * @param {string} [home]
 * @param {string} [hookDir]
 */
export function listPaths(home = homedir(), hookDir = HERE) {
  return [join(hookDir, '..', LIST_FILE), join(home, ORIGIN_MAIN_DIR, 'agents', LIST_FILE)];
}

/** @param {unknown} v */
const str = (v) => typeof v === 'string' && v !== '';

/**
 * 清单正文 → 各项；认不出的明确失败（哪一项、哪里不对），不跳过
 * @param {string} text
 * @returns {{ ok: true, items: Item[] } | { ok: false, why: string }}
 */
export function parseList(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { ok: false, why: `不是合法的 JSON（${e instanceof Error ? e.message : e}）` };
  }
  if (typeof obj !== 'object' || obj === null || !Array.isArray(obj.items))
    return { ok: false, why: '认不出：要有 items 数组' };
  for (const [k, it] of obj.items.entries()) {
    const at = `第 ${k + 1} 项`;
    if (typeof it !== 'object' || it === null || !str(it.id)) return { ok: false, why: `${at}认不出：缺 id` };
    for (const key of ['技能', '技能里的路径', '文件名', '开头'])
      if (!str(it[key])) return { ok: false, why: `${it.id} 认不出：缺「${key}」` };
    // 文件名进 git 的 pathspec，只认普通文件名，免得带上通配
    if (!/^[\w.-]+$/.test(it.文件名)) return { ok: false, why: `${it.id} 的「文件名」只能是字母数字和 ._-` };
    if (it.技能里的路径.split('/').at(-1) !== it.文件名)
      return { ok: false, why: `${it.id} 的「技能里的路径」和「文件名」对不上` };
  }
  return { ok: true, items: obj.items };
}

/**
 * 按候选位置读清单：第一个读得到的为准；都读不到、读到了认不出，明确失败
 * @param {string[]} paths
 * @param {(p: string) => string} [readText]
 * @returns {{ ok: true, items: Item[], path: string } | { ok: false, why: string }}
 */
export function loadList(paths, readText = (p) => readFileSync(p, 'utf8')) {
  const tried = [];
  for (const p of paths) {
    let text;
    try {
      text = readText(p);
    } catch (e) {
      const err = /** @type {{ code?: string, message?: string }} */ (e);
      tried.push(`${p}（${err?.code ?? err?.message ?? e}）`);
      continue;
    }
    const parsed = parseList(text);
    if (!parsed.ok) return { ok: false, why: `${p} ${parsed.why}` };
    return { ok: true, items: parsed.items, path: p };
  }
  return { ok: false, why: `读不到下发清单：${tried.join('；')}` };
}

/**
 * 本机装的上游可能在哪（先找的在前）
 * @param {string} home
 * @param {Item} item
 */
export function installedPaths(home, item) {
  return SKILL_DIRS.map((d) => join(home, d, item.技能, ...item.技能里的路径.split('/')));
}

/** @param {string} s */
const norm = (s) => s.replace(/\r\n/g, '\n');
/** @param {string[]} xs */
const listed = (xs) => xs.slice(0, 3).join('、') + (xs.length > 3 ? ` 等 ${xs.length} 份` : '');
/** @param {unknown} e */
const errWhy = (e) => {
  const err = /** @type {{ code?: string, message?: string }} */ (e);
  return String(err?.code ?? err?.message ?? e);
};

/**
 * 一项：当前仓（root）里找副本，和本机装的上游比。返回要说的几行。
 * @param {{ root: string, item: Item, git: Git, home: string, readText: (p: string) => string }} o
 * @returns {string[]}
 */
function itemLines({ root, item, git, home, readText }) {
  const found = git(root, ['ls-files', '-z', '--full-name', '--', `:(glob)**/${item.文件名}`]);
  if (!ok(found)) return [`${NOT_CHECKED}（${item.id}）：git ls-files 没跑成（${why(found)}）。`];
  const upstreamInRepo = `agents/skills/${item.技能}/${item.技能里的路径}`;
  const copies = [];
  const unread = [];
  for (const file of found.stdout.split('\0').filter(Boolean)) {
    if (file === upstreamInRepo) continue; // fleet-dao 里上游本身那份
    let text;
    try {
      text = readText(join(root, file));
    } catch (e) {
      // 已跟踪、工作树里删了：这份不在了，不算副本
      if (errWhy(e) !== 'ENOENT') unread.push(`${file}（${errWhy(e)}）`);
      continue;
    }
    if (norm(text).split('\n', 1)[0].startsWith(item.开头)) copies.push({ file, text });
  }
  const lines = [];
  if (unread.length > 0)
    lines.push(`${NOT_CHECKED}（${item.id}）：仓里的 ${listed(unread)} 读不了，是不是副本、漂没漂不知道。`);
  if (copies.length === 0) return lines;
  const names = copies.map((c) => c.file);
  const tried = [];
  let upstream = null;
  let from = '';
  for (const p of installedPaths(home, item)) {
    try {
      upstream = readText(p);
      from = p;
      break;
    } catch (e) {
      tried.push(`${p}（${errWhy(e)}）`);
    }
  }
  if (upstream === null) {
    lines.push(
      `${NOT_CHECKED}（${item.id}）：仓里有 ${listed(names)}，本机装的 ${item.技能} 技能里那份读不到（${tried.join('；')}），不知道漂没漂；同步一下这台（pnpm agents:sync）再看。`,
    );
    return lines;
  }
  const drifted = copies.filter((c) => norm(c.text) !== norm(upstream)).map((c) => c.file);
  if (drifted.length > 0)
    lines.push(
      `下发副本和上游不一样：${listed(drifted)} 和本机装的 ${item.技能} 技能里的 ${item.技能里的路径} 不同；照 ${item.技能} 技能（SKILL.md）把 ${from} 原样再拷一次。`,
    );
  return lines;
}

/**
 * 开会话用：当前仓里按下发清单找副本，漂了的、没查成的各说一行；全一致、没有副本、不是 git 仓不出声。
 * @param {{ cwd: string, git: Git, home: string, hookDir?: string, readText?: (p: string) => string }} o
 * @returns {string[]}
 */
export function copyLines({ cwd, git, home, hookDir = HERE, readText = (p) => readFileSync(p, 'utf8') }) {
  try {
    const top = git(cwd, ['rev-parse', '--show-toplevel']);
    // git 跑不起来由临时调整表那一行说，这里不重复
    if (gitBroken(top) || !ok(top)) return [];
    const root = top.stdout.trim();
    if (!root) return [];
    const list = loadList(listPaths(home, hookDir), readText);
    if (!list.ok) return [`${NOT_CHECKED}：${list.why}。`];
    return list.items.flatMap((item) => itemLines({ root, item, git, home, readText }));
  } catch (e) {
    return [`${NOT_CHECKED}：${errWhy(e)}。`];
  }
}
