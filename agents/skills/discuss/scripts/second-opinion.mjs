#!/usr/bin/env node
// 第二意见垫片：经本机 Mirasim 起一个全新会话（默认 codex 的 gpt-6-luna、走 Mirasim 云端额度），审一个 PR，拿回结论；
// 或者拿一份分析去问反方（--text）。只在 VPS 引擎接活之前用，引擎的第二意见接上 Mirasim 就退役（fleet-dao#64）。
// 结论和过程存在 ~/.local/share/second-opinion/runs/（本机，不进任何仓：里面有 PR 内容；也不放技能目录，同步会把它换掉）。
// 帧协议照 fleet-dao docs/reference/adapters.md 第八节。完工判据借旧仓 windsurf-dao 的 scripts/lib/mirasim-runtime.mjs
// judgeCompletion：phase 到 done 且没有 error、没有 incomplete；走中继的还要账本里起针后有 2xx 行。
//
//   node second-opinion.mjs --pr 50 --high-risk --author-family <族[,族…]> [--repo <检出>] [--ui] [--timeout-min 45] [--slot 2]
//     已经合进主线的 PR 也能审（合并后补审）：认出是已合并的，评论、状态都写「合并后补审」，没过写明开修复 PR 或 git revert。
//   node second-opinion.mjs --after-merge-pending [--json] [--no-fetch] [--repo <检出>]
//     列合并后待补审的：主线上 14 天内合并、改到了清单里标 review: after-merge 的路径、PR 头上还没有通过的 second-opinion。
//   node second-opinion.mjs --after-merge-sweep --author-family <族[,族…]> [--repo <检出>]：把上面还没补审的逐个审一遍。
//   node second-opinion.mjs --after-merge-resolve <原 PR 号> --by <修复或 revert 的 PR 号>：补审没过、修复已合，记成已处理。
//   node second-opinion.mjs --text 分析.md --author-family <族[,族…]> [--name 短名] [--budget-sec 30]
//     拍板前的反方：按 GPT→Claude→DeepSeek→Grok→Kimi 选不同族，退出码 0 同意 / 1 有异议 / 2 没查成
//   node second-opinion.mjs --selftest [--repo <检出>]
//   --repo 不给就用当前目录所在的 git 检出。
//
// 挡不挡由本脚本判，不信审的人最后那句「结论」（创始人 2026-10-03 晚「1+2+3」的第 2 条，规矩钉在
// agents/test/rules/second-opinion-verdict.rules.test.ts）：每条必须改带【现实】/【构造】和【碰安全】/【改数据库】/【其他】；
// 【构造】的不挡；第 1、2 轮【现实】的都挡（没带标签的按【现实】【其他】算）；第 3 轮起只挡【现实】且碰安全或改数据库的，
// 其余写通过、评论里列「转合并后处理」。第几轮 = 这个 PR 上本脚本已经贴过的结论评论数 + 1（不管头变没变）；读不到按第 1 轮算。
//
// 退出码：0 通过；1 必须改；2 没查成；3 PR 审查没开（不带 --high-risk）。连不上、没起来、超时、结果格式认不出（没有「必须改」
// 那一段、最后一行不是结论）、账本对不上、有调用没走中继，一律 2，不当通过。端点没装、没开、未登录、roster 不含模型或超时都
// 换下一家；几家都用不了照实报。

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cursorAgentEnv, cursorAgentProblem, dataDir, findBin, NotInstalled } from './tools.mjs';
import { missingWalkthrough } from './walkthrough.mjs';

// ask.mjs 也要用（两边起 cursor-agent 都要摘同几个环境变量）：定义挪去了 tools.mjs 共用，这里转手导出，
// 别让已经 import { cursorAgentEnv } from './second-opinion.mjs' 的调用方（包括测试）断掉。
export { cursorAgentEnv } from './tools.mjs';

const DATA = dataDir();
const RUNS = join(DATA, 'runs');
const MIRA = join(homedir(), '.mirasim');
// 讨论/第二意见共同的厂商族顺序。作者族由调用方显式传入；不能从环境变量或当前进程名猜。
export const FAMILY_ORDER = ['gpt', 'claude', 'deepseek', 'grok', 'kimi'];
const PROFILES = {
  // Mirasim 2026-09-30 的真实 modelRosterCache：codex/gpt-6-luna。
  code: { family: 'gpt', agent: 'codex', model: 'gpt-6-luna', route: 'cloud' },
  // Claude 必须经 reclaude；不要直接起 claude。model 留空，由 reclaude 的 JSON 输出报告实际模型。
  claude: { family: 'claude', agent: 'reclaude', model: null, route: 'local' },
  // Mirasim modelRosterCache：dsh/deepseek-flash。若这台 Mirasim 没有 dsh，照实换下一家。
  deepseek: { family: 'deepseek', agent: 'dsh', model: 'deepseek-flash', route: 'cloud' },
  // Mirasim 的 grok 执行体不点名模型；本机未登录时会明确报不可用。
  grok: { family: 'grok', agent: 'grok', model: null, route: 'cloud' },
  // Mirasim modelRosterCache：kimi/kimi-code/k3。
  kimi: { family: 'kimi', agent: 'kimi', model: 'kimi-code/k3', route: 'cloud' },
  // 旧显式参数保留兼容，但不进入新的族顺序；它们仍带 family，不能绕过同族排除。
  code5: { family: 'gpt', agent: 'codex', model: 'gpt-5.6-luna', route: 'cloud' },
  cursor: { family: 'gpt', agent: 'cursor-cli', model: 'gpt-5.6-luna-high', route: 'local' },
  glm: { family: 'glm', agent: 'cursor-cli', model: 'glm-5.2-high', route: 'local' },
  kimi3: { family: 'kimi', agent: 'cursor-cli', model: 'kimi-k3-high', route: 'local' },
  'grok-cli': { family: 'grok', agent: 'cursor-cli', model: 'grok-4.7-medium', route: 'local' },
  ui: { family: 'gemini', agent: 'antigravity', model: 'gemini-3.8-flash-high', route: null },
};
const PROFILE_BY_FAMILY = {
  gpt: PROFILES.code,
  claude: PROFILES.claude,
  deepseek: PROFILES.deepseek,
  grok: PROFILES.grok,
  kimi: PROFILES.kimi,
};
const DONE = new Set(['done', 'complete', 'completed']);
const FAILED = new Set(['error', 'failed', 'aborted', 'cancelled', 'canceled']);

class NotChecked extends Error {}

// 主审连不上就换下一家（创始人 2026-09-25：一个渠道不生效，讨论和审查的主体就换）。
// 族顺序由 FAMILY_ORDER + PROFILE_BY_FAMILY 唯一决定；审出结论后不因不喜欢结论换人。
// 「模型满载」也算连不上（2026-09-26：codex 快照报 done 带 incomplete「Selected model is at capacity」，没换人直接判没查成）。
export const UNAVAILABLE =
  /\b(502|503|529)\b|no upstream available|Service Unavailable|overloaded|at capacity|try a different model/i;
function pickProfile(name) {
  const p = PROFILES[name];
  if (!p)
    throw new NotChecked(
      `不认识的 --agent ${name}（code / claude / deepseek / grok / kimi / code5 / cursor / kimi3 / ui）`,
    );
  return p;
}

function splitFamilies(raw, label = '--author-family') {
  const values = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/))
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0)
    throw new NotChecked(
      `要 ${label} <gpt|claude|deepseek|grok|kimi>：讨论/第二意见不能确认作者模型族（可逗号分隔），不会从环境变量猜`,
    );
  const unknown = values.filter((family) => !FAMILY_ORDER.includes(family));
  if (unknown.length)
    throw new NotChecked(`不认识的作者模型族：${unknown.join('、')}（可用：${FAMILY_ORDER.join('、')}）`);
  return new Set(values);
}

/**
 * 为讨论和第二意见生成候选链。作者族可传多个；显式执行体也必须经过同族排除。
 * UI 仍固定走 Gemini，且不借此绕过作者族校验。
 */
export function discussionProfiles(o = {}) {
  if (o.authorFamily && o.excludeFamily)
    throw new NotChecked('--author-family 和 --exclude-family 只能选一个');
  const excluded = splitFamilies(o.authorFamily ?? o.excludeFamily);
  if (o.agent) {
    const profile = pickProfile(o.agent);
    if (excluded.has(profile.family))
      throw new NotChecked(`不能选与作者同一模型族的执行体：${profile.family}（${o.agent}）`);
    return [profile];
  }
  if (o.ui) {
    if (excluded.has(PROFILES.ui.family))
      throw new NotChecked(`不能选与作者同一模型族的执行体：${PROFILES.ui.family}（ui）`);
    return [PROFILES.ui]; // 界面类只给 Gemini，不拿别家顶
  }
  const candidates = FAMILY_ORDER.filter((family) => !excluded.has(family)).map(
    (family) => PROFILE_BY_FAMILY[family],
  );
  if (candidates.length === 0) throw new NotChecked('作者模型族覆盖全部候选，没有可用的不同模型族');
  return candidates;
}

function prProfiles(o) {
  return discussionProfiles(o);
}
async function withFallback(chain, log, run, { budgetMs } = {}) {
  const misses = [];
  const deadline = Number.isFinite(budgetMs) ? Date.now() + budgetMs : null;
  for (const p of chain) {
    const who = `${p.agent}/${p.model ?? '服务端默认'}`;
    const remainingMs = deadline === null ? undefined : deadline - Date.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      misses.push(`${who}：讨论总预算已用完`);
      break;
    }
    try {
      const r = await run(p, remainingMs);
      if (misses.length) r.fallbackNote = `主审连不上换了人：${misses.join('；')}`;
      return { ...r, profile: p };
    } catch (e) {
      // 候选端点没装、没开、没登录、模型不在 roster、或本轮超时，都换下一家并照实记下。
      // 结论解析发生在 withFallback 之后，所以「不喜欢结论」不会触发换家。
      if (e instanceof NotInstalled) {
        misses.push(`${who}：${e.message}`);
        log(`${who} 用不了（${e.message}），换下一家`);
        continue;
      }
      if (e instanceof NotChecked) {
        misses.push(`${who}：${e.message}`);
        log(`${who} 没查成（${e.message.slice(0, 160)}），换下一家`);
        continue;
      }
      throw e;
    }
  }
  throw new NotChecked(`候选的几家全没成：${misses.join('；')}`);
}

// ---------- 纯函数（--selftest 覆盖） ----------

