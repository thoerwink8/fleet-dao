// SessionStart 钩子（agents-sync 装进 ~/.fleet-dao/hooks/；登记在仓级 .claude/settings.json：fleet-dao 自己的那份直接写着，
// 别的仓有订阅标记时由用户级的 plugin-loader.mjs 写进去，用户级设置里不登记它）。
// 开会话、续会话时跑；stdout 打一段 JSON，hookSpecificOutput.additionalContext 进会话上下文（Grok 不收开会话钩子的输出）。三件事：
// 1. 会话所在的仓：取一下远端；在 main 上、没有未提交的改动、落后了就快进；快进不了，或在别的分支上而 AGENTS.md 和主线不同，
//    提醒一句。不是 git 仓、没有 origin/main 的不出声。
//    Mirasim 每条消息都 --resume，这一钩子每轮都跑（Claude Code 要求 SessionStart 保持快：
//    https://code.claude.com/docs/en/hooks ）。git fetch、问 GitHub、扫工作树和 QUIET_MS 共用一扇门，
//    记在 ~/.fleet-dao/session-net/：三分钟内做过就跳过，失败也记上一笔，免得断网时每条消息都等满超时。
//    跳过时仍用手里已有的 origin/main 做本地核对。引导对账、临时调整、仓里的创始人引导每轮都做。
//    工人（FLEET_WORKER=1）不走这扇门，起来就要当前的远端。
// 2. 这台机器的规矩、技能、钩子、权限：同步脚本另有**一份只归它的检出**（~/.fleet-dao/origin-main，
//    agents/hooks/sync-source.mjs），永远停在 origin/main 的分离头上，再跑一遍 agents-sync --apply；结论一句话。
//    在别的仓里开会话也照做。这台机器自己的 fleet-dao 检出在哪、在哪个分支、有没有没提交的改动，都不影响这一件
//    （改动合进主线后每台机器要自己同步，不靠人提醒）：主检出停在功能分支上
//    不再让这台机器停在旧规矩上。那边的检出只被当「种子」读，一个写操作都没有。
//    上次同步成功不到 QUIET_MS 就不再跑：Cursor 讨论一次并行起好几个会话，每个都会触发这个钩子。
//    过了这扇门，同一天也再取、再同步。不用日期文件把主线冻到明天（当天 01:30 同步之后 #1147 到了主线，
//    后面的会话都跳过，钩子停在旧的 node 命令上）。
// 3. 会话所在仓的「## 生效中的临时调整」表（通用段「我拍了板」那条）：到了最迟复查日期的、缺列的、日期认不出的
//    各说一行，提醒照读法②问创始人。以前拍的临时调整抄进产品仓时丢了撤回条件和复查日期，额度恢复了新会话还照做。
// 4. 会话开在 fleet-dao 里时：我开的、检查全绿、没挂自动合并、没碰改标准的 PR（漏走 pnpm pr:open 的兜底），有才说一行；
//    gh 没查成说一行没查成，不当成「没有」。这一件和进度单 #1055、扫工作树一起走第 1 件的三分钟门。
// 5. 法国库里的整池暂停：复查日期到了（北京时间）提示一句（池、原因、负责人、到驾驶舱额度页打开）。没填复查日期的不提示。
//    只在这台配了登法国的 ssh 时查：~/.fleet-dao/france-ssh，或真开会话时进程里的 FLEET_FRANCE_SSH。没配不出声，不当成没到期。
//    当库被测试调用时不读进程环境，免得测试机上的环境变量把 ssh 打出去；真开会话（本文件当主程序）才把进程环境传进去。
//    查不成就说没查成。结果缓存 QUIET_MS，免得每条消息都 ssh。认不出的不当成没到期。
// 6. 仓合同：会话所在仓按 fleet-dao 的 agents/repo-contract.json 查，
//    有缺项说一段事实，每个仓每天最多一次，全过不出声。只在真开会话时接上（repoContract 参数），测试按需注入。
//    引导条目的〔范围：通用｜只此仓〕：checkDirectives 在那一行后面补一句没标的、标了通用还没上推的。
// 环境变量 FLEET_WORKER=1（机器派的会话设）：只做第 1、2 件，其余各段（创始人的事、整池暂停、工作树）一律不出。
// 没查成、没做成都明说原因和这台落后主线几个提交，不当成是最新的。一律退出 0：开会话钩子退出码非 0 也挡不住会话，
// 只会把输出丢掉；钩子自己出了意外也要打一句「没查成」。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineageOf, ownerPresence, reconcile, relayedUpTo, sentByFounder } from './founder-inbox.mjs';
import { fetchIsFresh, fetchWithFallback, markFetchOk, repoStampKey } from './fresh-main.mjs';
import { gitBroken, gitRunner, gitOk as ok, readFallbackProxy, gitWhy as why } from './git-run.mjs';
import { logDir } from './prompt-log.mjs';
import { proxyEnvOf, writeProxyEnv } from './proxy-env.mjs';
import { contractLines, DIRECTIVE_HEADING, pendingItems, scopeNote } from './repo-contract.mjs';
import {
  cleanId,
  isMachineOpening,
  isMachineSession,
  stateDir,
  sessionLines as unattendedLines,
} from './unattended.mjs';

export const SYNC_MS = 30_000;
export const QUIET_MS = 3 * 60_000;
const ORIGIN_MAIN = 'refs/remotes/origin/main';
// 规矩在两份文件里：通用段的原件 agents/shared-rules.md、仓根 AGENTS.md 的本仓段
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
/** 开场列进度单上的引导时每条只带前多少字：全文每次开场都注入太长，要看全文跑 pnpm progress read --pending */
export const DIRECTIVE_HEAD_CHARS = 40;
/** @param {string} s */
const head = (s) => {
  const chars = Array.from(s);
  return (
    (chars.length > DIRECTIVE_HEAD_CHARS ? `${chars.slice(0, DIRECTIVE_HEAD_CHARS).join('')}…` : s) ||
    '（内容空着）'
  );
};

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
// 标题和条目的读法放在 repo-contract.mjs：收尾的 Stop 钩子、仓合同的 progress 一项读的是同一个
export { DIRECTIVE_HEADING };

const DIRECTIVE_NOT_CHECKED = '创始人引导待处理清单没查成';

/**
 * 引导认主（同一个仓开着几个指挥官会话时，每个都被叫去办全部待处理引导，会撞车开出重复 PR）。
 * 主人是记下它的那个会话的血缘（Mirasim 会话目录名，founder-inbox.mjs 的 lineageOf），写成 `〔主：<目录名>〕`：进度单 #1055 的评论里
 * 由 pnpm progress directive 写、pnpm progress claim 改；别的仓「## 创始人引导（待处理）」清单的条目里手写。
 * 开会话时本血缘的列出来叫它办；有主、主不是本血缘的只计数、不列原文；没写主或写「无主」的照列，但要先认领。
 */
export const NO_OWNER = '无主';
const OWNER_MARK = /〔主：([^〕\s]+)〕/;

/** 一段话里的主人标记 → 主人（没有就是「无主」），和去掉标记的正文 */
function splitOwner(text) {
  const m = OWNER_MARK.exec(text);
  return { owner: m ? m[1] : NO_OWNER, text: text.replace(OWNER_MARK, '').trim() };
}

