#!/usr/bin/env node
// 第二意见垫片：经本机 Mirasim 起一个全新会话（默认 codex 的 gpt-6-luna、走 Mirasim 云端额度），审一个 PR，拿回结论；
// 或者拿一份分析去问反方（--text）。只在 VPS 引擎接活之前用，引擎的第二意见接上 Mirasim 就退役（fleet-dao#64）。
// 结论和过程存在 ~/.local/share/second-opinion/runs/（本机，不进任何仓：里面有 PR 内容；也不放技能目录，同步会把它换掉）。
// 帧协议照 fleet-dao docs/reference/adapters.md 第八节。完工判据借旧仓 windsurf-dao 的 scripts/lib/mirasim-runtime.mjs
// judgeCompletion：phase 到 done 且没有 error、没有 incomplete；走中继的还要账本里起针后有 2xx 行。
//
//   node second-opinion.mjs --pr 50 --high-risk [--repo <检出>] [--ui] [--round 1] [--timeout-min 45] [--slot 2]
//   node second-opinion.mjs --text 分析.md [--name 短名]   拍板前的反方：把分析喂给另一家，退出码 0 同意 / 1 有异议 / 2 没查成
//   node second-opinion.mjs --selftest [--repo <检出>]
//   --repo 不给就用当前目录所在的 git 检出。
//
// 退出码：0 通过；1 必须改；2 没查成；3 PR 审查没开（不带 --high-risk）。连不上、没起来、超时、结论认不出、账本对不上、
// 有调用没走中继，一律 2，不当通过。这台机器没装、没开 Mirasim，没装、没登录 cursor-agent，就换下一家；几家都用不了照实报。

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cursorAgentProblem, dataDir, findBin, NotInstalled } from './tools.mjs';
import { missingWalkthrough } from './walkthrough.mjs';

const DATA = dataDir();
const RUNS = join(DATA, 'runs');
const MIRA = join(homedir(), '.mirasim');
const PROFILES = {
  // 写码是 Claude，第二意见换厂商；GPT 不碰界面，界面类走 Gemini（创始人 2026-09-25 拍）。
  code: { agent: 'codex', model: 'gpt-6-luna', route: 'cloud' },
  // 同一个上游没有 gpt-6-luna 时顶上来（2026-09-26 实测 relay 回 503 no upstream available for model "gpt-6-luna"）
  code5: { agent: 'codex', model: 'gpt-5.6-luna', route: 'cloud' },
  // Mirasim 那条上游挂了时换渠道：Cursor 订阅里的 gpt-5.6-luna，走本机 cursor-agent 命令行、只读模式（创始人 2026-09-26 提）
  cursor: { agent: 'cursor-cli', model: 'gpt-5.6-luna-high', route: 'local' },
  // 讨论要多家时点名用（同走 Cursor 订阅）：--agent glm / --agent kimi3
  glm: { agent: 'cursor-cli', model: 'glm-5.2-high', route: 'local' },
  kimi3: { agent: 'cursor-cli', model: 'kimi-k3-high', route: 'local' },
  grok: { agent: 'cursor-cli', model: 'grok-4.7-medium', route: 'local' },
  ui: { agent: 'antigravity', model: 'gemini-3.8-flash-high', route: null },
  // pi 吃服务端默认模型（kimi-k3），不点名（adapters.md pi 一节）
  kimi: { agent: 'pi', model: null, route: 'cloud' },
};
const DONE = new Set(['done', 'complete', 'completed']);
const FAILED = new Set(['error', 'failed', 'aborted', 'cancelled', 'canceled']);

class NotChecked extends Error {}

// 主审连不上就换下一家（创始人 2026-09-25：一个渠道不生效，讨论和审查的主体就换）。
// 只在「上游没有可用的」这类连不上时换；审出结论、认不出结论、超时都不换，照原样报。
const FALLBACK = ['code', 'cursor', 'code5', 'kimi'];
// 「模型满载」也算连不上（2026-09-26：codex 快照报 done 带 incomplete「Selected model is at capacity」，没换人直接判没查成）。
export const UNAVAILABLE =
  /\b(502|503|529)\b|no upstream available|Service Unavailable|overloaded|at capacity|try a different model/i;
