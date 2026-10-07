// SessionStart 钩子（agents-sync 装进 ~/.fleet-dao/hooks/，登记在 ~/.claude/settings.json；Grok、Devin、Cursor 默认借道读这份）。
// 开会话、续会话时跑；stdout 打一段 JSON，hookSpecificOutput.additionalContext 进会话上下文（Grok 不收开会话钩子的输出）。三件事：
// 1. 会话所在的仓：取一下远端；在 main 上、没有未提交的改动、落后了就快进；快进不了，或在别的分支上而 AGENTS.md 和主线不同，
//    提醒一句（#72 撞过：会话读到旧的 AGENTS.md）。不是 git 仓、没有 origin/main 的不出声。
//    Mirasim 每条消息都 --resume，这一钩子每轮都跑（Claude Code 要求 SessionStart 保持快：
//    https://code.claude.com/docs/en/hooks ，2026-10-06）。git fetch、问 GitHub、扫工作树和 QUIET_MS 共用一扇门，
//    记在 ~/.fleet-dao/session-net/：三分钟内做过就跳过，失败也记上一笔，免得断网时每条消息都等满超时。
//    跳过时仍用手里已有的 origin/main 做本地核对。引导对账、临时调整、仓里的创始人引导、工人状态每轮都做。
//    工人（FLEET_WORKER=1）不走这扇门，起来就要当前的远端。
// 2. 这台机器的规矩、技能、钩子、权限：同步脚本另有**一份只归它的检出**（~/.fleet-dao/origin-main，
//    agents/hooks/sync-source.mjs），永远停在 origin/main 的分离头上，再跑一遍 agents-sync --apply；结论一句话。
//    在别的仓里开会话也照做。这台机器自己的 fleet-dao 检出在哪、在哪个分支、有没有没提交的改动，都不影响这一件
//    （2026-10-01 创始人：「我希望每台机器，能在我们改动后，自动就同步，而不是人为提醒」）：主检出停在功能分支上
//    不再让这台机器停在旧规矩上。那边的检出只被当「种子」读，一个写操作都没有。
//    上次同步成功不到 QUIET_MS 就不再跑：Cursor 讨论一次并行起好几个会话，每个都会触发这个钩子。
//    过了这扇门，同一天也再取、再同步。不用日期文件把主线冻到明天（2026-10-07：当天 01:30 同步之后 #1147 到了主线，
//    后面的会话都跳过，钩子停在旧的 node 命令上）。
// 3. 会话所在仓的「## 生效中的临时调整」表（通用段「我拍了板」那条）：到了最迟复查日期的、缺列的、日期认不出的
//    各说一行，提醒照读法②问创始人。2026-09-28 拍的临时调整抄进产品仓时丢了撤回条件和复查日期，额度恢复了新会话还照做。
// 4. 会话开在 fleet-dao 里时：我开的、检查全绿、没挂自动合并、没碰改标准的 PR（漏走 pnpm pr:open 的兜底），有才说一行；
//    gh 没查成说一行没查成，不当成「没有」。这一件和进度单 #1055、扫工作树一起走第 1 件的三分钟门。
// 环境变量 FLEET_WORKER=1（commander 的 worker.mjs 起工人时设）：只做第 1、2 件，其余各段（创始人的事、工作树、工人状态）一律不出。
// 没查成、没做成都明说原因和这台落后主线几个提交，不当成是最新的。一律退出 0：开会话钩子退出码非 0 也挡不住会话，
// 只会把输出丢掉；钩子自己出了意外也要打一句「没查成」。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcile, sentByFounder } from './founder-inbox.mjs';
import { fetchIsFresh, fetchWithFallback, markFetchOk, repoStampKey } from './fresh-main.mjs';
import { gitBroken, gitRunner, gitOk as ok, gitWhy as why } from './git-run.mjs';
import { logDir } from './prompt-log.mjs';
import {
  cleanId,
  isMachineOpening,
  isMachineSession,
  pidAlive,
  stateDir,
  sessionLines as unattendedLines,
  WORKERS_REL,
} from './unattended.mjs';

export const SYNC_MS = 30_000;
export const QUIET_MS = 3 * 60_000;
const ORIGIN_MAIN = 'refs/remotes/origin/main';
// 规矩在两份文件里：通用段的原件 agents/shared-rules.md（2026-10-05 从仓根 AGENTS.md 挪出来）、仓根 AGENTS.md 的本仓段
const RULE_FILES = ['AGENTS.md', 'agents/shared-rules.md'];
const READ_MAIN =
  '规矩以 origin/main 的为准（git show origin/main:AGENTS.md、git show origin/main:agents/shared-rules.md）';

/** 同步专用的检出、拿它的锁、把它准备好：和 pnpm agents:sync 走同一份（agents/hooks/sync-source.mjs）。
 *  人家是钩子家的脚本，装在 ~/.fleet-dao/hooks/ 里，这里按路径动态加载；加载不了也要照旧说一句，不静默。 */
let source = null;
let sourceWhy = null;
try {
  source = await import('./sync-source.mjs');
} catch (err) {
  sourceWhy = err?.message ?? String(err);
}

/** git 跑一条命令：钩子共用的那一份（git-run.mjs）；引导钩子（bootstrap.mjs）和测试从这里拿 */
export { gitRunner };

/** 用同步专用检出里的 agents-sync 同步这台机器 */
export function syncRunner(timeoutMs = SYNC_MS) {
  return (repo, home) => {
    const bin = join(repo, 'packages', 'agents-sync', 'bin', 'agents-sync');
    const r = spawnSync(process.execPath, [bin, '--apply', '--repo', repo, '--home', home], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error, timeoutMs };
  };
}

const short = (sha) => String(sha).slice(0, 7);