/** 本会话的血缘目录名；无血缘、没查成都是 null（有主的引导就一律不算本会话的） */
const lineageDir = (lineage) => (lineage?.status === 'found' ? lineage.dir : null);

export function checkDirectives(cwd, git, lineage = null) {
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
    const items = pendingItems(text, Number(n));
    if (items === null) {
      out.push(`${DIRECTIVE_NOT_CHECKED}（${file}:${n}）：标题下面认不出条目。`);
      continue;
    }
    // 认主：本血缘的、无主的列出来；有主、主不是本血缘的只计数
    const mine = lineageDir(lineage);
    const parts = items.map(splitOwner);
    const shown = parts.filter((p) => p.owner === NO_OWNER || p.owner === mine);
    const others = parts.length - shown.length;
    const unowned = shown.filter((p) => p.owner === NO_OWNER).length;
    const said = [];
    if (shown.length > 0) {
      const listed = shown
        .slice(0, 5)
        .map((p) => `${mine && p.owner === NO_OWNER ? '（无主）' : ''}${brief(p.text)}`);
      said.push(
        `创始人引导还有 ${shown.length} 条没处理（${file}:${n}）：${listed.join('；')}${shown.length > 5 ? ' 等' : ''}。先接着办，办完把那条标「已处理」或删掉。`,
      );
      // 〔范围：通用｜只此仓〕：只看待处理的、归本会话或无主的，已处理的老条目不追溯
      const scope = scopeNote(shown.map((p) => p.text));
      if (scope) said.push(scope);
      if (mine && unowned > 0)
        said.push(`无主的先在那一条写上〔主：${mine}〕认领再办（已写了别的主的不动）。`);
    }
    if (others > 0)
      said.push(`别的会话还有 ${others} 条引导在办（${file}:${n}，写了别的〔主：…〕），不归你，别动。`);
    if (said.length > 0) out.push(said.join(''));
  }
  return out;
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
 * 为什么开会话时列出来：他的话有两种丢法，一种是到了没处理，一种是排队时
 * 会话进程死了、从头没送到——钩子在提交那一刻就落了盘，新会话开场看一眼这份文件，上一个会话没来得及处理的话就在这里，不靠他重发。
 * 「上一个会话」只认同一条血缘：同一个 Mirasim 会话换了原生会话号（/compact、换模型）之前的那个号（founder-inbox.mjs 的 lineageOf）。
 * 别的 Mirasim 会话收到的话不列；无血缘的不列。
 * 列最近 RECENT_MS 以内、本会话还没见过的全部（当前这个号自己落盘的话它早见过，不列），每条截到 RECENT_CHARS 字，总字数到 RECENT_TOTAL_CHARS
 * 封顶（超了留最新的、写明更早的几条没列）；没有文件、没有最近的话都不出声；读不了文件（不是没有，是读不了）要说一句，不当成「没有」。
 * 机器派的会话（工人、反方）的提示现在不落盘（prompt-log.mjs）；这里再滤一遍，是为了 10-05 之前已经落盘的那些。
 * 第三种丢法：他在一轮跑着时打的字走 Mirasim 的「引导」，那一轮被打断、出错就丢了，
 * Claude Code 从头没收到、prompt-log 里自然也没有。所以再拿 Mirasim 自己记的「发了的账」（founder-inbox.mjs）和这份「收到的账」对一遍，
 * 发了没收到的单独一行、放前面、叫会话先答。这一段在每一轮开头都跑（Mirasim 每轮都 --resume 起进程，SessionStart 每轮都触发），
 * 所以上一轮丢的引导下一轮一开头就补上了。对账范围是「上一轮（含）以来」不是固定 RECENT_MS（一轮能跑一个多小时），见 founder-inbox.mjs 开头；下面「列收到的话」仍只看 RECENT_MS。
 */
export const RECENT_MS = 60 * 60_000;
export const RECENT_CHARS = 200;
export const RECENT_TOTAL_CHARS = 3000;
/** 后台任务完成、系统提醒也会以「用户消息」的身份进 UserPromptSubmit，落盘时原样记，列的时候不算创始人的话 */
const SYSTEM_PROMPT = /^\s*(?:<task-notification|<system-reminder|\[SYSTEM NOTIFICATION)/;

export function recentPrompts({
  home,
  now = Date.now(),
  dir = null,
  sessionId = null,
  env = process.env,
  lineage = null,
}) {
  // 只认本血缘（同一个 Mirasim 会话用过的原生会话号，founder-inbox.mjs 的 lineageOf）：别的 Mirasim 会话收到的话一概不列
  // 只列本血缘的：列所有会话的话，另一个项目的会话会把它当成自己的活办掉。
  // 无血缘（不是 Mirasim 起的、这台没装）两行都不出，不拿别的会话的话顶；没查成明说。
  const line = lineage ?? lineageOf({ home, sessionId, env });
  if (line.status === 'none') return [];
  if (line.status === 'unchecked')
    return [
      `创始人的话没核成：认不出本会话是哪个 Mirasim 会话（${line.why}）；本会话丢的话、换会话号之前收到的话这次没列。别拿别的会话的话当自己的活。`,
    ];
  const family = new Set(line.sessionIds);
  // 落盘目录和写的那边（prompt-log.mjs 的 logDir）同一份：原来这里不认 FLEET_PROMPT_LOG_DIR（全仓审查第 4 路 R4）
  const base = dir ?? logDir(process.env, home);
  // 发了的账（本血缘那一个 Mirasim 会话目录）：对账范围是「上一轮（含）以来」，可能比 RECENT_MS 早得多（founder-inbox.mjs 开头），收到的账也读到那么早
  const sent = sentByFounder({ home, now, env, only: line.dir });
  const since = sent.absent ? now - RECENT_MS : Math.min(now - RECENT_MS, sent.since);
  const days = new Set([beijingToday(now), beijingToday(since)]);
  for (let t = since; t < now; t += 12 * 3_600_000) days.add(beijingToday(t));
  /** 收到的账：本血缘里哪个原生会话号收到的都记，别的会话收到的不记 */
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
          typeof e.sessionId === 'string' &&
          family.has(e.sessionId) &&
          !SYSTEM_PROMPT.test(e.prompt) &&
          !isMachineOpening(e.prompt) &&
          !isMachineSession({ env: {}, cwd: e.cwd }) &&
          Number.isFinite(at) &&
          at >= since &&
          at <= now + 60_000
        )
          received.push({ at, text: e.prompt, sessionId: e.sessionId, line: line.dir });
      } catch {
        // 坏的一行跳过：别因为一行坏了就把别的话也藏起来
      }
    }
  }
  const lines = [];
  // 发了的账和收到的账对一遍：发了、没收到的就是丢在 Mirasim「引导」里的那种（founder-inbox.mjs 开头）。
  // 发了的只读了本血缘那个目录，收到的也只留本血缘的：换了原生会话号之前丢的也补回本会话；别的会话丢的不进来
  if (!sent.absent) {
    for (const p of sent.problems) lines.push(`创始人在 Mirasim 里发的话没读全：${p}；有没有丢的核不了。`);
    // 现在不再往 steer-shown 写。旧记录还在：转过的仍算收到，免得开会话把已经转过的再列一遍
    const relay = relayedUpTo({ home, sessionIds: line.sessionIds, env });
    for (const p of relay.problems) lines.push(`旧的引导记录没核成：${p}；这次分不清哪些已经转过。`);
    const { lost } = reconcile(sent.entries, received, { relayed: { line: line.dir, at: relay.at } });
    if (lost.length > 0) {
      const shown = packNewestFirst(lost);
      lines.push(
        `创始人发了、但 Claude Code 没收到的话（Mirasim 的「引导」在那一轮被打断或出错时丢了，他以为你看到了；共 ${lost.length} 条${shown.omitted}）：${shown.items.join(' ')} 先答这些，答完再接着干。`,
      );
    }
  }
  // 同一个 Mirasim 会话换原生会话号之前收到的（/compact、换模型）：当前这个号自己收到的它早见过，不列
  const earlier = received.filter((e) => now - e.at <= RECENT_MS && e.sessionId !== sessionId);
  if (earlier.length > 0) {
    const shown = packNewestFirst(earlier);
    lines.push(
      `本会话（同一个 Mirasim 会话）换会话号之前最近 ${Math.round(RECENT_MS / 60_000)} 分钟收到的话（共 ${earlier.length} 条${shown.omitted}；换号前没来得及处理的在这里，已经办过的不用再办）：${shown.items.join(' ')}`,
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
  const root = fleetRoot(cwd, git);
  if (root === null) return [];
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
 * fleet-dao 的创始人引导记在 GitHub 置顶单 #1055（pnpm progress directive），不在仓里的文件里：这里起
 * `progress.ts read --pending` 读没处理的几条，硬超时 PROGRESS_MS。不是 fleet-dao 不出声（别的仓仍读自己的
 * 「## 创始人引导（待处理）」一节，见 checkDirectives）；查不成出一行「没查成」，不挡开会话。
 * 优先用同步专用检出里那份脚本，没有再用会话所在检出里的。
 */
export const PROGRESS_MS = 8_000;
/** 引导挂了多久、本会话又接不了，就交给创始人拍 */
export const STALE_DIRECTIVE_MS = 24 * 60 * 60_000;
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

/**
 * 参数同 checkIdlePrs，加 lineage（本会话的血缘）；返回要说的几行：没有待处理的、不是 fleet-dao 都不出声。
 * 认主（见 NO_OWNER 上面）：progress.ts 的第 4 列是主人（旧版脚本没有这一列，就从正文里的〔主：…〕认，再没有算无主）。
 * 本血缘的列全文叫它办；有主、主不是本血缘的只说条数；无主的照列开头，但先认领（pnpm progress claim）。
 */
export function checkProgressIssue({ cwd, git, run, mirror = null, lineage = null }) {
  const root = fleetRoot(cwd, git);
  if (root === null) return [];
  const script = progressScript(root, mirror);
  if (!script) return [progressMissing()];
  return progressLines(run(script, root), lineage);
}

/** 会话所在的仓是 fleet-dao 的检出就返回仓根，不是（或不是 git 仓）返回 null */
function fleetRoot(cwd, git) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!ok(top) || !top.stdout.trim()) return null;
  const root = top.stdout.trim();
  const url = git(root, ['config', '--get', 'remote.origin.url']);
  if (!ok(url) || !FLEET_ORIGIN.test(url.stdout.trim())) return null;
  return root;
}