/** 最后一行结论（审的人自己说的；挡不挡不看它，见 parseReview / judgeReview）。认不出 = null。 */
export function parseVerdict(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/[*`_]/g, '').trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? '';
  const m = /^结论\s*[：:]\s*(通过|必须改\s*(\d+)\s*条)\s*$/.exec(last);
  if (!m) return null;
  if (m[1] === '通过') return { pass: true, blocking: 0 };
  const n = Number(m[2]);
  return n > 0 ? { pass: false, blocking: n } : null;
}

/** 快照 → 判断。只有 done 才往下核账本。 */
export function judgeSnapshot(view) {
  if (!view || typeof view.phase !== 'string' || !view.phase)
    return { status: 'unknown', why: '快照里没有 phase' };
  const phase = view.phase.toLowerCase();
  if (FAILED.has(phase))
    return { status: 'failed', why: `快照报 ${phase}${view.error ? `：${view.error}` : ''}` };
  if (!DONE.has(phase)) return { status: 'running', why: phase };
  if (view.incomplete === true)
    return {
      status: 'failed',
      why: `快照报 ${phase} 但带着 incomplete${view.error ? `：${view.error}` : ''}`,
    };
  if (view.error) return { status: 'failed', why: `快照报 ${phase}，但带着死因：${view.error}` };
  return { status: 'done', why: phase };
}

/** 账本行 → 起针后有没有成功调用、有没有没走中继的调用。 */
export function judgeLedger(rows, since, mustRelay) {
  const fresh = rows.filter(
    (r) => Number.isFinite(Date.parse(r?.ts ?? '')) && Date.parse(r.ts) >= since - 1000,
  );
  const served = fresh.filter((r) => Number(r.status) >= 200 && Number(r.status) < 300);
  const offRelay = mustRelay ? fresh.filter((r) => r.viaRelay !== true) : [];
  if (offRelay.length > 0) {
    const hosts = [...new Set(offRelay.map((r) => String(r.upstreamHost ?? '?')))].join('、');
    return {
      ok: false,
      why: `有 ${offRelay.length} 次调用没走中继（上游 ${hosts}），可能走了按量计费的路——停用这个垫片，先查清`,
    };
  }
  if (served.length === 0)
    return {
      ok: false,
      why: `账本里没有起针后的成功调用（共 ${rows.length} 行，起针后 ${fresh.length} 行）`,
    };
  const hosts = [...new Set(served.map((r) => String(r.upstreamHost ?? '?')))].join('、');
  return {
    ok: true,
    why: `起针后 ${served.length} 次成功调用（上游 ${hosts}）${mustRelay ? '，全走中继' : ''}`,
  };
}

// ---------- 挡不挡：审的人交回的正文 → 判定（创始人 2026-10-03 晚「1+2+3」的第 2 条） ----------
//
// 起因：#701 一个 PR 审了 10 次，最后一个头第一次判「必须改」、第二次判「通过」；每一轮都能想出一种更偏的「理论上能绕过」的
// 写法。规矩写着「最多 2 轮」，脚本却不管：#617 做过按头数数轮，20 分钟后被 #609 带着旧文件整段盖掉了，没人发现。
// 现在：审的人只管现实里会出的事——每条必须改自己标【现实】/【构造】和类别；挡不挡由这里按标签和轮数判，不信它最后那句结论。
// 改这一段的判法就是改规矩：agents/test/rules/second-opinion-verdict.rules.test.ts 钉着它，改那个文件要创始人同意。

/** 第 1、2 轮【现实】的必须改都挡；从第 3 轮起只挡【现实】且碰安全或改数据库的，其余写通过、评论里列「转合并后处理」。 */
export const STRICT_ROUNDS = 2;
/** 第 3 轮起照样挡的类别：泄露了、删了数据就回不来，不能「先合了再说」。 */
export const ALWAYS_BLOCK = ['碰安全', '改数据库'];

/** 【…】或 […] 里的标签（一对括号里可以并写几个：【现实·碰安全】）。 */
const LABEL = /[【[]\s*([^】\]\n]{1,30}?)\s*[】\]]/g;

/** 一段话里的标签：现实性（现实 / 构造）和类别（碰安全 / 改数据库 / 其他）。两样都标了取更严的（现实、碰安全优先）；没标是 null。 */
export function labelsOf(text) {
  const reality = new Set();
  const category = new Set();
  for (const m of String(text ?? '').matchAll(LABEL)) {
    for (const word of m[1].split(/[\s·・、,，|/／+＋&＆<>＜＞]+/)) {
      if (word === '现实') reality.add('现实');
      else if (word === '构造') reality.add('构造');
      else if (word === '碰安全' || word === '安全') category.add('碰安全');
      else if (word === '改数据库' || word === '数据库') category.add('改数据库');
      else if (word === '其他' || word === '其它') category.add('其他');
    }
  }
  return {
    reality: reality.has('现实') ? '现实' : reality.has('构造') ? '构造' : null,
    category: ['碰安全', '改数据库', '其他'].find((c) => category.has(c)) ?? null,
  };
}

/** 去掉 Markdown 的强调和代码记号，只看字。 */
const plain = (s) =>
  String(s)
    .replace(/[*_`~]/g, '')
    .trim();
/** 列表的一条：- * + • 或 1. 1) 1、 开头。 */
const BULLET = /^(\s*)(?:[-*+•]|\d{1,3}[.)、．])\s+(.*)$/;
/** 「没有」的几种写法：无、（无）、暂无、没有、无。 */
const NONE = /^[（(]?(?:无|没有|暂无|none|n\/a)[)）]?[。.！!]?$/i;

/**
 * 一段（「必须改」或「小毛病」标题下面那几行）→ 一条一条的正文。按列表符号分条：缩进不比第一条深的列表符号起新的一条，
 * 更深的、没有列表符号的行接在上一条后面；第一条之前的几行以冒号结尾的算引子（「有两条：」），别的单算一条（宁可多算，不漏）。
 * 整段没有列表符号就按空行分段。只写了「无」的条不算。
 */
export function itemsOf(lines) {
  const rows = lines.map((l) => String(l).replace(/\t/g, '    ').replace(/\s+$/, ''));
  const items = [];
  const first = rows.findIndex((l) => BULLET.test(l));
  if (first < 0) {
    let cur = [];
    for (const l of [...rows, '']) {
      if (l.trim()) cur.push(l.trim());
      else if (cur.length > 0) {
        items.push(cur.join('\n'));
        cur = [];
      }
    }
  } else {
    const lead = rows
      .slice(0, first)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lead.length > 0 && !/[：:]$/.test(lead.at(-1))) items.push(lead.join('\n'));
    const top = BULLET.exec(rows[first])[1].length;
    for (const l of rows.slice(first)) {
      const m = BULLET.exec(l);
      if (m && m[1].length <= top) items.push(m[2].trim());
      else if (l.trim() && items.length > 0) items[items.length - 1] += `\n${l.trim()}`;
    }
  }
  return items.filter((t) => !NONE.test(plain(t.replace(/\n/g, ' '))));
}

/** 一条必须改的标签：先看第一行，第一行没写的那一样再从整条里找。 */
function itemLabels(text) {
  const head = labelsOf(String(text).split('\n')[0]);
  const all = labelsOf(text);
  return { reality: head.reality ?? all.reality, category: head.category ?? all.category };
}

/**
 * 审的人交回的正文 → { ok: true, mustFix, minor, claimed, body } 或 { ok: false, why }。
 * 认不出（判没查成、不写通过）的只有：没有「必须改」这一段；最后一行不是结论（多半没写完）；结论说必须改、那一段却一条也读不出。
 * 结论行只当「写完了」的记号和对照：挡不挡看 judgeReview，不看它。
 */
export function parseReview(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const title = (l) => /^#{1,6}\s+(.*?)\s*$/.exec(plain(l))?.[1] ?? null;
  const isEnd = (l) => title(l) !== null || /^结论\s*[：:]/.test(plain(l));
  // 取最后一个「必须改」标题：前面要是把题面里的输出格式抄了一遍，真正的答案在后面
  const lastTitled = (name) => lines.findLastIndex((l) => title(l)?.startsWith(name) === true);
  const sectionAt = (at) => {
    let end = at + 1;
    while (end < lines.length && !isEnd(lines[end])) end++;
    return lines.slice(at + 1, end);
  };
  const at = lastTitled('必须改');
  if (at < 0) return { ok: false, why: '没有「## 必须改」这一段（格式认不出）' };
  const claimed = parseVerdict(text);
  if (!claimed)
    return { ok: false, why: '最后一行不是「结论：通过」或「结论：必须改 N 条」（多半没写完，格式认不出）' };
  const mustFix = itemsOf(sectionAt(at)).map((t) => ({ text: t, ...itemLabels(t) }));
  if (mustFix.length === 0 && !claimed.pass)
    return {
      ok: false,
      why: `审的人结论写「必须改 ${claimed.blocking} 条」，「必须改」那一段却一条也读不出（格式认不出）`,
    };
  const minorAt = lastTitled('小毛病');
  return {
    ok: true,
    mustFix,
    minor: minorAt < 0 ? [] : itemsOf(sectionAt(minorAt)),
    claimed,
    body: lines.slice(at).join('\n').trim(),
  };
}

/**
 * 判定：【构造】的不挡（挪进小毛病）；第 1、2 轮其余的都挡；第 3 轮起只挡碰安全、改数据库的，其余转合并后处理。
 * 没带标签的按【现实】【其他】算（第 1、2 轮照挡，保守）。round 认不出按第 1 轮。
 */
export function judgeReview(parsed, round) {
  const r = Number.isInteger(round) && round >= 1 ? round : 1;
  const blocking = [];
  const deferred = [];
  const constructed = [];
  for (const f of parsed.mustFix) {
    const item = {
      text: f.text,
      reality: f.reality ?? '现实',
      category: f.category ?? '其他',
      unlabeled: f.reality == null || f.category == null,
    };
    if (item.reality === '构造') constructed.push(item);
    else if (r <= STRICT_ROUNDS || ALWAYS_BLOCK.includes(item.category)) blocking.push(item);
    else deferred.push(item);
  }
  return {
    pass: blocking.length === 0,
    round: r,
    blocking,
    deferred,
    constructed,
    minor: parsed.minor ?? [],
    claimed: parsed.claimed,
  };
}

/** 本脚本贴到 PR 上的结论评论的第一行：第二意见、合并后补审都算一轮「审完、出了结论」（老格式「经 Mirasim」的也认）。 */
export const POSTED_REVIEW =
  /^\*\*(?:第二意见|合并后补审) 第 \d+ 轮\*\*（[^）\n]*审的头 [0-9a-f]{7,40}）：(?:通过|必须改 \d+ 条)/;

/** PR 上的评论正文 → 之前审完、出了结论几轮（不管头变没变）。 */
export function priorRounds(bodies) {
  return bodies.filter((b) => POSTED_REVIEW.test(String(b ?? '').trimStart())).length;
}

/** GitHub 提交状态 description 的上限（140 个字符）。 */
const DESCRIPTION_MAX = 140;
function clip(s, max = DESCRIPTION_MAX) {
  const chars = [...String(s)];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : String(s);
}
const tagOf = (f) => `【${f.reality}】【${f.category}】`;
/** 「【现实】【碰安全】1、【现实】【其他】2」 */
function tally(items) {
  const n = new Map();
  for (const f of items) n.set(tagOf(f), (n.get(tagOf(f)) ?? 0) + 1);
  return [...n].map(([k, v]) => `${k}${v}`).join('、');
}
const firstLine = (t) => {
  const s = plain(String(t).split('\n')[0]);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};

/** 写到 PR 头上的提交状态（合并闸认 success；description 写清是哪几条挡、为什么）。 */
export function statusText(j, afterMerge = false) {
  const who = afterMerge ? '合并后补审' : '第二意见';
  if (j.pass) {
    const extra = [
      j.deferred.length > 0 ? `${j.deferred.length} 条转合并后处理` : '',
      j.constructed.length > 0 ? `${j.constructed.length} 条构造的不挡` : '',
    ]
      .filter(Boolean)
      .join('，');
    return {
      state: 'success',
      description: clip(`${who}通过（第 ${j.round} 轮${extra ? `；${extra}` : ''}）`),
    };
  }
  return {
    state: 'failure',
    description: clip(
      `${who}${afterMerge ? '没过' : ''}第 ${j.round} 轮：必须改 ${j.blocking.length} 条${afterMerge ? '，开修复 PR 或 revert' : ''}（${tally(j.blocking)}）`,
    ),
  };
}

/** 评论和记录里的「脚本判定」那几行：哪几条挡、哪几条转合并后、哪几条算构造的，和审的人自己的结论对不上就写出来。 */
export function judgementLines(j, { afterMerge = false, mergeCommit = null, roundNote = '' } = {}) {
  const rule =
    j.round <= STRICT_ROUNDS
      ? `第 ${j.round} 轮，【现实】的必须改都挡（没带标签的按【现实】【其他】算），【构造】的不挡`
      : `第 ${j.round} 轮（前面已经审完过 ${j.round - 1} 轮），只挡【现实】且碰安全或改数据库的，其余转合并后处理，【构造】的不挡`;
  const list = (items) =>
    items.map((f) => `  - ${f.unlabeled ? `（没带全标签，按${tagOf(f)}算）` : ''}${firstLine(f.text)}`);
  const out = [`脚本判定（不看审的人最后那句结论）：${rule}。`];
  if (j.blocking.length > 0) out.push(`- 挡合并 ${j.blocking.length} 条：`, ...list(j.blocking));
  if (j.deferred.length > 0)
    out.push(
      `- 转合并后处理 ${j.deferred.length} 条（不挡这次合并；合并后开小单或修复 PR）：`,
      ...list(j.deferred),
    );
  if (j.constructed.length > 0)
    out.push(
      `- 构造出来的 ${j.constructed.length} 条算小毛病（要人故意写出特殊写法才出现，不挡）：`,
      ...list(j.constructed),
    );
  if (j.pass && j.blocking.length === 0 && j.deferred.length === 0 && j.constructed.length === 0)
    out.push('- 必须改：无。');
  if (j.claimed?.pass && !j.pass)
    out.push(`- 审的人结论写「通过」，但「必须改」里有 ${j.blocking.length} 条要挡的：照样挡。`);
  if (j.claimed && !j.claimed.pass && j.pass)
    out.push(`- 审的人结论写「必须改 ${j.claimed.blocking} 条」，按上面的规矩一条都不挡：通过。`);
  if (roundNote) out.push(`- 轮数：${roundNote}。`);
  if (afterMerge && !j.pass)
    out.push(
      '',
      `**合并后补审没过**：开修复 PR，或 \`git revert ${mergeCommit ? String(mergeCommit).slice(0, 7) : '<合并提交>'}\`；修复合了跑 \`second-opinion.mjs --after-merge-resolve <这个 PR 号> --by <修复 PR 号>\` 记成已处理。`,
    );
  return out;
}