function commonOf(g) {
  const r = g('rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!ok(r)) return null;
  const p = resolve(r.stdout.trim());
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** 这个仓「问 GitHub + 扫工作树」的记号。取远端成功另记在 fetch-ok（fresh-main.mjs），两扇门按同一个 git 公共目录分仓。 */
function sessionNetStamp(home, cwd, git) {
  const key = repoStampKey(cwd, git, ok);
  if (!key) return null;
  return join(home, '.fleet-dao', 'session-net', key);
}

/**
 * 第 1 件：会话所在的仓。返回要说的一句（没有就是 null）；取过远端的话，带上这个仓的 git 公共目录和取没取成
 * （会话就开在 fleet-dao 里时，第 2 件不用再取一遍）。
 * network 为 false：不取远端，只用手里已有的 origin/main 做本地核对（三分钟门里的那一轮）。
 * @param {{ network?: boolean }} [opts]
 */
export function checkHere(cwd, git, { network = true } = {}) {
  const g = (...a) => git(cwd, a);
  const inside = g('rev-parse', '--is-inside-work-tree');
  // 不是 git 仓的目录不出声；git 自己跑不起来也不在这儿说（第 2 件同步那一句会说清，免得同一个毛病说两遍）
  if (!ok(inside) || inside.stdout.trim() !== 'true') return { line: null, fetch: null };
  const common = commonOf(g);
  /** @type {{ common: string | null, ok: boolean, why: string }} */
  let fetch;
  if (!network) {
    fetch = { common, ok: true, why: '' };
  } else {
    // 先照环境里的代理取（reclaude 的口），没成再直连取一次；两次的原因都带上（fresh-main.mjs）
    const fetched = fetchWithFallback(git, cwd, ['fetch', '-q', 'origin'], { okOf: ok, whyOf: why });
    if (!fetched.ok)
      return {
        line: `开场核规矩没查成：git fetch 失败（${fetched.why}）。规矩以 origin/main 为准，动手前用 git show origin/main:AGENTS.md 读一遍。`,
        fetch: { common, ok: false, why: fetched.why },
      };
    fetch = { common, ok: true, why: '' };
  }
  if (!ok(g('rev-parse', '-q', '--verify', ORIGIN_MAIN))) return { line: null, fetch };
  const branch = g('branch', '--show-current').stdout.trim();
  const behind = Number(g('rev-list', '--count', `HEAD..${ORIGIN_MAIN}`).stdout.trim() || '0');
  if (branch === 'main') {
    if (behind === 0) return { line: null, fetch };
    const dirty = g('status', '--porcelain', '--untracked-files=no').stdout.trim() !== '';
    if (!dirty && ok(g('merge', '--ff-only', '-q', ORIGIN_MAIN)))
      return { line: `已把 main 快进到最新（原来落后 ${behind} 个提交），AGENTS.md 等规矩是最新的。`, fetch };
    return {
      line: `注意：main 落后 origin/main ${behind} 个提交，${dirty ? '有没提交的改动' : '快进失败'}没法自动更新；规矩以 origin/main 为准。`,
      fetch,
    };
  }
  const differs = g('diff', '--quiet', ORIGIN_MAIN, '--', ...RULE_FILES);
  if (differs.status === 1)
    return {
      line: `注意：当前分支 ${branch || '（分离头）'} 的规矩（AGENTS.md 或 agents/shared-rules.md）和 origin/main 不一样，${READ_MAIN}。`,
      fetch,
    };
  return { line: null, fetch };
}

/** 这台同步到哪个提交、落后主线几个（g 已经钉在同步专用的检出上了；算不了就说算不了） */
export const TEMP_HEADING = '## 生效中的临时调整';
export const GREP_MS = 5_000;
const TEMP_COLS = ['内容', '当时为什么', '谁拍的', '撤回条件', '最迟复查日期'];
const TEMP_HINT = '照通用段「我拍了板」那条补齐五列，日期一律 YYYY-MM-DD 北京时间';
const NOT_CHECKED = '临时调整表没查成';

/** 北京时间的今天，YYYY-MM-DD */
export function beijingToday(now = Date.now()) {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 格子开头是 YYYY-MM-DD、且是真有的一天 → 那一天；认不出 → null */
function dayOf(cell) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(cell);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

/** 表格的一行 → 各格（去掉两头的竖线；\| 是格子里的竖线） */
function cellsOf(line) {
  const body = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replaceAll('\\|', '|'));
}

const brief = (s) => (s.length > 30 ? `${s.slice(0, 30)}…` : s) || '（内容空着）';

/**
 * 解析「## 生效中的临时调整」（在 headingLine 行，从 1 数）下面的表：到下一个一、二级标题之前的第一张表，
 * 表前可以有说明文字，表头 + 分隔行之后可以一行都没有。认不出 → { broken }；认得出 → { due, missing, badDate }。
 */
export function parseTempTable(text, headingLine, today) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  for (let i = headingLine; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^#{1,2}\s/.test(t)) break;
    if (t.startsWith('|')) rows.push({ no: i + 1, line: t });
    else if (rows.length > 0) break;
  }
  if (rows.length === 0) return { broken: '标题下面没有表格' };
  if (rows.length < 2 || !cellsOf(rows[1].line).every((c) => /^:?-{3,}:?$/.test(c)))
    return { broken: `第 ${rows[0].no} 行的表头下面没有 |---| 分隔行，认不出是表格` };
  const head = cellsOf(rows[0].line);
  if (head.length !== TEMP_COLS.length || !head[4].includes('复查'))
    return { broken: `表头是「${head.join('｜')}」，要五列：${TEMP_COLS.join('｜')}` };
  const due = [];
  const missing = [];
  const badDate = [];
  for (const r of rows.slice(2)) {
    const c = cellsOf(r.line);
    const name = brief(c[0] ?? '');
    if (c.length !== TEMP_COLS.length) {
      missing.push(`第 ${r.no} 行「${name}」${c.length < TEMP_COLS.length ? '只有' : '有'} ${c.length} 列`);
      continue;
    }
    const empty = TEMP_COLS.filter((_, k) => !c[k]);
    if (empty.length > 0) missing.push(`第 ${r.no} 行「${name}」的「${empty.join('、')}」空着`);
    if (!c[4]) continue;
    const day = dayOf(c[4]);
    if (day === null) badDate.push(`第 ${r.no} 行「${name}」的「${brief(c[4])}」`);
    else if (day <= today) due.push(`${name}（最迟 ${day}）`);
  }
  return { due, missing, badDate };
}

/**
 * 第 3 件：会话所在仓里的「## 生效中的临时调整」表（通用段「我拍了板」那条）。到了最迟复查日期的、缺列的、
 * 日期认不出的各说一行；有标题却认不出表，明说没查成；没有这张表、不是 git 仓不出声；git 跑不起来明说。
 * 只用本地 git grep 找已跟踪的 .md（不取远端，限时 GREP_MS），不拖慢开会话。返回要说的几行。
 */
export function checkTemporary(cwd, git, now = Date.now()) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (gitBroken(top))
    return [`${NOT_CHECKED}：这台的 git 跑不起来（${why(top)}），会话所在仓里有没有到期的临时调整不知道。`];
  const root = top.stdout.trim();
  if (!ok(top) || !root) return [];
  // -z：文件名原样、和行号用 \0 隔开（中文文件名不会被转义成 "\345..."，文件名里有冒号也不乱）
  const found = git(root, ['grep', '-n', '-z', '-I', '-E', `^${TEMP_HEADING}[[:space:]]*$`, '--', '*.md']);
  if (found.status === 1 && !found.error && !found.stderr.trim()) return [];
  if (!ok(found)) return [`${NOT_CHECKED}：git grep 找表没成（${why(found)}）。`];
  const hits = found.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => /^([^\0]+)\0(\d+)\0/.exec(l));
  if (hits.length === 0 || hits.some((m) => m === null))
    return [`${NOT_CHECKED}：git grep 的输出认不出（${why(found)}）。`];
  const today = beijingToday(now);
  const out = [];
  const many = hits.length > 1;
  if (many)
    out.push(
      `临时调整表不止一张（${hits.map((m) => `${m[1]}:${m[2]}`).join('、')}）：一个仓只该有一张，并成一张。`,
    );
  for (const [, file, n] of hits) {
    const at = many ? `${file}:${n}` : file;
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch (err) {
      out.push(`${NOT_CHECKED}（${at}）：读不了（${err?.code ?? err?.message ?? err}）。`);
      continue;
    }
    const r = parseTempTable(text, Number(n), today);
    if (r.broken) {
      out.push(`${NOT_CHECKED}（${at}）：${r.broken}。`);
      continue;
    }
    if (r.due.length > 0)
      out.push(
        `临时调整到了最迟复查日期 ${r.due.length} 条（${at}，今天 ${today}）：${r.due.join('；')}。照通用段读法②问创始人一句，不默认照做也不自己撤。`,
      );
    if (r.missing.length > 0)
      out.push(`临时调整表有 ${r.missing.length} 行缺列（${at}）：${r.missing.join('；')}。${TEMP_HINT}。`);
    if (r.badDate.length > 0)
      out.push(
        `临时调整表有 ${r.badDate.length} 行最迟复查日期认不出（${at}）：${r.badDate.join('；')}。${TEMP_HINT}。`,
      );
  }
  return out;
}