const progressScript = (root, mirror) =>
  [mirror, join(root, PROGRESS_SCRIPT)].find((s) => s && existsSync(s));
const progressMissing = () => `${PROGRESS_NOT_CHECKED}：找不到 ${PROGRESS_SCRIPT.replaceAll('\\', '/')}。`;

/**
 * progress.ts read --pending 跑出来的结果 → 要说的几行（开会话的同步那半拿后台存下的结果调它，认主要用本会话的血缘）。
 * @param {{ status: number | null, stdout: string, stderr: string, error?: { message?: string, code?: string } | null, timeoutMs?: number }} r
 */
export function progressLines(r, lineage = null, { presence = null, adopt = null, now = Date.now() } = {}) {
  if (r.error || r.status !== 0) return [`${PROGRESS_NOT_CHECKED}：${why(r)}。`];
  const rows = String(r.stdout)
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const items = rows.map((l) => l.split('\t'));
  if (items.some((c) => c.length < 3 || !/^\d+$/.test(c[0])))
    return [`${PROGRESS_NOT_CHECKED}：progress.ts 的输出认不出（${String(r.stdout).trim().slice(0, 60)}）。`];
  if (items.length === 0) return [];
  const mine = lineageDir(lineage);
  const all = items.map(([id, head, text, col, created]) => {
    const split = splitOwner(text);
    const owner = col?.trim() || split.owner;
    const at = Date.parse(created?.trim() ?? '');
    return {
      id,
      when: head.replace(/^【[^】]*】/, ''),
      text: split.text.replace(/^原话：/, ''),
      owner,
      age: Number.isFinite(at) ? now - at : null,
    };
  });
  const lines = [];
  // 自动认领（只在指挥官会话：认得出本会话血缘；机器派的会话不走到这里）：主人会话确定已不在（ownerPresence 判 gone）的才认，
  // 判不了的不认。认领在后台跑 progress.ts claim --auto，那边再核一遍、用原主做乐观锁；这里照实说「在认领」，不说「认领了」。
  const adopted = [];
  if (mine !== null && presence && adopt) {
    for (const d of all) {
      if (d.owner === mine || d.owner === NO_OWNER) continue;
      const p = presence(d.owner);
      if (p?.state !== 'gone') continue;
      const started = adopt(d.id, d.owner);
      if (started?.ok) {
        adopted.push(d);
        d.owner = mine;
        d.why = p.why;
      }
    }
  }
  if (adopted.length > 0)
    lines.push(
      `主人会话已不在的创始人引导 ${adopted.length} 条，后台正在替本会话认领（开 PR 改主人）：${adopted.map((d) => `${d.id}（${d.why}）`).join('；')}。下面按归本会话列；认领没成的下次开场照实再列。`,
    );
  // 每条只列编号、时间、前 DIRECTIVE_HEAD_CHARS 个字和怎么处理；一条只进一处（进了「要你拍的」的不在无主那行再列一遍）
  const ours = all.filter((d) => mine !== null && d.owner === mine);
  // 挂了超过 24 小时、本会话又接不了的（无主、主人还在或判不了）：交给创始人拍
  const stale = all.filter((d) => d.owner !== mine && d.age !== null && d.age > STALE_DIRECTIVE_MS);
  const unowned = all.filter((d) => d.owner === NO_OWNER);
  const unownedFresh = unowned.filter((d) => !stale.includes(d));
  const others = all.filter((d) => !ours.includes(d) && d.owner !== NO_OWNER && !stale.includes(d)).length;
  const full = '全文 pnpm progress read --pending';
  if (stale.length > 0)
    lines.push(
      `要你拍的（放进报进度的「要你拍的」）：创始人引导 ${stale.length} 条挂了超过 24 小时、本会话接不了：${stale
        .slice(0, 5)
        .map((d) => `${d.id}（${d.when}，主：${d.owner}）${head(d.text)}`)
        .join(
          '；',
        )}${stale.length > 5 ? ' 等' : ''}。请他定：交给本会话办（pnpm progress claim <编号> --force --why "<他的话>"）、作废（pnpm progress done <编号> --drop）还是再等；${full}。`,
    );
  if (ours.length > 0)
    lines.push(
      `创始人引导有 ${ours.length} 条归本会话、没处理（进度单 #1055；本会话是 Mirasim 会话 ${mine}）：${ours.map((d) => `${d.id}（${d.when}）${head(d.text)}`).join('；')}。先接着办（${full}），办完 pnpm progress done <评论号>。`,
    );
  if (unownedFresh.length > 0) {
    const shown = unownedFresh.slice(0, 5).map((d) => `${d.id}（${d.when}）${head(d.text)}`);
    const how =
      mine !== null
        ? '先认领再办：pnpm progress claim <评论号>（已归别的会话的会被拒）'
        : '本会话认不出是哪个 Mirasim 会话、认领不了：是这个会话记的就接着办，不是就别动';
    lines.push(
      `无主的创始人引导 ${unownedFresh.length} 条（进度单 #1055；旧的、或在 Mirasim 外记的）：${shown.join('；')}${unownedFresh.length > 5 ? ' 等' : ''}。${how}；${full}。`,
    );
  }
  if (others > 0) lines.push(`别的会话还有 ${others} 条创始人引导在办（进度单 #1055），不归你，别动。`);
  return lines;
}