function viewOf(msg) {
  const full =
    msg?.type === 'snapshot' ? msg.snapshot : msg?.type === 'session' ? msg.patch?.full : undefined;
  if (!full || typeof full !== 'object') return null;
  const phase =
    typeof full.phase === 'string' && full.phase
      ? full.phase
      : typeof full.runState === 'string'
        ? full.runState
        : null;
  let error = null;
  if (typeof full.error === 'string' && full.error) error = full.error;
  else if (full.error && typeof full.error.message === 'string') error = full.error.message;
  return {
    phase,
    text: typeof full.text === 'string' ? full.text : '',
    toolCalls: Array.isArray(full.toolCalls) ? full.toolCalls.length : 0,
    error,
    incomplete: full.incomplete === true,
    model: typeof full.model === 'string' ? full.model : null,
    interactions: Array.isArray(full.interactions) ? full.interactions : [],
    updatedAt: full.updatedAt ?? null,
  };
}

// ---------- 连 Mirasim ----------

class Wire {
  constructor(url) {
    this.queue = [];
    this.waiters = [];
    this.closed = null;
    this.ws = new WebSocket(url);
    this.opened = new Promise((ok, bad) => {
      this.ws.onopen = () => ok();
      this.ws.onerror = () => bad(new NotChecked('连不上本机 Mirasim 的 ws'));
    });
    this.ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0].ok(m);
      else this.queue.push(m);
    };
    this.ws.onclose = () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w.ok(null);
    };
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
  /** 等一帧；超时或连接断了回 null（调用方判没查成）。 */
  waitFor(pred, ms) {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    if (this.closed) return Promise.resolve(null);
    return new Promise((ok) => {
      const w = {
        pred,
        ok: (m) => {
          clearTimeout(t);
          ok(m);
        },
      };
      const t = setTimeout(() => {
        const at = this.waiters.indexOf(w);
        if (at >= 0) this.waiters.splice(at, 1);
        ok(null);
      }, ms);
      this.waiters.push(w);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

/** 找在役的那个口：令牌文件按新到旧试，握手拿到 state 帧的才算。没装、没开、一个口都握不上手，都算这台用不了 Mirasim */
async function connect() {
  if (!existsSync(MIRA)) throw new NotInstalled(`这台机器没装 Mirasim（没有 ${MIRA}）`);
  const dir = join(MIRA, 'run');
  let files;
  try {
    files = readdirSync(dir).filter((f) => /^local-\d+\.token$/.test(f));
  } catch (e) {
    throw new NotInstalled(`本机 Mirasim 没开（读不到 ${dir}：${e.code ?? e.message}）`);
  }
  if (files.length === 0) throw new NotInstalled(`本机 Mirasim 没开（${dir} 里没有令牌文件）`);
  files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
  const tried = [];
  for (const f of files) {
    const port = /(\d+)/.exec(f)[1];
    const token = readFileSync(join(dir, f), 'utf8').trim();
    const url = `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`;
    const wire = new Wire(url);
    try {
      await wire.opened;
    } catch {
      tried.push(`${port} 连不上`);
      continue;
    }
    wire.send({ type: 'clientHello' });
    wire.send({ type: 'getState' });
    const st = await wire.waitFor((m) => m.type === 'state', 30_000);
    if (!st) {
      tried.push(`${port} 没回 state 帧`);
      wire.close();
      continue;
    }
    return { url, wire, state: st.state ?? {} };
  }
  throw new NotInstalled(`本机 Mirasim 一个口都没握手成（${tried.join('；')}），多半没开`);
}

async function readView(url, sessionKey) {
  const wire = new Wire(url);
  try {
    await wire.opened;
    wire.send({ type: 'clientHello' });
    wire.send({ type: 'subscribe', sessionKey });
    const msg = await wire.waitFor(
      (m) =>
        (m.type === 'snapshot' || m.type === 'session') &&
        (typeof m.sessionKey !== 'string' || !m.sessionKey || m.sessionKey === sessionKey),
      30_000,
    );
    return msg ? viewOf(msg) : null;
  } catch {
    return null;
  } finally {
    wire.close();
  }
}

async function relayUsage(url) {
  const wire = new Wire(url);
  try {
    await wire.opened;
    wire.send({ type: 'clientHello' });
    wire.send({ type: 'getRelay' });
    const m = await wire.waitFor((x) => x.type === 'relay' && Array.isArray(x.relay?.usage?.windows), 15_000);
    const w7 = m?.relay?.usage?.windows?.find((w) => w.label === '7d');
    return w7 && Number.isFinite(w7.usedPercent) ? w7.usedPercent : null;
  } catch {
    return null;
  } finally {
    wire.close();
  }
}

function readLedger(uuid) {
  const dir = join(MIRA, 'traffic', uuid);
  let files;
  try {
    files = readdirSync(dir).filter((f) => /^index-.*\.ndjson$/.test(f));
  } catch (e) {
    return { readable: false, why: `读不到账本目录（${e.code ?? e.message}）` };
  }
  const rows = [];
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        return { readable: false, why: `账本 ${f} 有一行不是 JSON` };
      }
    }
  }
  return { readable: true, rows };
}

// ---------- PR ----------