function pickProfile(name) {
  const p = PROFILES[name];
  if (!p) throw new NotChecked(`不认识的 --agent ${name}（code / code5 / kimi / ui）`);
  return p;
}
function prProfiles(o) {
  if (o.agent) return [pickProfile(o.agent)];
  if (o.ui) return [PROFILES.ui]; // 界面类只给 Gemini，不拿别家顶
  return FALLBACK.map((k) => PROFILES[k]);
}
async function withFallback(chain, log, run) {
  const misses = [];
  for (const p of chain) {
    const who = `${p.agent}/${p.model ?? '服务端默认'}`;
    try {
      const r = await run(p);
      if (misses.length) r.fallbackNote = `主审连不上换了人：${misses.join('；')}`;
      return { ...r, profile: p };
    } catch (e) {
      // 这台机器没装、没开、没登录这一家要的工具：和连不上一样换下一家，原因照实记下
      if (e instanceof NotInstalled) {
        misses.push(`${who}：${e.message}`);
        log(`${who} 用不了（${e.message}），换下一家`);
        continue;
      }
      if (!(e instanceof NotChecked) || !UNAVAILABLE.test(e.message)) throw e;
      misses.push(`${who} 连不上`);
      log(`${who} 连不上（${e.message.slice(0, 160)}），换下一家`);
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
    const chain = o.agent ? [pickProfile(o.agent)] : FALLBACK.map((k) => PROFILES[k]);
    const r = await withFallback(
      chain,
      (s) => console.error(s),
      (p) =>
        runSession({
          prompt: o.blind ? blindPrompt(material) : critiquePrompt(material),
          profile: p,
          workdir: dir,
          timeoutMin: o.timeoutMin,
          log: (s) => console.error(s),
          pollMs: 1_000,
          effort: o.effort,
        }),
    );
    const profile = r.profile;
    const v = o.blind ? (r.text.trim() ? { agree: true, objections: 0 } : null) : parseCritique(r.text);
    const head = [
      `# ${o.blind ? '盲答' : '反方'}：${name}`,
      '',
      `- 题面：${src}`,
      `- 会话：${r.sessionKey}（${r.model ?? profile.model ?? '服务端默认'}，思考强度 ${o.effort ?? '默认'}）${r.fallbackNote ? `；${r.fallbackNote}` : ''}`,
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

// Windows 上 Git Bash 留下的几个环境变量：cursor-agent 靠它们猜「当前是不是 bash 环境」，猜完拿它跑钩子的 stdin 转发脚本，
// 那脚本本身是 PowerShell 语法，交给 bash 的 eval 直接语法错、钩子判失败＝把这次调用拦掉（agents/hooks/pretool.mjs 的
// 头几行有同一条注释，附了论证：2026-09-28 本机实测——同一次调用，父进程环境里有没有这几个变量，钩子是崩还是正常跑，
// 只差这几个变量在不在）。本机会话大多是从 Git Bash 起的，spawn 默认整份带过去；这里起 cursor-agent 时摘掉，让它
// 猜成本机原生的壳（PowerShell/cmd），钩子才跑得动。摘的是环境变量，不是钩子本身的判断——密钥路径那些规矩照样生效。
export function cursorAgentEnv(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return env;
  const out = { ...env };
  for (const k of ['SHELL', 'MSYSTEM', 'MSYSTEM_PREFIX', 'MSYSTEM_CHOST', 'TERM']) delete out[k];
  return out;
}

// cursor-agent 只读跑一轮：题面写进工作目录里的临时文件（Windows 命令行长度有限），让它读文件照做。
// 退出码非 0、超时、没有输出都算没查成；错误原文带上，供换人判断是不是「连不上」。
function runCursor({ prompt, profile, workdir, timeoutMin, log }) {
  const problem = cursorAgentProblem();
  if (problem) return Promise.reject(new NotInstalled(problem));
  const file = join(workdir, `.second-opinion-prompt-${process.pid}.md`);
  writeFileSync(file, prompt);
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
      `读工作目录里的 ${file.split(/[\\/]/).pop()}，完全照里面的要求做，按里面要求的格式作答。`,
    ];
    const child = spawn('cursor-agent', args, {
      cwd: workdir,
      windowsHide: true,
      shell: process.platform === 'win32',
      env: cursorAgentEnv(),
    });
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
      rmSync(file, { force: true });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (code !== 0)
        return rejectP(new NotChecked(`cursor-agent 退出码 ${code}：${(err || out).trim().slice(0, 400)}`));
      if (!out.trim())
        return rejectP(new NotChecked(`cursor-agent 退出码 0 但没有输出：${err.trim().slice(0, 400)}`));
      log(`[${secs}s] done（cursor ${profile.model}）`);
      resolveP({
        text: out,
        sessionKey: `cursor:${process.pid}`,
        model: profile.model,
        ledgerNote: '走 Cursor 订阅（本机 cursor-agent），不经 Mirasim 账本',
        usage: `${secs} 秒`,
      });
    });
  });
}

