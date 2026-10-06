// second-opinion.mjs 拆出来的：起会话、等它答完。走本机 Mirasim 的（帧协议照 fleet-dao docs/reference/adapters.md 第八节：
// 连口、订阅快照、核账本、跑完删会话），和不经 Mirasim 的两家（reclaude、cursor-agent）。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_STALL_MIN,
  errCode,
  isObjectLike,
  MIRA,
  messageOf,
  NotChecked,
  RETRYABLE_START,
  RetryableStart,
  Stalled,
} from './so-common.mjs';
import { judgeLedger, judgeSnapshot } from './so-verdict.mjs';
import { cursorAgentEnv, cursorAgentProblem, findBin, NotInstalled } from './tools.mjs';

/** @typedef {import('./so-common.mjs').Profile} Profile */
/** @typedef {import('./so-common.mjs').SessionResult} SessionResult */
/** @typedef {import('./so-common.mjs').SessionOpts} SessionOpts */
/** @typedef {import('./so-common.mjs').Log} Log */
/** @typedef {import('./so-verdict.mjs').LedgerRow} LedgerRow */
/**
 * 从 Mirasim 的 ws 读回来的一帧：按协议文档（adapters.md 第八节）写的字段，用到的地方原来就有显式判断。
 * @typedef {{ type?: string, state?: { agentsAvailable?: unknown, version?: string }, snapshot?: unknown, patch?: { full?: unknown }, sessionKey?: string, message?: string, sessions?: { sessionKey: string, title?: unknown, runState?: unknown }[], relay?: { usage?: { windows?: { label?: string, usedPercent?: number }[] } } }} Frame
 */
/** @typedef {{ phase: string | null, text: string, toolCalls: number, error: string | null, incomplete: boolean, model: string | null, interactions: unknown[], updatedAt: unknown }} SessionView 一帧快照整理出来的会话现状 */

/**
 * @param {Frame | null | undefined} msg
 * @returns {SessionView | null}
 */