function sh(cmd, args, cwd, env = process.env) {
  return execFileSync(cmd, args, {
    cwd,
    env,
    windowsHide: true,
    encoding: 'utf8',
    // 默认 1 MB：14 天的 git log --name-status、翻了几页的评论会超
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function preparePr(repo, pr, slot) {
  for (const [bin, forWhat] of [
    ['gh', '取 PR 的信息、贴结论'],
    ['git', '取 PR 的头、切审查树'],
  ]) {
    if (!findBin(bin)) throw new NotChecked(`这台机器没装 ${bin}（PATH 上找不到；审 PR 要它${forWhat}）`);
  }
  const info = JSON.parse(
    gh(
      ['pr', 'view', String(pr), '--json', 'headRefOid,baseRefName,title,body,files,state,mergeCommit'],
      repo,
    ),
  );
  if (info.state === 'CLOSED') throw new NotChecked(`PR #${pr} 关掉了、没合并：不审`);
  // 已经合进主线的照样审（合并后补审）：refs/pull/<号>/head 还在，三个点的 diff 照样只给它自己的改动
  const merged = info.state === 'MERGED';
  const mergeCommit = typeof info.mergeCommit?.oid === 'string' ? info.mergeCommit.oid : null;
  if (merged && !mergeCommit) throw new NotChecked(`PR #${pr} 说已合并，却读不到合并提交`);
  const refs = [
    'fetch',
    '-q',
    'origin',
    info.baseRefName,
    `+refs/pull/${pr}/head:refs/remotes/origin/pr/${pr}`,
  ];
  // 本机代理对 github.com 的 TLS 时好时坏（2026-09-25 实测直连通、代理不通）：先照常取，不行再绕开代理直连。
  const { https_proxy, http_proxy, HTTPS_PROXY, HTTP_PROXY, ...direct } = process.env;
  const tries = [
    () => sh('git', refs, repo),
    () => sh('git', ['-c', 'http.proxy=', '-c', 'https.proxy=', ...refs], repo, direct),
  ];
  const errors = [];
  for (const t of tries) {
    try {
      t();
      errors.length = 0;
      break;
    } catch (e) {
      errors.push(String(e.stderr ?? e.message).trim());
    }
  }
  if (errors.length) throw new NotChecked(`git fetch 没成：${errors.join('；')}`);
  const got = sh('git', ['rev-parse', `refs/remotes/origin/pr/${pr}`], repo);
  if (got !== info.headRefOid)
    throw new NotChecked(`取回的头 ${got.slice(0, 7)} 和 PR 现在的头 ${info.headRefOid.slice(0, 7)} 对不上`);
  // 固定一棵树轮着用：Mirasim 把 codex 进程按工作目录留在池里，那个目录删不掉（Windows 报占用）。
  // 每轮切到这次的头、清掉上一轮的改动；node_modules 留着，下一轮装得快。
  const tree = join(repo, '.claude', 'worktrees', slot === 1 ? 'second-opinion' : `second-opinion-${slot}`);
  if (!existsSync(tree)) sh('git', ['worktree', 'add', '-q', '--detach', tree, got], repo);
  else {
    sh('git', ['-C', tree, 'checkout', '-q', '--force', '--detach', got], repo);
    sh('git', ['-C', tree, 'clean', '-q', '-fdx', '-e', 'node_modules'], repo);
  }
  const at = sh('git', ['-C', tree, 'rev-parse', 'HEAD'], repo);
  if (at !== got) throw new NotChecked(`审查树停在 ${at.slice(0, 7)}，不是要审的 ${got.slice(0, 7)}`);
  return { ...info, head: got, tree, merged, mergeCommit };
}

/** 给审的人的题面。挡不挡由脚本按标签判（parseReview / judgeReview），所以每条必须改的两个标签是题面里的硬要求。 */
export function reviewPrompt(pr, info, ui, fast) {
  const files = (info.files ?? []).map((f) => f.path);
  return [
    `你是 PR #${pr} 的「第二意见」：一个全新会话，独立判断。写这段改动的是另一家模型，你的用处是找出它自己看不出的问题。`,
    '',
    `工作目录就是这个 PR 的头（${info.head}），基线是 origin/${info.baseRefName}。改动：\`git diff origin/${info.baseRefName}...HEAD\`（共 ${files.length} 个文件）。`,
    ...(info.merged
      ? [
          `这个 PR 已经合进主线（合并提交 ${String(info.mergeCommit).slice(0, 7)}），这是合并后补审：标准和合并前一样；三个点的 diff 照样只给它自己的改动。`,
        ]
      : []),
    `PR 标题：${info.title}`,
    'PR 正文（要做什么、怎么算做完、对应的 specs 都在这里）：',
    '<<<',
    info.body ?? '',
    '>>>',
    '',
    '要做的：',
    '1. 读仓根 AGENTS.md（「底线」几条是硬规矩），读正文里提到的 specs/ 需求和方案。',
    fast
      ? '2. 只看改动（git diff），必要时读改动附近的代码；不装依赖、不跑测试（CI 在同时跑）。要快：全文 600 字以内，只报最要紧的。'
      : '2. 看改动，需要时读相关代码；要跑测试先 `pnpm install --frozen-lockfile`，跑不了就照实说跑不了。',
    ui
      ? '3. 这是界面类改动：重点看界面在各种数据和失败状态下显示得对不对、说法是不是说人话、手机宽度下能不能用。'
      : '3. 只报真问题：会导致错误行为的、失败路径被当成「没事」的（读不到却回空、0、ok）、和需求或方案不符的、泄露密钥或内部信息到公开处的、测试没测到它声称测到的。风格偏好不报。',
    '4. 只管现实里会出的事。每条「必须改」开头必须写两个标签：',
    '   - 现实性：【现实】＝这次改动在正常使用里就会出问题，或者现在就有问题；【构造】＝要有人故意写出某种特殊写法才会出现的绕过、偏门情况。',
    '   - 类别：【碰安全】＝泄密、提权、放过失败、绕过检查、对公网开口子；【改数据库】＝删改已有数据或表结构；【其他】＝别的。',
    '   不要为「要人故意构造才出现」的情况报必须改：这类写进「小毛病」。',
    '',
    '规矩：不改文件、不提交、不推、不在 GitHub 上留言；不打印任何密钥、令牌的值。就在这一个会话里审完，不拆子代理、不做委派预检（省额度，结论也不会散在几处）。',
    '',
    '输出（简体中文）：',
    '## 必须改',
    '- 【现实】【碰安全】`文件:行` 问题；具体什么输入会得到什么错误结果；建议怎么改',
    '（这两个标签只是示例，按每条的实际情况写：第一个是【现实】或【构造】，第二个是【碰安全】【改数据库】【其他】之一；没有必须改就写「无」）',
    '## 小毛病',
    '- `文件:行` 问题；建议怎么改（不挡合并；没有就写「无」）',
    '',
    '最后一行单独写结论，只能是下面两种之一：',
    '结论：通过',
    '结论：必须改 N 条',
  ].join('\n');
}

// ---------- 反方（拍板前的分析） ----------

/** 反方的结论行。认不出 = null。 */
export function parseCritique(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/[*`_]/g, '').trim())
    .filter(Boolean);
  const m = /^结论\s*[：:]\s*(同意|有异议\s*(\d+)\s*条)\s*$/.exec(lines.at(-1) ?? '');
  if (!m) return null;
  if (m[1] === '同意') return { agree: true, objections: 0 };
  const n = Number(m[2]);
  return n > 0 ? { agree: false, objections: n } : null;
}

function blindPrompt(question) {
  return [
    '下面是一道设计题。独立给出你的方案：不知道别人怎么想，也不要迎合谁。',
    '要快、要短：全文 400 字以内，不读文件、不跑命令、不拆子代理。',
    '',
    '<<<',
    question,
    '>>>',
    '',
    '输出（简体中文，说人话）：',
    '## 方案（几条要点）',
    '## 关键取舍（你放弃了什么、为什么）',
    '## 最容易出事的地方',
  ].join('\n');
}

function critiquePrompt(material) {
  return [
    '你是「反方」：一个全新会话，另一家模型。下面是另一个 AI（总指挥）准备交给创始人拍板的分析和选项。',
    '你的用处是找出它自己看不出的东西——框架错在哪、漏了哪种情况、代价估错在哪、有没有更根本的问题它没碰到。',
    '不要重新设计整个系统，只针对这份分析说话；同意的地方一句带过，不凑异议。',
    '要快、要短：全文 400 字以内，只写最要紧的几条（最多 5 条），每条一两句。',
    '',
    '<<<',
    material,
    '>>>',
    '',
    '规矩：就在这一个会话里答完，不读文件、不跑命令、不拆子代理；不打印任何密钥、令牌的值。',
    '',
    '输出（简体中文，说人话）：',
    '## 框架对不对',
    '（它把问题看成什么；你认为该看成什么。一致就写「一致」）',
    '## 漏掉的',
    '- 每条：漏了什么；什么情况下会出事；建议怎么补',
    '（没有就写「无」）',
    '## 选项怎么改',
    '（给创始人的选项该加、该删、该改哪条；推荐哪个、为什么）',
    '',
    '最后一行单独写结论，只能是下面两种之一：',
    '结论：同意',
    '结论：有异议 N 条',
  ].join('\n');
}

async function critique(o) {
  const src = resolve(o.text);
  let material;
  try {
    material = readFileSync(src, 'utf8');
  } catch (e) {
    throw new NotChecked(`读不到 ${src}（${e.code ?? e.message}）`);
  }
  if (!material.trim()) throw new NotChecked(`${src} 是空的`);
  if (!o.blind) {
    const why = missingWalkthrough(material);
    if (why) throw new NotChecked(why);
  }
  // 中性目录：不在任何仓里，会话不会自己读进 AGENTS.md 之类，只凭题面说话
  const dir = join(RUNS, 'critique');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = (o.name ?? 'critique').replace(/[^\w一-鿿-]/g, '-');
  const out = join(RUNS, `critique-${name}-${stamp}.md`);
  try {
    const chain = discussionProfiles(o);
    const budgetSec = Number(o.budgetSec ?? 30);
    if (!Number.isFinite(budgetSec) || budgetSec <= 0)
      throw new NotChecked('--budget-sec 必须是正数（讨论默认 30 秒）');
    const budgetMs = budgetSec * 1000;
    const r = await withFallback(
      chain,
      (s) => console.error(s),
      (p, remainingMs) =>
        runSession({
          prompt: o.blind ? blindPrompt(material) : critiquePrompt(material),
          profile: p,
          workdir: dir,
          timeoutMin: Math.min(o.timeoutMin, (remainingMs ?? o.timeoutMin * 60_000) / 60_000),
          log: (s) => console.error(s),
          pollMs: 1_000,
          effort: o.effort,
          discussion: true,
        }),
      { budgetMs },
    );
    const profile = r.profile;
    const v = o.blind ? (r.text.trim() ? { agree: true, objections: 0 } : null) : parseCritique(r.text);
    const head = [
      `# ${o.blind ? '盲答' : '反方'}：${name}`,
      '',
      `- 题面：${src}`,
      `- 会话：${r.sessionKey}（${r.model ?? profile.model ?? profile.agent}，思考强度 ${o.effort ?? '默认'}）${r.fallbackNote ? `；${r.fallbackNote}` : ''}`,
      `- 账本：${r.ledgerNote}；${r.usage}`,
      `- 结论：${o.blind ? (v ? '答了' : '空的（没查成）') : v ? (v.agree ? '同意' : `有异议 ${v.objections} 条`) : '认不出（没查成）'}`,
      '',
      '---',
      '',
    ].join('\n');
    writeFileSync(out, `${head + r.text}\n`);
    console.log(out);
    process.exitCode = v ? (v.agree ? 0 : 1) : 2;
  } catch (e) {
    writeFileSync(out, `# 反方：${name}：没查成\n\n- 题面：${src}\n- 原因：${e.message}\n`);
    console.log(out);
    throw e;
  }
}

// ---------- 主流程 ----------

// cursorAgentEnv 挪到 tools.mjs 了（ask.mjs、second-opinion.mjs 两边起 cursor-agent 都要用，见那边的注释）；
// 这个文件顶部 import 了它、又 re-export 了它，用法不用变。

/** 从 reclaude --output-format json 的结果里取正文；形状认不出就明确失败。 */
export function parseReclaudeOutput(raw) {
  const source = String(raw ?? '').trim();
  if (!source) throw new NotChecked('reclaude 退出码 0 但没有输出');
  const values = [];
  try {
    values.push(JSON.parse(source));
  } catch {
    for (const line of source.split(/\r?\n/).reverse()) {
      if (!line.trim()) continue;
      try {
        values.push(JSON.parse(line));
        break;
      } catch {
        // JSON 输出有时是逐行事件；继续尝试下一行，全部失败再报格式认不出。
      }
    }
  }
  const textOf = (value) => {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) {
      const parts = value.map(textOf).filter(Boolean);
      return parts.join('\n').trim();
    }
    if (!value || typeof value !== 'object') return '';
    for (const key of ['result', 'text', 'response', 'content', 'output']) {
      const text = textOf(value[key]);
      if (text) return text;
    }
    const message = textOf(value.message);
    if (message) return message;
    return '';
  };
  for (const value of values) {
    const text = textOf(value);
    if (text) return text;
  }
  throw new NotChecked('reclaude JSON 输出格式认不出（缺 result/text/content）');
}

function runClaude({ prompt, workdir, timeoutMin, log }) {
  if (!findBin('reclaude'))
    return Promise.reject(new NotInstalled('这台机器没装 reclaude（PATH 上找不到；Claude 必须经 reclaude）'));
  const started = Date.now();
  // prompt 走 stdin，不把题面拼进 Windows shell 的命令行；`-p` 无位置参数时由 reclaude 从 stdin 读。
  const args = ['-p', '--output-format', 'json', '--effort', 'medium', '--max-turns', '1'];
  log(`[0.0s] reclaude 起了（只读，单回合）`);
  return new Promise((resolveP, rejectP) => {
    const child = spawn('reclaude', args, {
      cwd: workdir,
      windowsHide: true,
      shell: process.platform === 'win32',
      env: process.env,
    });
    let out = '';
    let err = '';
    let settled = false;
    child.stdin.on('error', () => {
      // 执行体提前退出时写 stdin 会 EPIPE，最终以退出码和 stdout 为准。
    });
    child.stdin.end(prompt);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(
      () => {
        child.kill();
        finish(rejectP, new NotChecked(`reclaude ${timeoutMin} 分钟没答完，已停掉`));
      },
      Math.max(1, timeoutMin * 60_000),
    );
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => finish(rejectP, new NotChecked(`reclaude 起不来：${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0)
        return finish(
          rejectP,
          new NotChecked(`reclaude 退出码 ${code}：${(err || out).trim().slice(0, 400)}`),
        );
      try {
        const text = parseReclaudeOutput(out);
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        log(`[${secs}s] done（reclaude）`);
        finish(resolveP, {
          text,
          sessionKey: `reclaude:${process.pid}:${started}`,
          model: null,
          ledgerNote: '走本机 reclaude，不经 Mirasim 中继',
          usage: `${secs} 秒`,
        });
      } catch (e) {
        finish(rejectP, e);
      }
    });
  });
}

// 断链修复（本机 2026-09-28 两次实测，和 ask.mjs 同一个坑）：原来题面写进工作目录里的临时文件（Windows 命令行
// 长度有限），让它读文件照做——指望 cursorAgentEnv() 摘掉 Git Bash 留下的环境变量就能让它的钩子猜成本机原生壳。
// 实测不够：只要父进程链里有 Git Bash，钩子照样把读文件的工具调用拦掉（见 ask.mjs 头几行的论证）。改成不给位置
// 参数、题面从 stdin 喂给它，模型不用调任何工具就能看到题面（cursorAgentEnv() 留着一起用，多一层保险，不影响）。
// 题面最前面塞一行随机核对码、要求原样抄进答案：退出码 0、有输出，但输出里没有核对码，照样判没查成，不会被
// 「有输出就算答了」蒙混过去——不管读不到题面的原因是钩子拦的、权限，还是别的。
function runCursor({ prompt, profile, workdir, timeoutMin, log }) {
  const problem = cursorAgentProblem();
  if (problem) return Promise.reject(new NotInstalled(problem));
  const nonce = randomUUID().slice(0, 8);
  const started = Date.now();
  log(`[0.0s] cursor-agent 起了（${profile.model}，只读，工作目录 ${workdir}）`);
  return new Promise((resolveP, rejectP) => {
    const args = [
      '-p',
      '--output-format',
      'text',
      '--trust',
      '--mode',
      'ask',
      '--workspace',
      workdir,
      '--model',
      profile.model,
    ];
    const child = spawn('cursor-agent', args, {
      cwd: workdir,
      windowsHide: true,
      shell: process.platform === 'win32',
      env: cursorAgentEnv(),
    });
    child.stdin.on('error', () => {
      // 执行体提前退出时写 stdin 会 EPIPE，结果以退出码和 stdout 为准
    });
    child.stdin.end(
      `核对码：${nonce}\n（把上面这一行原样抄进你回答的第一行，证明你真的收到了这份题面；然后另起一行再照要求作答，不要写别的过程话。）\n\n${prompt}`,
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill();
      rejectP(new NotChecked(`cursor-agent ${timeoutMin} 分钟没答完，杀掉了`));
    }, timeoutMin * 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      rejectP(new NotChecked(`cursor-agent 起不来：${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (code !== 0)
        return rejectP(new NotChecked(`cursor-agent 退出码 ${code}：${(err || out).trim().slice(0, 400)}`));
      const trimmed = out.trim();
      if (!trimmed)
        return rejectP(new NotChecked(`cursor-agent 退出码 0 但没有输出：${err.trim().slice(0, 400)}`));
      if (!trimmed.includes(nonce))
        return rejectP(
          new NotChecked(`cursor-agent 没读到题面（答案里没有核对码）：${trimmed.slice(0, 400)}`),
        );
      // 读到了：把核对码那一行从记下的答案里去掉，只留真正的答案
      const stripped = trimmed
        .split(/\r?\n/)
        .filter((line) => !line.includes(nonce))
        .join('\n')
        .trim();
      log(`[${secs}s] done（cursor ${profile.model}）`);
      resolveP({
        text: stripped,
        sessionKey: `cursor:${process.pid}`,
        model: profile.model,
        ledgerNote: '走 Cursor 订阅（本机 cursor-agent），不经 Mirasim 账本',
        usage: `${secs} 秒`,
      });
    });
  });
}

async function runSession({
  prompt,
  profile,
  workdir,
  timeoutMin,
  log,
  pollMs = 10_000,
  effort,
  discussion = false,
}) {
  if (profile.agent === 'reclaude') return runClaude({ prompt, workdir, timeoutMin, log });
  if (profile.agent === 'cursor-cli') return runCursor({ prompt, profile, workdir, timeoutMin, log });
  const { url, wire, state } = await connect();
  const agents = Array.isArray(state.agentsAvailable) ? state.agentsAvailable : [];
  if (!agents.includes(profile.agent)) {
    wire.close();
    throw new NotChecked(`本机 Mirasim（${state.version ?? '?'}）没有 ${profile.agent} 这个执行体`);
  }
  const before = await relayUsage(url);
  const since = Date.now();
  wire.send({
    type: 'prompt',
    prompt,
    agent: profile.agent,
    workdir,
    model: profile.model,
    route: profile.route,
    ...(effort ? { effort } : {}),
    clientRef: `second-opinion-${since}`,
  });
  // 起 codex 会堵服务端 40–58 秒（adapters.md MS-08），等足 120 秒。没回应答也不重发（MS-18：会烧两次额度）。
  const ack = await wire.waitFor(
    (m) => m.type === 'accepted' || m.type === 'error',
    discussion ? Math.max(1, Math.min(30_000, timeoutMin * 60_000)) : 120_000,
  );
  wire.close();
  if (!ack)
    throw new NotChecked(
      `发了起会话的请求，120 秒没收到应答：没重发，去 ${join(MIRA, 'sessions', profile.agent)} 按工作目录 ${workdir} 对账`,
    );
  if (ack.type === 'error') throw new NotChecked(`Mirasim 拒了：${ack.message ?? JSON.stringify(ack)}`);
  const sessionKey = ack.sessionKey;
  const secs = () => `${((Date.now() - since) / 1000).toFixed(1)}s`;
  log(
    `[${secs()}] 会话 ${sessionKey} 起了（${profile.agent} / ${profile.model} / 路由 ${profile.route ?? '自动'}）`,
  );

  try {
    return await pollSession({ profile, url, sessionKey, since, timeoutMin, pollMs, log, before, secs });
  } finally {
    // 一次性会话：成没成、超没超时，跑完一律删掉（账本在 pollSession 里已经读完），不留在会话列表里。
    // --keep-session 是排查用的例外：会话留着，自己去 Mirasim 里看，看完 `--stop-stale` 清掉。
    if (!KEEP_SESSION) await forget(url, sessionKey, log);
  }
}

async function pollSession({ profile, url, sessionKey, since, timeoutMin, pollMs, log, before, secs }) {
  const deadline = since + timeoutMin * 60_000;
  let lastSig = '';
  let lastChange = Date.now();
  let lastPhase = '';
  let misses = 0;
  let view = null;
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    view = await readView(url, sessionKey);
    if (!view) {
      if (++misses >= Math.max(6, Math.ceil(60_000 / pollMs)))
        throw new NotChecked(`会话 ${sessionKey} 一分钟读不到快照（没查成）`);
      continue;
    }
    misses = 0;
    if (view.phase !== lastPhase) log(`  [${secs()}] ${view.phase}${view.model ? `（${view.model}）` : ''}`);
    lastPhase = view.phase;
    const verdict = judgeSnapshot(view);
    if (verdict.status === 'done') break;
    if (verdict.status === 'failed') throw new NotChecked(`会话 ${sessionKey} ${verdict.why}`);
    const sig = `${view.phase}|${view.text.length}|${view.toolCalls}|${view.updatedAt}`;
    if (sig !== lastSig) {
      lastSig = sig;
      lastChange = Date.now();
    }
    const stalled = Date.now() - lastChange > 10 * 60_000;
    if (stalled || Date.now() > deadline) {
      await stop(url, sessionKey);
      const pending = view.interactions.length
        ? `；会话里有 ${view.interactions.length} 个在等人回答的交互`
        : '';
      throw new NotChecked(
        `会话 ${sessionKey} ${stalled ? '10 分钟没动静' : `${timeoutMin} 分钟没跑完`}，已发停止${pending}`,
      );
    }
  }
  if (profile.agent !== 'claude' && profile.model && view.model && view.model !== profile.model) {
    throw new NotChecked(`要的是 ${profile.model}，快照报实际跑的是 ${view.model}`);
  }
  const uuid = sessionKey.split(':').slice(1).join(':');
  // 账本比快照的 done 晚一两秒落盘（2026-09-25 实测）：没读到起针后的成功行就等一等再读，最多 10 秒
  let ledger = readLedger(uuid);
  for (
    let i = 0;
    i < 10 && profile.route === 'cloud' && !(ledger.readable && judgeLedger(ledger.rows, since, true).ok);
    i++
  ) {
    await new Promise((r) => setTimeout(r, 1_000));
    ledger = readLedger(uuid);
  }
  let ledgerNote;
  if (profile.route === 'cloud') {
    if (!ledger.readable) throw new NotChecked(`快照说完工，但${ledger.why}——没核成`);
    const j = judgeLedger(ledger.rows, since, true);
    if (!j.ok) throw new NotChecked(j.why);
    ledgerNote = j.why;
  } else {
    ledgerNote = ledger.readable ? judgeLedger(ledger.rows, since, false).why : `不走中继，${ledger.why}`;
  }
  const after = await relayUsage(url);
  const usage =
    before != null && after != null ? `中继 7 天窗 ${before}% → ${after}%` : '中继 7 天窗用量没读到';
  return { sessionKey, text: view.text, model: view.model, ledgerNote, usage };
}

async function stop(url, sessionKey) {
  const wire = new Wire(url);
  try {
    await wire.opened;
    wire.send({ type: 'clientHello' });
    wire.send({ type: 'stop', sessionKey });
    await wire.waitFor((m) => m.type === 'error', 3000);
  } catch {
  } finally {
    wire.close();
  }
}

/**
 * 把会话连它的目录和账本一起删掉（Mirasim 的 deleteSession）。第二意见每次都是一次性的：跑完就删，
 * 不留在会话列表里等人来清（创始人 2026-10-03：「在 mirasim 起一个会话，我根本不想看见它，并且我希望随时能清理掉」）。
 * 删之前账本要先读完（traffic/<uuid> 跟会话一起没）。删不掉不当成失败——结论已经拿到了，只如实说一句。
 */
async function forget(url, sessionKey, log) {
  const wire = new Wire(url);
  try {
    await wire.opened;
    wire.send({ type: 'clientHello' });
    wire.send({ type: 'deleteSession', sessionKey });
    const r = await wire.waitFor((m) => m.type === 'error' || m.type === 'sessions', 5000);
    if (r && r.type === 'error') log?.(`会话 ${sessionKey} 没删掉：${r.message ?? JSON.stringify(r)}`);
    else log?.(`会话 ${sessionKey} 已删（连目录和账本）`);
  } catch (e) {
    log?.(`会话 ${sessionKey} 没删掉：${e.message}`);
  } finally {
    wire.close();
  }
}

/** 列本机 Mirasim 的会话（走 listSessions 帧）。读不到就抛，不当成「一个也没有」。 */
async function listSessions() {
  const { wire } = await connect();
  try {
    wire.send({ type: 'listSessions' });
    const m = await wire.waitFor((x) => x.type === 'sessions' && Array.isArray(x.sessions), 20_000);
    if (!m) throw new NotChecked('本机 Mirasim 没回会话列表（20 秒）');
    return m.sessions;
  } finally {
    wire.close();
  }
}

/** 第二意见跑出来的会话都带这个开头（reviewPrompt / critiquePrompt 的第一句），用来认哪些是我们留下的。 */
const OUR_SESSION_TITLE = /^(你是 PR #\d+ 的「第二意见」|你是「反方」)/;

/**
 * 跑完删不删会话。默认删（一次性会话，不留在 Mirasim 列表里等人清）；`--keep-session` 留着排查用。
 * 模块级布尔而不是逐层传参：runSession 在好几个地方起会话，参数表已经很长，这个开关只有「删不删」一个意思。
 */
let KEEP_SESSION = false;

/** 清掉我们（second-opinion / 反方）留下的旧会话：只删已经停的（running 的不动，可能正有人等着看）。 */
async function stopStale(log) {
  const { url } = await connect();
  const sessions = await listSessions();
  const ours = sessions.filter((s) => OUR_SESSION_TITLE.test(String(s.title ?? '')));
  const running = ours.filter((s) => s.runState === 'running');
  const done = ours.filter((s) => s.runState !== 'running');
  for (const s of done) await forget(url, s.sessionKey, log);
  return { deleted: done.length, stillRunning: running.length };
}

/** 贴到 PR 的正文：会话自己的过程话去掉，从「## 必须改」起照原样。 */
/** 审查意见里本机目录（审查树、仓根）的绝对路径改成仓内相对路径：贴到公开仓的评论里不带本机目录（2026-09-26 #148 的补审评论带出过）。 */
export function stripLocalPaths(text, dirs) {
  let out = String(text);
  for (const d of dirs) {
    const norm = String(d).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!norm) continue;
    const pattern = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[\\\\/]');
    out = out.replace(new RegExp(`/?${pattern}[\\\\/]`, 'gi'), '');
  }
  return out;
}

/**
 * 贴到 PR 的评论。第一行的格式别改：POSTED_REVIEW 靠它数轮（「第二意见 第 N 轮」「审的头 七位」「：通过 / 必须改 N 条」）。
 * 结论是脚本的判定，不是审的人自己写的那句；审的人的原文（从「必须改」那一段起）附在后面。
 */
export function prComment({
  judged,
  head,
  model,
  body,
  afterMerge = false,
  mergeCommit = null,
  roundNote = '',
  note = '',
}) {
  const who = afterMerge ? '合并后补审' : '第二意见';
  const conclusion = judged.pass ? '通过' : `必须改 ${judged.blocking.length} 条`;
  return [
    `**${who} 第 ${judged.round} 轮**（${model}；审的头 ${String(head).slice(0, 7)}）：${conclusion}`,
    '',
    ...judgementLines(judged, { afterMerge, mergeCommit, roundNote }),
    '',
    ...(note ? [`（${note}）`, ''] : []),
    '审的人原文：',
    '',
    String(body).trim(),
    '',
    afterMerge
      ? '<sub>本机第二意见垫片合并后补审（清单里标 review: after-merge 的 CI 判法先合后审，创始人 2026-10-03「1+2+3」）。没过的开修复 PR 或 revert。</sub>'
      : '<sub>本机第二意见垫片自动贴（规矩见 design 第五节）。挡不挡由脚本按标签和轮数判；小毛病和转合并后处理的不挡合并，合并后开小单。</sub>',
  ].join('\n');
}

/** 贴之前按仓里的卫生检查扫一遍：没扫成、扫出真密钥，一律抛（不贴；账号、组织编号、邮箱、IP 这类标识不算泄漏，
 * 不拦，创始人 2026-09-28 傍晚拍，specs/169-Fusion形态/需求.md）。 */
export async function checkPublishable(repo, body) {
  const scan = await import(pathToFileURL(join(repo, 'packages', 'hygiene', 'src', 'scan.ts')).href);
  const report = scan.scanFiles(['second-opinion.md'], () => Buffer.from(body, 'utf8'));
  if (report.binary.length > 0 || report.scanned.length !== 1) throw new Error('卫生检查没扫成，没贴');
  if (report.findings.length > 0)
    throw new Error(`卫生检查拦下了（${report.findings.map(scan.formatFinding).join('；')}），没贴`);
}

async function postToPr(repo, pr, body) {
  await checkPublishable(repo, body);
  mkdirSync(RUNS, { recursive: true });
  const file = join(RUNS, `.comment-${process.pid}.md`);
  writeFileSync(file, body);
  try {
    return gh(
      [
        'api',
        '-X',
        'POST',
        `repos/{owner}/{repo}/issues/${pr}/comments`,
        '-F',
        `body=@${file}`,
        '--jq',
        '.html_url',
      ],
      repo,
    );
  } finally {
    rmSync(file, { force: true });
  }
}

/** 这个头上现在的 second-opinion（GitHub 按新到旧排，取第一条）；没有回 undefined。读不到抛。 */
function currentSecondOpinion(repo, head) {
  const all = JSON.parse(gh(['api', `repos/{owner}/{repo}/commits/${head}/statuses`], repo) || '[]');
  if (!Array.isArray(all)) throw new NotChecked(`${head.slice(0, 7)} 的提交状态认不出（不是列表）`);
  return all.find((s) => s?.context === 'second-opinion');
}

/** 在审的那个头上写提交状态 second-opinion（合并闸在「先审后合」时认它，#74）。头变了旧状态自然不算。 */
function setStatus(repo, head, { state, description }, url) {
  // 总指挥已经在这个头上放行过（审查跑到一半时放行的），就不拿这一轮的结论盖掉它；结论照样贴在 PR 评论里
  const current = currentSecondOpinion(repo, head);
  if (current?.state === 'success' && String(current.description ?? '').startsWith('总指挥放行')) {
    console.error(
      `提交状态没改：${head.slice(0, 7)} 上已有总指挥放行（${current.description}），这一轮结论只贴评论`,
    );
    return;
  }
  const args = [
    'api',
    '-X',
    'POST',
    `repos/{owner}/{repo}/statuses/${head}`,
    '-f',
    `state=${state}`,
    '-f',
    'context=second-opinion',
    '-f',
    `description=${clip(description)}`,
  ];
  if (url) args.push('-f', `target_url=${url}`);
  gh(args, repo);
}

/**
 * 这个 PR 之前审完、出了结论几轮：数本脚本贴过的结论评论（不管头变没变，第二意见和合并后补审都算）。
 * 读不到回 { prior: null, why }，调用方按第 1 轮算（宁可多挡）。不数 runs 目录：那里的文件名用的是调用方给的 --round，
 * 同一个头重跑会盖掉；#701 贴了 10 次、每次都写「第 1 轮」。
 */
export function reviewRounds(pr, ghRun) {
  try {
    const out = ghRun([
      'api',
      '--paginate',
      `repos/{owner}/{repo}/issues/${pr}/comments`,
      '--jq',
      '.[] | (.body // "") | @json',
    ]);
    const bodies = String(out)
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    if (bodies.some((b) => typeof b !== 'string')) throw new Error('评论正文认不出');
    return { prior: priorRounds(bodies), why: '' };
  } catch (e) {
    return { prior: null, why: errText(e) };
  }
}

/** 一次命令失败的原因：stderr 第一行（没有就用 message），最多 200 字。 */
function errText(e) {
  const s = String(e?.stderr ?? '').trim() || String(e?.message ?? e).trim();
  const first = s.split(/\r?\n/).find((l) => l.trim()) ?? s;
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}

/** gh 走代理时好时坏（2026-09-25 实测）：先照常，不行再绕开代理直连。 */
function gh(args, cwd) {
  const { https_proxy, http_proxy, HTTPS_PROXY, HTTP_PROXY, ...direct } = process.env;
  try {
    return sh('gh', args, cwd);
  } catch {
    return sh('gh', args, cwd, direct);
  }
}

/** 要审的仓：--repo 给了用它，没给用当前目录所在的 git 检出 */
function repoOf(o) {
  if (o.repo) return resolve(o.repo);
  try {
    return resolve(sh('git', ['rev-parse', '--show-toplevel'], process.cwd()));
  } catch {
    throw new NotChecked('认不出要审的是哪个仓：在仓的检出里跑，或者用 --repo <检出> 指明');
  }
}

// ---------- 合并后补审（创始人 2026-10-03 晚「1+2+3」的第 3 条） ----------
//
// 清单（packages/conventions/high-risk-paths.json）里标了 review: after-merge 的条目（CI 判法那几份）：合并闸不等第二意见、
// 先合；合并后由这里补审。「哪些该补」只按主线上的那份清单认，从这个标记第一次出现在主线上的那个提交起算（在那之前合的 PR
// 走的是先审后合，不归这里管），最多往回看 14 天。只认提交状态：PR 头上有通过的 second-opinion 才算补过了。
// 补审没过的不重跑（重跑只会撞出一次随机的「通过」），等修复 PR 或 revert 合进去，再用 --after-merge-resolve 记成已处理。

export const AFTER_MERGE_DAYS = 14;
export const RISK_PATHS_FILE = 'packages/conventions/high-risk-paths.json';

/**
 * 主线上那份清单 → 每条的路径、是不是先合后审（认最具体的那条要用全部）。认不出回一句为什么（调用方判没查成）：
 * 不是 JSON、没有 paths、有一条没有 path、review 写了 after-merge 以外的东西。
 */
export function riskRules(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return `不是合法的 JSON（${e.message}）`;
  }
  const paths = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.paths : undefined;
  if (!Array.isArray(paths) || paths.length === 0) return '没有 paths 列表（或是空的）';
  const rules = [];
  for (const [i, item] of paths.entries()) {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string' || !item.path.trim())
      return `paths 第 ${i + 1} 条认不出（没有 path）`;
    if (item.review !== undefined && item.review !== 'after-merge')
      return `paths 第 ${i + 1} 条（${item.path}）的 review「${String(item.review)}」认不出`;
    rules.push({ path: item.path.trim(), afterMerge: item.review === 'after-merge' });
  }
  return rules;
}

