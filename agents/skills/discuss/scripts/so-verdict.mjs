// second-opinion.mjs 拆出来的纯函数（--selftest 覆盖）：认结论行、判快照和账本、审的人交回的正文 → 挡不挡、
// 提交状态和评论里「脚本判定」那几行、反方的结论行。改这里的判法就是改规矩，见下面「挡不挡」那段。

/** @typedef {{ pass: boolean, blocking: number }} Verdict 审的人最后一行写的结论（挡不挡不看它） */
/** @typedef {'现实' | '构造'} Reality */
/** @typedef {'碰安全' | '改数据库' | '其他'} Category */
/** @typedef {{ reality: Reality | null, category: Category | null }} Labels */
/** @typedef {{ text: string, reality: Reality | null, category: Category | null }} Finding 一条必须改（标签可能没带全） */
/** @typedef {{ text: string, reality: Reality, category: Category, unlabeled: boolean }} JudgedItem 判过的一条（没带的标签已按【现实】【其他】补上） */
/** @typedef {{ ok: true, mustFix: Finding[], minor: string[], claimed: Verdict, body: string }} ParsedReview */
/** @typedef {{ pass: boolean, round: number, blocking: JudgedItem[], deferred: JudgedItem[], constructed: JudgedItem[], minor: string[], claimed: Verdict }} Judgement 脚本按标签和轮数判出来的 */
/** @typedef {{ afterMerge?: boolean, mergeCommit?: string | null, roundNote?: string }} JudgementOptions */

const DONE = new Set(['done', 'complete', 'completed']);
const FAILED = new Set(['error', 'failed', 'aborted', 'cancelled', 'canceled']);

// ---------- 纯函数（--selftest 覆盖） ----------

/**
 * 最后一行结论（审的人自己说的；挡不挡不看它，见 parseReview / judgeReview）。认不出 = null。
 * @param {unknown} text
 * @returns {Verdict | null}
 */
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

/**
 * 快照 → 判断。只有 done 才往下核账本。
 * @param {{ phase?: unknown, error?: unknown, incomplete?: unknown } | null | undefined} view
 * @returns {{ status: 'unknown' | 'failed' | 'running' | 'done', why: string }}
 */
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

/** @typedef {Record<string, unknown>} LedgerRow Mirasim 账本里的一行（读回来的 JSON，字段按用到的几个核） */

/**
 * 账本行 → 起针后有没有成功调用、有没有没走中继的调用。
 * @param {LedgerRow[]} rows
 * @param {number} since
 * @param {boolean} mustRelay
 * @returns {{ ok: boolean, why: string }}
 */