/**
 * 第 3.5 件：会话所在仓里的「## 创始人引导（待处理）」一节（通用段「你的引导必须落盘」那条）。
 * 有没处理完的引导就报几条、让人接着办；没有这一节、不是 git 仓不出声；git 跑不起来、读不了明说没查成。
 * 只用本地 git grep 找已跟踪的 .md（不取远端，限时 GREP_MS），不拖慢开会话。返回要说的几行。
 */
export const DIRECTIVE_HEADING = '## 创始人引导（待处理）';
const DIRECTIVE_NOT_CHECKED = '创始人引导待处理清单没查成';

export function checkDirectives(cwd, git) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (gitBroken(top))
    return [
      `${DIRECTIVE_NOT_CHECKED}：这台的 git 跑不起来（${why(top)}），会话所在仓里有没有没处理的引导不知道。`,
    ];
  const root = top.stdout.trim();
  if (!ok(top) || !root) return [];
  const found = git(root, [
    'grep',
    '-n',
    '-z',
    '-I',
    '-E',
    `^${DIRECTIVE_HEADING}[[:space:]]*$`,
    '--',
    '*.md',
  ]);
  if (found.status === 1 && !found.error && !found.stderr.trim()) return [];
  if (!ok(found)) return [`${DIRECTIVE_NOT_CHECKED}：git grep 找这一节没成（${why(found)}）。`];
  const hits = found.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => /^([^\0]+)\0(\d+)\0/.exec(l));
  if (hits.length === 0 || hits.some((m) => m === null))
    return [`${DIRECTIVE_NOT_CHECKED}：git grep 的输出认不出（${why(found)}）。`];
  const out = [];
  for (const [, file, n] of hits) {
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch (err) {
      out.push(`${DIRECTIVE_NOT_CHECKED}（${file}:${n}）：读不了（${err?.code ?? err?.message ?? err}）。`);
      continue;
    }
    const items = directiveItems(text, Number(n));
    if (items === null) {
      out.push(`${DIRECTIVE_NOT_CHECKED}（${file}:${n}）：标题下面认不出条目。`);
      continue;
    }
    if (items.length > 0)
      out.push(
        `创始人引导还有 ${items.length} 条没处理（${file}:${n}）：${items.slice(0, 5).join('；')}${items.length > 5 ? ' 等' : ''}。先接着办，办完把那条标「已处理」或删掉。`,
      );
  }
  return out;
}

/** 「## 创始人引导（待处理）」标题下一节里的条目：`- ` 开头、没标「已处理」的非空行；标题下到下一个一、二级标题为止 */
function directiveItems(text, headingLine) {
  const lines = text.split(/\r?\n/);
  const items = [];
  for (let i = headingLine; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^#{1,2}\s/.test(t)) break;
    if (t.startsWith('- ') && !/已处理/.test(t)) items.push(brief(t.slice(2).trim()));
  }
  return items;
}

/** 这台同步到哪个提交、落后主线几个（g 已经钉在同步专用的检出上了；算不了就说算不了） */
function lag(g, synced, stale) {
  const basis = stale ? '（按本机上次取到的主线算）' : '';
  if (!synced) return `这台还没记过同步到哪个提交，${READ_MAIN}`;
  const c = g('rev-list', '--count', `${synced}..${ORIGIN_MAIN}`);
  const n = Number(c.stdout.trim());
  if (!ok(c) || c.stdout.trim() === '' || !Number.isInteger(n))
    return `这台同步到 ${short(synced)}，和主线比不了（${why(c)}），${READ_MAIN}`;
  if (n === 0) return `这台同步到 ${short(synced)}，没落后主线${basis}`;
  return `这台同步到 ${short(synced)}，落后主线 ${n} 个提交${basis}`;
}

/** 同步专用检出这一趟做的事：切了、修过还是新建了 */
function sourceNote(prepared) {
  if (prepared.repaired === true) return '同步专用的检出修好了一份（原来那份挪到旁边留着了）';
  if (prepared.moved === true) return '同步专用的检出新切了一下';
  return '';
}

/** agents-sync 的输出 → 一句话 */
export function describeSync(r, repo, origin, lagText, note = '') {
  const check = `node ${join(repo, 'packages', 'agents-sync', 'bin', 'agents-sync').replaceAll('\\', '/')} --check`;
  const tail = [note, lagText].filter(Boolean).join('；');
  if (r.error) {
    const what =
      r.error.code === 'ETIMEDOUT'
        ? `${Math.round((r.timeoutMs ?? SYNC_MS) / 1000)} 秒没跑完`
        : `起不来（${r.error.message}）`;
    return `规矩同步没查成：agents-sync ${what}；${tail}。`;
  }
  const lines = String(r.stdout ?? '').split(/\r?\n/);
  const pick = (glyph) => lines.filter((l) => l.startsWith(`  ${glyph} `)).map((l) => l.slice(4));
  const bad = pick('✗');
  const unknown = pick('…');
  // 只记同步位置的那一行不算装了什么
  const changed = pick('↻').filter((l) => !l.startsWith('~/.fleet-dao/synced.json'));
  const summary = lines.some((l) => l.startsWith('结论：'));
  if (r.status === 0 && summary) {
    if (changed.length === 0)
      return `规矩同步：这台已同步到主线最新（${short(origin)}），规矩、技能、钩子、权限都和仓里一致。`;
    const keys = changed.map((l) => l.split('：')[0]);
    const listed = keys.slice(0, 3).join('、') + (keys.length > 3 ? ' 等' : '');
    return `规矩同步：这台刚同步到主线最新（${short(origin)}），改了 ${changed.length} 处（${listed}）；本会话开场已经读进来的全局说明和技能还是旧的，下次开会话才生效，拿不准以 origin/main 的 AGENTS.md 为准。`;
  }
  if (r.status === 1 && bad.length > 0) {
    const shown = bad.slice(0, 2).join('；') + (bad.length > 2 ? '……' : '');
    return `规矩同步有没做成的（${bad.length} 处）：${shown}。全部看 ${check}；${tail}。`;
  }
  // 退出码 2：逐项里有没查成的，或者原件读不到、根本没往下走（那时原因只在 stderr）
  if (r.status === 2) return `规矩同步没查成：${(unknown[0] ?? why(r)).replace(/^没查成：/, '')}；${tail}。`;
  return `规矩同步没查成：agents-sync 退出码 ${r.status}，没给出逐项结论（${why(r)}）；${tail}。`;
}

