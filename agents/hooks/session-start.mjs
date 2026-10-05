// SessionStart 钩子（agents-sync 装进 ~/.fleet-dao/hooks/，登记在 ~/.claude/settings.json；Grok、Devin、Cursor 默认借道读这份）。
// 开会话、续会话时跑；stdout 打一段 JSON，hookSpecificOutput.additionalContext 进会话上下文（Grok 不收开会话钩子的输出）。三件事：
// 1. 会话所在的仓：取一下远端；在 main 上、没有未提交的改动、落后了就快进；快进不了，或在别的分支上而 AGENTS.md 和主线不同，
//    提醒一句（#72 撞过：会话读到旧的 AGENTS.md）。不是 git 仓、没有 origin/main 的不出声。
// 2. 这台机器的规矩、技能、钩子、权限：同步脚本另有**一份只归它的检出**（~/.fleet-dao/origin-main，
//    agents/hooks/sync-source.mjs），永远停在 origin/main 的分离头上，再跑一遍 agents-sync --apply；结论一句话。
//    在别的仓里开会话也照做。这台机器自己的 fleet-dao 检出在哪、在哪个分支、有没有没提交的改动，都不影响这一件
//    （2026-10-01 创始人：「我希望每台机器，能在我们改动后，自动就同步，而不是人为提醒」）：主检出停在功能分支上
//    不再让这台机器停在旧规矩上。那边的检出只被当「种子」读，一个写操作都没有。
//    上次同步成功不到 QUIET_MS 就不再跑：Cursor 讨论一次并行起好几个会话，每个都会触发这个钩子。
// 3. 会话所在仓的「## 生效中的临时调整」表（通用段「我拍了板」那条）：到了最迟复查日期的、缺列的、日期认不出的
//    各说一行，提醒照读法②问创始人。2026-09-28 拍的临时调整抄进产品仓时丢了撤回条件和复查日期，额度恢复了新会话还照做。
// 4. 会话开在 fleet-dao 里时：合并后待补审的 PR（先合后审，创始人 2026-10-03「1+2+3」），有待补审的或没查成才说一行；
//    限时 AFTER_MERGE_MS，超时、网络不通明说没查成，不当成「没有」。
// 没查成、没做成都明说原因和这台落后主线几个提交，不当成是最新的。一律退出 0：开会话钩子退出码非 0 也挡不住会话，
// 只会把输出丢掉；钩子自己出了意外也要打一句「没查成」。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithFallback, withoutProxy } from './fresh-main.mjs';
import { cleanId, stateDir, sessionLines as unattendedLines } from './unattended.mjs';

export const FETCH_MS = 15_000;
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