/** 和 packages/shared 的 DEFAULT_POOL_HOLD_OWNER 同一个字。钩子装到机器上，不能 import 那个包。 */
const DEFAULT_POOL_HOLD_OWNER = '指挥官';
const FRANCE_SSH_ENV = 'FLEET_FRANCE_SSH';
const POOL_HOLD_SEEN = 'pool-holds-seen.json';
const POOL_HOLD_SSH_MS = 8_000;
const POOL_HOLD_SQL = "SELECT value FROM settings WHERE key = 'engine.poolHolds'";
const POOL_HOLD_DB = "dbname=fleet options='-c default_transaction_read_only=on'";
const POOL_HOLD_KEYS = new Set(['reason', 'decidedBy', 'revokeWhen', 'reviewBy', 'owner']);

const shQuote = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

function franceHost({ home, env, readText }) {
  const fromEnv = env && typeof env[FRANCE_SSH_ENV] === 'string' ? env[FRANCE_SSH_ENV].trim() : '';
  let raw = fromEnv;
  let from = `环境变量 ${FRANCE_SSH_ENV}`;
  if (!raw) {
    const file = join(home, '.fleet-dao', 'france-ssh');
    let text;
    try {
      text = (readText ?? readFileSync)(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return { ok: false, kind: 'not-configured' };
      return { ok: false, kind: 'bad-config', why: '登法国的 ssh 配置读不了' };
    }
    raw =
      String(text)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l !== '' && !l.startsWith('#')) ?? '';
    from = '登法国的 ssh 配置';
    if (!raw) return { ok: false, kind: 'bad-config', why: '登法国的 ssh 配置是空的' };
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9._@-]{0,200}$/.test(raw)) {
    return { ok: false, kind: 'bad-config', why: `${from}里的 ssh 名字认不出` };
  }
  return { ok: true, host: raw };
}

const scrubHost = (text, host) =>
  String(text ?? '')
    .split(host)
    .join('（名字已隐去）')
    .slice(0, 180);

/** 和 france-lib.mjs 的 LOGIN_KEY_NAMES 同一份：fleet_login，其次创始人的 id_ed25519、id_rsa。不含 grok_bot。 */
const FRANCE_LOGIN_KEY_NAMES = ['fleet_login', 'id_ed25519', 'id_rsa'];

function franceLoginIdentityArgs(home) {
  const found = [];
  for (const name of FRANCE_LOGIN_KEY_NAMES) {
    const file = join(home, '.ssh', name);
    try {
      if (existsSync(file) && statSync(file).isFile()) found.push(file);
    } catch {
      // 读不到就当没有这把
    }
  }
  if (found.length === 0) return [];
  return ['-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', ...found.flatMap((file) => ['-i', file])];
}

/**
 * 读法国库里的 engine.poolHolds。同步、只读。没配登法国的 ssh 回 { ok: true, skipped: true }（不出声）。
 * env 不传就不看进程环境。成功和失败都按 QUIET_MS 记在 ~/.fleet-dao/pool-holds-seen.json，免得每条消息都 ssh。
 * 原因里不带 ssh 名字（可能是 IP）。
 */