function readRecord(home) {
  const file = join(home, '.fleet-dao', 'synced.json');
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, missing: err?.code === 'ENOENT', why: err?.code ?? err?.message ?? String(err) };
  }
}

/**
 * 这一件要起 git 跑好几条：拿锁、把专用检出新切一下、建的时候还要取远端（取远端那几条自己会放宽超时）。
 * 这台 git 跑不起来（缺 DLL、PATH 上没有）就说清是 git 的毛病，别让每条命令各自报成别的原因。
 */
function gitAlive(git) {
  const r = git(process.cwd(), ['--version']);
  return ok(r) ? null : why(r);
}

function quietFor(stamp, now) {
  try {
    // 文件时间和 Date.now() 不是同一个钟，刚写的文件可能比 now 晚零点几毫秒：几秒以内的「将来」也算刚写的
    const age = now - statSync(stamp).mtimeMs;
    return age > -5_000 && age < QUIET_MS ? Math.max(0, age) : null;
  } catch {
    return null;
  }
}

function touch(stamp, now) {
  try {
    mkdirSync(dirname(stamp), { recursive: true });
    writeFileSync(stamp, `${new Date(now).toISOString()}\n`);
  } catch {
    // 记不下只是下次多同步一遍，不影响这次的结论
  }
}

const RERUN =
  '在 fleet-dao 的检出里跑一遍 node packages/agents-sync/bin/agents-sync --apply --repo ~/.fleet-dao/origin-main';

/**
 * 第 2 件：同步这台机器。fetch 是第 1 件在同一个仓里取远端的结果（没取过是 null，这里用不到：这件在专用检出里取）。
 * 返回一句话。做不成的原因分得清：git 起不来、取不到远端、专用检出建不起来、agents-sync 没做成。
 */
export function syncFleet({ home, git, sync, fetch = null, now = Date.now(), seed = null, force = false }) {
  // fetch 是第 1 件在会话所在的仓里取远端的结果。这一件不走它：用的是同步专用的检出，自己在那里面取（见下面）
  void fetch;
  const rec = readRecord(home);
  const recorded = rec.ok && typeof rec.value?.repo === 'string' ? rec.value.repo : null;
  // 种子：记着的那个检出还在就用它；不在了（老机器、检出挪过）退回调用方给的（bootstrap.mjs 给会话所在的检出）
  const seedRepo = recorded !== null && existsSync(recorded) ? recorded : (seed ?? recorded);
  const synced = rec.ok && typeof rec.value?.synced?.commit === 'string' ? rec.value.synced.commit : null;
  const stamp = join(home, '.fleet-dao', 'session-sync.ok');
  const quiet = synced && !force ? quietFor(stamp, now) : null;
  if (quiet !== null)
    return `规矩同步：${Math.max(1, Math.round(quiet / 60_000))} 分钟内刚同步成功过（这台同步到 ${short(synced)}），这次没再取远端。`;

  if (source === null)
    return `规矩同步没查成：开会话钩子读不了同步专用检出那一段（${sourceWhy}）；${RERUN}，${READ_MAIN}。`;

  const mirror = source.syncDirIn(home);
  // prepareSource 起 git 用的是「git -C <目录> …」的写法（sync-source 自己的 runner 就这样）
  const g = (...a) => git(mirror, a);
  const dead = gitAlive(git);
  if (dead !== null)
    return `规矩同步没跑：这台的 git 跑不起来（${dead}），没法核对 ${mirror}；${lag(g, synced, true)}。`;
  const lock = source.takeSourceLock(home, { now });
  if (!lock.ok) return `规矩同步没跑：${lock.why}；${lag(g, synced, true)}。`;

  try {
    const prepared = source.prepareSource(home, seedRepo, { repair: true, deps: { gitFactory: () => git } });
    if (!prepared.ok) return `规矩同步没跑：${prepared.why}；${lag(g, synced, true)}。`;

    const origin = String(prepared.head ?? '');
    const lagText = lag(g, synced, false);
    const r = sync(prepared.dir, home);
    if (r.status === 0 && !r.error) touch(stamp, now);
    const note = sourceNote(prepared);
    const said = describeSync(r, prepared.dir, origin, lagText, note);
    return rec.ok
      ? said
      : `${said.replace(/。$/, '')}；~/.fleet-dao/synced.json ${rec.missing ? '还没记过' : `读不懂（${rec.why}）`}，这次同步会重写一份。`;
  } finally {
    lock.release();
  }
}

/**
 * 创始人最近落盘的话（agents/hooks/prompt-log.mjs 在他每条消息一提交就写进 ~/.fleet-dao/prompt-log/<北京日期>.jsonl）。
 * 为什么开会话时列出来（创始人 2026-10-04「我发了hi但是好像你视而不见」）：他的话有两种丢法，一种是到了没处理，一种是排队时
 * 会话进程死了、从头没送到——钩子在提交那一刻就落了盘，新会话开场看一眼这份文件，上一个会话没来得及处理的话就在这里，不靠他重发。
 * 列最近 RECENT_MS 以内、本会话还没见过的全部（本会话自己落盘的话它早见过，不列），每条截到 RECENT_CHARS 字，总字数到 RECENT_TOTAL_CHARS
 * 封顶（超了留最新的、写明更早的几条没列）；没有文件、没有最近的话都不出声；读不了文件（不是没有，是读不了）要说一句，不当成「没有」。
 * 机器派的会话（工人、反方）的提示现在不落盘（prompt-log.mjs）；这里再滤一遍，是为了 10-05 之前已经落盘的那些。
 * 第三种丢法（创始人 2026-10-06「你好像没接收到【选方案a】」）：他在一轮跑着时打的字走 Mirasim 的「引导」，那一轮被打断、出错就丢了，
 * Claude Code 从头没收到、prompt-log 里自然也没有。所以再拿 Mirasim 自己记的「发了的账」（founder-inbox.mjs）和这份「收到的账」对一遍，
 * 发了没收到的单独一行、放前面、叫会话先答。这一段在每一轮开头都跑（Mirasim 每轮都 --resume 起进程，SessionStart 每轮都触发），
 * 所以上一轮丢的引导下一轮一开头就补上了。
 */
