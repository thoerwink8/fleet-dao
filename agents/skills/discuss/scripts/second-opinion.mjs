#!/usr/bin/env node
// 第二意见垫片：经本机 Mirasim 起一个全新会话（默认 codex 的 gpt-6-luna、走 Mirasim 云端额度），审一个 PR，拿回结论；
// 或者拿一份分析去问反方（--text）。只在 VPS 引擎接活之前用，引擎的第二意见接上 Mirasim 就退役（fleet-dao#64）。
// 结论和过程存在 ~/.local/share/second-opinion/runs/（本机，不进任何仓：里面有 PR 内容；也不放技能目录，同步会把它换掉）。
// 帧协议照 fleet-dao docs/reference/adapters.md 第八节。完工判据借旧仓 windsurf-dao 的 scripts/lib/mirasim-runtime.mjs
// judgeCompletion：phase 到 done 且没有 error、没有 incomplete；走中继的还要账本里起针后有 2xx 行。
//
//   node second-opinion.mjs --pr 50 --high-risk --author-family <族[,族…]> [--repo <检出>] [--ui] [--round 1] [--timeout-min 45] [--slot 2]
//   node second-opinion.mjs --text 分析.md --author-family <族[,族…]> [--name 短名] [--budget-sec 30]
//     拍板前的反方：按 GPT→Claude→DeepSeek→Grok→Kimi 选不同族，退出码 0 同意 / 1 有异议 / 2 没查成
//   node second-opinion.mjs --selftest [--repo <检出>]
//   --repo 不给就用当前目录所在的 git 检出。
//
// 退出码：0 通过；1 必须改；2 没查成；3 PR 审查没开（不带 --high-risk）。连不上、没起来、超时、结论认不出、账本对不上、
// 有调用没走中继，一律 2，不当通过。端点没装、没开、未登录、roster 不含模型或超时都换下一家；几家都用不了照实报。

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/** 最后一行结论。认不出 = null，调用方判「没查成」。 */
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
    gh(['pr', 'view', String(pr), '--json', 'headRefOid,baseRefName,title,body,files'], repo),
  );
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
  return { ...info, head: got, tree };
}

function reviewPrompt(pr, info, ui, fast) {
  const files = (info.files ?? []).map((f) => f.path);
  return [
    `你是 PR #${pr} 的「第二意见」：一个全新会话，独立判断。写这段改动的是另一家模型，你的用处是找出它自己看不出的问题。`,
    '',
    `工作目录就是这个 PR 的头（${info.head}），基线是 origin/${info.baseRefName}。改动：\`git diff origin/${info.baseRefName}...HEAD\`（共 ${files.length} 个文件）。`,
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
    '',
    '规矩：不改文件、不提交、不推、不在 GitHub 上留言；不打印任何密钥、令牌的值。就在这一个会话里审完，不拆子代理、不做委派预检（省额度，结论也不会散在几处）。',
    '',
    '输出（简体中文）：',
    '## 必须改',
    '- `文件:行` 问题；具体什么输入会得到什么错误结果；建议怎么改',
    '（没有就写「无」）',
    '## 小毛病',
    '- 同上格式，不挡合并（没有就写「无」）',
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

export function prComment(round, head, model, verdict, text, postMerge = false) {
  const at = String(text).indexOf('## 必须改');
  const body = (at >= 0 ? String(text).slice(at) : String(text)).trim();
  const conclusion = verdict.pass ? '通过' : `必须改 ${verdict.blocking} 条`;
  return [
    `**${postMerge ? '合并后补审' : '第二意见'} 第 ${round} 轮**（${model}，经 Mirasim；审的头 ${head.slice(0, 7)}）：${conclusion}`,
    '',
    body,
    '',
    postMerge
      ? '<sub>本机第二意见垫片合并后自动补审（design 第五节：CI 绿就合的，第二意见挪到合并后、不挡合并）。必须改的由总指挥当场开修复 PR。</sub>'
      : '<sub>本机第二意见垫片自动贴（fleet-dao#64；规矩见 design 第五节）。小毛病不挡合并，合并时没修的挂到需求单上。</sub>',
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
    const nwo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], repo);
    return gh(
      ['api', '-X', 'POST', `repos/${nwo}/issues/${pr}/comments`, '-F', `body=@${file}`, '--jq', '.html_url'],
      repo,
    );
  } finally {
    rmSync(file, { force: true });
  }
}