async function runSession({ prompt, profile, workdir, timeoutMin, log, pollMs = 10_000, effort }) {
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
  const ack = await wire.waitFor((m) => m.type === 'accepted' || m.type === 'error', 120_000);
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

/** 贴之前按仓里的卫生检查扫一遍：名单读不到、没扫成、扫出东西，一律抛（不贴）。loadOpts 只给自测用。 */
export async function checkPublishable(repo, body, loadOpts = {}) {
  const scan = await import(pathToFileURL(join(repo, 'packages', 'hygiene', 'src', 'scan.ts')).href);
  const values = await import(pathToFileURL(join(repo, 'packages', 'hygiene', 'src', 'values.ts')).href);
  const loaded = values.loadSensitiveValues(loadOpts);
  if (!loaded.ok) throw new Error(`卫生检查没法做（${loaded.reason}），没贴`);
  const report = scan.scanFiles(
    ['second-opinion.md'],
    () => Buffer.from(body, 'utf8'),
    undefined,
    loaded.values,
  );
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
    else if (a === '--text') o.text = argv[++i];
    else if (a === '--name') o.name = argv[++i];
    else if (a === '--effort') o.effort = argv[++i];
    else if (a === '--agent') o.agent = argv[++i];
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
  // 卫生检查：名单读不到不贴、扫出名单上的值不贴、干净的放行（名单是假的，不碰本机那份；卫生检查的代码用 repo 里那份）
  const fakeList = {
    env: {},
    home: 'FAKEHOME',
    exists: (p) => p.startsWith('FAKEHOME') && p.endsWith('sensitive-values.txt'),
    read: () => 'SECRETVAL-9f3a\n',
  };
  const rejects = async (p) =>
    p.then(
      () => false,
      () => true,
    );
  eq(
    await rejects(checkPublishable(repo, '干净的正文', { env: {}, home: 'FAKEHOME', exists: () => false })),
    true,
    '名单读不到不贴',
  );
  eq(
    await rejects(checkPublishable(repo, '里面有 SECRETVAL-9f3a 这个值', fakeList)),
    true,
    '扫出名单上的值不贴',
  );
  eq(await rejects(checkPublishable(repo, '干净的正文', fakeList)), false, '干净的放行');
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
  if (o.text) return await critique({ ...o, timeoutMin: o.timeoutMin === 45 ? 20 : o.timeoutMin });
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
      `- 会话：${r.sessionKey}（${r.model ?? r.profile.model ?? '服务端默认'}）${r.fallbackNote ? `；${r.fallbackNote}` : ''}`,
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
            r.model ?? r.profile.model ?? '服务端默认',
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