/** 改到的文件里按「最具体（路径最长）的那条规则」算是先合后审的；改名的新旧名字都算（和合并闸的 riskyFiles 一个判法）。 */
export function afterMergeHits(files, rules) {
  const hits = [];
  for (const f of files) {
    for (const name of [f.path, f.previous]) {
      if (!name || hits.includes(name)) continue;
      const rule = rules
        .filter((r) => (r.path.endsWith('/') ? name.startsWith(r.path) : name === r.path))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (rule?.afterMerge) hits.push(name);
    }
  }
  return hits;
}

/** `git log -z --name-status --format=%x01%H %cI` 的输出 → 每个提交改了哪些文件（改名、复制带上旧名字）。认不出抛。 */
export function parseNameStatusLog(stdout) {
  const commits = [];
  for (const chunk of String(stdout).split('\x01').slice(1)) {
    const cut = chunk.indexOf('\0');
    const header = (cut < 0 ? chunk : chunk.slice(0, cut)).trim();
    const m = /^([0-9a-f]{40}) (\S+)$/.exec(header);
    if (!m) throw new NotChecked(`git log 的输出认不出（提交那一行是「${header.slice(0, 60)}」）`);
    const tokens = (cut < 0 ? '' : chunk.slice(cut + 1)).split('\0').map((t) => t.replace(/^\n/, ''));
    const files = [];
    for (let i = 0; i < tokens.length; ) {
      const st = tokens[i];
      if (st === '') {
        i++;
        continue;
      }
      if (!/^[ACDMRTUXB]\d*$/.test(st))
        throw new NotChecked(
          `git log 的输出认不出（${m[1].slice(0, 7)} 的改动状态是「${st.slice(0, 20)}」）`,
        );
      const two = st[0] === 'R' || st[0] === 'C';
      const names = tokens.slice(i + 1, i + (two ? 3 : 2));
      if (names.length !== (two ? 2 : 1) || names.some((n) => !n))
        throw new NotChecked(`git log 的输出认不出（${m[1].slice(0, 7)} 少了文件名）`);
      files.push(two ? { path: names[1], previous: names[0] } : { path: names[0] });
      i += two ? 3 : 2;
    }
    commits.push({ sha: m[1], date: m[2], files });
  }
  return commits;
}