function viewOf(msg) {
  const full =
    msg?.type === 'snapshot' ? msg.snapshot : msg?.type === 'session' ? msg.patch?.full : undefined;
  if (!isObjectLike(full)) return null;
  const phase =
    typeof full.phase === 'string' && full.phase
      ? full.phase
      : typeof full.runState === 'string'
        ? full.runState
        : null;
  /** @type {string | null} */
  let error = null;
  if (typeof full.error === 'string' && full.error) error = full.error;
  else if (isObjectLike(full.error) && typeof full.error.message === 'string') error = full.error.message;
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
  /** @param {string} url */
  constructor(url) {
    /** @type {Frame[]} 还没人要的帧 */
    this.queue = [];
    /** @type {{ pred: (m: Frame) => boolean, ok: (m: Frame | null) => void }[]} 在等某一帧的人 */
    this.waiters = [];
    /** @type {boolean | null} */
    this.closed = null;
    this.ws = new WebSocket(url);
    /** @type {Promise<void>} */
    this.opened = new Promise((ok, bad) => {
      this.ws.onopen = () => ok();
      this.ws.onerror = () => bad(new NotChecked('连不上本机 Mirasim 的 ws'));
    });
    this.ws.onmessage = (ev) => {
      /** @type {Frame} */
      let m;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0]?.ok(m);
      else this.queue.push(m);
    };
    this.ws.onclose = () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w.ok(null);
    };
  }
  /** @param {Record<string, unknown>} obj */
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
  /**
   * 等一帧；超时或连接断了回 null（调用方判没查成）。
   * @param {(m: Frame) => boolean} pred
   * @param {number} ms
   * @returns {Promise<Frame | null>}
   */
  waitFor(pred, ms) {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0] ?? null);
    if (this.closed) return Promise.resolve(null);
    return new Promise((ok) => {
      /** @type {{ pred: (m: Frame) => boolean, ok: (m: Frame | null) => void }} */
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
/** @returns {Promise<{ url: string, wire: Wire, state: NonNullable<Frame['state']> }>} */
async function connect() {
  if (!existsSync(MIRA)) throw new NotInstalled(`这台机器没装 Mirasim（没有 ${MIRA}）`);
  const dir = join(MIRA, 'run');
  /** @type {string[]} */
  let files;
  try {
    files = readdirSync(dir).filter((f) => /^local-\d+\.token$/.test(f));
  } catch (e) {
    throw new NotInstalled(`本机 Mirasim 没开（读不到 ${dir}：${errCode(e) ?? messageOf(e)}）`);
  }
  if (files.length === 0) throw new NotInstalled(`本机 Mirasim 没开（${dir} 里没有令牌文件）`);
  files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
  /** @type {string[]} */
  const tried = [];
  for (const f of files) {
    const port = /(\d+)/.exec(f)?.[1] ?? '';
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

/**
 * @param {string} url
 * @param {string} sessionKey
 * @returns {Promise<SessionView | null>}
 */
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

/**
 * @param {string} url
 * @returns {Promise<number | null>}
 */
async function relayUsage(url) {
  const wire = new Wire(url);
  try {
    await wire.opened;
    wire.send({ type: 'clientHello' });
    wire.send({ type: 'getRelay' });
    const m = await wire.waitFor((x) => x.type === 'relay' && Array.isArray(x.relay?.usage?.windows), 15_000);
    const w7 = m?.relay?.usage?.windows?.find((w) => w.label === '7d');
    return w7 && w7.usedPercent !== undefined && Number.isFinite(w7.usedPercent) ? w7.usedPercent : null;
  } catch {
    return null;
  } finally {
    wire.close();
  }
}

/**
 * @param {string} uuid
 * @returns {{ readable: true, rows: LedgerRow[] } | { readable: false, why: string }}
 */
function readLedger(uuid) {
  const dir = join(MIRA, 'traffic', uuid);
  /** @type {string[]} */
  let files;
  try {
    files = readdirSync(dir).filter((f) => /^index-.*\.ndjson$/.test(f));
  } catch (e) {
    return { readable: false, why: `读不到账本目录（${errCode(e) ?? messageOf(e)}）` };
  }
  /** @type {LedgerRow[]} */
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

// ---------- 各家怎么跑 ----------

// cursorAgentEnv 挪到 tools.mjs 了（ask.mjs、second-opinion.mjs 两边起 cursor-agent 都要用，见那边的注释）；
// second-opinion.mjs 顶部 re-export 了它，用法不用变。

/**
 * 从 reclaude --output-format json 的结果里取正文；形状认不出就明确失败。
 * @param {unknown} raw
 * @returns {string}
 */
export function parseReclaudeOutput(raw) {
  const source = String(raw ?? '').trim();
  if (!source) throw new NotChecked('reclaude 退出码 0 但没有输出');
  /** @type {unknown[]} */
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
  /**
   * @param {unknown} value
   * @returns {string}
   */
  const textOf = (value) => {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) {
      const parts = value.map(textOf).filter(Boolean);
      return parts.join('\n').trim();
    }
    if (!isObjectLike(value)) return '';
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

/**
 * @param {Pick<SessionOpts, 'prompt' | 'workdir' | 'timeoutMin' | 'log'>} opts
 * @returns {Promise<SessionResult>}
 */
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
      // 机器派的会话：开会话和落盘的钩子（session-start.mjs、prompt-log.mjs）认 FLEET_WORKER，不把它的题面当创始人的话落盘
      env: { ...process.env, FLEET_WORKER: '1' },
    });
    let out = '';
    let err = '';
    let settled = false;
    child.stdin.on('error', () => {
      // 执行体提前退出时写 stdin 会 EPIPE，最终以退出码和 stdout 为准。
    });
    child.stdin.end(prompt);
    /**
     * @template T
     * @param {(v: T) => void} fn
     * @param {T} value
     */
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
    child.stdout.on('data', (/** @type {Buffer} */ d) => (out += d));
    child.stderr.on('data', (/** @type {Buffer} */ d) => (err += d));
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
/**
 * @param {Pick<SessionOpts, 'prompt' | 'profile' | 'workdir' | 'timeoutMin' | 'log'>} opts
 * @returns {Promise<SessionResult>}
 */
function runCursor({ prompt, profile, workdir, timeoutMin, log }) {
  const problem = cursorAgentProblem();
  if (problem) return Promise.reject(new NotInstalled(problem));
  const model = profile.model;
  // 走 cursor-cli 的几家档案都写了模型；没写就不起（原来会把 null 当参数交给 cursor-agent）
  if (model === null)
    return Promise.reject(new NotChecked(`${profile.agent} 的档案没写模型，不知道让 cursor-agent 用哪个`));
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
      model,
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
    child.stdout.on('data', (/** @type {Buffer} */ d) => (out += d));
    child.stderr.on('data', (/** @type {Buffer} */ d) => (err += d));
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

/**
 * @param {SessionOpts} opts
 * @returns {Promise<SessionResult>}
 */
export async function runSession({
  prompt,
  profile,
  workdir,
  timeoutMin,
  log,
  pollMs = 10_000,
  stallMin = DEFAULT_STALL_MIN,
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
  // 协议里 accepted 帧一定带会话号；没带就明说，别拿 undefined 去订阅、读账本
  if (typeof sessionKey !== 'string' || !sessionKey)
    throw new NotChecked(`Mirasim 应了、却没给会话号：${JSON.stringify(ack)}`);
  const secs = () => `${((Date.now() - since) / 1000).toFixed(1)}s`;
  log(
    `[${secs()}] 会话 ${sessionKey} 起了（${profile.agent} / ${profile.model} / 路由 ${profile.route ?? '自动'}）`,
  );

  try {
    return await pollSession({
      profile,
      url,
      sessionKey,
      since,
      timeoutMin,
      pollMs,
      log,
      before,
      secs,
      stallMin,
    });
  } finally {
    // 一次性会话：成没成、超没超时，跑完一律删掉（账本在 pollSession 里已经读完），不留在会话列表里。
    // --keep-session 是排查用的例外：会话留着，自己去 Mirasim 里看，看完 `--stop-stale` 清掉。
    if (!KEEP_SESSION) await forget(url, sessionKey, log);
  }
}

/**
 * 等的那几步（读快照、发停止、读用量、睡一下、看钟）：测试换成假的，用假钟不真等几分钟。
 * @typedef {{ readView: (url: string, sessionKey: string) => Promise<SessionView | null>, stop: (url: string, sessionKey: string) => Promise<void>, relayUsage: (url: string) => Promise<number | null>, sleep: (ms: number) => Promise<void>, now: () => number }} PollIo
 */
/** @type {PollIo} */
const REAL_IO = {
  readView,
  stop,
  relayUsage,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

/**
 * 等一个会话答完。「连续 stallMin 分钟没有任何新输出」就判这家没查成（抛 Stalled，withFallback 当场换下一家）：
 * 进展 = 阶段、正文长度、工具调用数、updatedAt 任何一样变了。原来这里写死 10 分钟，#1056 当天 deepseek、grok 起了会话就卡在
 * streaming，一家 8 分钟还没换（创始人 2026-10-05 嫌慢，改成默认 4 分钟、可用 --stall-min 调）。
 * @param {{ profile: Profile, url: string, sessionKey: string, since: number, timeoutMin: number, pollMs: number, log: Log, before: number | null, secs: () => string, stallMin?: number, io?: PollIo }} opts
 * @returns {Promise<SessionResult>}
 */
export async function pollSession({
  profile,
  url,
  sessionKey,
  since,
  timeoutMin,
  pollMs,
  log,
  before,
  secs,
  stallMin = DEFAULT_STALL_MIN,
  io = REAL_IO,
}) {
  const deadline = since + timeoutMin * 60_000;
  let lastSig = '';
  let lastChange = io.now();
  /** @type {string | null} */
  let lastPhase = '';
  let misses = 0;
  /** @type {SessionView | null} */
  let view = null;
  for (;;) {
    await io.sleep(pollMs);
    view = await io.readView(url, sessionKey);
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
    if (verdict.status === 'failed') {
      if (view.incomplete && view.error && RETRYABLE_START.test(view.error))
        throw new RetryableStart(`会话 ${sessionKey} ${verdict.why}（启动没成，还没开始审）`);
      throw new NotChecked(`会话 ${sessionKey} ${verdict.why}`);
    }
    const sig = `${view.phase}|${view.text.length}|${view.toolCalls}|${view.updatedAt}`;
    if (sig !== lastSig) {
      lastSig = sig;
      lastChange = io.now();
    }
    const stalled = io.now() - lastChange > stallMin * 60_000;
    if (stalled || io.now() > deadline) {
      await io.stop(url, sessionKey);
      const pending = view.interactions.length
        ? `；会话里有 ${view.interactions.length} 个在等人回答的交互`
        : '';
      if (stalled)
        throw new Stalled(`会话 ${sessionKey} ${stallMin} 分钟没出声，已发停止${pending}`, stallMin);
      throw new NotChecked(`会话 ${sessionKey} ${timeoutMin} 分钟没跑完，已发停止${pending}`);
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
    await io.sleep(1_000);
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
  const after = await io.relayUsage(url);
  const usage =
    before != null && after != null ? `中继 7 天窗 ${before}% → ${after}%` : '中继 7 天窗用量没读到';
  return { sessionKey, text: view.text, model: view.model, ledgerNote, usage };
}

/**
 * @param {string} url
 * @param {string} sessionKey
 */
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
 * 把会话连它的目录和账本一起删掉（Mirasim 的 deleteSession）。会话每次都是一次性的：跑完就删，
 * 不留在会话列表里等人来清（创始人 2026-10-03：「在 mirasim 起一个会话，我根本不想看见它，并且我希望随时能清理掉」）。
 * 删之前账本要先读完（traffic/<uuid> 跟会话一起没）。删不掉不当成失败——结论已经拿到了，只如实说一句。
 * @param {string} url
 * @param {string} sessionKey
 * @param {Log | undefined} log
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
    log?.(`会话 ${sessionKey} 没删掉：${messageOf(e)}`);
  } finally {
    wire.close();
  }
}

/**
 * 列本机 Mirasim 的会话（走 listSessions 帧）。读不到就抛，不当成「一个也没有」。
 * @returns {Promise<NonNullable<Frame['sessions']>>}
 */
export async function listSessions() {
  const { wire } = await connect();
  try {
    wire.send({ type: 'listSessions' });
    const m = await wire.waitFor((x) => x.type === 'sessions' && Array.isArray(x.sessions), 20_000);
    if (!m) throw new NotChecked('本机 Mirasim 没回会话列表（20 秒）');
    const sessions = m.sessions;
    if (!Array.isArray(sessions)) throw new NotChecked('本机 Mirasim 回的会话列表认不出');
    return sessions;
  } finally {
    wire.close();
  }
}

/** 反方跑出来的会话都带这个开头（critiquePrompt 的第一句），用来认哪些是我们留下的。 */
export const OUR_SESSION_TITLE = /^你是「反方」/;

/**
 * 跑完删不删会话。默认删（一次性会话，不留在 Mirasim 列表里等人清）；`--keep-session` 留着排查用。
 * 模块级布尔而不是逐层传参：runSession 在好几个地方起会话，参数表已经很长，这个开关只有「删不删」一个意思。
 * 入口按命令行用 setKeepSession 设它（别的模块改不了这里的 let）。
 */
let KEEP_SESSION = false;
/** @param {boolean} keep */
export function setKeepSession(keep) {
  KEEP_SESSION = keep;
}

/**
 * 清掉我们（反方）留下的旧会话：只删已经停的（running 的不动，可能正有人等着看）。
 * @param {Log} log
 */
export async function stopStale(log) {
  const { url } = await connect();
  const sessions = await listSessions();
  const ours = sessions.filter((s) => OUR_SESSION_TITLE.test(String(s.title ?? '')));
  const running = ours.filter((s) => s.runState === 'running');
  const done = ours.filter((s) => s.runState !== 'running');
  for (const s of done) await forget(url, s.sessionKey, log);
  return { deleted: done.length, stillRunning: running.length };
}