/** 在审的那个头上写提交状态 second-opinion：pr-fields 在「先审后合」时认它（fleet-dao#74）。头变了旧状态自然不算。 */
function setStatus(repo, head, verdict, url) {
  const nwo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], repo);
  const state = verdict.pass ? 'success' : 'failure';
  // 总指挥已经在这个头上放行过（审查跑到一半时放行的），就不拿这一轮的结论盖掉它；结论照样贴在 PR 评论里
  const current = JSON.parse(gh(['api', `repos/${nwo}/commits/${head}/statuses`], repo) || '[]').find(
    (s) => s.context === 'second-opinion',
  );
  if (current?.state === 'success' && String(current.description ?? '').startsWith('总指挥放行')) {
    console.error(
      `提交状态没改：${head.slice(0, 7)} 上已有总指挥放行（${current.description}），这一轮结论只贴评论`,
    );
    return;
  }
  const description = verdict.pass ? '第二意见通过' : `第二意见：必须改 ${verdict.blocking} 条`;
  const args = [
    'api',
    '-X',
    'POST',
    `repos/${nwo}/statuses/${head}`,
    '-f',
    `state=${state}`,
    '-f',
    'context=second-opinion',
    '-f',
    `description=${description}`,
  ];
  if (url) args.push('-f', `target_url=${url}`);
  gh(args, repo);
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