const SO_STATES = new Set(['success', 'failure', 'error', 'pending', 'expected']);

/** 一次问 GitHub：这几个主线提交各是哪个 PR 合进来的、那个 PR 头上的 second-opinion 是什么。 */
export function prsOfCommitsQuery(shas) {
  const pr =
    'number title state mergedAt headRefOid baseRefName mergeCommit { oid } commits(last: 1) { nodes { commit { oid status { context(name: "second-opinion") { state description } } } } }';
  const parts = shas.map((sha, i) => {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new NotChecked(`提交号「${String(sha).slice(0, 60)}」认不出`);
    return `c${i}: object(oid: "${sha}") { ... on Commit { associatedPullRequests(first: 5) { nodes { ${pr} } } } }`;
  });
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${parts.join(' ')} } }`;
}

/**
 * 每个碰了先合后审路径的主线提交对到 PR 上（合并提交对得上的优先，其次合进 main 的），按 PR 头上的 second-opinion 分：
 * done（success）、failed（failure：补审没过，等修复或 revert）、unreviewed（没有、pending、error）。对不上 PR 的进 problems。
 * GitHub 回的样子认不出抛 NotChecked。
 */
export function classifyAfterMerge(candidates, repoData) {
  if (!repoData || typeof repoData !== 'object')
    throw new NotChecked('GitHub 回的 GraphQL 认不出（没有 data.repository）');
  const byPr = new Map();
  const problems = [];
  candidates.forEach((c, i) => {
    const where = `${c.sha.slice(0, 7)}（改到 ${c.hits.join('、')}）`;
    const node = repoData[`c${i}`];
    if (node == null) {
      problems.push(`${where}：GitHub 上找不到这个提交`);
      return;
    }
    const nodes = node.associatedPullRequests?.nodes;
    if (!Array.isArray(nodes))
      throw new NotChecked(`GitHub 回的 ${c.sha.slice(0, 7)} 认不出（没有 associatedPullRequests）`);
    const pr =
      nodes.find((p) => p?.mergeCommit?.oid === c.sha) ??
      nodes.find((p) => p?.state === 'MERGED' && p?.baseRefName === 'main');
    if (!pr) {
      problems.push(`${where}：找不到合它进主线的 PR（直接推到主线的？没法按 PR 补审）`);
      return;
    }
    const head = pr.commits?.nodes?.[0]?.commit;
    if (!Number.isInteger(pr.number) || typeof pr.headRefOid !== 'string' || head?.oid !== pr.headRefOid)
      throw new NotChecked(`GitHub 回的 #${pr.number ?? '?'} 认不出（读不到它的头）`);
    const raw = head.status?.context?.state;
    const state = raw == null ? null : String(raw).toLowerCase();
    if (state !== null && !SO_STATES.has(state))
      throw new NotChecked(`#${pr.number} 头上的 second-opinion 状态「${raw}」认不出`);
    const seen = byPr.get(pr.number);
    if (seen) {
      for (const h of c.hits) if (!seen.files.includes(h)) seen.files.push(h);
      return;
    }
    byPr.set(pr.number, {
      number: pr.number,
      title: String(pr.title ?? ''),
      mergedAt: pr.mergedAt ?? null,
      head: pr.headRefOid,
      mergeCommit: typeof pr.mergeCommit?.oid === 'string' ? pr.mergeCommit.oid : c.sha,
      files: [...c.hits],
      state,
      description: String(head.status?.context?.description ?? ''),
    });
  });
  const all = [...byPr.values()].sort((a, b) => a.number - b.number);
  return {
    done: all.filter((p) => p.state === 'success'),
    failed: all.filter((p) => p.state === 'failure'),
    unreviewed: all.filter((p) => p.state !== 'success' && p.state !== 'failure'),
    problems,
  };
}

/**
 * 合并后待补审的。git、gh 是起命令的两样（失败抛错、成功回 stdout）；fetchMain 不给就不取远端（开会话钩子刚取过）。
 * 读不到、认不出一律抛 NotChecked（调用方判没查成），不当成「没有待补审的」。主线上的清单还没有 after-merge 的条目时
 * 列表就是空的——那是真没有，不是没查成。
 */
export function pendingAfterMerge({
  git,
  gh: ghRun,
  fetchMain = null,
  now = Date.now(),
  days = AFTER_MERGE_DAYS,
}) {
  if (fetchMain) {
    try {
      fetchMain();
    } catch (e) {
      throw new NotChecked(`取主线没成（${errText(e)}），不知道最近合了哪些 PR`);
    }
  }
  let listText;
  try {
    listText = git(['show', `origin/main:${RISK_PATHS_FILE}`]);
  } catch (e) {
    throw new NotChecked(`读不到主线上的 ${RISK_PATHS_FILE}（${errText(e)}）`);
  }
  const rules = riskRules(listText);
  if (typeof rules === 'string') throw new NotChecked(`主线上的 ${RISK_PATHS_FILE} ${rules}`);
  const afterMergePaths = rules.filter((r) => r.afterMerge).map((r) => r.path);
  const base = { days, afterMergePaths, done: [], failed: [], unreviewed: [], problems: [] };
  if (afterMergePaths.length === 0)
    return { ...base, since: null, note: '主线上的清单还没有标 review: after-merge 的条目' };
  // 先合后审从哪天起：这个标记第一次出现在主线上的那个提交（-S 列的是标记个数变了的提交，最后一行最早）
  let intro;
  try {
    intro = git([
      'log',
      'origin/main',
      '--first-parent',
      '--format=%H %cI',
      '-S',
      '"after-merge"',
      '--',
      RISK_PATHS_FILE,
    ]);
  } catch (e) {
    throw new NotChecked(`查不出先合后审是哪天起的（${errText(e)}）`);
  }
  const oldest = String(intro).split('\n').filter(Boolean).at(-1) ?? '';
  const startedAt = Date.parse(oldest.split(' ')[1] ?? '');
  if (!Number.isFinite(startedAt))
    throw new NotChecked(`查不出先合后审是哪天起的（git log -S 的输出认不出：「${oldest.slice(0, 60)}」）`);
  const since = new Date(Math.max(now - days * 86_400_000, startedAt)).toISOString();
  let logText;
  let count;
  try {
    logText = git([
      '-c',
      'core.quotePath=false',
      'log',
      'origin/main',
      `--since=${since}`,
      '--first-parent',
      '--diff-merges=first-parent',
      '--name-status',
      '-M',
      '-z',
      '--format=%x01%H %cI',
    ]);
    count = git(['rev-list', '--count', '--first-parent', `--since=${since}`, 'origin/main']);
  } catch (e) {
    throw new NotChecked(`git log 没跑成（${errText(e)}）`);
  }
  const commits = parseNameStatusLog(logText);
  if (String(commits.length) !== String(count).trim())
    throw new NotChecked(
      `git log 读出 ${commits.length} 个提交，rev-list 说有 ${String(count).trim()} 个：输出认不出`,
    );
  const candidates = commits
    .map((c) => ({ ...c, hits: afterMergeHits(c.files, rules) }))
    .filter((c) => c.hits.length > 0);
  if (candidates.length === 0) return { ...base, since };
  let data;
  try {
    const out = ghRun([
      'api',
      'graphql',
      '-F',
      'owner={owner}',
      '-F',
      'name={repo}',
      '-f',
      `query=${prsOfCommitsQuery(candidates.map((c) => c.sha))}`,
    ]);
    data = JSON.parse(out)?.data?.repository;
  } catch (e) {
    if (e instanceof NotChecked) throw e;
    throw new NotChecked(`问 GitHub 这几个提交是哪个 PR 合的没成（${errText(e)}）`);
  }
  return { ...base, since, ...classifyAfterMerge(candidates, data) };
}

