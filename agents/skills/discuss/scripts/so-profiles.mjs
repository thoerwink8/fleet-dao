// second-opinion.mjs 拆出来的：各家执行体的档案、按作者族排候选、主审连不上换下一家。
import { NotChecked, RetryableStart, Stalled } from './so-common.mjs';
import { NotInstalled } from './tools.mjs';

/** @typedef {import('./so-common.mjs').Profile} Profile */
/** @typedef {import('./so-common.mjs').SessionResult} SessionResult */
/** @typedef {import('./so-common.mjs').Log} Log */
/** @typedef {'code' | 'claude' | 'deepseek' | 'grok' | 'kimi' | 'code5' | 'cursor' | 'glm' | 'kimi3' | 'grok-cli' | 'ui'} ProfileName */
/** @typedef {{ agent?: string | undefined, authorFamily?: string | string[] | undefined, excludeFamily?: string | undefined, ui?: boolean | undefined }} ProfileOptions */

// 讨论/第二意见共同的厂商族顺序。作者族由调用方显式传入；不能从环境变量或当前进程名猜。
// 创始人 2026-10-05：「第二意见太慢了，我建议优先 gpt6luna，不行就 grok」——gpt 第一、grok 第二，其余排后面只当兜底
// （当天 #1056 的第二意见 25 分钟：deepseek、grok 起了会话卡在 streaming、没人换，最后 kimi 才出结论）。
/** @type {string[]} */
export const FAMILY_ORDER = ['gpt', 'grok', 'claude', 'deepseek', 'kimi'];
/** @type {Record<ProfileName, Profile>} */
export const PROFILES = {
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
/** @type {Record<string, Profile | undefined>} */
const PROFILE_BY_FAMILY = {
  gpt: PROFILES.code,
  claude: PROFILES.claude,
  deepseek: PROFILES.deepseek,
  grok: PROFILES.grok,
  kimi: PROFILES.kimi,
};

// 主审连不上就换下一家（创始人 2026-09-25：一个渠道不生效，讨论和审查的主体就换）。
// 族顺序由 FAMILY_ORDER + PROFILE_BY_FAMILY 唯一决定；审出结论后不因不喜欢结论换人。
// 「模型满载」也算连不上（2026-09-26：codex 快照报 done 带 incomplete「Selected model is at capacity」，没换人直接判没查成）。
export const UNAVAILABLE =
  /\b(502|503|529)\b|no upstream available|Service Unavailable|overloaded|at capacity|try a different model/i;
/** @param {string} name */
function pickProfile(name) {
  const p = /** @type {Record<string, Profile | undefined>} */ (PROFILES)[name];
  if (!p)
    throw new NotChecked(
      `不认识的 --agent ${name}（code / claude / deepseek / grok / kimi / code5 / cursor / kimi3 / ui）`,
    );
  return p;
}

/**
 * @param {unknown} raw
 * @param {string} [label]
 */
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
 * @param {ProfileOptions} [o]
 * @returns {Profile[]}
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
  /** @type {Profile[]} */
  const candidates = [];
  for (const family of FAMILY_ORDER) {
    if (excluded.has(family)) continue;
    const profile = PROFILE_BY_FAMILY[family];
    // FAMILY_ORDER 里的每一族在 PROFILE_BY_FAMILY 里都有一家；对不上说明有人只改了一边，明说
    if (!profile)
      throw new NotChecked(`族 ${family} 没有对应的执行体（FAMILY_ORDER 和 PROFILE_BY_FAMILY 对不上）`);
    candidates.push(profile);
  }
  if (candidates.length === 0) throw new NotChecked('作者模型族覆盖全部候选，没有可用的不同模型族');
  return candidates;
}

/** @param {ProfileOptions} o */
export function prProfiles(o) {
  return discussionProfiles(o);
}
/** 启动没成、可重试的 incomplete（中继撞上状态库补数据，见 RetryableStart）：同一家等多久、最多重试几次。 */
const START_RETRY_WAIT_MS = 30_000;
const MAX_START_RETRIES = 2;
/** @param {number} ms */
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 跑一家；撞上「启动没成」就等 START_RETRY_WAIT_MS 在同一家重新起会话，最多 MAX_START_RETRIES 次，再不行（或整轮预算不够等了）
 * 把最后那个错抛回去，由 withFallback 当没查成换下一家。别的错一律原样抛。
 * @param {Profile} p
 * @param {string} who
 * @param {(p: Profile, remainingMs: number | undefined) => Promise<SessionResult>} run
 * @param {number | undefined} remainingMs
 * @param {number | null} deadline
 * @param {Log} log
 * @param {(ms: number) => Promise<void>} sleep
 * @returns {Promise<SessionResult>}
 */
async function runRetryingStart(p, who, run, remainingMs, deadline, log, sleep) {
  let left = remainingMs;
  for (let retry = 0; ; retry++) {
    try {
      return await run(p, left);
    } catch (e) {
      if (!(e instanceof RetryableStart) || retry >= MAX_START_RETRIES) throw e;
      if (deadline !== null && deadline - Date.now() <= START_RETRY_WAIT_MS) throw e;
      log(
        `${who} 启动没成（${e.message.slice(0, 160)}），${START_RETRY_WAIT_MS / 1000} 秒后在同一家重试（第 ${retry + 1}/${MAX_START_RETRIES} 次）`,
      );
      await sleep(START_RETRY_WAIT_MS);
      left = deadline === null ? undefined : deadline - Date.now();
    }
  }
}

/**
 * @param {Profile[]} chain
 * @param {Log} log
 * @param {(p: Profile, remainingMs: number | undefined) => Promise<SessionResult>} run
 * @param {{ budgetMs?: number | undefined, sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<SessionResult & { profile: Profile }>}
 */
export async function withFallback(chain, log, run, { budgetMs, sleep = defaultSleep } = {}) {
  /** @type {string[]} */
  const misses = [];
  const deadline = budgetMs !== undefined && Number.isFinite(budgetMs) ? Date.now() + budgetMs : null;
  for (const [at, p] of chain.entries()) {
    const who = `${p.agent}/${p.model ?? '服务端默认'}`;
    const remainingMs = deadline === null ? undefined : deadline - Date.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      misses.push(`${who}：讨论总预算已用完`);
      break;
    }
    try {
      const r = await runRetryingStart(p, who, run, remainingMs, deadline, log, sleep);
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
      if (e instanceof Stalled) {
        // 起了会话、连续 N 分钟没有任何新输出：不等到整轮超时，当场换下一家
        misses.push(`${who}：${e.message}`);
        const next = chain[at + 1];
        log(
          next
            ? `${p.family} ${e.minutes} 分钟没出声，换 ${next.family}`
            : `${p.family} ${e.minutes} 分钟没出声，后面没有下一家了`,
        );
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