export function readFrancePoolHolds({ home, env, spawn = spawnSync, now = Date.now(), readText, writeText }) {
  const dir = join(home, '.fleet-dao');
  const cacheFile = join(dir, POOL_HOLD_SEEN);
  let cached = null;
  try {
    cached = JSON.parse((readText ?? readFileSync)(cacheFile, 'utf8'));
  } catch {
    cached = null;
  }
  if (
    cached &&
    typeof cached.at === 'number' &&
    now - cached.at < QUIET_MS &&
    now - cached.at > -5_000 &&
    cached.read
  ) {
    return cached.read;
  }
  const host = franceHost({ home, env, readText });
  if (!host.ok && host.kind === 'not-configured') return { ok: true, skipped: true };
  if (!host.ok) return { ok: false, why: host.why };
  const remote = [
    'sudo',
    '-n',
    '-u',
    'fleet',
    'psql',
    '-X',
    '-q',
    '-t',
    '-A',
    '-v',
    'ON_ERROR_STOP=1',
    '-d',
    shQuote(POOL_HOLD_DB),
    '-c',
    shQuote(POOL_HOLD_SQL),
  ].join(' ');
  const r = spawn(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'Compression=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=10',
      '-o',
      'ServerAliveCountMax=3',
      // 和 france-lib.mjs 的 LOGIN_KEY_NAMES 同一份。法国 MaxAuthTries 是 3，只提交这几把，不走 agent。
      ...franceLoginIdentityArgs(home),
      host.host,
      remote,
    ],
    { encoding: 'utf8', timeout: POOL_HOLD_SSH_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let read;
  if (r?.error || r?.status !== 0) {
    const detail = r?.error
      ? (r.error.code ?? r.error.message ?? 'ssh 没起来')
      : String(r?.stderr ?? '')
          .trim()
          .split('\n')[0] || `退出码 ${r?.status ?? '无'}`;
    read = { ok: false, why: `连不上法国（${scrubHost(detail, host.host)}）` };
  } else {
    const stdout = String(r.stdout ?? '').trim();
    if (stdout === '') read = { ok: true, value: undefined };
    else {
      try {
        read = { ok: true, value: JSON.parse(stdout) };
      } catch {
        read = { ok: false, why: '库里的值不是 JSON' };
      }
    }
  }
  try {
    mkdirSync(dir, { recursive: true });
    (writeText ?? writeFileSync)(cacheFile, JSON.stringify({ at: now, read }));
  } catch {
    // 缓存写不上照样把这次的结果交出去
  }
  return read;
}

const holdText = (entry, key) => (typeof entry[key] === 'string' ? entry[key].trim() : '');

function holdDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 读到的整池暂停 → 要说的几行。没配（skipped）、库里没有这一项：不出声。认不出、没查成：明说，不当成没到期。 */
export function poolHoldPromptLines(read, today) {
  if (!read || read.skipped) return [];
  if (!read.ok) return [`整池暂停没查成：${read.why}。有没有到期的不知道。`];
  const value = read.value;
  if (value === undefined) return [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['整池暂停整份认不出，当不了没到期。到驾驶舱额度页看。'];
  }
  const overdue = [];
  const bad = [];
  for (const [poolId, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      bad.push(poolId);
      continue;
    }
    const extra = Object.keys(entry).some((k) => !POOL_HOLD_KEYS.has(k));
    const reason = holdText(entry, 'reason');
    const reviewRaw = entry.reviewBy;
    const reviewBy = holdText(entry, 'reviewBy');
    // 没写复查日期不算到期、也不算认不出。写了但不是 YYYY-MM-DD（含空白）仍算认不出。
    const reviewBad = reviewRaw !== undefined && !holdDay(reviewBy);
    const ownerRaw = entry.owner;
    const ownerBad = ownerRaw !== undefined && (typeof ownerRaw !== 'string' || ownerRaw.trim() === '');
    if (
      extra ||
      !reason ||
      !holdText(entry, 'decidedBy') ||
      !holdText(entry, 'revokeWhen') ||
      reviewBad ||
      ownerBad
    ) {
      bad.push(poolId);
      continue;
    }
    if (reviewBy === '' || today < reviewBy) continue;
    const owner = typeof ownerRaw === 'string' && ownerRaw.trim() ? ownerRaw.trim() : DEFAULT_POOL_HOLD_OWNER;
    const days = Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${reviewBy}T00:00:00Z`)) / 86_400_000,
    );
    const when = days <= 0 ? '就是今天' : `已过 ${days} 天`;
    overdue.push(
      `整池暂停到期：${poolId}（原因：${reason}；负责人：${owner}；复查日期 ${reviewBy}，${when}）。到驾驶舱额度页打开或改复查日期，引擎不会自动撤。`,
    );
  }
  const lines = [...overdue];
  if (bad.length > 0) {
    lines.push(`整池暂停有 ${bad.length} 条认不出（${bad.join('、')}），当不了没到期。到驾驶舱额度页看。`);
  }
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
  idlePr = idlePrRunner(),
  progress = progressRunner(),
  env = process.env,
  poolHolds = null,
  repoContract = null,
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
  // 工人（FLEET_WORKER=1）只要规矩同步：创始人引导、他最近的话、工作树清单都是指挥官的事，
  // 注进工人的开场它会当成自己的活，还白占 8–11 秒
  if (worker)
    return [...(here.line ? [here.line] : []), syncFleet({ home, git, sync, fetch: here.fetch, now })];
  let holdRead = { ok: true, skipped: true };
  try {
    holdRead = (poolHolds ?? (() => readFrancePoolHolds({ home, now, spawn: spawnSync })))();
  } catch (err) {
    holdRead = { ok: false, why: err?.message ?? String(err) };
  }
  // 同步专用检出里那份脚本和这个钩子一样来自 origin/main；没有再用会话所在检出里的
  const syncDir = source ? source.syncDirIn(home) : null;
  // 本会话的血缘（同一个 Mirasim 会话用过的原生会话号）：他的话、引导都按它认主，别的会话的不给本会话
  const lineage = lineageOf({ home, sessionId, env });
  return [
    ...(here.line ? [here.line] : []),
    ...unattendedLines({ dir: unattendedDir, sessionId: cleanId(sessionId), now }),
    ...checkTemporary(cwd, localGit, now),
    ...poolHoldPromptLines(holdRead, beijingToday(now)),
    ...checkDirectives(cwd, localGit, lineage),
    ...(repoContract ? repoContract(cwd) : []),
    ...(quiet
      ? []
      : checkProgressIssue({
          cwd,
          git: localGit,
          run: progress,
          mirror: syncDir ? join(syncDir, PROGRESS_SCRIPT) : null,
          lineage,
        })),
    ...recentPrompts({ home, now, sessionId, env, lineage }),
    ...(quiet ? [] : sweepWorktrees(cwd, localGit, now, home)),
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

// ── 拆成两半────────────────────────────────────────────────────────────────
// 上面的 sessionStart 是一口气全做完的老路子（工人 FLEET_WORKER=1 起来就要当前的远端，还走它；测试也拿它测各件）。
// 本机实测它中位 27.7 秒、最长 86 秒，Mirasim 每条消息 resume 都付一遍。现在真开会话走 fastSessionStart：
// - 同步那半只做本地的：会话所在仓的本地核对（用手里已有的 origin/main，落后就快进）、临时调整表、引导、仓合同、他最近的话，
//   外加读后台上一次写下的结果（~/.fleet-dao/session-bg/<仓的指纹>.json）。目标中位 ≤1 秒。
// - 取远端、规矩同步（agents-sync）、gh、扫工作树、ssh 法国查整池暂停：放进脱离的后台子进程
//   （本文件 --background <会话目录>），写结果文件，下次开会话读。结果没有、过了 QUIET_MS、读不懂就再起一个；锁（同名 .lock）
//   BG_LOCK_MS 内是新的就不起第二个。
// - 后台每一步出错都写进结果（{ ok: false, why }），整个崩了写 crashed：下次开场如实说「没查成」和原因，不吞掉、不当成没事。
// - 后台子进程的环境：配了 ~/.fleet-dao/fallback-proxy 就把四个代理变量换成它（proxy-env.mjs），gh、ssh 不穿 reclaude 的口。

/** 后台跑着的锁多久算还新（超过就当那个后台死了，照起新的） */
export const BG_LOCK_MS = 5 * 60_000;
/** 后台里问 GitHub 的脚本（进度单、绿了没挂的 PR）各给多久 */
export const BG_SCRIPT_MS = 45_000;
/** 后台结果多久没刷新就在开场多说一句 */
const BG_STALE_MS = 30 * 60_000;
const BG_WHAT = '开场的联网几项（取远端、规矩同步、GitHub 上的进度单和 PR、清工作树、法国整池暂停）';

/** 后台结果文件：按仓的 git 公共目录分（和 fetch-ok、session-net 同一种指纹）；不在 git 仓里的共用 _none */
function cachePathOf(home, common) {
  const key = common ? createHash('sha256').update(common).digest('hex').slice(0, 16) : '_none';
  return join(home, '.fleet-dao', 'session-bg', `${key}.json`);
}

/** 这个会话目录的后台结果文件在哪 */
export function bgCachePath(home, cwd, git) {
  return cachePathOf(
    home,
    commonOf((...a) => git(cwd, a)),
  );
}

/** 锁里记的时刻还在 BG_LOCK_MS 以内 */
function lockFresh(lock, now) {
  try {
    const at = JSON.parse(readFileSync(lock, 'utf8'))?.at;
    const age = now - Number(at);
    return Number.isFinite(age) && age > -5_000 && age < BG_LOCK_MS;
  } catch {
    return false;
  }
}

/** 拿后台的锁：已有新锁拿不到；旧锁（后台死了）删掉重拿 */
function takeBgLock(lock, now) {
  if (lockFresh(lock, now)) return false;
  try {
    mkdirSync(dirname(lock), { recursive: true });
    rmSync(lock, { force: true });
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: now }), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

/** 跑脚本的结果存进 JSON：error 只留 message、code（why() 只看这两样） */
const plainRun = (r) => ({
  status: r.status,
  stdout: r.stdout ?? '',
  stderr: r.stderr ?? '',
  ...(r.timeoutMs ? { timeoutMs: r.timeoutMs } : {}),
  ...(r.error ? { error: { message: r.error.message, code: r.error.code } } : {}),
});

/**
 * 后台那半：取远端、规矩同步、整池暂停、进度单、绿了没挂的 PR、扫工作树，结果写进 bgCachePath。每一步单独兜住，出错记 { ok: false, why }。
 * 另一个后台拿着新锁时什么都不做，返回 'busy'。
 */
export function runBackground({
  cwd,
  home,
  git,
  sync,
  localGit = git,
  now = Date.now(),
  env = process.env,
  idlePr = idlePrRunner(),
  progress = progressRunner(),
  poolHolds = null,
  fallbackProxy = undefined,
}) {
  const common = commonOf((...a) => localGit(cwd, a));
  const path = cachePathOf(home, common);
  const lock = `${path}.lock`;
  if (!takeBgLock(lock, now)) return 'busy';
  try {
    const steps = {};
    const step = (name, fn) => {
      try {
        steps[name] = { ok: true, value: fn() };
      } catch (err) {
        steps[name] = { ok: false, why: err?.message ?? String(err) };
      }
    };
    /** @type {{ common: string | null, ok: boolean, why: string } | null} */
    let fetch = null;
    if (common !== null) {
      step('fetch', () => {
        const got = fetchWithFallback(git, cwd, ['fetch', '-q', 'origin'], {
          okOf: ok,
          whyOf: why,
          env,
          ...(fallbackProxy ? { fallbackProxy } : {}),
        });
        fetch = { common, ok: got.ok, why: got.why };
        if (got.ok) markFetchOk({ home, cwd, git: localGit, okOf: ok, now });
        return { ok: got.ok, why: got.why };
      });
    }
    step('sync', () => syncFleet({ home, git, sync, now }));
    step('holds', () => (poolHolds ?? (() => readFrancePoolHolds({ home, env, now, spawn: spawnSync })))());
    if (common !== null) {
      const syncDir = source ? source.syncDirIn(home) : null;
      step('progress', () => {
        const root = fleetRoot(cwd, localGit);
        if (root === null) return null;
        const script = progressScript(root, syncDir ? join(syncDir, PROGRESS_SCRIPT) : null);
        return script ? { run: plainRun(progress(script, root)), script, root } : { missing: true };
      });
      step('idle', () =>
        checkIdlePrs({
          cwd,
          git: localGit,
          run: idlePr,
          fetch,
          mirror: syncDir ? join(syncDir, IDLE_SCRIPT) : null,
        }),
      );
      step('sweep', () => sweepWorktrees(cwd, localGit, now, home));
    }
    writeJsonAtomic(path, { v: 1, at: now, steps });
    return 'done';
  } finally {
    rmSync(lock, { force: true });
  }
}

/** 读后台结果：{ kind: 'none' } 没有；{ kind: 'bad', why } 读不懂；{ kind: 'ok', value } */
function readBgCache(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { kind: 'none' };
    return { kind: 'bad', why: err?.code ?? err?.message ?? String(err) };
  }
  try {
    const value = JSON.parse(text);
    if (
      typeof value?.at !== 'number' ||
      (typeof value.steps !== 'object' && typeof value.crashed !== 'string')
    )
      return { kind: 'bad', why: '形状认不出' };
    return { kind: 'ok', value };
  } catch {
    return { kind: 'bad', why: '不是 JSON' };
  }
}

const agoText = (ms) => {
  const n = Math.round(ms / 60_000);
  return n < 1 ? '后台刚' : `后台 ${n} 分钟前`;
};

/** 起脱离的后台：不继承输出（钩子的 stdout 一关 Claude Code 就往下走），备用代理换进它的环境 */
function spawnDetached({ cwd, home }) {
  try {
    const fb = readFallbackProxy(home);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--background', cwd], {
      // 工作目录放系统临时目录：继承会话目录的话，Windows 上后台跑着时那个目录（常是工作树）删不掉；git 一律 -C 指目录，用不着它
      cwd: tmpdir(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: fb.proxy ? proxyEnvOf(process.env, fb.proxy) : process.env,
    });
    child.on('error', () => {});
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, why: err?.message ?? String(err) };
  }
}

/**
 * 后台替本会话认领一条主人已不在的引导：起 progress.ts claim <编号> --auto --expect-owner <原主>（脱离、不等），那边再核
 * 一遍「指挥官会话、原主确定不在、主人没变」才开 PR 改主。起不来返回 { ok: false }，这条就不算在认领。测试用 setAdoptDirective 换掉。
 */
let adoptDirective = ({ script, root, id, owner, sessionId }) => {
  try {
    const child = spawn(process.execPath, [script, 'claim', String(id), '--auto', '--expect-owner', owner], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId },
    });
    child.on('error', () => {});
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, why: err?.message ?? String(err) };
  }
};
export function setAdoptDirective(fn) {
  adoptDirective = fn;
}

/**
 * 同步那半（真开会话走这个）：只跑本地的，联网的几项读后台上一次的结果；该刷新就起一个后台。返回要说的几行。
 * spawnBackground 测试换成假的；git 只跑本地命令（GREP_MS 那份就够）。
 */
export function fastSessionStart({
  cwd,
  home,
  git,
  localGit = git,
  now = Date.now(),
  sessionId = null,
  unattendedDir = stateDir(),
  env = process.env,
  repoContract = null,
  spawnBackground = spawnDetached,
}) {
  const here = checkHere(cwd, localGit, { network: false });
  const path = cachePathOf(home, here.fetch?.common ?? null);
  const cache = readBgCache(path);
  const c = cache.kind === 'ok' ? cache.value : null;
  const age = c ? now - c.at : null;
  const ago = age === null ? '' : agoText(Math.max(0, age));
  const steps = c && !c.crashed ? c.steps : {};
  const got = (name) => steps[name];
  const failed = (name, label) => {
    const s = got(name);
    return s && !s.ok ? [`${label}没查成：后台出错（${s.why}）。`] : [];
  };
  const lineage = lineageOf({ home, sessionId, env });
  const lines = [];
  if (here.line) lines.push(here.line);
  const f = got('fetch');
  if (f?.ok && f.value && f.value.ok === false)
    lines.push(
      `开场核规矩没查成：后台 git fetch 失败（${f.value.why}，${ago}）。规矩以 origin/main 为准，动手前用 git show origin/main:AGENTS.md 读一遍。`,
    );
  lines.push(...failed('fetch', '开场核规矩（取远端）'));
  lines.push(...unattendedLines({ dir: unattendedDir, sessionId: cleanId(sessionId), now }));
  lines.push(...checkTemporary(cwd, localGit, now));
  const h = got('holds');
  if (h?.ok) lines.push(...poolHoldPromptLines(h.value, beijingToday(now)));
  lines.push(...failed('holds', '整池暂停'));
  lines.push(...checkDirectives(cwd, localGit, lineage));
  lines.push(...(repoContract ? repoContract(cwd) : []));
  const p = got('progress');
  if (p?.ok && p.value?.missing) lines.push(progressMissing());
  else if (p?.ok && p.value?.run) {
    const sid = cleanId(sessionId);
    const { script, root } = p.value;
    lines.push(
      ...progressLines(p.value.run, lineage, {
        now,
        presence: (owner) => ownerPresence({ home, owner, now, env }),
        adopt:
          typeof script === 'string' && typeof root === 'string' && sid
            ? (id, owner) => adoptDirective({ script, root, id, owner, sessionId: sid })
            : null,
      }),
    );
  }
  lines.push(...failed('progress', PROGRESS_NOT_CHECKED.replace(/没查成$/, '')));
  lines.push(...recentPrompts({ home, now, sessionId, env, lineage }));
  const sw = got('sweep');
  if (sw?.ok && Array.isArray(sw.value)) lines.push(...sw.value);
  lines.push(...failed('sweep', '清工作树'));
  const idle = got('idle');
  if (idle?.ok && Array.isArray(idle.value)) lines.push(...idle.value);
  lines.push(...failed('idle', IDLE_NOT_CHECKED.replace(/没查成$/, '')));
  const s = got('sync');
  if (s?.ok && typeof s.value === 'string') lines.push(`${s.value.replace(/。$/, '')}（${ago}跑的）。`);
  else if (s && !s.ok) lines.push(`规矩同步没查成：后台出错（${s.why}）；${READ_MAIN}。`);

  if (cache.kind === 'none') lines.push(`${BG_WHAT}还没出结果：已在后台起查，下次开会话再报；${READ_MAIN}。`);
  else if (cache.kind === 'bad')
    lines.push(`${BG_WHAT}没查成：后台的结果读不懂（${cache.why}），已重新在后台起查；${READ_MAIN}。`);
  else if (c?.crashed) lines.push(`${BG_WHAT}没查成：后台出错（${c.crashed}，${ago}）；${READ_MAIN}。`);
  else if (age !== null && age > BG_STALE_MS)
    lines.push(`${BG_WHAT}是${ago}查的，之后没刷新成；这次已重新起查。`);

  const due = c === null || age === null || !(age > -5_000 && age < QUIET_MS);
  if (due && !lockFresh(`${path}.lock`, now)) {
    const r = spawnBackground({ cwd, home });
    if (!r.ok) lines.push(`${BG_WHAT}后台起不来（${r.why}），这次没查；${READ_MAIN}。`);
  }
  return lines;
}

/**
 * 顺手清掉本仓 `.claude/worktrees/` 下攒着的旧树。
 *
 * 起因：「任何 work tree 里的任务在完成之后，本地的 work tree 必须清掉……
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
 * 超出这三条的一律不动、也不当成「查成」——清理 29 棵树那次，就是靠第 2 条救回了一份决定书
 * （`decision-align` 树里那份决定从没进过主线）。
 *
 * 留着的树要有主。有没提交的改动或没推上去的提交：不删（那是别人的活，存成 ref 再从盘上
 * 收走也是删数据，没有人在旁边拍就不做），刚动过也记成一条认领——负责人是指挥官，期限是首次记下
 * 之后 24 小时，落在 ~/.fleet-dao/kept-worktrees.json。下次开会话再读同一条，过了期限还在就接着报。
 * 两小时只挡住删除：干净、提交都在远端、但刚动过的树可能有人正在用，先留着、不派认领。
 * 这一轮没查成（最后动过的时间、git status、没列出没推的提交）：不删；已经认领过的留着原期限，
 * 不当成处理了，也不当成没有主。查不出、记不上就照实说，不覆盖那份清单。
 * 法国那半是每小时对账的「要人拍」（worktree:<仓>/<树>，packages/engine 的 worktree-sweep.ts）；
 * 本机没起引擎，不把两套清扫并成一套，只把「留着的树要有主」收成同一份清单的两边
 * （法国没查成不撤那条要人拍，本机没查成不撤已有认领）。
 */

/**
 * 多久没动过才收走（第 3 条）：另一个会话可能正开着一棵树干活。
 * 从 30 分钟放到 2 小时：一个会话 PR 合了之后常常接着在同一棵树里切下一条分支，中间隔半小时以上很常见；
 * 晚两小时收走一棵没用的树没有代价，早收走一棵在用的代价很大（见 lastTouched）。
 */
export const SWEEP_IDLE_MS = 2 * 60 * 60_000;

/** 残留工作树的认领：谁负责、多久之内要处理。记在家目录，下次开会话再读。 */
export const KEEP_OWNER = '指挥官';
export const KEEP_DEADLINE_MS = 24 * 60 * 60_000;

function keptLedgerPath(home) {
  return join(home, '.fleet-dao', 'kept-worktrees.json');
}

/** 给人看的期限。北京没有夏令时，按 UTC+8 算，不依赖这台机器的时区。 */
function beijingStamp(ms) {
  const d = new Date(ms + 8 * 60 * 60_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} 北京时间`;
}

function loadClaims(path) {
  if (!existsSync(path)) return { ok: true, claims: [] };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, why: `读不了（${err?.message ?? String(err)}）` };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, why: '不是 JSON' };
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.claims)) {
    return { ok: false, why: '认不出（没有 claims 数组）' };
  }
  for (const c of data.claims) {
    if (!c || typeof c.key !== 'string' || typeof c.repo !== 'string' || typeof c.firstSeen !== 'string') {
      return { ok: false, why: '有一条认领缺字段' };
    }
    if (Number.isNaN(Date.parse(c.firstSeen))) return { ok: false, why: '有一条认领的时间认不出' };
  }
  return { ok: true, claims: data.claims };
}