const SWEEP_HINT = '--after-merge-sweep --author-family <写它的模型族>';
const prLine = (p) =>
  `- #${p.number} ${p.title}（合并于 ${String(p.mergedAt ?? '?').slice(0, 10)}，改到 ${p.files.join('、')}）`;

/** --after-merge-pending 给人看的那几行。 */
export function formatPending(p) {
  if (p.note) return `没有合并后待补审的：${p.note}。`;
  const out = [
    `合并后补审：主线上 ${String(p.since).slice(0, 16).replace('T', ' ')}（UTC）之后合并、改到先合后审路径的 PR 共 ${p.done.length + p.failed.length + p.unreviewed.length} 个，补审通过 ${p.done.length} 个。`,
  ];
  if (p.unreviewed.length > 0)
    out.push(`还没补审 ${p.unreviewed.length} 个（跑 ${SWEEP_HINT}）：`, ...p.unreviewed.map(prLine));
  if (p.failed.length > 0)
    out.push(
      `补审没过、等修复或 revert ${p.failed.length} 个：`,
      ...p.failed.map(
        (x) =>
          `${prLine(x)}：${x.description || '没过'}；修复合了跑 --after-merge-resolve ${x.number} --by <修复 PR 号>，或 git revert ${x.mergeCommit.slice(0, 7)}`,
      ),
    );
  if (p.problems.length > 0)
    out.push(`对不上 PR 的提交 ${p.problems.length} 个：`, ...p.problems.map((x) => `- ${x}`));
  if (p.unreviewed.length + p.failed.length + p.problems.length === 0) out.push('没有待补审的。');
  return out.join('\n');
}

/** 取一次主线（和审 PR 时一样：先照常取，不行再绕开代理直连）。 */
function fetchMain(repo) {
  const refs = ['fetch', '-q', 'origin', 'main'];
  const { https_proxy, http_proxy, HTTPS_PROXY, HTTP_PROXY, ...direct } = process.env;
  try {
    sh('git', refs, repo);
  } catch (first) {
    try {
      sh('git', ['-c', 'http.proxy=', '-c', 'https.proxy=', ...refs], repo, direct);
    } catch (second) {
      throw new Error(`${errText(first)}；绕开代理再取也没成：${errText(second)}`);
    }
  }
}

/** 起 git、gh 的真家伙（测试换成假的）：失败抛错，成功回 stdout。 */
function realDeps(repo) {
  return {
    git: (a) => sh('git', a, repo),
    gh: (a) => {
      if (!findBin('gh')) throw new Error('这台机器没装 gh（PATH 上找不到）');
      return gh(a, repo);
    },
    fetchMain: () => fetchMain(repo),
  };
}

// ---------- 锁：同一个 PR 同时只跑一轮，不同 PR 可以并行（创始人 2026-10-03 晚：原来一把全局锁，不同 PR 也互相排队） ----------

/** 拿着锁的那个进程还在不在（没权限发信号也算在）。 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/**
 * 拿一把锁（文件 <dir>/.lock-<name>，里面是进程号）：拿着的进程还活着就抛 NotChecked；进程已死的陈旧锁直接盖掉。
 * 返回放锁的函数；进程退出时也放。dir / pid / alive 只给测试换。
 */
export function takeLock(name, why, { dir = RUNS, pid = process.pid, alive = isAlive } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `.lock-${name}`);
  if (existsSync(file)) {
    const holder = Number(readFileSync(file, 'utf8'));
    if (holder !== pid && alive(holder)) throw new NotChecked(`${why}（进程 ${holder}），等它跑完`);
  }
  writeFileSync(file, String(pid));
  const release = () => rmSync(file, { force: true });
  process.on('exit', release);
  return release;
}

/** 每个位子一棵审查树（固定几棵轮着用，见 preparePr）：没指定 --slot 就挑第一个空着的；都被占着照实报。 */
export function takeSlot(o, deps = {}) {
  if (o.slotGiven && (!Number.isInteger(o.slot) || o.slot < 1 || o.slot > 4))
    throw new NotChecked('--slot 只能是 1–4');
  const busy = [];
  for (const slot of o.slotGiven ? [o.slot] : [1, 2, 3, 4]) {
    try {
      return { slot, release: takeLock(`slot${slot}`, `审查树 ${slot} 另一轮在用`, deps) };
    } catch (e) {
      if (!(e instanceof NotChecked)) throw e;
      busy.push(e.message);
    }
  }
  throw new NotChecked(o.slotGiven ? busy[0] : `四棵审查树都有人在用：${busy.join('；')}`);
}

/**
 * 审一个 PR（开着的、已经合并的都行）：起会话、按标签和轮数判、贴评论、写提交状态。
 * 返回退出码：0 通过、1 必须改、2 没查成（结果格式认不出、状态没写上）；起会话这类没查成抛 NotChecked。
 */
async function reviewPr({ o, repo, pr, log }) {
  const chain = prProfiles(o); // 作者族不对先在这儿报，别等树切好了才说
  // 同一个 PR 同时只跑一轮（后来的退出 2）；不同 PR 各拿各的审查树，可以并行
  const releasePr = takeLock(`pr${pr}`, `PR #${pr} 另一轮第二意见在跑`);
  const { slot, release: releaseSlot } = takeSlot(o);
  try {
    return await reviewPrLocked({ o, repo, pr, log, chain, slot });
  } finally {
    releaseSlot();
    releasePr();
  }
}

async function reviewPrLocked({ o, repo, pr, log, chain, slot }) {
  const info = preparePr(repo, pr, slot);
  const counted = reviewRounds(pr, (a) => gh(a, repo));
  const round = (counted.prior ?? 0) + 1;
  const roundNote =
    counted.prior === null
      ? `轮数没数成（读不到 PR 上已有的评论：${counted.why}），按第 1 轮算（宁可多挡）`
      : `这个 PR 之前审完过 ${counted.prior} 轮，这是第 ${round} 轮`;
  const afterMerge = info.merged;
  const who = afterMerge ? '合并后补审' : '第二意见';
  const out = join(RUNS, `pr${pr}-${info.head.slice(0, 7)}-r${round}.md`);
  log(
    `PR #${pr} 头 ${info.head.slice(0, 7)}${afterMerge ? `（已合并，合并提交 ${info.mergeCommit.slice(0, 7)}：合并后补审）` : ''}，工作树 ${info.tree}；${roundNote}`,
  );
  try {
    // 默认快：中等思考强度、只看 diff、不跑测试，和 CI 同时跑（创始人 2026-09-25 定的关卡时间预算）；--slow 才走老的完整审法
    const fast = !o.slow;
    const r = await withFallback(chain, log, (p) =>
      runSession({
        prompt: reviewPrompt(pr, info, o.ui, fast),
        profile: p,
        workdir: info.tree,
        timeoutMin: o.timeoutMin,
        log,
        pollMs: fast ? 2_000 : 10_000,
        effort: o.effort ?? (fast ? 'medium' : undefined),
      }),
    );
    r.text = stripLocalPaths(r.text, [info.tree, repo]);
    const model = r.model ?? r.profile.model ?? r.profile.agent;
    const head = [
      `# PR #${pr} ${who} 第 ${round} 轮`,
      '',
      `- 审的头：${info.head}`,
      ...(afterMerge ? [`- 已合并：合并提交 ${info.mergeCommit}`] : []),
      `- 会话：${r.sessionKey}（${model}）${r.fallbackNote ? `；${r.fallbackNote}` : ''}`,
      `- 账本：${r.ledgerNote}；${r.usage}`,
      `- 轮数：${roundNote}`,
    ];
    const parsed = parseReview(r.text);
    if (!parsed.ok) {
      // 认不出的不贴、不写状态：不当通过，也不拿一份读不懂的东西去挡人
      writeFileSync(
        out,
        [...head, `- 结论：认不出（没查成，不算通过）：${parsed.why}`, '', '---', '', r.text, ''].join('\n'),
      );
      console.log(out);
      log(`没查成：审的结果${parsed.why}`);
      return 2;
    }
    const judged = judgeReview(parsed, round);
    const status = statusText(judged, afterMerge);
    writeFileSync(
      out,
      [
        ...head,
        `- 结论：${status.description}`,
        '',
        ...judgementLines(judged, { afterMerge, mergeCommit: info.mergeCommit, roundNote }),
        '',
        '---',
        '',
        r.text,
        '',
      ].join('\n'),
    );
    console.log(out);
    let code = judged.pass ? 0 : 1;
    if (!o.noPost) {
      let url;
      try {
        url = await postToPr(
          repo,
          pr,
          prComment({
            judged,
            head: info.head,
            model,
            body: parsed.body,
            afterMerge,
            mergeCommit: info.mergeCommit,
            roundNote,
            note: r.fallbackNote ?? '',
          }),
        );
        log(`贴到了 PR：${url}`);
      } catch (e) {
        log(`没贴上 PR：${e.message}`);
        appendFileSync(out, `\n（没贴上 PR：${e.message}）\n`);
      }
      try {
        setStatus(repo, info.head, status, url);
        log(
          `提交状态 second-opinion 写到了 ${info.head.slice(0, 7)}：${status.state}（${status.description}）`,
        );
      } catch (e) {
        log(`提交状态没写上：${errText(e)}`);
        code = 2;
      }
    }
    if (afterMerge && !judged.pass)
      console.log(
        `合并后补审没过：开修复 PR，或 git revert ${info.mergeCommit.slice(0, 7)}；修复合了跑 --after-merge-resolve ${pr} --by <修复 PR 号>`,
      );
    return code;
  } catch (e) {
    writeFileSync(
      out,
      `# PR #${pr} ${who} 第 ${round} 轮：没查成\n\n- 审的头：${info.head}\n- 原因：${e.message}\n`,
    );
    console.log(out);
    throw e;
  }
}

/** 退出码合起来：有没查成的算 2，否则有必须改的算 1。 */
const worse = (a, b) => (a === 2 || b === 2 ? 2 : Math.max(a, b));

/** --after-merge-sweep：把还没补审的逐个审一遍（补审没过的不重跑，见本段开头）。 */
async function afterMergeSweep({ o, repo, log }) {
  prProfiles(o); // 作者族先核
  const p = pendingAfterMerge({ ...realDeps(repo), fetchMain: o.noFetch ? null : () => fetchMain(repo) });
  console.log(formatPending(p));
  let code = 0;
  for (const item of p.unreviewed) {
    log(`—— 补审 #${item.number} ——`);
    try {
      code = worse(code, await reviewPr({ o, repo, pr: item.number, log }));
    } catch (e) {
      log(`#${item.number} 没查成：${e.message}`);
      code = 2;
    }
  }
  return code;
}

/**
 * --after-merge-resolve <原 PR> --by <修复或 revert 的 PR>：补审没过的问题已经修好、合进主线，在原 PR 的头上写通过，
 * 待补审清单就不再列它。只认「原 PR 头上是补审没过」「修复 PR 已合并」这两样都对得上的，免得拿它绕过补审。
 */
async function afterMergeResolve({ o, repo, log }) {
  if (!Number.isInteger(o.resolve) || o.resolve <= 0 || !Number.isInteger(o.by) || o.by <= 0)
    throw new NotChecked('要 --after-merge-resolve <原 PR 号> --by <修复或 revert 的 PR 号>');
  if (o.resolve === o.by) throw new NotChecked('--by 不能是它自己');
  const view = (n) =>
    JSON.parse(gh(['pr', 'view', String(n), '--json', 'number,state,title,headRefOid,mergeCommit'], repo));
  const orig = view(o.resolve);
  const fix = view(o.by);
  if (orig.state !== 'MERGED')
    throw new NotChecked(
      `#${o.resolve} 不是已合并的 PR（${orig.state}）：没合并的照常审（--pr），不走合并后补审`,
    );
  if (fix.state !== 'MERGED')
    throw new NotChecked(`#${o.by} 还没合并（${fix.state}）：修复或 revert 合进主线之后再记`);
  const current = currentSecondOpinion(repo, orig.headRefOid);
  if (current?.state === 'success') {
    console.log(`#${o.resolve} 头上的 second-opinion 已经是通过（${current.description}），不用再记`);
    return 0;
  }
  if (current?.state !== 'failure')
    throw new NotChecked(
      `#${o.resolve} 头上的 second-opinion 是「${current?.state ?? '没有'}」，不是补审没过：还没补审的先跑 --after-merge-sweep`,
    );
  const fixAt = String(fix.mergeCommit?.oid ?? '').slice(0, 7);
  let url;
  try {
    url = await postToPr(
      repo,
      o.resolve,
      [
        `**合并后补审：已处理**——补审没过的问题由 #${fix.number}（${fix.title}${fixAt ? `，合并提交 ${fixAt}` : ''}）处理。`,
        '',
        `原来的结论：${current.description}`,
      ].join('\n'),
    );
    log(`贴到了 PR：${url}`);
  } catch (e) {
    log(`没贴上 PR：${e.message}`);
  }
  setStatus(
    repo,
    orig.headRefOid,
    { state: 'success', description: `合并后补审没过的问题已由 #${fix.number} 处理` },
    url,
  );
  console.log(`#${o.resolve} 记成已处理（由 #${fix.number}）：头 ${orig.headRefOid.slice(0, 7)} 上写了通过`);
  return 0;
}