export function judgeLedger(rows, since, mustRelay) {
  const fresh = rows.filter(
    (r) => Number.isFinite(Date.parse(String(r?.ts ?? ''))) && Date.parse(String(r.ts)) >= since - 1000,
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
/**
 * 第 3 轮起照样挡的类别：泄露了、删了数据就回不来，不能「先合了再说」。
 * @type {Category[]}
 */
export const ALWAYS_BLOCK = ['碰安全', '改数据库'];

/** @type {Category[]} */
const CATEGORIES = ['碰安全', '改数据库', '其他'];

/** 【…】或 […] 里的标签（一对括号里可以并写几个：【现实·碰安全】）。 */
const LABEL = /[【[]\s*([^】\]\n]{1,30}?)\s*[】\]]/g;

/**
 * 一段话里的标签：现实性（现实 / 构造）和类别（碰安全 / 改数据库 / 其他）。两样都标了取更严的（现实、碰安全优先）；没标是 null。
 * @param {unknown} text
 * @returns {Labels}
 */
export function labelsOf(text) {
  const reality = new Set();
  const category = new Set();
  for (const m of String(text ?? '').matchAll(LABEL)) {
    for (const word of (m[1] ?? '').split(/[\s·・、,，|/／+＋&＆<>＜＞]+/)) {
      if (word === '现实') reality.add('现实');
      else if (word === '构造') reality.add('构造');
      else if (word === '碰安全' || word === '安全') category.add('碰安全');
      else if (word === '改数据库' || word === '数据库') category.add('改数据库');
      else if (word === '其他' || word === '其它') category.add('其他');
    }
  }
  return {
    reality: reality.has('现实') ? '现实' : reality.has('构造') ? '构造' : null,
    category: CATEGORIES.find((c) => category.has(c)) ?? null,
  };
}

/**
 * 去掉 Markdown 的强调和代码记号，只看字。
 * @param {unknown} s
 */
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
 * @param {readonly unknown[]} lines
 * @returns {string[]}
 */
export function itemsOf(lines) {
  const rows = lines.map((l) => String(l).replace(/\t/g, '    ').replace(/\s+$/, ''));
  /** @type {string[]} */
  const items = [];
  const first = rows.findIndex((l) => BULLET.test(l));
  if (first < 0) {
    /** @type {string[]} */
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
    if (lead.length > 0 && !/[：:]$/.test(lead.at(-1) ?? '')) items.push(lead.join('\n'));
    // first 是 findIndex 找到的、一定能匹配列表符号；?? 只为让类型跟上
    const top = (BULLET.exec(rows[first] ?? '')?.[1] ?? '').length;
    for (const l of rows.slice(first)) {
      const m = BULLET.exec(l);
      if (m && (m[1] ?? '').length <= top) items.push((m[2] ?? '').trim());
      else if (l.trim() && items.length > 0) items[items.length - 1] += `\n${l.trim()}`;
    }
  }
  return items.filter((t) => !NONE.test(plain(t.replace(/\n/g, ' '))));
}

/**
 * 一条必须改的标签：先看第一行，第一行没写的那一样再从整条里找。
 * @param {string} text
 * @returns {Labels}
 */
function itemLabels(text) {
  const head = labelsOf(String(text).split('\n')[0]);
  const all = labelsOf(text);
  return { reality: head.reality ?? all.reality, category: head.category ?? all.category };
}

/**
 * 审的人交回的正文 → { ok: true, mustFix, minor, claimed, body } 或 { ok: false, why }。
 * 认不出（判没查成、不写通过）的只有：没有「必须改」这一段；最后一行不是结论（多半没写完）；结论说必须改、那一段却一条也读不出。
 * 结论行只当「写完了」的记号和对照：挡不挡看 judgeReview，不看它。
 * @param {unknown} text
 * @returns {ParsedReview | { ok: false, why: string }}
 */
export function parseReview(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  /** @param {string} l */
  const title = (l) => /^#{1,6}\s+(.*?)\s*$/.exec(plain(l))?.[1] ?? null;
  /** @param {string} l */
  const isEnd = (l) => title(l) !== null || /^结论\s*[：:]/.test(plain(l));
  // 取最后一个「必须改」标题：前面要是把题面里的输出格式抄了一遍，真正的答案在后面
  /** @param {string} name */
  const lastTitled = (name) => lines.findLastIndex((l) => title(l)?.startsWith(name) === true);
  /** @param {number} at */
  const sectionAt = (at) => {
    let end = at + 1;
    while (end < lines.length && !isEnd(lines[end] ?? '')) end++;
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
 * @param {ParsedReview} parsed
 * @param {unknown} round
 * @returns {Judgement}
 */
export function judgeReview(parsed, round) {
  const r = typeof round === 'number' && Number.isInteger(round) && round >= 1 ? round : 1;
  /** @type {JudgedItem[]} */
  const blocking = [];
  /** @type {JudgedItem[]} */
  const deferred = [];
  /** @type {JudgedItem[]} */
  const constructed = [];
  for (const f of parsed.mustFix) {
    /** @type {JudgedItem} */
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

/**
 * PR 上的评论正文 → 之前审完、出了结论几轮（不管头变没变）。
 * @param {readonly unknown[]} bodies
 */
export function priorRounds(bodies) {
  return bodies.filter((b) => POSTED_REVIEW.test(String(b ?? '').trimStart())).length;
}

/** 和 POSTED_REVIEW 认同一种第一行，把谁审的、第几轮、审的头、结论拆出来。 */
const POSTED_PARTS =
  /^\*\*(第二意见|合并后补审) 第 (\d+) 轮\*\*（[^）\n]*审的头 ([0-9a-f]{7,40})）：(通过|必须改 (\d+) 条)/;

/** @typedef {{ who: string, round: number, pass: boolean, blocking: number, line: string }} PostedVerdict 头上已贴的一条结论 */

/**
 * 这个头上本脚本已经贴过的结论（有几条取最后一条）；没有回 null。同一个头只审一次：再起一轮只会撞出一次随机的结论，
 * 还白占一轮、把轮数推到放宽门槛的第 3 轮（#1003 的同一个头 ec120f6 隔 42 秒审了两轮）。这样每个头最多贴一条结论，
 * priorRounds 数出来的评论数就是审过的不同头的个数。
 * @param {readonly unknown[]} bodies
 * @param {string} head 完整的提交号
 * @returns {PostedVerdict | null}
 */
export function postedOnHead(bodies, head) {
  /** @type {PostedVerdict | null} */
  let found = null;
  for (const b of bodies) {
    const text = String(b ?? '').trimStart();
    if (!POSTED_REVIEW.test(text)) continue;
    const m = POSTED_PARTS.exec(text);
    if (!m) continue;
    const [line = '', who = '', round = '', abbrev = '', verdict = '', n] = m;
    if (!head.startsWith(abbrev)) continue;
    found = {
      who,
      round: Number(round),
      pass: verdict === '通过',
      blocking: n === undefined ? 0 : Number(n),
      line: line.replace(/\*\*/g, ''),
    };
  }
  return found;
}

/** GitHub 提交状态 description 的上限（140 个字符）。 */
const DESCRIPTION_MAX = 140;
/**
 * @param {unknown} s
 * @param {number} [max]
 */
export function clip(s, max = DESCRIPTION_MAX) {
  const chars = [...String(s)];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : String(s);
}
/** @param {{ reality: string, category: string }} f */
const tagOf = (f) => `【${f.reality}】【${f.category}】`;
/**
 * 「【现实】【碰安全】1、【现实】【其他】2」
 * @param {JudgedItem[]} items
 */
function tally(items) {
  /** @type {Map<string, number>} */
  const n = new Map();
  for (const f of items) n.set(tagOf(f), (n.get(tagOf(f)) ?? 0) + 1);
  return [...n].map(([k, v]) => `${k}${v}`).join('、');
}
/** @param {unknown} t */
const firstLine = (t) => {
  const s = plain(String(t).split('\n')[0]);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};

/**
 * 写到 PR 头上的提交状态（合并闸认 success；description 写清是哪几条挡、为什么）。
 * @param {Judgement} j
 * @param {boolean} [afterMerge]
 * @returns {{ state: 'success' | 'failure', description: string }}
 */
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

/**
 * 评论和记录里的「脚本判定」那几行：哪几条挡、哪几条转合并后、哪几条算构造的，和审的人自己的结论对不上就写出来。
 * @param {Judgement} j
 * @param {JudgementOptions} [opts]
 * @returns {string[]}
 */
export function judgementLines(j, { afterMerge = false, mergeCommit = null, roundNote = '' } = {}) {
  const rule =
    j.round <= STRICT_ROUNDS
      ? `第 ${j.round} 轮，【现实】的必须改都挡（没带标签的按【现实】【其他】算），【构造】的不挡`
      : `第 ${j.round} 轮（前面已经审完过 ${j.round - 1} 轮），只挡【现实】且碰安全或改数据库的，其余转合并后处理，【构造】的不挡`;
  /** @param {JudgedItem[]} items */
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

/**
 * 反方的结论行。认不出 = null。
 * @param {unknown} text
 * @returns {{ agree: boolean, objections: number } | null}
 */
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