export const RECENT_MS = 60 * 60_000;
export const RECENT_CHARS = 200;
export const RECENT_TOTAL_CHARS = 3000;
/** 后台任务完成、系统提醒也会以「用户消息」的身份进 UserPromptSubmit，落盘时原样记（2026-10-04 实测），列的时候不算创始人的话 */
const SYSTEM_PROMPT = /^\s*(?:<task-notification|<system-reminder|\[SYSTEM NOTIFICATION)/;

export function recentPrompts({ home, now = Date.now(), dir = null, sessionId = null, env = process.env }) {
  // 落盘目录和写的那边（prompt-log.mjs 的 logDir）同一份：原来这里不认 FLEET_PROMPT_LOG_DIR（全仓审查第 4 路 R4）
  const base = dir ?? logDir(process.env, home);
  const days = new Set([beijingToday(now), beijingToday(now - RECENT_MS)]);
  /** 收到的账：Claude Code 真收到过的（哪个会话收的都记） */
  const received = [];
  for (const day of days) {
    const file = join(base, `${day}.jsonl`);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      return [`创始人落盘的话没读成：${file} 读不了（${err?.code ?? err}）；这个会话没送到的话可能在里面。`];
    }
    for (const row of text.split(/\r?\n/)) {
      if (!row.trim()) continue;
      try {
        const e = JSON.parse(row);
        const at = Date.parse(e?.at);
        if (
          typeof e?.prompt === 'string' &&
          !SYSTEM_PROMPT.test(e.prompt) &&
          !isMachineOpening(e.prompt) &&
          !isMachineSession({ env: {}, cwd: e.cwd }) &&
          Number.isFinite(at) &&
          now - at <= RECENT_MS &&
          at <= now + 60_000
        )
          received.push({
            at,
            text: e.prompt,
            sessionId: typeof e.sessionId === 'string' ? e.sessionId : null,
          });
      } catch {
        // 坏的一行跳过：别因为一行坏了就把别的话也藏起来
      }
    }
  }
  const lines = [];
  // 发了的账（Mirasim 的会话记录）和收到的账对一遍：发了、没收到的就是丢在 Mirasim「引导」里的那种（founder-inbox.mjs 开头）
  const sent = sentByFounder({ home, now, env });
  if (!sent.absent) {
    for (const p of sent.problems) lines.push(`创始人在 Mirasim 里发的话没读全：${p}；有没有丢的核不了。`);
    const { lost } = reconcile(sent.entries, received);
    if (lost.length > 0) {
      const shown = packNewestFirst(lost);
      lines.push(
        `创始人发了、但 Claude Code 没收到的话（Mirasim 的「引导」在那一轮被打断或出错时丢了，他以为你看到了；共 ${lost.length} 条${shown.omitted}）：${shown.items.join(' ')} 先答这些，答完再接着干。`,
      );
    }
  }
  // 别的会话收到的：本会话自己收到的它早见过，不列
  const others = received.filter((e) => !(sessionId && e.sessionId === sessionId));
  if (others.length > 0) {
    const shown = packNewestFirst(others);
    lines.push(
      `创始人最近 ${Math.round(RECENT_MS / 60_000)} 分钟落盘的话（共 ${others.length} 条${shown.omitted}；上一个会话没来得及处理的在这里，已经办过的不用再办）：${shown.items.join(' ')}`,
    );
  }
  return lines;
}

/** 从最新的往回装，装到总字数封顶为止（最新的一条无论多长都留）；每条截到 RECENT_CHARS 字 */
function packNewestFirst(entries) {
  const sorted = [...entries].sort((a, b) => a.at - b.at);
  const hhmm = (ms) => new Date(ms + 8 * 3_600_000).toISOString().slice(11, 16);
  const cut = (s) => (s.length > RECENT_CHARS ? `${s.slice(0, RECENT_CHARS)}……` : s).replace(/\s+/g, ' ');
  const items = [];
  let used = 0;
  for (const e of sorted.reverse()) {
    const one = `［${hhmm(e.at)}］${cut(e.text)}`;
    if (items.length > 0 && used + one.length > RECENT_TOTAL_CHARS) break;
    items.unshift(one);
    used += one.length;
  }
  const omitted = sorted.length - items.length;
  return { items, omitted: omitted > 0 ? `，字数封顶只列最新 ${items.length} 条` : '' };
}

/** fleet-dao 自己的检出（origin 指向它；和 packages/github/src/hygiene-scope.ts 的 HYGIENE_REPO 是同一个仓）：只在这里查 PR、进度单 */
export const FLEET_ORIGIN = /github\.com[:/]+thoerwink8\/fleet-dao(?:\.git)?\/?$/i;

const prList = (items) =>
  items
    .slice(0, 6)
    .map((p) => `#${p.number}`)
    .join('、') + (items.length > 6 ? ' 等' : '');

/**
 * 第 4 件：绿了没挂自动合并的 PR（全仓审查第 2 路清单 7 号；pnpm pr:open 是必经那一步，这里只是兜底——法国引擎的
 * 每小时对账关着）。查法和判路径不在这里另写：起 packages/conventions/src/bin/pr-idle.ts（不带第三方依赖，同步专用检出
 * 没装 node_modules 也跑得起来），优先用同步专用检出里那份，没有再用会话所在检出里的；硬超时 IDLE_PR_MS。
 */
export const IDLE_PR_MS = 8_000;
const IDLE_SCRIPT = join('packages', 'conventions', 'src', 'bin', 'pr-idle.ts');
const IDLE_NOT_CHECKED = '绿了没挂自动合并的 PR 没查成';