function saveClaims(path, claims) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, claims }, null, 2)}\n`);
    renameSync(tmp, path);
    return { ok: true };
  } catch (err) {
    return { ok: false, why: err?.message ?? String(err) };
  }
}

/**
 * 把这一仓确认还有活的树写进认领清单。期限从第一次记下算，下次再看到不往后推。
 * 这一轮没查成的树：已有认领原样留着，不按「本轮确认有活」的那几棵把它们重写掉。
 * 清单读不懂或写不进去：不覆盖，调用方照实说没记上。
 */
function assignKept(home, repo, leftovers, unchecked, now) {
  const path = keptLedgerPath(home);
  const loaded = loadClaims(path);
  if (!loaded.ok) return { ok: false, why: loaded.why, path, claims: [], preserved: [] };
  const rest = loaded.claims.filter((c) => c.repo !== repo);
  const mine = loaded.claims.filter((c) => c.repo === repo);
  const claims = leftovers.map((tree) => {
    const prev = mine.find((c) => c.key === tree.dir);
    const firstMs = prev ? Date.parse(prev.firstSeen) : now;
    return {
      key: tree.dir,
      name: tree.name,
      repo,
      why: tree.why,
      owner: KEEP_OWNER,
      firstSeen: new Date(firstMs).toISOString(),
      deadline: new Date(firstMs + KEEP_DEADLINE_MS).toISOString(),
    };
  });
  const claimedKeys = new Set(claims.map((c) => c.key));
  const uncheckedKeys = new Set(unchecked.map((u) => u.dir));
  const preserved = mine.filter((c) => uncheckedKeys.has(c.key) && !claimedKeys.has(c.key));
  const next = [...rest, ...claims, ...preserved];
  if (JSON.stringify(loaded.claims) === JSON.stringify(next)) return { ok: true, path, claims, preserved };
  const saved = saveClaims(path, next);
  if (!saved.ok) return { ok: false, why: saved.why, path, claims: [], preserved };
  return { ok: true, path, claims, preserved };
}

/**
 * 这棵树最后一次被动是什么时候。只看树根目录的修改时间是错的：在里面改文件、提交、切分支都不动树根那一层，
 * 一棵正在用的树照样显得「搁了很久」——审查会话正在用的树就是这么被删成空壳的。
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

export function sweepWorktrees(cwd, git, now = Date.now(), home = undefined) {
  const g = (...a) => git(cwd, a);
  if (!ok(g('rev-parse', '--is-inside-work-tree'))) return [];
  const top = g('rev-parse', '--show-toplevel');
  if (!ok(top)) return [];
  const rootPath = top.stdout.trim();
  // 原来只列 `.claude/worktrees/` 一个目录，建到别处的树（代理自己挑的 `.worktrees/`、
  // `wt/`）**根本看不见**，于是攒到 60 多棵；那些树里带着各自的 biome.json，biome 整仓扫一遍报
  // 「nested root configuration」，把这台机器上**所有会话**的推送都拦了。改成问 git 本仓注册了哪些树
  // ——建在哪都算，不再靠「它应该在哪个目录」这个约定。
  const listed = g('worktree', 'list', '--porcelain');
  const record = typeof home === 'string' && home !== '';
  if (!ok(listed)) {
    if (!record) return [];
    return [`本仓的工作树没列成（${why(listed)}），认领清单没动，不当成已经没有残留。`];
  }
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
  const leftovers = [];
  const unchecked = [];
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
    const treeDir = resolve(dir);
    const touched = lastTouched(dir, g);
    if (touched === null) {
      unchecked.push({ name, dir: treeDir, why: '最后动过的时间没查成' });
      continue;
    }
    const dirty = g('-C', dir, 'status', '--porcelain');
    if (!ok(dirty)) {
      unchecked.push({ name, dir: treeDir, why: `git status 没跑成（${why(dirty)}）` });
      continue;
    }
    const unmerged = g('-C', dir, 'rev-list', 'HEAD', '--not', '--remotes');
    if (!ok(unmerged)) {
      unchecked.push({ name, dir: treeDir, why: `没列出没推的提交（${why(unmerged)}）` });
      continue;
    }
    const isDirty = dirty.stdout.trim() !== '';
    const isUnpushed = unmerged.stdout.trim() !== '';
    if (isDirty || isUnpushed) {
      // 有活就认领，不论刚动过没有。两小时只挡住下面「干净树」的删除。
      const parts = [];
      if (isDirty) parts.push('没提交的改动');
      if (isUnpushed) parts.push('没推上去的提交');
      leftovers.push({
        name,
        dir: treeDir,
        why: parts.length === 2 ? '没提交的改动，也有没推上去的提交' : parts[0],
      });
      continue;
    }
    if (now - touched < SWEEP_IDLE_MS) {
      kept.push(name); // 干净、但刚动过：可能有人正在用，先不删、也不派认领
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
  const shellHome = join(rootPath, '.claude', 'worktrees');
  let entries = [];
  try {
    entries = readdirSync(shellHome);
  } catch {
    // 没有这个目录
  }
  let cleared = 0;
  for (const name of entries) {
    const dir = join(shellHome, name);
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
  if (!record) {
    for (const t of leftovers) kept.push(t.name);
    for (const u of unchecked) kept.push(u.name);
  } else {
    const assigned = assignKept(home, resolve(rootPath), leftovers, unchecked, now);
    if (!assigned.ok) {
      lines.push(
        leftovers.length > 0
          ? `残留工作树 ${leftovers.map((t) => t.name).join('、')} 认领没记上（${assigned.why}），不当成已经有人负责，也没删。`
          : `残留工作树的认领清单没查成（${assigned.why}），不当成已经有人负责，也没改那份清单。`,
      );
    } else {
      for (const c of assigned.claims) {
        const deadline = beijingStamp(Date.parse(c.deadline));
        if (Date.parse(c.deadline) <= now) {
          lines.push(
            `残留工作树 ${c.name} 过了期限还没处理：负责人仍是${KEEP_OWNER}（${c.why}；期限 ${deadline}）。记在 ${assigned.path}。钩子不删。`,
          );
        } else {
          lines.push(
            `残留工作树 ${c.name} 有主：${KEEP_OWNER}，${deadline}前处理（${c.why}）。记在 ${assigned.path}。过了还在就接着报；钩子不删。`,
          );
        }
      }
    }
    for (const u of unchecked) {
      const claim = assigned.preserved.find((c) => c.key === u.dir);
      if (!claim) {
        lines.push(`工作树 ${u.name} 没查成（${u.why}），不当成已经有人负责，也没删。`);
        continue;
      }
      const deadline = beijingStamp(Date.parse(claim.deadline));
      const still =
        Date.parse(claim.deadline) <= now
          ? `原认领还在且过了期限：负责人仍是${KEEP_OWNER}（${claim.why}；期限 ${deadline}）`
          : `原认领还在：负责人仍是${KEEP_OWNER}，${deadline}前处理（${claim.why}）`;
      lines.push(
        `工作树 ${u.name} 没查成（${u.why}），${still}。不当成已经处理了，也没删。记在 ${assigned.path}。`,
      );
    }
  }
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

if (isMain() && process.argv[2] === '--background') {
  // 后台那半（fastSessionStart 起的脱离子进程）：输出没人看，结果全写进结果文件；整个崩了也写一笔 crashed，下次开场照实说
  const home = homedir();
  const cwd = process.argv[3] || process.cwd();
  const localGit = gitRunner(GREP_MS);
  try {
    runBackground({
      cwd,
      home,
      git: gitRunner(),
      sync: syncRunner(),
      localGit,
      env: process.env,
      // 后台不挡会话：问 GitHub 的两个脚本放宽到 BG_SCRIPT_MS（同步那半只给 8 秒是为了不拖开会话，查进度单 8 秒常超时）
      idlePr: idlePrRunner(BG_SCRIPT_MS),
      progress: progressRunner(BG_SCRIPT_MS),
      fallbackProxy: readFallbackProxy(home).proxy,
      poolHolds: () => readFrancePoolHolds({ home, env: process.env, spawn: spawnSync }),
    });
  } catch (err) {
    try {
      writeJsonAtomic(bgCachePath(home, cwd, localGit), {
        v: 1,
        at: Date.now(),
        crashed: String(err?.message ?? err).slice(0, 300),
      });
    } catch {
      // 连结果文件都写不了：下次开场读不到结果，会照实说「还没出结果」并再起一次
    }
  }
} else if (isMain()) {
  if (process.env.FLEET_HEADLESS === '1') process.exit(0);
  let lines;
  const home = homedir();
  try {
    let input = {};
    try {
      input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    } catch {
      // 输入读不懂不要紧：会话目录退回到钩子自己的工作目录
    }
    const shared = {
      cwd: pickCwd(input),
      home,
      sessionId: input?.session_id ?? process.env.CLAUDE_CODE_SESSION_ID,
      repoContract: (dir) => contractLines({ cwd: dir, git: gitRunner(GREP_MS), home }),
    };
    lines =
      process.env.FLEET_WORKER === '1'
        ? // 工人起来就要当前的远端：照老路子一口气做完（它不是每条消息都 resume）
          sessionStart({
            ...shared,
            git: gitRunner(),
            sync: syncRunner(),
            localGit: gitRunner(GREP_MS),
            poolHolds: () => readFrancePoolHolds({ home, env: process.env, spawn: spawnSync }),
          })
        : fastSessionStart({ ...shared, git: gitRunner(GREP_MS) });
  } catch (err) {
    lines = [`开场核规矩没查成：开会话钩子自己出错了（${err?.message ?? err}）；${READ_MAIN}。`];
  }
  lines.push(...writeProxyEnv({ home, envFile: process.env.CLAUDE_ENV_FILE }));
  process.stdout.write(`${render(lines)}\n`);
}