function args(argv) {
  const o = { round: 1, timeoutMin: 45, ui: false, slot: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr') o.pr = Number(argv[++i]);
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--round') o.round = Number(argv[++i]);
    else if (a === '--slot') o.slot = Number(argv[++i]);
    else if (a === '--timeout-min') o.timeoutMin = Number(argv[++i]);
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
  const c = prComment(
    1,
    'abcdef1234',
    'gpt-6-luna',
    { pass: false, blocking: 1 },
    '我先读规矩……\n## 必须改\n- `a.ts:1` 问题\n结论：必须改 1 条',
  );
  eq(
    c.includes('我先读规矩') || !c.includes('## 必须改') || !c.includes('abcdef1'),
    false,
    '贴 PR 的正文去掉过程话、带着头',
  );
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
  console.log('selftest ok（27 条）');
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
  // PR 审查只在先审后合的两种改动上跑（创始人 2026-09-26 定，design 第五节「流程只为快」）：加 --high-risk；
  // --post-merge 留给还在调它的看门脚本。别的 PR 审查一律不跑，退出码 3（不是 0，免得调用方当成通过）。
  // 这个开关原来是本机 ~/.local/share/second-opinion/PR-REVIEW-DISABLED 这个文件，搬进仓时写死在这里。方案讨论（--text）不受影响。
  if (o.pr && !o.highRisk && !o.postMerge) {
    console.error(
      'PR 第二意见只在先审后合的两种改动（迁移里有删改语句、碰安全）上跑，要加 --high-risk；其余 CI 绿就合、合并后不再补审（design 第五节）。',
    );
    process.exitCode = 3;
    return;
  }
  if (o.text) return await critique({ ...o, timeoutMin: o.timeoutMin === 45 ? 0.5 : o.timeoutMin });
  if (!Number.isInteger(o.pr) || o.pr <= 0) throw new NotChecked('要 --pr <号> 或 --text <文件>');
  const repo = repoOf(o);
  const runs = RUNS;
  mkdirSync(runs, { recursive: true });
  const log = (s) => console.error(s);
  // 每个位子一棵审查树：同一位子同一时刻只跑一轮；要并行就换 --slot。
  if (!Number.isInteger(o.slot) || o.slot < 1 || o.slot > 4) throw new NotChecked('--slot 只能是 1–4');
  const lock = join(runs, `.lock-${o.slot}`);
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    let alive = false;
    try {
      alive = Number.isInteger(pid) && pid > 0 && process.kill(pid, 0);
    } catch {}
    if (alive) throw new NotChecked(`另一轮第二意见在跑（进程 ${pid}），等它跑完`);
  }
  writeFileSync(lock, String(process.pid));
  process.on('exit', () => rmSync(lock, { force: true }));
  const info = preparePr(repo, o.pr, o.slot);
  const out = join(runs, `pr${o.pr}-${info.head.slice(0, 7)}-r${o.round}.md`);
  log(`PR #${o.pr} 头 ${info.head.slice(0, 7)}，工作树 ${info.tree}`);
  let code = 2;
  try {
    // 默认快：中等思考强度、只看 diff、不跑测试，和 CI 同时跑（创始人 2026-09-25 定的关卡时间预算）；--slow 才走老的完整审法
    const fast = !o.slow;
    const r = await withFallback(prProfiles(o), log, (p) =>
      runSession({
        prompt: reviewPrompt(o.pr, info, o.ui, fast),
        profile: p,
        workdir: info.tree,
        timeoutMin: o.timeoutMin,
        log,
        pollMs: fast ? 2_000 : 10_000,
        effort: o.effort ?? (fast ? 'medium' : undefined),
      }),
    );
    r.text = stripLocalPaths(r.text, [info.tree, repo]);
    const v = parseVerdict(r.text);
    const head = [
      `# PR #${o.pr} 第二意见 第 ${o.round} 轮`,
      '',
      `- 审的头：${info.head}`,
      `- 会话：${r.sessionKey}（${r.model ?? r.profile.model ?? r.profile.agent}）${r.fallbackNote ? `；${r.fallbackNote}` : ''}`,
      `- 账本：${r.ledgerNote}；${r.usage}`,
      `- 结论：${v ? (v.pass ? '通过' : `必须改 ${v.blocking} 条`) : '认不出（没查成，不算通过）'}`,
      '',
      '---',
      '',
    ].join('\n');
    writeFileSync(out, `${head + r.text}\n`);
    code = v ? (v.pass ? 0 : 1) : 2;
    console.log(out);
    // 认得出结论的才贴到 PR 上（必须改 + 小毛病都贴，GitHub 是记它们的地方）；没贴上照实说，不改结论
    if (v && !o.noPost) {
      let url;
      try {
        url = await postToPr(
          repo,
          o.pr,
          prComment(
            o.round,
            info.head,
            r.model ?? r.profile.model ?? r.profile.agent,
            v,
            r.fallbackNote
              ? `（${r.fallbackNote}）

${r.text}`
              : r.text,
            o.postMerge,
          ),
        );
        log(`贴到了 PR：${url}`);
      } catch (e) {
        log(`没贴上 PR：${e.message}`);
        writeFileSync(out, `${head}（没贴上 PR：${e.message}）\n\n${r.text}\n`);
      }
      try {
        setStatus(repo, info.head, v, url);
        log(`提交状态 second-opinion 写到了 ${info.head.slice(0, 7)}：${v.pass ? 'success' : 'failure'}`);
      } catch (e) {
        log(`提交状态没写上：${String(e.stderr ?? e.message).trim()}`);
        code = 2;
      }
    }
  } catch (e) {
    writeFileSync(
      out,
      `# PR #${o.pr} 第二意见 第 ${o.round} 轮：没查成\n\n- 审的头：${info.head}\n- 原因：${e.message}\n`,
    );
    console.log(out);
    throw e;
  }
  process.exitCode = code;
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