/** 在仓根起 pr-idle.ts：{ status, stdout, stderr, error, timeoutMs }，超时由 spawnSync 杀掉 */
export function idlePrRunner(timeoutMs = IDLE_PR_MS) {
  return (script, repo) => {
    const r = spawnSync(process.execPath, [script], {
      cwd: repo,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error, timeoutMs };
  };
}

/** 参数：cwd、git、run、fetch（第 1 件取远端的结果）、mirror（同步专用检出里那份脚本）；返回要说的几行：没有、不是 fleet-dao 都不出声 */
export function checkIdlePrs({ cwd, git, run, fetch, mirror = null }) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!ok(top) || !top.stdout.trim()) return [];
  const root = top.stdout.trim();
  const url = git(root, ['config', '--get', 'remote.origin.url']);
  if (!ok(url) || !FLEET_ORIGIN.test(url.stdout.trim())) return [];
  if (fetch && fetch.ok === false) return [`${IDLE_NOT_CHECKED}：取不到远端（${fetch.why}）。`];
  const script = [mirror, join(root, IDLE_SCRIPT)].find((s) => s && existsSync(s));
  if (!script) return [`${IDLE_NOT_CHECKED}：找不到 ${IDLE_SCRIPT.replaceAll('\\', '/')}。`];
  const r = run(script, root);
  if (r.error || r.status !== 0) return [`${IDLE_NOT_CHECKED}：${why(r)}。`];
  let p;
  try {
    p = JSON.parse(r.stdout);
  } catch {
    return [`${IDLE_NOT_CHECKED}：pr-idle.ts 的输出认不出（${String(r.stdout).trim().slice(0, 60)}）。`];
  }
  if (!Array.isArray(p?.idle) || !p.idle.every((x) => typeof x?.number === 'number'))
    return [`${IDLE_NOT_CHECKED}：pr-idle.ts 的输出少了 idle 列表。`];
  if (p.idle.length === 0) return [];
  return [
    `绿了没挂自动合并的 PR ${p.idle.length} 个：${prList(p.idle)}（我开的、没碰改标准；挂上：gh pr merge <号> --auto --squash，以后开 PR 用 pnpm pr:open）。`,
  ];
}

/**
 * fleet-dao 的创始人引导记在 GitHub 置顶单 #1055（pnpm progress:directive），不在仓里的文件里：这里起
 * `progress.ts read --pending` 读没处理的几条，硬超时 PROGRESS_MS。不是 fleet-dao 不出声（别的仓仍读自己的
 * 「## 创始人引导（待处理）」一节，见 checkDirectives）；查不成出一行「没查成」，不挡开会话。
 * 优先用同步专用检出里那份脚本，没有再用会话所在检出里的。
 */
export const PROGRESS_MS = 8_000;
const PROGRESS_SCRIPT = join('packages', 'conventions', 'src', 'bin', 'progress.ts');
const PROGRESS_NOT_CHECKED = '创始人引导（进度单 #1055）没查成';

/** 在仓根起 progress.ts read --pending：{ status, stdout, stderr, error, timeoutMs } */
export function progressRunner(timeoutMs = PROGRESS_MS) {
  return (script, repo) => {
    const r = spawnSync(process.execPath, [script, 'read', '--pending'], {
      cwd: repo,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error, timeoutMs };
  };
}

/** 参数同 checkIdlePrs；返回要说的几行：没有待处理的、不是 fleet-dao 都不出声 */
export function checkProgressIssue({ cwd, git, run, mirror = null }) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!ok(top) || !top.stdout.trim()) return [];
  const root = top.stdout.trim();
  const url = git(root, ['config', '--get', 'remote.origin.url']);
  if (!ok(url) || !FLEET_ORIGIN.test(url.stdout.trim())) return [];
  const script = [mirror, join(root, PROGRESS_SCRIPT)].find((s) => s && existsSync(s));
  if (!script) return [`${PROGRESS_NOT_CHECKED}：找不到 ${PROGRESS_SCRIPT.replaceAll('\\', '/')}。`];
  const r = run(script, root);
  if (r.error || r.status !== 0) return [`${PROGRESS_NOT_CHECKED}：${why(r)}。`];
  const rows = String(r.stdout)
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const items = rows.map((l) => l.split('\t'));
  if (items.some((c) => c.length < 3 || !/^\d+$/.test(c[0])))
    return [`${PROGRESS_NOT_CHECKED}：progress.ts 的输出认不出（${String(r.stdout).trim().slice(0, 60)}）。`];
  if (items.length === 0) return [];
  const shown = items
    .slice(0, 5)
    .map(
      ([id, head, text]) =>
        `${id}（${head.replace(/^【[^】]*】/, '')}）${brief(text.replace(/^原话：/, ''))}`,
    );
  return [
    `创始人引导还有 ${items.length} 条没处理（进度单 #1055）：${shown.join('；')}${items.length > 5 ? ' 等' : ''}。先接着办，办完 pnpm progress:done <评论号>；全文 pnpm progress:read。`,
  ];
}

/** localGit 只跑本地命令（找临时调整表），限时比取远端短 */
export function sessionStart({
  cwd,
  home,
  git,
  sync,
  localGit = git,
  now = Date.now(),
  sessionId = null,
  unattendedDir = stateDir(),
  idlePr = idlePrRunner(),
  progress = progressRunner(),
  env = process.env,
}) {
  // 工人不走三分钟门：它起来就要当前的远端。聊天这场每条消息都续上。
  // 问 GitHub、扫工作树看 session-net；git fetch 看 fetch-ok（子代理刚取成过就不再取）。两扇门都是三分钟。
  const worker = env.FLEET_WORKER === '1';
  const stamp = worker ? null : sessionNetStamp(home, cwd, localGit);
  const quiet = stamp !== null && quietFor(stamp, now) !== null;
  const fetchedRecently = !worker && fetchIsFresh({ home, cwd, git: localGit, okOf: ok, now });
  const doFetch = worker || (!quiet && !fetchedRecently);
  const here = checkHere(cwd, git, { network: doFetch });
  if (doFetch && here.fetch?.ok === true) markFetchOk({ home, cwd, git: localGit, okOf: ok, now });
  // 失败也记上 session-net：断网时下一轮不再把 GitHub 超时重付一遍。fetch-ok 只在取成时记，子代理仍会再试。
  if (stamp !== null && !quiet) touch(stamp, now);
  // 工人（FLEET_WORKER=1，worker-lib.mjs 起的）只要规矩同步：创始人引导、他最近的话、工作树清单、工人状态都是指挥官的事，
  // 注进工人的开场它会当成自己的活（2026-10-05 审计 N5），还白占 8–11 秒
  if (worker)
    return [...(here.line ? [here.line] : []), syncFleet({ home, git, sync, fetch: here.fetch, now })];
  // 同步专用检出里那份脚本和这个钩子一样来自 origin/main；没有再用会话所在检出里的
  const syncDir = source ? source.syncDirIn(home) : null;
  return [
    ...(here.line ? [here.line] : []),
    ...unattendedLines({ dir: unattendedDir, sessionId: cleanId(sessionId), now }),
    ...checkTemporary(cwd, localGit, now),
    ...checkDirectives(cwd, localGit),
    ...(quiet
      ? []
      : checkProgressIssue({
          cwd,
          git: localGit,
          run: progress,
          mirror: syncDir ? join(syncDir, PROGRESS_SCRIPT) : null,
        })),
    ...recentPrompts({ home, now, sessionId }),
    ...(quiet ? [] : sweepWorktrees(cwd, localGit)),
    ...workerLines(home, now),
    ...(quiet
      ? []
      : checkIdlePrs({
          cwd,
          git: localGit,
          run: idlePr,
          fetch: here.fetch,
          mirror: syncDir ? join(syncDir, IDLE_SCRIPT) : null,
        })),
    syncFleet({ home, git, sync, fetch: here.fetch, now }),
  ];
}