function args(argv) {
  const o = { timeoutMin: 45, ui: false, slot: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr') o.pr = Number(argv[++i]);
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--round') {
      // 不再起作用：第几轮由脚本数 PR 上已经贴过的结论（#701 贴了 10 次、每次都写「第 1 轮」）
      i++;
      o.roundGiven = true;
    } else if (a === '--after-merge-pending') o.afterMergePending = true;
    else if (a === '--after-merge-sweep') o.afterMergeSweep = true;
    else if (a === '--after-merge-resolve') {
      o.resolve = Number(argv[++i]);
      o.resolveGiven = true;
    } else if (a === '--by') o.by = Number(argv[++i]);
    else if (a === '--json') o.json = true;
    else if (a === '--no-fetch') o.noFetch = true;
    else if (a === '--slot') {
      o.slot = Number(argv[++i]);
      o.slotGiven = true;
    } else if (a === '--timeout-min') o.timeoutMin = Number(argv[++i]);
    else if (a === '--ui') o.ui = true;
    else if (a === '--selftest') o.selftest = true;
    else if (a === '--ping') o.ping = true;
    else if (a === '--no-post') o.noPost = true;
    else if (a === '--keep-session') o.keepSession = true;
    else if (a === '--sessions') o.sessions = true;
    else if (a === '--stop-stale') o.stopStale = true;
    else if (a === '--text') o.text = argv[++i];
    else if (a === '--name') o.name = argv[++i];
    else if (a === '--effort') o.effort = argv[++i];
    else if (a === '--agent') o.agent = argv[++i];
    else if (a === '--author-family') o.authorFamily = [o.authorFamily, argv[++i]].filter(Boolean).join(',');
    else if (a === '--exclude-family') o.excludeFamily = argv[++i];
    else if (a === '--budget-sec') o.budgetSec = Number(argv[++i]);
    else if (a === '--blind') o.blind = true;
    else if (a === '--slow') o.slow = true;
    else if (a === '--high-risk') o.highRisk = true;
    else if (a === '--post-merge') o.postMerge = true;
    else throw new NotChecked(`不认识的参数 ${a}`);
  }
  return o;
}

async function selftest(repo) {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}：要 ${JSON.stringify(b)}，得 ${JSON.stringify(a)}`);
  };
  eq(parseVerdict('## 必须改\n无\n结论：通过'), { pass: true, blocking: 0 }, '通过');
  eq(parseVerdict('…\n**结论：必须改 2 条**\n'), { pass: false, blocking: 2 }, '必须改带加粗');
  eq(parseVerdict('结论：必须改 0 条'), null, '必须改 0 条认不出');
  eq(parseVerdict('结论：通过\n另外一句'), null, '结论不在最后一行');
  eq(parseVerdict(''), null, '空输出');
  eq(
    judgeSnapshot({ phase: 'done', error: 'pi turn stalled past 30 minutes' }).status,
    'failed',
    'done 带死因',
  );
  eq(judgeSnapshot({ phase: 'done', incomplete: true }).status, 'failed', 'done 带 incomplete');
  eq(judgeSnapshot({ phase: 'streaming' }).status, 'running', '还在跑');
  eq(judgeSnapshot({}).status, 'unknown', '没有 phase');
  eq(judgeSnapshot({ phase: 'done', error: null }).status, 'done', '真完工');
  const t0 = Date.parse('2026-09-25T10:00:00Z');
  const row = (ts, status, viaRelay, upstreamHost = 'relay') => ({ ts, status, viaRelay, upstreamHost });
  eq(judgeLedger([row('2026-09-25T10:00:05Z', 200, true)], t0, true).ok, true, '中继成功');
  eq(judgeLedger([row('2026-09-25T09:00:00Z', 200, true)], t0, true).ok, false, '只有起针前的行');
  eq(judgeLedger([row('2026-09-25T10:00:05Z', 200, false, 'api.example')], t0, true).ok, false, '没走中继');
  eq(judgeLedger([row('2026-09-25T10:00:05Z', 429, true)], t0, true).ok, false, '只有失败行');
  eq(judgeLedger([], t0, true).ok, false, '空账本');
  // 挡不挡由脚本判（规矩钉在 agents/test/rules/second-opinion-verdict.rules.test.ts，这里只抽几条）
  const judged = (text, round) => {
    const p = parseReview(text);
    return p.ok ? judgeReview(p, round).pass : null;
  };
  eq(judged('## 必须改\n- `a.ts:1` 没带标签\n结论：必须改 1 条', 1), false, '没带标签的照挡');
  eq(judged('## 必须改\n- 【构造】【碰安全】`a.ts:1` 偏门写法\n结论：必须改 1 条', 1), true, '构造的不挡');
  eq(
    judged('## 必须改\n- 【现实】【其他】`a.ts:1` 问题\n结论：必须改 1 条', 3),
    true,
    '第 3 轮其他的转合并后',
  );
  eq(
    judged('## 必须改\n- 【现实】【碰安全】`a.ts:1` 问题\n结论：必须改 1 条', 3),
    false,
    '第 3 轮碰安全照挡',
  );
  eq(judged('## 必须改\n- 【现实】【其他】`a.ts:1` 问题\n结论：通过', 1), false, '审的人说通过也照挡');
  eq(judged('只有一句话\n结论：通过', 1), null, '没有必须改那一段认不出');
  const parsed = parseReview('我先读规矩……\n## 必须改\n- 【现实】【其他】`a.ts:1` 问题\n结论：必须改 1 条');
  const c = prComment({
    judged: judgeReview(parsed, 1),
    head: 'abcdef1234',
    model: 'gpt-6-luna',
    body: parsed.body,
  });
  eq(
    c.includes('我先读规矩') || !c.includes('## 必须改') || !c.includes('abcdef1'),
    false,
    '贴 PR 的正文去掉过程话、带着头',
  );
  eq(priorRounds([c, '别的评论']), 1, '贴出去的结论评论数得出轮数');
  // 卫生检查：扫出真密钥不贴、干净的放行（卫生检查的代码用 repo 里那份；账号、组织编号、邮箱、IP 这类标识不算
  // 泄漏，不拦，创始人 2026-09-28 傍晚拍，specs/169-Fusion形态/需求.md）
  const leakToken = ['ghp', 'Q3mNz8VbTf6RpLc2WdYs5HuXa9GjKe4B'].join('_');
  const rejects = async (p) =>
    p.then(
      () => false,
      () => true,
    );
  eq(await rejects(checkPublishable(repo, `里面有 ${leakToken} 这个值`)), true, '扫出真密钥不贴');
  eq(await rejects(checkPublishable(repo, '干净的正文')), false, '干净的放行');
  eq(parseCritique('## 漏掉的\n无\n结论：同意'), { agree: true, objections: 0 }, '反方同意');
  eq(parseCritique('**结论：有异议 3 条**'), { agree: false, objections: 3 }, '反方有异议');
  eq(parseCritique('结论：有异议 0 条'), null, '有异议 0 条认不出');
  eq(parseCritique('结论：通过'), null, '审 PR 的结论不算反方结论');
  eq(
    UNAVAILABLE.test(
      '快照报 done 但带着 incomplete：Selected model is at capacity. Please try a different model.',
    ),
    true,
    '模型满载算连不上、换下一家',
  );
  eq(UNAVAILABLE.test('结论认不出'), false, '认不出结论不换人');
  eq(missingWalkthrough('【规则】只有方案没有推演') !== null, true, '反方题面缺【推演】拦下');
  eq(
    missingWalkthrough(
      `【推演】${'从开单走到关单，每个阶段的边界和最坏情况都列了，对照了成熟产品的做法。'.repeat(3)}`,
    ),
    null,
    '带够【推演】放行',
  );
  console.log('selftest ok（33 条）');
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.selftest) return await selftest(repoOf(o));
  KEEP_SESSION = o.keepSession === true;
  // 会话列表 / 清旧会话：都是本机 Mirasim 的操作，不审东西、不碰仓。
  if (o.sessions) {
    const list = await listSessions();
    if (list.length === 0) console.log('本机 Mirasim 上一个会话也没有');
    for (const s of list) {
      const ours = OUR_SESSION_TITLE.test(String(s.title ?? '')) ? '第二意见' : '别的';
      console.log(
        `${s.sessionKey}\t${s.runState ?? '?'}\t${ours}\t${String(s.title ?? '')
          .split('\n')[0]
          .slice(0, 40)}`,
      );
    }
    return;
  }
  if (o.stopStale) {
    const r = await stopStale((s) => console.log(s));
    console.log(`清掉 ${r.deleted} 个已停的第二意见会话；还有 ${r.stillRunning} 个在跑的没动`);
    return;
  }
  const profile = o.ui ? PROFILES.ui : PROFILES.code;
  if (o.ping) {
    // 走一遍整条路（起会话、判完工、核账本），不审东西。
    const dir = join(RUNS, 'ping');
    mkdirSync(dir, { recursive: true });
    const r = await runSession({
      prompt: '只回一行，原样照抄：结论：通过',
      profile,
      workdir: dir,
      timeoutMin: 10,
      log: (s) => console.error(s),
    });
    console.log(
      `${r.sessionKey}（${r.model}）｜${r.ledgerNote}｜${r.usage}｜结论 ${JSON.stringify(parseVerdict(r.text))}`,
    );
    process.exitCode = parseVerdict(r.text)?.pass ? 0 : 2;
    return;
  }
  const log = (s) => console.error(s);
  if (o.roundGiven) log('--round 不再起作用：第几轮由脚本数这个 PR 上已经贴过的结论评论（不管头变没变）');
  // 合并后补审：列、记成已处理都不审东西；要不要 --high-risk 不相干（清单里标 review: after-merge 的本来就是先审后合的路径）
  if (o.afterMergePending) {
    const repo = repoOf(o);
    if (!findBin('git')) throw new NotChecked('这台机器没装 git（PATH 上找不到）');
    const p = pendingAfterMerge({ ...realDeps(repo), fetchMain: o.noFetch ? null : () => fetchMain(repo) });
    console.log(o.json ? JSON.stringify(p) : formatPending(p));
    return;
  }
  if (o.resolveGiven || o.by !== undefined) {
    process.exitCode = await afterMergeResolve({ o, repo: repoOf(o), log });
    return;
  }
  // PR 审查只在先审后合的改动上跑（创始人 2026-09-26 定，design 第五节「流程只为快」）：加 --high-risk（--post-merge 是旧名字，
  // 一样算）。别的 PR 审查一律不跑，退出码 3（不是 0，免得调用方当成通过）。方案讨论（--text）不受影响。
  if (o.pr && !o.highRisk && !o.postMerge) {
    console.error(
      'PR 第二意见只在先审后合的改动（迁移里有删改语句、碰安全；清单里标先合后审的合并后补）上跑，要加 --high-risk；其余 CI 绿就合（design 第五节）。',
    );
    process.exitCode = 3;
    return;
  }
  if (o.text) return await critique({ ...o, timeoutMin: o.timeoutMin === 45 ? 0.5 : o.timeoutMin });
  if (o.afterMergeSweep) {
    const repo = repoOf(o);
    for (const bin of ['git', 'gh'])
      if (!findBin(bin)) throw new NotChecked(`这台机器没装 ${bin}（PATH 上找不到）`);
    process.exitCode = await afterMergeSweep({ o, repo, log });
    return;
  }
  if (!Number.isInteger(o.pr) || o.pr <= 0)
    throw new NotChecked('要 --pr <号>、--text <文件>，或 --after-merge-pending / --after-merge-sweep');
  process.exitCode = await reviewPr({ o, repo: repoOf(o), pr: o.pr, log });
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

// 被测试 import 时不跑
if (isMain()) {
  main().catch((e) => {
    console.error(e instanceof NotChecked || e instanceof NotInstalled ? `没查成：${e.message}` : e.stack);
    process.exitCode = 2;
  });
}