/** git 跑一条命令：{ status, stdout, stderr, error } */
export function gitRunner(timeoutMs = FETCH_MS) {
  return (cwd, args, opts = {}) => {
    const r = spawnSync('git', args, {
      cwd,
      ...(opts.direct ? { env: withoutProxy() } : {}),
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error, timeoutMs };
  };
}

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

/** 一次命令为什么没成：超时、起不来，或者输出的第一行 */
export function why(r) {
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT') return `超过 ${Math.round((r.timeoutMs ?? FETCH_MS) / 1000)} 秒没完`;
    return `起不来：${r.error.message}`;
  }
  const first = `${r.stderr ?? ''}\n${r.stdout ?? ''}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (first) return first;
  // Windows 上程序没起来会给 0xC000xxxx 这类很大的退出码（缺 DLL 是 0xC0000135）：光写十进制看不出来
  if (typeof r.status === 'number' && r.status > 0x7fffffff)
    return `退出码 ${r.status}（0x${r.status.toString(16).toUpperCase()}，Windows 上程序没起来，多半缺 DLL）`;
  return `退出码 ${r.status}`;
}

const ok = (r) => r.status === 0 && !r.error;

/**
 * git 自己没跑起来（起不来、超时、被系统叫停、没有退出码，或者 Windows 上 0xC0000xxx 那一类），
 * 和「git 说这里不是仓」是两回事：git 说话了，不是仓时退出码是 128（或者 0 加一个 false）。前者不能说成后者——
 * 2026-09-30 本机 git 缺 DLL（退出码 3221225781）被说成「不是 git 仓」，把真毛病盖住了。
 */
export function gitBroken(r) {
  if (r.error || typeof r.status !== 'number') return true;
  return r.status !== 0 && r.status !== 128 && r.status > 0x7fffffff;
}
const short = (sha) => String(sha).slice(0, 7);

function commonOf(g) {
  const r = g('rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!ok(r)) return null;
  const p = resolve(r.stdout.trim());
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * 第 1 件：会话所在的仓。返回要说的一句（没有就是 null）；取过远端的话，带上这个仓的 git 公共目录和取没取成
 * （会话就开在 fleet-dao 里时，第 2 件不用再取一遍）
 */
export function checkHere(cwd, git) {
  const g = (...a) => git(cwd, a);
  const inside = g('rev-parse', '--is-inside-work-tree');
  // 不是 git 仓的目录不出声；git 自己跑不起来也不在这儿说（第 2 件同步那一句会说清，免得同一个毛病说两遍）
  if (!ok(inside) || inside.stdout.trim() !== 'true') return { line: null, fetch: null };
  const common = commonOf(g);
  // 先照环境里的代理取（reclaude 的口），没成再直连取一次；两次的原因都带上（fresh-main.mjs）
  const fetched = fetchWithFallback(git, cwd, ['fetch', '-q', 'origin'], { okOf: ok, whyOf: why });
  if (!fetched.ok)
    return {
      line: `开场核规矩没查成：git fetch 失败（${fetched.why}）。规矩以 origin/main 为准，动手前用 git show origin/main:AGENTS.md 读一遍。`,
      fetch: { common, ok: false, why: fetched.why },
    };
  const fetch = { common, ok: true, why: '' };
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
 * 只列最近 RECENT_MS 以内的最多 RECENT_MAX 条，每条截到 RECENT_CHARS 字；没有文件、没有最近的话都不出声；
 * 读不了文件（不是没有，是读不了）要说一句，不当成「没有」。
 */
export const RECENT_MS = 60 * 60_000;
export const RECENT_MAX = 5;
export const RECENT_CHARS = 200;
/** 后台任务完成、系统提醒也会以「用户消息」的身份进 UserPromptSubmit，落盘时原样记（2026-10-04 实测），列的时候不算创始人的话 */
const SYSTEM_PROMPT = /^\s*(?:<task-notification|<system-reminder|\[SYSTEM NOTIFICATION)/;

export function recentPrompts({ home, now = Date.now(), dir = null }) {
  const base = dir ?? join(home, '.fleet-dao', 'prompt-log');
  const days = new Set([beijingToday(now), beijingToday(now - RECENT_MS)]);
  const entries = [];
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
          Number.isFinite(at) &&
          now - at <= RECENT_MS &&
          at <= now + 60_000
        )
          entries.push({ at, prompt: e.prompt });
      } catch {
        // 坏的一行跳过：别因为一行坏了就把别的话也藏起来
      }
    }
  }
  if (entries.length === 0) return [];
  entries.sort((a, b) => a.at - b.at);
  const shown = entries.slice(-RECENT_MAX);
  const hhmm = (ms) => new Date(ms + 8 * 3_600_000).toISOString().slice(11, 16);
  const cut = (s) => (s.length > RECENT_CHARS ? `${s.slice(0, RECENT_CHARS)}……` : s).replace(/\s+/g, ' ');
  const said = shown.map((e) => `［${hhmm(e.at)}］${cut(e.prompt)}`).join(' ');
  return [
    `创始人最近 ${Math.round(RECENT_MS / 60_000)} 分钟落盘的话（共 ${entries.length} 条，列最后 ${shown.length} 条；上一个会话没来得及处理、或根本没送到的在这里，已经办过的不用再办）：${said}`,
  ];
}

/**
 * 第 4 件：合并后待补审（清单里标 review: after-merge 的 CI 判法先合后审，合并后由 discuss 技能的 second-opinion.mjs 补审）。
 * 只在 fleet-dao 自己的检出里查（origin 指向它；和 packages/github/src/hygiene-scope.ts 的 HYGIENE_REPO 是同一个仓）。
 * 查法不在这里另写一份：起 second-opinion.mjs --after-merge-pending --json，硬超时 AFTER_MERGE_MS。脚本优先用同步专用检出里
 * 那份（和这个钩子一样来自 origin/main，旧分支的检出里那份可能还不认这个参数），没有再用会话所在检出里的。
 */
export const AFTER_MERGE_MS = 8_000;
export const FLEET_ORIGIN = /github\.com[:/]+thoerwink8\/fleet-dao(?:\.git)?\/?$/i;
const SO_SCRIPT = join('agents', 'skills', 'discuss', 'scripts', 'second-opinion.mjs');
const SO_RUN = 'node agents/skills/discuss/scripts/second-opinion.mjs';
const AM_NOT_CHECKED = '合并后待补审没查成';

/** 起 second-opinion.mjs 查合并后待补审：{ status, stdout, stderr, error, timeoutMs }，超时由 spawnSync 杀掉 */
export function afterMergeRunner(timeoutMs = AFTER_MERGE_MS) {
  return (script, repo) => {
    const r = spawnSync(
      process.execPath,
      [script, '--after-merge-pending', '--json', '--no-fetch', '--repo', repo],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error, timeoutMs };
  };
}

const prList = (items) =>
  items
    .slice(0, 6)
    .map((p) => `#${p.number}`)
    .join('、') + (items.length > 6 ? ' 等' : '');

/**
 * fetch 是第 1 件在会话所在仓里取远端的结果（取不到时主线上合了什么不知道，直接说没查成，不起脚本）。
 * mirror 是同步专用检出里那份脚本（先试它），再试会话所在检出里的。返回要说的几行：没有待补审的、不是 fleet-dao 都不出声。
 */
export function checkAfterMerge({ cwd, git, run, fetch, mirror = null }) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!ok(top) || !top.stdout.trim()) return [];
  const root = top.stdout.trim();
  const url = git(root, ['config', '--get', 'remote.origin.url']);
  if (!ok(url) || !FLEET_ORIGIN.test(url.stdout.trim())) return [];
  if (fetch && fetch.ok === false)
    return [`${AM_NOT_CHECKED}：取不到远端（${fetch.why}），最近合并的 PR 补审了没有不知道。`];
  const script = [mirror, join(root, SO_SCRIPT)].find((s) => s && existsSync(s));
  if (!script) return [`${AM_NOT_CHECKED}：找不到 ${SO_SCRIPT.replaceAll('\\', '/')}。`];
  const r = run(script, root);
  if (r.error || r.status !== 0)
    return [
      `${AM_NOT_CHECKED}：${why(r).replace(/^没查成：/, '')}（自己跑一遍 ${SO_RUN} --after-merge-pending 看原因）。`,
    ];
  let p;
  try {
    p = JSON.parse(r.stdout);
  } catch {
    return [
      `${AM_NOT_CHECKED}：second-opinion.mjs 的输出认不出（${String(r.stdout).trim().slice(0, 60)}）。`,
    ];
  }
  if (![p?.unreviewed, p?.failed, p?.problems].every(Array.isArray))
    return [`${AM_NOT_CHECKED}：second-opinion.mjs 的输出少了 unreviewed、failed 或 problems。`];
  const lines = [];
  if (p.unreviewed.length > 0)
    lines.push(
      `合并后待补审 ${p.unreviewed.length} 个：${prList(p.unreviewed)}（跑 ${SO_RUN} --after-merge-sweep --author-family <写它的模型族>）。`,
    );
  if (p.failed.length > 0)
    lines.push(
      `合并后补审没过、等修复或 revert ${p.failed.length} 个：${prList(p.failed)}（修复合了跑 ${SO_RUN} --after-merge-resolve <号> --by <修复 PR 号>）。`,
    );
  if (p.problems.length > 0)
    lines.push(`合并后补审对不上 PR 的提交 ${p.problems.length} 个：${p.problems.slice(0, 2).join('；')}。`);
  return lines;
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
  afterMerge = afterMergeRunner(),
}) {
  const here = checkHere(cwd, git);
  // 同步专用检出里那份脚本和这个钩子一样来自 origin/main；没有再用会话所在检出里的
  const mirror = source ? join(source.syncDirIn(home), SO_SCRIPT) : null;
  return [
    ...(here.line ? [here.line] : []),
    ...unattendedLines({ dir: unattendedDir, sessionId: cleanId(sessionId), now }),
    ...checkTemporary(cwd, localGit, now),
    ...checkDirectives(cwd, localGit),
    ...recentPrompts({ home, now }),
    ...sweepWorktrees(cwd, localGit),
    ...checkAfterMerge({ cwd, git: localGit, run: afterMerge, fetch: here.fetch, mirror }),
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
 * 1. 不是那个固定名：`second-opinion*` 是 discuss 技能**故意复用**的审查树（它每轮 git clean 自己管，
 *    而且 Windows 上 Mirasim 的进程占着目录、本来就删不掉）。
 * 2. 没有未提交的改动（含未跟踪文件）：有就说明可能有人的东西在里面。
 * 3. 这个树上的提交**一条都不比远端多**（`rev-list HEAD --not --remotes` 是空的）：
 *    多一条就是有没推上去的活，**绝不删**，照实报。（判「远端」不判「origin/main」：
 *    树常常建在某条开着 PR 的分支的头上，那些提交在对应的远端分支上、安全，判 main 会把它们全留下。）
 * 4. **最近 30 分钟没动过**：另一个会话此刻正开着一棵树干活时，它可能刚好是「干净、已推」的
 *    ——只按前三条就会把它删掉、把人家正在干的事打断。刚建出来、刚提交过的树都不碰。
 *    （代价是刚做完的树要等半小时才收走，而这条命中率低、留着也无害。）
 *
 * 超出这四条的一律不动、也不当成「查成」——2026-10-02 清那 29 棵时，就是靠第 3 条救回了决定 0006
 * （`decision-align` 树里那份决定从没进过主线）。
 */

/** 多久没动过才收走（第 4 条）：另一个会话可能正开着一棵树干活。 */
export const SWEEP_IDLE_MS = 30 * 60_000;

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
  if (dirs.length === 0) return [];
  const kept = [];
  let removed = 0;
  for (const dir of dirs) {
    const name = basename(dir);
    if (/^second-opinion/.test(name)) continue; // discuss 自己的复用树
    const head = g('-C', dir, 'rev-parse', 'HEAD');
    if (!ok(head)) {
      // 注册还在、目录没了：`git worktree prune` 收拾这条记录（它只删管理条目，不动盘上任何东西）。
      if (ok(g('worktree', 'prune'))) stale += 1;
      else kept.push(name);
      continue;
    }
    let touched;
    try {
      touched = statSync(dir).mtimeMs;
    } catch {
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
    else kept.push(name);
  }
  const lines = [];
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