/**
 * 顺手清掉本仓 `.claude/worktrees/` 下攒着的旧树。
 *
 * 起因（创始人 2026-10-02，实战教训）：「任何 work tree 里的任务在完成之后，本地的 work tree 必须清掉……
 * 不要积累，因为 Mirasim 会因为 work tree 和会话越来越多导致越来越卡」。本机实测攒到 29 棵。
 * `.claude/worktrees/` 在 .gitignore 里，所以没有别的东西会管它：开会话钩子是唯一每次都会跑的地方。
 *
 * **只删证据齐全的，删不掉任何独有东西**（这三条全过才删，任一条不成立就跳过、且不报成失败）：
 * 1. 没有未提交的改动（含未跟踪文件）：有就说明可能有人的东西在里面。
 * 2. 这个树上的提交**一条都不比远端多**（`rev-list HEAD --not --remotes` 是空的）：
 *    多一条就是有没推上去的活，**绝不删**，照实报。（判「远端」不判「origin/main」：
 *    树常常建在某条开着 PR 的分支的头上，那些提交在对应的远端分支上、安全，判 main 会把它们全留下。）
 * 3. **最近 2 小时没动过**（看树根和它在 git 里的管理目录，见 lastTouched）：另一个会话此刻正开着一棵树干活时，它可能刚好是「干净、已推」的
 *    ——只按前三条就会把它删掉、把人家正在干的事打断。刚建出来、刚提交过的树都不碰。
 *    （代价是刚做完的树要等两小时才收走，而这条命中率低、留着也无害。）
 *
 * 超出这三条的一律不动、也不当成「查成」——2026-10-02 清那 29 棵时，就是靠第 2 条救回了决定 0006
 * （`decision-align` 树里那份决定从没进过主线）。
 */

/**
 * 多久没动过才收走（第 3 条）：另一个会话可能正开着一棵树干活。
 * 2026-10-05 从 30 分钟放到 2 小时：一个会话 PR 合了之后常常接着在同一棵树里切下一条分支，中间隔半小时以上很常见；
 * 晚两小时收走一棵没用的树没有代价，早收走一棵在用的代价很大（见 lastTouched）。
 */
export const SWEEP_IDLE_MS = 2 * 60 * 60_000;

/**
 * 这棵树最后一次被动是什么时候。只看树根目录的修改时间是错的：在里面改文件、提交、切分支都不动树根那一层，
 * 一棵正在用的树照样显得「搁了很久」——2026-10-05 审查会话正在用的树就是这么被删成空壳的。
 * 所以连它在 git 里的管理目录一起看（index 在暂存、提交、切分支时都会重写，HEAD 和 logs/HEAD 记切分支和提交）。
 * 读不出来返回 null，调用方当「可能在用」留着。
 */
function lastTouched(dir, g) {
  let latest;
  try {
    latest = statSync(dir).mtimeMs;
  } catch {
    return null;
  }
  const admin = g('-C', dir, 'rev-parse', '--absolute-git-dir');
  if (!ok(admin)) return null;
  for (const f of ['index', 'HEAD', join('logs', 'HEAD')]) {
    try {
      latest = Math.max(latest, statSync(join(admin.stdout.trim(), f)).mtimeMs);
    } catch {
      // 没有这份文件（刚建的树可能还没有 logs）不算读不出来
    }
  }
  return latest;
}

/** 工作树的空壳：目录还在、里面的 .git 没了。在里面跑 git 会顺着往上找到主检出，命令就落在主检出上。 */
function isShell(dir) {
  try {
    return statSync(dir).isDirectory() && !existsSync(join(dir, '.git'));
  } catch {
    return false;
  }
}

/** 删空壳，删不掉（有进程占着）返回 false。空壳里只会是删树时剩下的东西：能删的树都是干净、提交全在远端的。 */
function removeShell(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    // 下面照实看还在不在
  }
  return !existsSync(dir);
}

/** 独立工人跑了这么久还没退，开会话时提一句（Claude 无头模式做完才出字，不能拿「多久没输出」判）。 */
export const WORKER_LONG_MS = 3 * 60 * 60_000;

/**
 * 工人最后一句说得出人话的输出。Claude 工人的日志是 stream-json（一行一个事件）：结论在 result 事件里，
 * 说的话在 assistant 事件的 text 里；别家模型是普通文字。和 commander 技能 worker-lib.mjs 的 saidOf 一个意思，
 * 这里只取「最后说了什么」（判做没做完），不翻工具调用。钩子和技能装在两个目录，没法互相 import，所以各写一份。
 */
function workerLastSaid(text) {
  const rows = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const tail = (t) => {
    const r = String(t)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    return r[r.length - 1] ?? '';
  };
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row.startsWith('{')) return row;
    let ev;
    try {
      ev = JSON.parse(row);
    } catch {
      return row;
    }
    if (ev?.type === 'result' && typeof ev.result === 'string') return tail(ev.result);
    if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
      const said = ev.message.content.filter(
        (b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim(),
      );
      if (said.length > 0) return tail(said[said.length - 1].text);
    }
  }
  return '';
}

/**
 * 工人状态目录（相对家目录）：定义在 unattended.mjs（收尾钩子数在跑的工人也用它），这里原样再导出。
 * commander 技能的 worker-lib.mjs 另有一份（钩子和技能装在两个目录，互相 import 不了），
 * agents/test/hooks-shared.test.ts 钉着两边相等。
 */
export { WORKERS_REL };

/**
 * 本机独立工人（commander 技能的 worker.mjs 起的，状态在 ~/.fleet-dao/workers/<名字>/meta.json）现在怎样（#1016）。
 * 工人是脱离会话的进程：它被强杀、卡死、做完都不会通知谁，所以由每次开会话都会跑的这里看一眼，不靠工人自己活着来报。
 * 只报要人知道的三种：不在跑了又没交活、跑了很久还没退、做完了没收拾。读不了的记录照实报没查成。
 */
export function workerLines(home, now = Date.now(), alive = pidAlive) {
  const root = join(home, WORKERS_REL);
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return []; // 这台没起过工人
  }
  const lines = [];
  for (const name of names) {
    let m;
    try {
      m = JSON.parse(readFileSync(join(root, name, 'meta.json'), 'utf8'));
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') continue;
      lines.push(`工人 ${name} 的记录没查成（meta.json 读不了或不是 JSON），用 worker.mjs status 看。`);
      continue;
    }
    if (!m || typeof m !== 'object' || m.cleanedAt) continue;
    if (!Number.isInteger(m.pid)) {
      lines.push(`工人 ${name} 起的时候没记上进程号，不知道在不在跑：用 worker.mjs status 看。`);
      continue;
    }
    let last = '';
    try {
      last = workerLastSaid(readFileSync(String(m.outLog), 'utf8'));
    } catch {
      // 还没有输出
    }
    const mins = Math.max(0, Math.round((now - Date.parse(String(m.startedAt))) / 60_000));
    if (alive(m.pid)) {
      if (now - Date.parse(String(m.startedAt)) > WORKER_LONG_MS)
        lines.push(`工人 ${name} 跑了 ${mins} 分钟还没退，看一眼是不是卡住了（worker.mjs status）。`);
      continue;
    }
    if (/^完成/.test(last))
      lines.push(`工人 ${name} 做完了（${last.slice(0, 60)}），看完结果跑 worker.mjs clean --name ${name}。`);
    else
      lines.push(
        `注意：工人 ${name} 不在跑了、也没交活（最后一句：${last ? last.slice(0, 80) : '没有输出'}）。它的工作树 ${m.worktree} 还在，接着做或 clean 掉。`,
      );
  }
  return lines;
}

export function sweepWorktrees(cwd, git, now = Date.now()) {
  const g = (...a) => git(cwd, a);
  if (!ok(g('rev-parse', '--is-inside-work-tree'))) return [];
  const top = g('rev-parse', '--show-toplevel');
  if (!ok(top)) return [];
  const rootPath = top.stdout.trim();
  // 2026-10-05：原来只列 `.claude/worktrees/` 一个目录，建到别处的树（代理自己挑的 `.worktrees/`、
  // `wt/`）**根本看不见**，于是攒到 60 多棵；那些树里带着各自的 biome.json，biome 整仓扫一遍报
  // 「nested root configuration」，把这台机器上**所有会话**的推送都拦了。改成问 git 本仓注册了哪些树
  // ——建在哪都算，不再靠「它应该在哪个目录」这个约定。
  const listed = g('worktree', 'list', '--porcelain');
  if (!ok(listed)) return [];
  const dirs = [];
  let stale = 0;
  for (const line of listed.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const dir = line.slice('worktree '.length).trim();
    if (!dir) continue;
    if (resolve(dir) === resolve(rootPath)) continue; // 主检出自己不是「顺手清」的对象
    dirs.push(dir);
  }
  const kept = [];
  const shells = [];
  let removed = 0;
  for (const dir of dirs) {
    const name = basename(dir);
    const head = g('-C', dir, 'rev-parse', 'HEAD');
    if (!ok(head)) {
      // 注册还在、目录没了：`git worktree prune` 收拾这条记录（它只删管理条目，不动盘上任何东西）。
      if (ok(g('worktree', 'prune'))) stale += 1;
      else kept.push(name);
      continue;
    }
    const touched = lastTouched(dir, g);
    if (touched === null) {
      kept.push(name);
      continue;
    }
    if (now - touched < SWEEP_IDLE_MS) {
      kept.push(name); // 刚动过：可能有人正在里面干活
      continue;
    }
    const dirty = g('-C', dir, 'status', '--porcelain');
    if (!ok(dirty) || dirty.stdout.trim() !== '') {
      kept.push(name);
      continue;
    }
    const unmerged = g('-C', dir, 'rev-list', 'HEAD', '--not', '--remotes');
    if (!ok(unmerged)) {
      kept.push(name);
      continue;
    }
    if (unmerged.stdout.trim() !== '') {
      kept.push(name); // 有没推上去的提交：不删，且要报给人
      continue;
    }
    if (ok(g('worktree', 'remove', '--force', dir))) removed += 1;
    else if (isShell(dir)) {
      // 删到一半（Windows 上别的进程占着里面的文件）：.git 没了、目录还在。留着它，在里面跑的 git 会悄悄落到主检出上。
      if (removeShell(dir)) removed += 1;
      else shells.push(name);
    } else kept.push(name);
  }
  // 以前删到一半留下的空壳（git 早不认它们了，上面那一圈看不见）
  const home = join(rootPath, '.claude', 'worktrees');
  let entries = [];
  try {
    entries = readdirSync(home);
  } catch {
    // 没有这个目录
  }
  let cleared = 0;
  for (const name of entries) {
    const dir = join(home, name);
    if (dirs.some((d) => resolve(d) === resolve(dir)) || !isShell(dir)) continue;
    // 刚建的目录先不碰：git worktree add 是先建目录、后写 .git
    try {
      if (now - statSync(dir).mtimeMs < SWEEP_IDLE_MS) continue;
    } catch {
      continue;
    }
    if (removeShell(dir)) cleared += 1;
    else shells.push(name);
  }
  const lines = [];
  if (cleared > 0) lines.push(`顺手清掉了 ${cleared} 个以前删到一半留下的工作树空壳。`);
  if (shells.length > 0)
    lines.push(
      `注意：${shells.length} 个工作树空壳删不掉（有进程占着）：${shells.slice(0, 5).join('、')}${shells.length > 5 ? ' …' : ''}。别在里面跑 git——它已经不是工作树，命令会落到主检出上。`,
    );
  if (removed > 0) lines.push(`顺手清掉了 ${removed} 棵本机没用的工作树（提交都在远端上了）。`);
  if (stale > 0) lines.push(`顺手清掉了 ${stale} 条工作树记录（目录早没了，git worktree prune）。`);
  if (kept.length > 0)
    lines.push(
      `注意：本仓还有 ${kept.length} 棵没清的工作树（刚动过的、有未提交的改动、或有没推上去的提交）：${kept.slice(0, 5).join('、')}${kept.length > 5 ? ' …' : ''}；看一眼是不是还要，不要了自己删。`,
    );
  return lines;
}

/** Claude Code、Codex、Devin 都认的开会话输出 */
export function render(lines) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') },
  });
}

/** 各家给的会话目录字段不一样：Claude Code、Grok 给 cwd，Grok 另给 workspaceRoot，Cursor 给 workspace_roots；Devin 不给 */
export function pickCwd(input) {
  const i = input && typeof input === 'object' ? input : {};
  const roots = Array.isArray(i.workspace_roots) ? i.workspace_roots : [];
  for (const c of [i.cwd, i.workspaceRoot, roots[0]]) if (typeof c === 'string' && c) return c;
  return process.cwd();
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  let lines;
  try {
    let input = {};
    try {
      input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    } catch {
      // 输入读不懂不要紧：会话目录退回到钩子自己的工作目录
    }
    lines = sessionStart({
      cwd: pickCwd(input),
      home: homedir(),
      git: gitRunner(),
      sync: syncRunner(),
      localGit: gitRunner(GREP_MS),
      sessionId: input?.session_id ?? process.env.CLAUDE_CODE_SESSION_ID,
    });
  } catch (err) {
    lines = [`开场核规矩没查成：开会话钩子自己出错了（${err?.message ?? err}）；${READ_MAIN}。`];
  }
  process.stdout.write(`${render(lines)}\n`);
}
