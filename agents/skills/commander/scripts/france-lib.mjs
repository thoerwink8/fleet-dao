// 法国引擎页（#328）的本机这头：从哪台机器读（ssh 名字）、经 ssh 跑查询脚本、回来的认不认得、抹字、断链怎么判、页面要的
// 汇总，页面服务里「多久读一次」的那份缓存，和页面服务本身（server.mjs 是它的外壳）。在法国上跑的查询脚本是
// france-query.mjs；页面是 france.html；命令行是 france.mjs。
// 改这里之前必须知道：
// - 这是驾驶舱正式版（#216 每步耗时和额度、#199 帅位栏）上线前的过渡页：那两张上线后整页停用，这份和 france-query.mjs、
//   france.html、france.mjs、server.mjs 一起删。
// - 读不到一律明说「没读到」和原因，kind 分得开：not-configured、bad-config、no-script、ssh-failed、timeout、query-failed、
//   bad-json、bad-shape；一块没读到只标那一块。不拿空、0 顶。
// - 额度的算法跟 packages/shared/src/usage.ts 走（输入当量的折法、没读到另记次数、花费按计费方式分开）：
//   agents/test/france.test.ts 拿那边的 summarizeUsage 核对。探针过期线跟 shared 的 routeProbeStaleMinutes 走，也核对。
// - 定时任务新不新鲜照 packages/db 的 scheduleHealth（看门狗 #203、驾驶舱定时任务页同一条线）。
// - 页面上的字都过 scrubText（邮箱、IP、令牌、长串抹掉）；ssh 的名字不上页面（可能写的是 IP）。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { APP, SCHEMA, SQL, UNITS } from './france-query.mjs';

/** @import { ChildProcessByStdio } from 'node:child_process' */
/** @import { Readable, Writable } from 'node:stream' */
/** @typedef {ChildProcessByStdio<Writable, Readable, Readable>} PipedChild 三条管道都开着的子进程 */
/** @typedef {(command: string, args: string[], options: { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: boolean }) => PipedChild} SpawnPiped spawn 的这一种用法（测试里换成假的） */

// 类型只写在 JSDoc 里（这份文件被原样装到机器上、纯 node 直接跑，没有编译步骤）；agents/tsconfig.json 用 checkJs 过严格检查。
// 「法国回来的」那几份形状在 parseSnapshot 里运行时逐项核过才认，核过之后才当成下面这些类型用。

/** @typedef {{ ok: false, kind: string, why: string }} Failure 没做成：kind 见文件头那一串；why 是给人看的原因 */

/**
 * 库里每个定时任务最近一次的某条记录（没有就是 null）。
 * @typedef {{ started_at: string, ended_at?: string | null, outcome?: string | null, why?: string | null }} JobRunFact
 */
/** @typedef {{ repo: string, n: number, title: string, state: string, phase?: string | null, doing?: string | null, last_problem?: string | null, created_at: string, updated_at?: string | null }} TaskRow */
/** @typedef {{ repo?: string | null, n?: number | null, stage: string, route_id: string, model?: string | null, model_name?: string | null, host?: string | null, pool?: string | null, billing?: string | null, actual_model?: string | null, queued_at: string, started_at?: string | null, ended_at?: string | null, input_tokens?: number | null, output_tokens?: number | null, cache_read_tokens?: number | null, cache_write_tokens?: number | null, cost_usd?: number | null, session_cost_usd?: number | null, outcome?: string | null, failure_code?: string | null, failure_message?: string | null, subtask_index?: number | null, subtask_title?: string | null }} RunRow */
/** @typedef {{ level: string, dedupe_key: string, title: string, body?: string | null, link?: string | null, created_at: string, updated_at?: string | null, n?: number | null }} NotificationRow */
/** @typedef {{ id: string, name: string, schedule: string, every: number, last_run?: JobRunFact | null, last_finished?: JobRunFact | null, last_success?: JobRunFact | null }} JobRow */
/** @typedef {{ id: string, pool: string, model: string, host: string, alive: boolean, probe_state?: string | null, probed_at?: string | null, probe_detail?: string | null, org_kind?: string | null, channel_enabled: boolean, billing: string, in_use: boolean }} RouteRow */
/** @typedef {{ at: string, action: string, ok: boolean, from_org?: string | null, to_org?: string | null, error?: string | null }} OrgAuditRow */
/** @typedef {{ repo: string, auto_dispatch_since?: string | null }} RepoRow */
/** @typedef {{ at: string, text: string }} RoundRow */
/** @typedef {{ unit: string, state: string }} ServiceUnit */

/** @typedef {{ head: string, headAt: string, checkedAt: string, commits: [string, string][] }} MainFacts */
/** @typedef {{ sha: string, verdict: 'green' | 'red' | 'pending' | 'unknown', detail: string, checkedAt: string }} CiFacts */
/** @typedef {{ since: string, sha: string, event: string, unmerged: boolean }} HoldFacts */
/** @typedef {{ sha: string, startedAt: string, endedAt?: string | null, detail?: string | null, result: 'running' | 'ok' | 'failed', supersededBy?: { sha: string, at: string } | null }} AttemptFacts */
/** @typedef {{ commit?: string | null, at: string, detail: string, result: 'ok' | 'failed' | 'unchecked' }} RulesFacts */
/** @typedef {{ error: string } | { appliedSha: string, oldestAt?: string | null, behind: number }} SystemFacts */
/** @typedef {{ action: string, detail: string, at: string }} LastFacts */
/** @typedef {{ checkedAt: string, result: string, drift: string[], unchecked: string[] }} ConfigFacts */
/**
 * 自动发布的读数（deploy/france/auto-release/lib.mjs 写的状态文件，france-query.mjs 带回来）。
 * @typedef {{ schema: 1, ranAt: string, main: MainFacts | null, mainError: string | null, ci: CiFacts | null, hold?: HoldFacts | null, waitingSince?: string | null, attempt?: AttemptFacts | null, rules: RulesFacts | null, system: SystemFacts | null, last: LastFacts | null, config?: ConfigFacts | null }} AutoReleaseState
 */

/**
 * 一块：读到了是 { ok: true, ...内容 }，没读到是 { ok: false, why }。
 * @template T
 * @typedef {({ ok: true } & T) | { ok: false, why: string }} Section
 */
/**
 * @typedef {{
 *   db: Section<{ now: string, readOnly: string }>,
 *   tasks: Section<{ rows: TaskRow[] }>,
 *   runs: Section<{ rows: RunRow[] }>,
 *   notifications: Section<{ count: number, rows: NotificationRow[] }>,
 *   jobs: Section<{ rows: JobRow[] }>,
 *   routes: Section<{ rows: RouteRow[] }>,
 *   orgAudit: Section<{ rows: OrgAuditRow[] }>,
 *   repos: Section<{ rows: RepoRow[] }>,
 *   services: Section<{ units: ServiceUnit[] }>,
 *   current: Section<{ sha: string }>,
 *   autoRelease: Section<{ state: AutoReleaseState }>,
 *   rounds: Section<{ since: string, rows: RoundRow[] }>,
 * }} Sections
 */
/** @typedef {keyof Sections} SectionName */
/** @typedef {{ at: string, sections: Sections }} Snapshot parseSnapshot 认过的一份 */

/**
 * 「额度」那几处吃的会话：toRun 整理出来的样子（字段名是驼峰），可空的都可以缺。
 * @typedef {{ model?: string | null, modelName?: string | null, stage: string, queuedAt: string, startedAt?: string | null, endedAt?: string | null, inputTokens?: number | null, outputTokens?: number | null, cacheReadTokens?: number | null, cacheWriteTokens?: number | null, billing?: string | null, costUsd?: number | null }} UsageRun
 */
/** @typedef {{ runs: number, usd: number, missing: number }} CostShare */
/**
 * @typedef {{ runs: number, running: number, notStarted: number, inputTokens: number, outputTokens: number, missingTokens: number, cacheReadTokens: number, cacheWriteTokens: number, missingCache: number, inputEquivalent: number, missingEquivalent: number, costUsd: number, missingCost: number, cost: { metered: CostShare, subscription: CostShare, unknown: CostShare }, estimate: { runs: number, usd: number, noPrice: number, noTokens: number }, queueMs: number, runMs: number, missingTime: number, noQueue: number }} Totals
 */

/** @typedef {{ level: 'bad' | 'note', what: string, where: string }} Issue */

export const ENV_NAME = 'FLEET_FRANCE_SSH';
/** 页面开着时多久从法国读一次。没人看就不读（不白连 ssh）。 */
export const REFRESH_MS = 30_000;
/** 一次 ssh 最多等多久：连接 10 秒，查询平时一两秒。 */
export const SSH_TIMEOUT_MS = 60_000;
/** 法国回来的最多收多少（平时十几万字节）。 */
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
export const REMOTE_COMMAND = 'node --input-type=module - --collect';

/** 各种「多久算不对」（分钟）。出处写在右边。 */
export const LIMITS = {
  /** 自动发布这么久没跑一轮：定时器停了、没装、跑崩了（packages/api 的 deploy-lag reportMs）。 */
  autoReleaseStale: 20,
  /** 一轮自动发布跑了这么久还没完（deploy-lag runningMs）。 */
  autoReleaseRunning: 60,
  /** 主线头这么久没读到（deploy-lag mainMs）。 */
  mainStale: 20,
  /** 装机脚本落后主线这么久要人重跑（deploy-lag systemMs）。 */
  systemBehind: 24 * 60,
  /** 会话跑了这么久还没完（法国巡查）。 */
  sessionRunning: 90,
  /** 会话登记了这么久还没起来。 */
  sessionStarting: 30,
  /** 这么久以内没成的会话列出来（法国巡查：近 3 小时）。 */
  failedLookback: 180,
  /**
   * 单在干活（running）、手上没有会话、这么久没动：多半停在等人或等一个派不出的路由（法国巡查：#293 那次停了 47 分钟没人知道）。
   */
  taskIdle: 20,
  /** 别的在跑状态（分诊、写方案、合并……）这么久没更新、又没有会话在跑，标一句留意。 */
  taskQuiet: 60,
};

/** 路由探针：平时每 15 分钟一轮，结论 45 分钟没更新算过期；贵的执行方式探通后隔 120 分钟再探（shared 的 web-api.ts）。 */
export const PROBE_EVERY = 15;
export const PROBE_STALE = 45;
/** @type {Record<string, number>} */
export const SLOW_PROBE_EVERY = { 'cursor-agent': 120, grok: 120, mirasim: 120 };
/** @param {string} host */
export const probeStaleMinutes = (host) =>
  (SLOW_PROBE_EVERY[host] ?? PROBE_EVERY) + PROBE_STALE - PROBE_EVERY;

// —— 给人看的名字（跟 engine 的 routing/names.ts、feishu 的 words.ts 走） ——

/** @type {Record<string, string>} */
export const STAGE_NAMES = {
  triage: '分诊',
  spec: '需求文档',
  plan: '规划',
  execute: '写码',
  ui: 'UI',
  review: '审查',
  verify: '开 PR 前验证',
  research: '调研',
  judge: '判断题',
};
/** 任务工作流三段（runs 表的 segment）对哪个阶段：对题 scope、动手 manual、验收 verify。 */
/** @type {Record<string, string>} */
const SEGMENT_STAGE = { scope: 'triage', manual: 'execute', verify: 'verify' };
/** @type {Record<string, string>} */
export const TASK_STATE_WORDS = {
  queued: '排队中',
  triaging: '在看需求',
  asking: '在等你们回答',
  planning: '在写方案',
  running: '在干活',
  merging: '在合并',
  done: '做完了',
  stopped: '已叫停',
  failed: '没做成',
  stalled: '卡住了',
};
/** @type {Record<string, string>} */
export const HOST_NAMES = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'cursor-agent': 'Cursor Agent',
  grok: 'Grok 命令行',
  mirasim: 'Mirasim',
  'api-shell': '接口外壳',
};
/** @type {Record<string, string>} */
export const ORG_NAMES = { solo: '独享', carpool: '拼车' };
/** @type {Record<string, string>} */
export const OUTCOME_WORDS = { ok: '成了', failed: '没成', stopped: '叫停了', stalled: '卡住了' };
/** @type {Record<string, string>} */
export const PROBE_WORDS = { ok: '探通了', failed: '没探通', not_wired: '插头没接', skipped: '没探' };
/** @type {string[]} */
export const TERMINAL = ['done', 'stopped', 'failed'];

/**
 * 各块的中文名：没读到时说「没读到：<名字>」。
 * @type {Record<SectionName, string>}
 */
export const SECTION_NAMES = {
  db: '库',
  tasks: '单子',
  runs: '会话',
  notifications: '提醒',
  jobs: '定时任务',
  routes: '路由',
  orgAudit: '切号记录',
  repos: '接活开关',
  services: '服务',
  current: '在用的版本',
  autoRelease: '自动发布的读数',
  rounds: '自动发布的日志',
};
/** 库查询的那几块（france-query.mjs 的 SQL 的键）。 */
const DB_SECTIONS = /** @type {SectionName[]} */ (Object.keys(SQL));
/** @type {SectionName[]} */
export const SECTIONS = [...DB_SECTIONS, 'services', 'current', 'autoRelease', 'rounds'];

/** @param {unknown} e */
const message = (e) => (e instanceof Error ? e.message : String(e));
/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * 抛出来的东西上的 code（ENOENT 这类）；不是带 code 的对象就是 undefined。
 * @param {unknown} e
 */
const errCode = (e) => (isObj(e) ? e.code : undefined);
/** @param {unknown} v */
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
/** @param {string} iso */
const ms = (iso) => Date.parse(iso);
/**
 * @param {string} fromIso
 * @param {string} toIso
 */
const minutesBetween = (fromIso, toIso) => Math.floor((ms(toIso) - ms(fromIso)) / 60_000);

// —— 抹字 ——

/**
 * 页面上、命令行里显示之前过这一道：令牌、密钥、邮箱、IP、长串抹掉（和 adapters 的 redact 同一套认法）。
 * @param {unknown} text
 */
export function scrubText(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <令牌>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<令牌>')
    .replace(/\b(?:sk|rk|pk|xai|tvly)-[A-Za-z0-9_-]{8,}/gi, '<密钥>')
    .replace(/\b(?:ghs|ghp|gho|ghu|ghr)_[A-Za-z0-9_]{8,}/g, '<令牌>')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}/g, '<令牌>')
    .replace(/\brck_[A-Za-z0-9_-]{8,}/g, '<密钥>')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '<密钥>')
    .replace(/([?&](?:token|key|access_token|api_key|secret|password)=)[^&\s"']+/gi, '$1<令牌>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<邮箱>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<IP>')
    .replace(/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, '<IP>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<长串>')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<长串>');
}

/**
 * 逐层抹：对象、数组里的每个字符串都过 scrubText。
 * @param {unknown} value
 * @returns {unknown}
 */
export function scrubDeep(value) {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v)]));
  return value;
}

// —— 从哪读 ——

/** @param {string} home */
export const configFile = (home) => join(home, '.fleet-dao', 'france-ssh');

/**
 * 登法国的 ssh 名字：环境变量 FLEET_FRANCE_SSH，其次 ~/.fleet-dao/france-ssh 的第一行（#299 定的放法，不进仓）。
 * 回 { ok: true, host } 或 { ok: false, kind, why }；原因里不带名字本身（可能写的是 IP）。
 * @param {{ env: Record<string, string | undefined>, home: string, readText: (file: string) => string }} io
 * @returns {{ ok: true, host: string } | Failure}
 */
export function readTarget({ env, home, readText }) {
  const fromEnv = env[ENV_NAME];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '')
    return checkHost(fromEnv.trim(), `环境变量 ${ENV_NAME}`);
  const file = configFile(home);
  let text;
  try {
    text = readText(file);
  } catch (e) {
    if (errCode(e) === 'ENOENT')
      return {
        ok: false,
        kind: 'not-configured',
        why: `这台机器没配登法国的 ssh 名字：在 ${file} 写一行 ~/.ssh/config 里的 Host 名（或设环境变量 ${ENV_NAME}）。手机、网页会话登不了法国，这一页看不了`,
      };
    return { ok: false, kind: 'bad-config', why: `${file} 读不了（${errCode(e) ?? message(e)}）` };
  }
  const line = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'));
  if (!line)
    return { ok: false, kind: 'bad-config', why: `${file} 是空的：写一行 ~/.ssh/config 里的 Host 名` };
  return checkHost(line, file);
}

/**
 * @param {string} host
 * @param {string} from
 * @returns {{ ok: true, host: string } | Failure}
 */
function checkHost(host, from) {
  // 不许以横线开头：挡住被 ssh 当成选项（-oProxyCommand=…）
  if (!/^[A-Za-z0-9_][A-Za-z0-9._@-]{0,200}$/.test(host))
    return {
      ok: false,
      kind: 'bad-config',
      why: `${from} 里的 ssh 名字认不出：只许字母、数字、点、横线、下划线、@，不许以横线开头`,
    };
  return { ok: true, host };
}

/**
 * ssh 的参数：不问口令（没钥匙就直接失败）、连 10 秒连不上就算。开压缩：本机到法国的线路慢（09-27 实测约 5KB/秒），
 * 回来的 JSON 压完小一大截，一次读从十几秒降到七秒上下（其中握手四秒多）。
 * @param {string} host
 */
export function sshArgs(host) {
  return [
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
    host,
    REMOTE_COMMAND,
  ];
}

/**
 * @param {unknown} text
 * @param {number} [n]
 */
const tail = (text, n = 2) =>
  scrubText(
    String(text ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-n)
      .join(' / '),
  );

/**
 * 起 ssh、把查询脚本从标准输入喂过去、收回标准输出。回 { ok: true, stdout } 或 { ok: false, kind, why }：
 * ssh-failed（起不了 ssh、ssh 自己报错，退出码 255）、timeout、query-failed（法国上的脚本没跑成）、bad-json（太大）。
 * @param {{ command: string, args: string[], script: string, timeoutMs?: number, maxBytes?: number, spawnImpl?: SpawnPiped }} opts
 * @returns {Promise<{ ok: true, stdout: string } | Failure>}
 */
export function runRemote({
  command,
  args,
  script,
  timeoutMs = SSH_TIMEOUT_MS,
  maxBytes = MAX_OUTPUT_BYTES,
  spawnImpl = spawn,
}) {
  return new Promise((resolve) => {
    /** @type {PipedChild} */
    let child;
    try {
      child = spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ ok: false, kind: 'ssh-failed', why: `起不了 ssh（${errCode(e) ?? message(e)}）` });
      return;
    }
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let timedOut = false;
    let tooBig = false;
    /** @param {{ ok: true, stdout: string } | Failure} value */
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('error', (e) =>
      finish({
        ok: false,
        kind: 'ssh-failed',
        why:
          errCode(e) === 'ENOENT'
            ? `本机找不到 ${command} 命令：装上 OpenSSH 客户端、放进 PATH`
            : `ssh 没起来（${errCode(e) ?? message(e)}）`,
      }),
    );
    child.stdout.on('data', (/** @type {Buffer} */ d) => {
      outBytes += d.length;
      if (outBytes > maxBytes) {
        tooBig = true;
        child.kill();
      } else out.push(d);
    });
    child.stderr.on('data', (/** @type {Buffer} */ d) => {
      errBytes += d.length;
      if (errBytes <= 64 * 1024) err.push(d);
    });
    child.on('close', (code, signal) => {
      const stderr = Buffer.concat(err).toString('utf8');
      if (timedOut)
        return finish({
          ok: false,
          kind: 'timeout',
          why: `ssh ${Math.round(timeoutMs / 1000)} 秒没回完（连不上法国，或法国上查得太慢），已经停了`,
        });
      if (tooBig)
        return finish({ ok: false, kind: 'bad-json', why: `法国回来的超过 ${maxBytes} 字节，不收` });
      if (code === 255)
        return finish({
          ok: false,
          kind: 'ssh-failed',
          why: `ssh 连不上法国：${tail(stderr) || '没说为什么'}`,
        });
      if (code !== 0)
        return finish({
          ok: false,
          kind: 'query-failed',
          why: `法国上的查询脚本没跑成（${code === null ? `被信号 ${signal} 停了` : `退出码 ${code}`}）：${tail(stderr) || '没说为什么'}`,
        });
      finish({ ok: true, stdout: Buffer.concat(out).toString('utf8') });
    });
    child.stdin.on('error', () => {}); // ssh 先退出时写管道会报 EPIPE：结局以 close 为准
    child.stdin.end(script);
  });
}

// —— 回来的认不认得 ——

/** @type {Record<string, (v: unknown) => boolean>} */
const TYPES = {
  str: (v) => typeof v === 'string',
  int: (v) => Number.isInteger(v),
  num: (v) => typeof v === 'number' && Number.isFinite(v),
  bool: (v) => typeof v === 'boolean',
  iso: isIso,
};
/** @typedef {{ [key: string]: string | ShapeSpec }} ShapeSpec 一个对象该有的键：'str'、'int?'（可空）、嵌套对象（可空） */
/** @type {ShapeSpec} */
const RUN_FACT = { started_at: 'iso', ended_at: 'iso?', outcome: 'str?', why: 'str?' };

/**
 * 按 spec 查一个对象：'str'、'int?'（可空）、嵌套对象（可空）。回第一处不对的描述，对就回 null。
 * @param {unknown} value
 * @param {ShapeSpec} spec
 * @param {string} at
 * @returns {string | null}
 */
function shapeProblem(value, spec, at) {
  if (!isObj(value)) return `${at} 不是对象`;
  for (const [key, want] of Object.entries(spec)) {
    const v = value[key];
    if (typeof want !== 'string') {
      if (v === null || v === undefined) continue;
      const p = shapeProblem(v, want, `${at}.${key}`);
      if (p) return p;
      continue;
    }
    const optional = want.endsWith('?');
    if (optional && (v === null || v === undefined)) continue;
    const typeName = want.replace('?', '');
    const check = TYPES[typeName];
    if (!check) throw new TypeError(`形状表里没有「${typeName}」这种类型（${at}.${key}）`);
    if (!check(v)) return `${at}.${key} 不是${typeName}`;
  }
  return null;
}

/**
 * @param {unknown} rows
 * @param {ShapeSpec} spec
 * @param {string} [at]
 * @returns {string | null}
 */
function rowsProblem(rows, spec, at = 'rows') {
  if (!Array.isArray(rows)) return `${at} 不是列表`;
  for (const [i, row] of rows.entries()) {
    const p = shapeProblem(row, spec, `${at}[${i}]`);
    if (p) return p;
  }
  return null;
}

/** @type {Record<'tasks' | 'runs' | 'notifications' | 'jobs' | 'routes' | 'orgAudit' | 'repos' | 'rounds', ShapeSpec>} */
const ROW_SPECS = {
  tasks: {
    repo: 'str',
    n: 'int',
    title: 'str',
    state: 'str',
    phase: 'str?',
    doing: 'str?',
    last_problem: 'str?',
    created_at: 'iso',
    updated_at: 'iso?',
  },
  runs: {
    repo: 'str?',
    n: 'int?',
    stage: 'str',
    route_id: 'str',
    model: 'str?',
    model_name: 'str?',
    host: 'str?',
    pool: 'str?',
    billing: 'str?',
    actual_model: 'str?',
    queued_at: 'iso',
    started_at: 'iso?',
    ended_at: 'iso?',
    input_tokens: 'num?',
    output_tokens: 'num?',
    cache_read_tokens: 'num?',
    cache_write_tokens: 'num?',
    cost_usd: 'num?',
    session_cost_usd: 'num?',
    outcome: 'str?',
    failure_code: 'str?',
    failure_message: 'str?',
    subtask_index: 'int?',
    subtask_title: 'str?',
  },
  notifications: {
    level: 'str',
    dedupe_key: 'str',
    title: 'str',
    body: 'str?',
    link: 'str?',
    created_at: 'iso',
    updated_at: 'iso?',
    n: 'int?',
  },
  jobs: {
    id: 'str',
    name: 'str',
    schedule: 'str',
    every: 'int',
    last_run: RUN_FACT,
    last_finished: RUN_FACT,
    last_success: RUN_FACT,
  },
  routes: {
    id: 'str',
    pool: 'str',
    model: 'str',
    host: 'str',
    alive: 'bool',
    probe_state: 'str?',
    probed_at: 'iso?',
    probe_detail: 'str?',
    org_kind: 'str?',
    channel_enabled: 'bool',
    billing: 'str',
    in_use: 'bool',
  },
  orgAudit: { at: 'iso', action: 'str', ok: 'bool', from_org: 'str?', to_org: 'str?', error: 'str?' },
  repos: { repo: 'str', auto_dispatch_since: 'iso?' },
  rounds: { at: 'iso', text: 'str' },
};

/** @type {readonly unknown[]} */
const ALERT_RESULTS = ['running', 'ok', 'failed'];
/** @type {readonly unknown[]} */
const CI_VERDICTS = ['green', 'red', 'pending', 'unknown'];
/** @type {readonly unknown[]} */
const RULES_RESULTS = ['ok', 'failed', 'unchecked'];

/**
 * 自动发布的读数（lib.mjs 写、packages/api 的 deploy-lag.ts 认的那几样）。回第一处不对的描述，对就回 null。
 * 下面每处先 isObj 再 shapeProblem：shapeProblem 对非对象回的也是「<键> 不是对象」，说法不变；先认一遍只为让类型跟上。
 * @param {unknown} s
 * @returns {string | null}
 */
export function autoReleaseProblem(s) {
  if (!isObj(s)) return '不是对象';
  if (s.schema !== 1) return `schema 是 ${JSON.stringify(s.schema)}，只认 1`;
  if (!isIso(s.ranAt)) return 'ranAt 不是时间';
  const main = s.main;
  if (main !== null) {
    if (!isObj(main)) return 'main 不是对象';
    const p = shapeProblem(main, { head: 'str', headAt: 'iso', checkedAt: 'iso' }, 'main');
    if (p) return p;
    const commits = main.commits;
    if (!Array.isArray(commits) || commits.length === 0) return 'main.commits 不是列表或是空的';
    if (
      !commits.every(
        (/** @type {unknown} */ c) => Array.isArray(c) && typeof c[0] === 'string' && isIso(c[1]),
      )
    )
      return 'main.commits 里有认不出的一项';
  }
  if (s.mainError !== null && typeof s.mainError !== 'string') return 'mainError 不是字符串';
  const ci = s.ci;
  if (ci !== null) {
    if (!isObj(ci)) return 'ci 不是对象';
    const p = shapeProblem(ci, { sha: 'str', detail: 'str', checkedAt: 'iso' }, 'ci');
    if (p) return p;
    if (!CI_VERDICTS.includes(ci.verdict)) return `ci.verdict 是 ${JSON.stringify(ci.verdict)}`;
  }
  // hold、waitingSince、attempt 是单元还会发版时写的；#1258 起新状态里没有这三项（undefined），老状态里有，两种都认
  if (s.hold != null) {
    const p = shapeProblem(s.hold, { since: 'iso', sha: 'str', event: 'str', unmerged: 'bool' }, 'hold');
    if (p) return p;
  }
  if (s.waitingSince != null && !isIso(s.waitingSince)) return 'waitingSince 不是时间';
  const attempt = s.attempt;
  if (attempt != null) {
    if (!isObj(attempt)) return 'attempt 不是对象';
    const p = shapeProblem(
      attempt,
      { sha: 'str', startedAt: 'iso', endedAt: 'iso?', detail: 'str?' },
      'attempt',
    );
    if (p) return p;
    if (!ALERT_RESULTS.includes(attempt.result)) return `attempt.result 是 ${JSON.stringify(attempt.result)}`;
    const by = attempt.supersededBy;
    if (by !== undefined && by !== null && !(isObj(by) && typeof by.sha === 'string'))
      return 'attempt.supersededBy 不是 { sha, at } 的样子';
  }
  const rules = s.rules;
  if (rules !== null) {
    if (!isObj(rules)) return 'rules 不是对象';
    const p = shapeProblem(rules, { commit: 'str?', at: 'iso', detail: 'str' }, 'rules');
    if (p) return p;
    if (!RULES_RESULTS.includes(rules.result)) return `rules.result 是 ${JSON.stringify(rules.result)}`;
  }
  const system = s.system;
  if (system !== null) {
    if (!isObj(system)) return 'system 不是对象';
    if (!('error' in system)) {
      const p = shapeProblem(system, { appliedSha: 'str', oldestAt: 'iso?' }, 'system');
      if (p) return p;
      const behind = system.behind;
      if (typeof behind !== 'number' || !Number.isInteger(behind) || behind < 0)
        return 'system.behind 不是非负整数';
    } else if (typeof system.error !== 'string') return 'system.error 不是字符串';
  }
  if (s.last !== null) {
    const p = shapeProblem(s.last, { action: 'str', detail: 'str', at: 'iso' }, 'last');
    if (p) return p;
  }
  // 配置对账（#323）是后加的：旧的状态文件没有这一项，不算认不出
  const config = s.config;
  if (config !== null && config !== undefined) {
    if (!isObj(config)) return 'config 不是对象';
    const p = shapeProblem(config, { checkedAt: 'iso', result: 'str' }, 'config');
    if (p) return p;
    if (!isNames(config.drift)) return 'config.drift 不是一串名字';
    if (!isNames(config.unchecked)) return 'config.unchecked 不是一串原因';
  }
  return null;
}

/**
 * 是一串字符串。
 * @param {unknown} v
 */
const isNames = (v) => Array.isArray(v) && v.every((/** @type {unknown} */ x) => typeof x === 'string');

/**
 * 一块的形状对不对：对就原样回（ok: true 那一份），不对就改成 { ok: false, why }。
 * 回的是「认过的」那一份，不再逐字段标类型：parseSnapshot 把整份认成 Sections。
 * @param {SectionName} name
 * @param {unknown} s
 * @returns {Record<string, unknown>}
 */
function checkSection(name, s) {
  if (!isObj(s) || typeof s.ok !== 'boolean')
    return { ok: false, why: '法国那头没给这一块（查询脚本和本机不是同一版？）' };
  if (!s.ok) return { ok: false, why: typeof s.why === 'string' && s.why ? s.why : '没说为什么' };
  /** @type {string | null} */
  let problem = null;
  switch (name) {
    case 'db':
      problem = isIso(s.now) && typeof s.readOnly === 'string' ? null : 'now、readOnly 认不出';
      break;
    case 'notifications':
      problem = Number.isInteger(s.count) ? rowsProblem(s.rows, ROW_SPECS.notifications) : 'count 不是整数';
      break;
    case 'services':
      problem = rowsProblem(s.units, { unit: 'str', state: 'str' }, 'units');
      break;
    case 'current':
      problem = typeof s.sha === 'string' && s.sha !== '' ? null : 'sha 认不出';
      break;
    case 'autoRelease':
      problem = autoReleaseProblem(s.state);
      break;
    default:
      problem = rowsProblem(s.rows, ROW_SPECS[name]);
  }
  return problem ? { ok: false, why: `形状认不出：${problem}` } : s;
}

/**
 * 法国回来的一行 JSON。成功 { ok: true, data: { at, sections } }（字都抹过）；整份认不出 { ok: false, kind, why }：
 * bad-json（不是 JSON、什么都没打）、bad-shape（不是这份查询脚本打的、版本对不上）。单独一块不对只标那一块。
 * @param {unknown} text
 * @returns {{ ok: true, data: Snapshot } | Failure}
 */
export function parseSnapshot(text) {
  const t = String(text ?? '').trim();
  if (t === '') return { ok: false, kind: 'bad-json', why: '法国上的查询脚本什么都没打出来' };
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(t);
  } catch (e) {
    return {
      ok: false,
      kind: 'bad-json',
      why: `法国回来的不是 JSON（${message(e)}；开头是「${scrubText(t.slice(0, 60))}」）`,
    };
  }
  if (!isObj(data) || data.app !== APP)
    return { ok: false, kind: 'bad-shape', why: '法国回来的 JSON 认不出：不是这份查询脚本打的' };
  if (data.schema !== SCHEMA)
    return {
      ok: false,
      kind: 'bad-shape',
      why: `法国回来的是第 ${JSON.stringify(data.schema)} 版格式，本机只认第 ${SCHEMA} 版`,
    };
  if (!isIso(data.at)) return { ok: false, kind: 'bad-shape', why: '法国回来的 JSON 没有查的时刻（at）' };
  const rawSections = data.sections;
  if (!isObj(rawSections)) return { ok: false, kind: 'bad-shape', why: '法国回来的 JSON 没有 sections' };
  const sections = Object.fromEntries(SECTIONS.map((name) => [name, checkSection(name, rawSections[name])]));
  // 每一块上面都按形状表逐项核过了（核不过的已经换成 { ok: false, why }），所以这里才认成 Snapshot
  return { ok: true, data: /** @type {Snapshot} */ (scrubDeep({ at: data.at, sections })) };
}

// —— 额度（跟 packages/shared/src/usage.ts 走） ——

/** 输入当量的折法：输入 1、缓存写 1.25、缓存读 0.1、输出 5；按二十分之一算成整数再除，免得小数尾巴。 */
const SCALED = { input: 20, cacheWrite: 25, cacheRead: 2, output: 100 };
/**
 * 读到的、不为负的整数才算数；其余（没读到、小数、负数、字符串）一律当没读到。
 * @param {unknown} v
 * @returns {number | undefined}
 */
const tokens = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

/**
 * @param {Pick<UsageRun, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>} r
 * @returns {number | undefined}
 */
export function inputEquivalentOf(r) {
  const input = tokens(r.inputTokens);
  const output = tokens(r.outputTokens);
  const read = tokens(r.cacheReadTokens);
  const write = tokens(r.cacheWriteTokens);
  if (input === undefined || output === undefined || read === undefined || write === undefined)
    return undefined;
  return Math.round(
    (input * SCALED.input + write * SCALED.cacheWrite + read * SCALED.cacheRead + output * SCALED.output) /
      20,
  );
}

/** @returns {CostShare} */
const emptyShare = () => ({ runs: 0, usd: 0, missing: 0 });
/** @returns {Totals} */
export function emptyTotals() {
  return {
    runs: 0,
    running: 0,
    notStarted: 0,
    inputTokens: 0,
    outputTokens: 0,
    missingTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    missingCache: 0,
    inputEquivalent: 0,
    missingEquivalent: 0,
    costUsd: 0,
    missingCost: 0,
    cost: { metered: emptyShare(), subscription: emptyShare(), unknown: emptyShare() },
    // shared 的 usage.ts 只给三段的 runs 按目录单价估没报的花费；这页只读会话（session_runs），老流程不估，恒为 0
    estimate: { runs: 0, usd: 0, noPrice: 0, noTokens: 0 },
    queueMs: 0,
    runMs: 0,
    missingTime: 0,
    // shared 的 usage.ts 给三段的 runs 记「没有排队」的笔数；这页只读会话（session_runs），恒为 0
    noQueue: 0,
  };
}

/**
 * @param {UsageRun} r
 * @returns {{ queueMs: number, runMs: number } | undefined}
 */
function durations(r) {
  const queued = ms(r.queuedAt);
  const ended = r.endedAt === null || r.endedAt === undefined ? Number.NaN : ms(r.endedAt);
  const started = r.startedAt === null || r.startedAt === undefined ? undefined : ms(r.startedAt);
  if (!Number.isFinite(queued) || !Number.isFinite(ended)) return undefined;
  if (started !== undefined && !Number.isFinite(started)) return undefined;
  const queueMs = (started ?? ended) - queued;
  const runMs = started === undefined ? 0 : ended - started;
  return queueMs >= 0 && runMs >= 0 ? { queueMs, runMs } : undefined;
}

/**
 * @param {Totals} t
 * @param {UsageRun} r
 */
function addRun(t, r) {
  if (r.endedAt === null || r.endedAt === undefined) {
    t.running += 1;
    return;
  }
  t.runs += 1;
  if (r.startedAt === null || r.startedAt === undefined) t.notStarted += 1;
  const input = tokens(r.inputTokens);
  const output = tokens(r.outputTokens);
  if (input !== undefined && output !== undefined) {
    t.inputTokens += input;
    t.outputTokens += output;
  } else t.missingTokens += 1;
  const read = tokens(r.cacheReadTokens);
  const write = tokens(r.cacheWriteTokens);
  if (read !== undefined && write !== undefined) {
    t.cacheReadTokens += read;
    t.cacheWriteTokens += write;
  } else t.missingCache += 1;
  const eq = inputEquivalentOf(r);
  if (eq !== undefined) t.inputEquivalent += eq;
  else t.missingEquivalent += 1;
  const share =
    r.billing === 'metered'
      ? t.cost.metered
      : r.billing === 'subscription'
        ? t.cost.subscription
        : t.cost.unknown;
  share.runs += 1;
  const cost = r.costUsd;
  if (cost !== null && cost !== undefined && Number.isFinite(cost) && cost >= 0) {
    t.costUsd += cost;
    share.usd += cost;
  } else {
    t.missingCost += 1;
    share.missing += 1;
  }
  const spent = durations(r);
  if (spent) {
    t.queueMs += spent.queueMs;
    t.runMs += spent.runMs;
  } else t.missingTime += 1;
}

/** 一组会话按模型（路由上的模型）、按环节、整组合计；会话按排队时刻排好传进来。 */
/**
 * @param {UsageRun[]} runs
 * @returns {{ total: Totals, byModel: (Totals & { model: string, modelName: string })[], byStage: (Totals & { stage: string })[] }}
 */
export function summarizeUsage(runs) {
  const total = emptyTotals();
  /** @type {Map<string, Totals & { model: string, modelName: string }>} */
  const byModel = new Map();
  /** @type {Map<string, Totals & { stage: string }>} */
  const byStage = new Map();
  for (const r of runs) {
    const modelKey = r.model ?? '?';
    let forModel = byModel.get(modelKey);
    if (!forModel) {
      forModel = {
        model: modelKey,
        modelName: r.modelName ?? r.model ?? '（路由查不到）',
        ...emptyTotals(),
      };
      byModel.set(modelKey, forModel);
    }
    let forStage = byStage.get(r.stage);
    if (!forStage) {
      forStage = { stage: r.stage, ...emptyTotals() };
      byStage.set(r.stage, forStage);
    }
    addRun(total, r);
    addRun(forModel, r);
    addRun(forStage, r);
  }
  return { total, byModel: [...byModel.values()], byStage: [...byStage.values()] };
}

// —— 整理成页面要的样子 ——

/**
 * @param {string} repo
 * @param {number} n
 */
const taskKey = (repo, n) => `${repo}#${n}`;
/** @param {string | null | undefined} repo */
const repoName = (repo) =>
  String(repo ?? '')
    .split('/')
    .at(-1) ?? '';

/** @typedef {ReturnType<typeof toRun>} RunView 页面上一次会话的样子（字段名驼峰、可空的都补成 null） */

/** @param {RunRow} r */
function toRun(r) {
  const stage = r.stage.startsWith('segment:') ? (SEGMENT_STAGE[r.stage.slice(8)] ?? r.stage) : r.stage;
  return {
    key: r.repo && r.n !== null && r.n !== undefined ? taskKey(r.repo, r.n) : null,
    repo: r.repo ?? null,
    n: r.n ?? null,
    stage,
    stageName: STAGE_NAMES[stage] ?? stage,
    routeId: r.route_id,
    model: r.model ?? null,
    modelName: r.model_name ?? null,
    host: r.host ?? null,
    hostName: r.host ? (HOST_NAMES[r.host] ?? r.host) : null,
    pool: r.pool ?? null,
    billing: r.billing ?? null,
    actualModel: r.actual_model ?? null,
    queuedAt: r.queued_at,
    startedAt: r.started_at ?? null,
    endedAt: r.ended_at ?? null,
    inputTokens: r.input_tokens ?? null,
    outputTokens: r.output_tokens ?? null,
    cacheReadTokens: r.cache_read_tokens ?? null,
    cacheWriteTokens: r.cache_write_tokens ?? null,
    costUsd: r.cost_usd ?? null,
    sessionCostUsd: r.session_cost_usd ?? null,
    outcome: r.outcome ?? null,
    outcomeName: r.outcome ? (OUTCOME_WORDS[r.outcome] ?? r.outcome) : '在跑',
    failureCode: r.failure_code ?? null,
    failureMessage: r.failure_message ?? null,
    subtaskIndex: r.subtask_index ?? null,
    subtaskTitle: r.subtask_title ?? null,
  };
}

/**
 * 一次会话排队、干活各多久（还在跑的按到 at 为止算）。
 * @param {RunView} r
 * @param {string} at
 */
function runTimes(r, at) {
  const end = r.endedAt ?? at;
  const queueMs = Math.max(0, ms(r.startedAt ?? end) - ms(r.queuedAt));
  const runMs = r.startedAt ? Math.max(0, ms(end) - ms(r.startedAt)) : 0;
  return { queueMs, runMs };
}

/** @typedef {{ at: string, org: string | null, how?: string | undefined, why?: string | null | undefined }} OrgSighting 引擎记过的一笔「会话用户挂的是哪个号」 */
/** @typedef {{ ok: false, why: string, at?: string } | { ok: true, org: string, name: string, at: string, how?: string | undefined }} MountedOrg */

/**
 * 会话用户此刻挂的号：看引擎自己记的——路由探针的结论（挂着的池才探、没挂的池写明「现在挂的是…」）和切号记录，取最新的。
 * @param {readonly Pick<RouteRow, 'org_kind' | 'probed_at' | 'probe_state' | 'probe_detail'>[] | null | undefined} routes
 * @param {readonly OrgAuditRow[] | null | undefined} audits
 * @returns {MountedOrg}
 */
export function mountedOrg(routes, audits) {
  /** @type {OrgSighting[]} */
  const seen = [];
  for (const r of routes ?? []) {
    if (!r.org_kind || !r.probed_at) continue;
    if (r.probe_state === 'ok')
      seen.push({
        at: r.probed_at,
        org: r.org_kind,
        how: `${ORG_NAMES[r.org_kind] ?? r.org_kind}池的路由探通了`,
      });
    const m = /会话用户现在挂的是(拼车|独享)组织/.exec(r.probe_detail ?? '');
    if (m) seen.push({ at: r.probed_at, org: m[1] === '拼车' ? 'carpool' : 'solo', how: '路由探针读的' });
    if (r.probe_state === 'failed' && /会话用户挂的组织认不出/.test(r.probe_detail ?? ''))
      seen.push({ at: r.probed_at, org: null, why: r.probe_detail });
  }
  for (const a of audits ?? []) {
    if (a.ok && a.to_org)
      seen.push({
        at: a.at,
        org: a.to_org,
        how: a.action === 'session-org.switch' ? '引擎切号的记录' : '切号后核对的记录',
      });
  }
  seen.sort((a, b) => ms(b.at) - ms(a.at));
  const latest = seen[0];
  if (!latest) return { ok: false, why: '引擎还没记过（路由探针没探过 Claude 的池，也没有切号记录）' };
  if (latest.org === null) return { ok: false, at: latest.at, why: `路由探针上一轮读不出：${latest.why}` };
  return {
    ok: true,
    org: latest.org,
    name: ORG_NAMES[latest.org] ?? latest.org,
    at: latest.at,
    how: latest.how,
  };
}

/**
 * 多久以前（相对法国查的那一刻）：「5 分钟前」「3 小时前」「2 天前」。
 * @param {string} fromIso
 * @param {string} at
 */
export function agoText(fromIso, at) {
  const m = Math.max(0, minutesBetween(fromIso, at));
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`;
}

/**
 * 定时任务新不新鲜：和 packages/db 的 scheduleHealth 同一条线。
 * @param {JobRow} job
 * @param {string} at
 * @returns {'never' | 'failing' | 'no-samples' | 'stale' | 'ok'}
 */
export function jobStatus(job, at) {
  if (!job.last_run) return 'never';
  if (job.last_finished?.outcome === 'failed') return 'failing';
  if (job.last_finished?.outcome === 'unscanned') return 'no-samples';
  const ended = job.last_success?.ended_at;
  if (!ended || ms(at) - ms(ended) > job.every * 60_000) return 'stale';
  return 'ok';
}
/** @type {Record<'never' | 'failing' | 'no-samples' | 'stale' | 'ok', string>} */
export const JOB_STATUS_WORDS = {
  never: '从没跑过',
  failing: '最近一轮没跑成',
  'no-samples': '最近一轮一个都没扫到',
  stale: '过期了',
  ok: '新鲜',
};

const WHERE = {
  unread:
    '本机跑 node $S/france.mjs 看原因；法国上手动跑同一份查询：ssh <法国> node --input-type=module - --collect < $S/france-query.mjs',
  service: (/** @type {string} */ u) => `法国：systemctl status ${u}；journalctl -u ${u} -n 50`,
  autoRelease: '法国：systemctl status fleet-auto-release.timer；journalctl -u fleet-auto-release -n 30',
  releaseLog: '法国：journalctl -u fleet-auto-release -n 50；/srv/fleet-dao-releases/.logs/ 下最新的日志',
  installer: '法国以 root 跑 bash /srv/fleet-dao/deploy/france.sh（碰防火墙、sudoers，要人看着跑）',
  notifications: '驾驶舱「提醒」或飞书；法国库 notifications 表 resolved_at 为空的',
  job: (/** @type {string} */ id) =>
    `法国：journalctl -u fleet-engine | grep ${id}；库 schedule_runs 表 job='${id}'`,
  route: '法国：journalctl -u fleet-engine | grep route-probe；库 routes 表',
  org: '法国：journalctl -u fleet-engine | grep session-org；docs/ops.md 第五节（会话用户切号）',
  session: '法国：journalctl -u fleet-engine；驾驶舱这张单的会话时间线',
  task: (/** @type {string} */ repo, /** @type {number} */ n) =>
    `https://github.com/${repo}/issues/${n}；法国：journalctl -u fleet-engine | grep '#${n}'`,
  readOnly: '本机 $S/france-query.mjs 里的 PSQL（连接参数 default_transaction_read_only）',
};

/** @type {Record<string, string>} */
const WAITING = {
  'ci-pending': '在等 CI',
  'wait-idle': '在等引擎空闲',
  hold: '人手动切过版本，等主线出新提交',
  'release-busy': '在发',
  releasing: '在发',
};

/**
 * 自动发布一轮的结论（deploy/france/auto-release/lib.mjs 的 act）的白话；认不出的原样给。
 * @type {Record<string, string>}
 */
export const ACTION_WORDS = {
  'up-to-date': '跟上了',
  released: '发了',
  releasing: '在发',
  'release-busy': '另一个发布在跑',
  'release-failed': '发布没成',
  'wait-idle': '在等引擎空闲',
  hold: '人手动切过版本',
  'failed-before': '这个提交发过、没过健康检查',
  'marker-none': '没有版本标记，不发',
  'marker-unknown': '版本标记读不到，不发',
  'marker-not-ancestor': '版本标记不是主线上的提交，不发',
  'marker-not-newer': '版本标记指的提交不比在用的新，不降级',
  'engine-unknown': '查不出引擎开没开着，不发',
  'ci-pending': '在等 CI',
  'ci-red': '主线 CI 红',
  'ci-unknown': 'CI 结论读不到',
  'main-unreadable': '主线头读不到',
  'current-unreadable': '在用的版本读不到',
  'history-unreadable': '发布历史读不到',
  'checkout-blocked': '部署检出被挡',
  'state-unwritable': '状态文件写不进去',
};

/**
 * 页面上「版本和自动发布」那一块（读到了的样子）。
 * @typedef {{ ok: true, current: string | null, currentWhy: string | null, head: string | null, headAt: string | null, checkedAt: string | null, mainError: string | null, ranAt: string, ci: CiFacts | null, hold: HoldFacts | null, waitingSince: string | null, attempt: AttemptFacts | null, rules: RulesFacts | null, system: SystemFacts | null, last: (LastFacts & { actionName: string }) | null, config: ConfigFacts | null, behind: number | null, oldestUnreleasedAt: string | null, inRecent: boolean | null, recentCount: number, waiting: string | null }} ReleaseView
 */

/**
 * 版本和自动发布：落后多少、卡在哪，给页面的样子和要标的异常。
 * @param {Sections['current']} current
 * @param {Sections['autoRelease']} auto
 * @param {string} at
 * @returns {{ view: ReleaseView | { ok: false, why: string, current: string | null }, issues: Issue[] }}
 */
function releaseFacts(current, auto, at) {
  /** @type {Issue[]} */
  const issues = [];
  if (!auto.ok)
    return { view: { ok: false, why: auto.why, current: current.ok ? current.sha : null }, issues };
  const st = auto.state;
  /** @type {ReleaseView} */
  const view = {
    ok: true,
    current: current.ok ? current.sha : null,
    currentWhy: current.ok ? null : current.why,
    head: st.main?.head ?? null,
    headAt: st.main?.headAt ?? null,
    checkedAt: st.main?.checkedAt ?? null,
    mainError: st.mainError,
    ranAt: st.ranAt,
    ci: st.ci,
    hold: st.hold ?? null,
    waitingSince: st.waitingSince ?? null,
    attempt: st.attempt ?? null,
    rules: st.rules,
    system: st.system,
    last: st.last ? { ...st.last, actionName: ACTION_WORDS[st.last.action] ?? st.last.action } : null,
    config: st.config ?? null,
    behind: null,
    oldestUnreleasedAt: null,
    inRecent: null,
    recentCount: st.main?.commits.length ?? 0,
    waiting: (st.last ? WAITING[st.last.action] : undefined) ?? null,
  };
  const running = st.attempt?.result === 'running' ? minutesBetween(st.attempt.startedAt, at) : null;
  let fresh = true;
  if (running !== null && running > LIMITS.autoReleaseRunning) {
    issues.push({
      level: 'bad',
      // running 不是 null 就是上面那个 attempt 在跑，所以 ?. 取到的一定是它的 sha
      what: `自动发布这一轮跑了 ${running} 分钟还没完（在发 ${st.attempt?.sha}）`,
      where: WHERE.releaseLog,
    });
  } else if (running === null && minutesBetween(st.ranAt, at) > LIMITS.autoReleaseStale) {
    fresh = false;
    issues.push({
      level: 'bad',
      what: `自动发布 ${minutesBetween(st.ranAt, at)} 分钟没跑过一轮（应每 5 分钟一轮）`,
      where: WHERE.autoRelease,
    });
  }
  if (!st.main) {
    fresh = false;
    issues.push({
      level: 'bad',
      what: `自动发布还没读到过主线头${st.mainError ? `：${st.mainError}` : ''}`,
      where: WHERE.autoRelease,
    });
  } else if (fresh && minutesBetween(st.main.checkedAt, at) > LIMITS.mainStale) {
    fresh = false;
    issues.push({
      level: 'bad',
      what: `主线头 ${minutesBetween(st.main.checkedAt, at)} 分钟没读到${st.mainError ? `：${st.mainError}` : ''}`,
      where: WHERE.autoRelease,
    });
  }
  if (current.ok && st.main) {
    const i = st.main.commits.findIndex((c) => c[0] === current.sha);
    view.inRecent = i >= 0;
    if (i > 0) {
      view.behind = i;
      const newer = st.main.commits[i - 1];
      if (!newer) throw new RangeError(`commits[${i - 1}] 取不到（i 来自 findIndex，不该发生）`);
      view.oldestUnreleasedAt = newer[1];
      // 落后几个提交只是读数、不算异常：发布只由驾驶舱按钮（或发版车）发，没人点就不会上线（决定 0032、#1271）
    } else if (i === 0) view.behind = 0;
    else if (fresh)
      issues.push({
        level: st.hold ? 'note' : 'bad',
        what: `在用 ${current.sha}，不在主线最近 ${st.main.commits.length} 个提交里${st.hold ? '（人手动切过版本）' : ''}`,
        where: WHERE.releaseLog,
      });
  }
  // 失败后人手动切到了更新的版本：自动发布记了 supersededBy（lib.mjs supersedeStaleFailure），旧失败不再是现在的问题（#1157）
  if (st.attempt?.result === 'failed' && !st.attempt.supersededBy)
    issues.push({
      level: 'bad',
      what: `最近一次自动发布没成（${st.attempt.sha}）${st.attempt.detail ? `：${st.attempt.detail.trim()}` : ''}`,
      where: WHERE.releaseLog,
    });
  if (st.ci?.verdict === 'red')
    issues.push({ level: 'note', what: `主线头 CI 红：${st.ci.detail}`, where: 'GitHub 上主线的 CI' });
  if (st.rules?.result === 'failed')
    issues.push({ level: 'bad', what: `规矩同步没成：${st.rules.detail}`, where: WHERE.releaseLog });
  else if (st.rules?.result === 'unchecked')
    issues.push({ level: 'bad', what: `规矩同步到哪没查成：${st.rules.detail}`, where: WHERE.releaseLog });
  if (st.system && 'error' in st.system)
    issues.push({ level: 'bad', what: `装机脚本装到哪没读到：${st.system.error}`, where: WHERE.installer });
  else if (
    st.system &&
    st.system.behind > 0 &&
    st.system.oldestAt &&
    minutesBetween(st.system.oldestAt, at) > LIMITS.systemBehind
  )
    issues.push({
      level: 'bad',
      what: `装机脚本落后主线 ${st.system.behind} 个相关提交、${Math.floor(minutesBetween(st.system.oldestAt, at) / 60)} 小时，要人重跑`,
      where: WHERE.installer,
    });
  return { view, issues };
}

/**
 * 一份快照整理成页面要的样子：断链排查（最要紧的在前）、每张单一行（点开是每次会话）、近 24 小时按环节和模型的汇总、
 * 引擎健康。每一块都带 ok；没读到的带 why，不拿空的顶。
 * @param {Snapshot} snapshot
 */
export function buildView(snapshot) {
  const { at, sections: S } = snapshot;
  /** @type {Issue[]} */
  const issues = [];
  /**
   * @param {string} what
   * @param {string} where
   */
  const bad = (what, where) => issues.push({ level: 'bad', what, where });
  /**
   * @param {string} what
   * @param {string} where
   */
  const note = (what, where) => issues.push({ level: 'note', what, where });

  // 没读到的块：库的几块常是同一个原因，并成一条
  /** 没读到的那一块的原因（读到了的没有）。 */
  const whyOf = (/** @type {SectionName} */ n) => {
    const s = S[n];
    return s.ok ? undefined : s.why;
  };
  const unread = SECTIONS.filter((n) => !S[n].ok);
  const dbUnread = unread.filter((n) => DB_SECTIONS.includes(n));
  const sameDbWhy = dbUnread.length === DB_SECTIONS.length && new Set(dbUnread.map(whyOf)).size === 1;
  /** @type {{ level: 'unread', what: string, where: string }[]} */
  const unreadItems = [];
  if (sameDbWhy)
    unreadItems.push({ level: 'unread', what: `没读到：库（${whyOf('db')}）`, where: WHERE.unread });
  for (const n of unread) {
    if (sameDbWhy && DB_SECTIONS.includes(n)) continue;
    unreadItems.push({
      level: 'unread',
      what: `没读到：${SECTION_NAMES[n]}（${whyOf(n)}）`,
      where: WHERE.unread,
    });
  }

  if (S.db.ok && S.db.readOnly !== 'on')
    bad(`这一轮查库的会话不是只读的（transaction_read_only=${S.db.readOnly}）`, WHERE.readOnly);

  // 服务
  if (S.services.ok)
    for (const u of S.services.units)
      if (u.state !== 'active') bad(`服务 ${u.unit} 是 ${u.state}（应是 active）`, WHERE.service(u.unit));

  // 版本和自动发布
  const release = releaseFacts(S.current, S.autoRelease, at);
  issues.push(...release.issues);

  // 提醒：一条一行，最多 5 条
  if (S.notifications.ok && S.notifications.count > 0) {
    for (const x of S.notifications.rows.slice(0, 5)) {
      const task = x.n && !x.title.includes(`#${x.n}`) ? `#${x.n} ` : '';
      (x.level === 'daily' ? note : bad)(
        `没处理的提醒：${task}${x.title}（${agoText(x.created_at, at)}）`,
        WHERE.notifications,
      );
    }
    if (S.notifications.count > 5) bad(`还有 ${S.notifications.count - 5} 条提醒没处理`, WHERE.notifications);
  }

  // 定时任务
  const jobs = S.jobs.ok
    ? S.jobs.rows.map((j) => {
        const status = jobStatus(j, at);
        const running = j.last_run && !j.last_run.ended_at ? j.last_run.started_at : null;
        const lastOkAgo = j.last_success?.ended_at ? minutesBetween(j.last_success.ended_at, at) : null;
        const label = `定时任务「${j.name}」`;
        if (status === 'never') bad(`${label}从没跑过`, WHERE.job(j.id));
        else if (status === 'failing')
          bad(`${label}最近一轮没跑成：${j.last_finished?.why ?? '没写原因'}`, WHERE.job(j.id));
        else if (status === 'no-samples')
          bad(`${label}最近一轮一个都没扫到：${j.last_finished?.why ?? '没写原因'}`, WHERE.job(j.id));
        else if (status === 'stale')
          bad(
            lastOkAgo === null
              ? `${label}从没跑成过`
              : `${label}上次跑成是 ${lastOkAgo} 分钟前（该在 ${j.every} 分钟内再跑成一次）`,
            WHERE.job(j.id),
          );
        else if (j.last_finished?.outcome === 'partial')
          note(`${label}最近一轮只查了一部分：${j.last_finished?.why ?? '没写原因'}`, WHERE.job(j.id));
        return {
          id: j.id,
          name: j.name,
          schedule: j.schedule,
          every: j.every,
          status,
          statusName: JOB_STATUS_WORDS[status],
          running,
          lastRun: j.last_run,
          lastFinished: j.last_finished,
          lastSuccess: j.last_success,
        };
      })
    : null;

  // 路由
  const routes = S.routes.ok
    ? S.routes.rows.map((r) => {
        const staleAfter = probeStaleMinutes(r.host);
        const age = r.probed_at ? minutesBetween(r.probed_at, at) : null;
        const stale = r.alive && (age === null || age > staleAfter);
        if (stale)
          bad(
            `路由 ${r.id} 算在线，但结论 ${age === null ? '从没探过' : `${age} 分钟没更新`}（过 ${staleAfter} 分钟算旧：在线是旧结论）`,
            WHERE.route,
          );
        else if (
          r.in_use &&
          r.probe_state === 'failed' &&
          !/会话用户挂的组织认不出/.test(r.probe_detail ?? '')
        )
          note(`路由 ${r.id} 没探通：${r.probe_detail ?? '没写原因'}`, WHERE.route);
        return {
          id: r.id,
          pool: r.pool,
          model: r.model,
          host: r.host,
          hostName: HOST_NAMES[r.host] ?? r.host,
          alive: r.alive,
          state: r.probe_state,
          stateName: r.probe_state ? (PROBE_WORDS[r.probe_state] ?? r.probe_state) : '还没探过',
          probedAt: r.probed_at,
          detail: r.probe_detail,
          orgKind: r.org_kind,
          inUse: r.in_use,
          billing: r.billing,
          stale,
          staleAfter,
        };
      })
    : null;

  // 会话用户挂的号
  let org;
  if (!S.routes.ok && !S.orgAudit.ok) org = { ok: false, why: `路由和切号记录都没读到（${S.routes.why}）` };
  else {
    const mounted = mountedOrg(S.routes.ok ? S.routes.rows : [], S.orgAudit.ok ? S.orgAudit.rows : []);
    if (!mounted.ok && mounted.at)
      bad(`会话用户挂的号认不出，Claude 的两个池都不派：${mounted.why}`, WHERE.org);
    org = {
      ...mounted,
      recent: S.orgAudit.ok
        ? S.orgAudit.rows.map((a) => ({
            at: a.at,
            action: a.action === 'session-org.switch' ? '切号' : '核对',
            ok: a.ok,
            from: a.from_org ? (ORG_NAMES[a.from_org] ?? a.from_org) : null,
            to: a.to_org ? (ORG_NAMES[a.to_org] ?? a.to_org) : null,
            error: a.error,
          }))
        : null,
      recentWhy: S.orgAudit.ok ? null : S.orgAudit.why,
    };
  }

  // 会话和单子
  const runs = S.runs.ok ? S.runs.rows.map(toRun) : [];
  const openRuns = runs.filter((r) => !r.endedAt);
  for (const r of openRuns) {
    const who = `${r.n ? `#${r.n} ` : ''}${r.stageName}（${r.routeId}）`;
    if (r.startedAt) {
      const m = minutesBetween(r.startedAt, at);
      if (m > LIMITS.sessionRunning) bad(`会话跑了 ${m} 分钟还没完：${who}`, WHERE.session);
    } else {
      const m = minutesBetween(r.queuedAt, at);
      if (m > LIMITS.sessionStarting) bad(`会话登记了 ${m} 分钟还没起来：${who}`, WHERE.session);
    }
  }
  for (const r of runs) {
    if (!r.endedAt || (r.outcome !== 'failed' && r.outcome !== 'stalled')) continue;
    if (minutesBetween(r.endedAt, at) > LIMITS.failedLookback) continue;
    note(
      `会话${r.outcomeName}：${r.n ? `#${r.n} ` : ''}${r.stageName}（${r.routeId}）${r.failureCode ? ` ${r.failureCode}` : ''}${r.failureMessage ? `：${r.failureMessage}` : ''}`,
      WHERE.session,
    );
  }

  /** @type {Map<string, RunView[]>} */
  const runsByTask = new Map();
  for (const r of runs) {
    if (!r.key) continue;
    const list = runsByTask.get(r.key);
    if (list) list.push(r);
    else runsByTask.set(r.key, [r]);
  }
  /** @param {RunView} r */
  const withTimes = (r) => ({ ...r, ...runTimes(r, at), inputEquivalent: inputEquivalentOf(r) ?? null });
  /** @param {TaskRow} t */
  const taskRow = (t) => {
    const key = taskKey(t.repo, t.n);
    const mine = runsByTask.get(key) ?? [];
    const summed = summarizeUsage(mine);
    const usage = {
      ...summed,
      byStage: summed.byStage.map((s) => ({ ...s, stageName: STAGE_NAMES[s.stage] ?? s.stage })),
    };
    const open = mine.filter((r) => !r.endedAt);
    return {
      key,
      repo: t.repo,
      repoName: repoName(t.repo),
      n: t.n,
      url: `https://github.com/${t.repo}/issues/${t.n}`,
      title: t.title,
      state: t.state,
      stateName: TASK_STATE_WORDS[t.state] ?? t.state,
      phase: t.phase,
      doing: t.doing,
      lastProblem: t.last_problem,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      firstRunAt: mine[0]?.queuedAt ?? null,
      openRuns: open.length,
      usage: S.runs.ok ? usage : null,
      runs: S.runs.ok ? mine.map(withTimes) : null,
      runsWhy: S.runs.ok ? null : S.runs.why,
    };
  };
  let tasks;
  if (S.tasks.ok) {
    const rows = S.tasks.rows.map(taskRow);
    for (const t of rows) {
      if (t.state === 'stalled')
        bad(`#${t.n} 卡住了${t.lastProblem ? `：${t.lastProblem}` : ''}`, WHERE.task(t.repo, t.n));
      else if (!TERMINAL.includes(t.state) && t.state !== 'queued') {
        if (t.lastProblem) note(`#${t.n} 最近的问题：${t.lastProblem}`, WHERE.task(t.repo, t.n));
        const quiet = minutesBetween(t.updatedAt ?? t.createdAt, at);
        const idle = `#${t.n} ${quiet} 分钟没动，手上也没有会话（${t.stateName}${t.phase ? ` · ${t.phase}` : ''}）`;
        if (S.runs.ok && t.openRuns === 0) {
          if (t.state === 'running' && quiet > LIMITS.taskIdle)
            bad(`${idle}：多半停在等人或等一个派不出的路由`, WHERE.task(t.repo, t.n));
          else if (t.state !== 'running' && t.state !== 'asking' && quiet > LIMITS.taskQuiet)
            note(idle, WHERE.task(t.repo, t.n));
        }
      }
    }
    tasks = {
      ok: true,
      active: rows.filter((t) => !TERMINAL.includes(t.state) && t.state !== 'queued'),
      queued: rows.filter((t) => t.state === 'queued'),
      finished: rows.filter((t) => TERMINAL.includes(t.state)),
    };
  } else tasks = { ok: false, why: S.tasks.why };

  // 近 24 小时
  let usage24h;
  if (S.runs.ok) {
    const since = ms(at) - 24 * 3600_000;
    const recent = runs.filter((r) => ms(r.queuedAt) >= since);
    const orphans = recent.filter((r) => !r.key);
    const u = summarizeUsage(recent);
    usage24h = {
      ok: true,
      total: u.total,
      byStage: u.byStage.map((s) => ({ ...s, stageName: STAGE_NAMES[s.stage] ?? s.stage })),
      byModel: u.byModel,
      failed: recent.filter((r) => r.outcome === 'failed' || r.outcome === 'stalled').length,
      orphanRuns: orphans.length,
    };
  } else usage24h = { ok: false, why: S.runs.why };

  // 接活开关
  const repos = S.repos.ok
    ? S.repos.rows.map((r) => ({
        repo: r.repo,
        repoName: repoName(r.repo),
        on: r.auto_dispatch_since !== null,
        since: r.auto_dispatch_since,
      }))
    : null;
  if (repos)
    for (const r of repos)
      if (!r.on) note(`仓 ${r.repoName} 的「让 AI 接活」关着：引擎不接这个仓的新单`, '驾驶舱这个项目的设置');

  /** @type {Record<'bad' | 'unread' | 'note', number>} */
  const order = { bad: 0, unread: 1, note: 2 };
  const anomalies = [...issues, ...unreadItems]
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => order[a.level] - order[b.level] || a.i - b.i)
    .map(({ i, ...x }) => x);

  return {
    at,
    anomalies,
    counts: {
      bad: anomalies.filter((x) => x.level === 'bad').length,
      unread: anomalies.filter((x) => x.level === 'unread').length,
      note: anomalies.filter((x) => x.level === 'note').length,
    },
    tasks,
    usage24h,
    health: {
      release: release.view,
      rounds: S.rounds.ok
        ? { ok: true, rows: S.rounds.rows, since: S.rounds.since }
        : { ok: false, why: S.rounds.why },
      services: S.services.ok ? { ok: true, units: S.services.units } : { ok: false, why: S.services.why },
      org,
      repos: repos ? { ok: true, rows: repos } : { ok: false, why: whyOf('repos') },
      jobs: jobs ? { ok: true, rows: jobs } : { ok: false, why: whyOf('jobs') },
      routes: routes ? { ok: true, rows: routes } : { ok: false, why: whyOf('routes') },
      notifications: S.notifications.ok
        ? { ok: true, count: S.notifications.count, rows: S.notifications.rows }
        : { ok: false, why: S.notifications.why },
      db: S.db.ok ? { ok: true, readOnly: S.db.readOnly } : { ok: false, why: S.db.why },
    },
    units: UNITS,
  };
}

// —— 取一次、页面服务里的缓存 ——

/** @typedef {ReturnType<typeof buildView>} View 页面要的整份数据 */
/** @typedef {{ ok: true, data: Snapshot } | Failure} FetchResult 取一次的结局 */

/**
 * 取一次：读 ssh 名字、读查询脚本、经 ssh 跑、认回来的。回 { ok: true, data } 或 { ok: false, kind, why }，不抛。
 * @param {{ home: string, env: Record<string, string | undefined>, scriptFile: string, command?: string, argsFor?: (host: string) => string[], timeoutMs?: number, readText?: (file: string) => string, spawnImpl?: SpawnPiped }} opts
 * @returns {() => Promise<FetchResult>}
 */
export function franceFetcher({
  home,
  env,
  scriptFile,
  command = 'ssh',
  argsFor = sshArgs,
  timeoutMs = SSH_TIMEOUT_MS,
  readText = (f) => readFileSync(f, 'utf8'),
  spawnImpl = spawn,
}) {
  return async () => {
    const target = readTarget({ env, home, readText });
    if (!target.ok) return target;
    /** @type {string} */
    let script;
    try {
      script = readText(scriptFile);
    } catch (e) {
      return {
        ok: false,
        kind: 'no-script',
        why: `本机的查询脚本读不到（${scriptFile}：${errCode(e) ?? message(e)}）`,
      };
    }
    const r = await runRemote({ command, args: argsFor(target.host), script, timeoutMs, spawnImpl });
    if (!r.ok) return r;
    return parseSnapshot(r.stdout);
  };
}

/**
 * 页面服务里的那一份：有人来读、离上次读完过了 refreshMs，就在后台再从法国读一次（同时只一次）；马上回手上有的。
 * 回 { refreshMs, now, loading, lastTry, good }：good 是最近一次读成的（带整理好的 view），lastTry 是最近一次的结局——
 * 读失败了 good 照留，页面照实写「最近一次没读到」和多久以前的数据。
 * @param {{ fetchOnce: () => Promise<FetchResult>, now?: () => Date, refreshMs?: number, htmlFile?: string | null }} opts
 */
export function createFranceSource({
  fetchOnce,
  now = () => new Date(),
  refreshMs = REFRESH_MS,
  htmlFile = null,
}) {
  /** @type {{ fetchedAt: string, tookMs: number, view: View | null } | null} */
  let good = null;
  /** @type {{ at: string, endedAt: string, tookMs: number, ok: boolean, kind?: string, why?: string } | null} */
  let lastTry = null;
  /** @type {{ since: Date, promise: Promise<void> } | null} */
  let inflight = null;
  const start = () => {
    const since = now();
    const promise = (async () => {
      /** @type {FetchResult} */
      let r;
      try {
        r = await fetchOnce();
      } catch (e) {
        r = { ok: false, kind: 'crashed', why: `取数出错：${message(e)}` };
      }
      /** @type {View | null} */
      let view = null;
      if (r.ok) {
        try {
          view = buildView(r.data);
        } catch (e) {
          r = { ok: false, kind: 'crashed', why: `整理法国的数据出错：${message(e)}` };
        }
      }
      const ended = now();
      const tookMs = ended.getTime() - since.getTime();
      if (r.ok) good = { fetchedAt: ended.toISOString(), tookMs, view };
      lastTry = {
        at: since.toISOString(),
        endedAt: ended.toISOString(),
        tookMs,
        ok: r.ok,
        ...(r.ok ? {} : { kind: r.kind, why: scrubText(r.why) }),
      };
      inflight = null;
    })();
    inflight = { since, promise };
    return promise;
  };
  return {
    htmlFile,
    read() {
      const t = now();
      if (!inflight && (lastTry === null || t.getTime() - ms(lastTry.endedAt) >= refreshMs)) start();
      return {
        refreshMs,
        now: t.toISOString(),
        loading: inflight ? { since: inflight.since.toISOString() } : null,
        lastTry,
        good,
      };
    },
    /** 马上读一次（已经在读就等那一次）。 */
    refresh: () => (inflight ? inflight.promise : start()),
  };
}

// —— 本机页面服务（server.mjs 是它的外壳）——
// 端口、端口的环境变量、认自己用的 APP_ID 都沿用帅位本机进度页时代的名字（进度页 #530 删了）：
// 以前起的、还开着的页面服务进程照样认得出是自己的（再起一遍说「已经在跑」，不报端口被别人占着），书签也照样能用。

export const DEFAULT_PORT = 1127;
export const PORT_ENV = 'FLEET_PROGRESS_PORT';
/** /api/ping 回这个，起服务时用它认「端口上已经是我们自己的页面服务」。 */
export const APP_ID = 'fleet-progress';

/**
 * 页面服务：/ 转到 /france；/france 给法国引擎页，/api/france 给它的数据（france.read()），/api/ping 认自己。只许读。
 * 页面文件每次现读：读不到 500 带原因，不给空页面。france 是 createFranceSource 的那一份，必给。
 * @param {{ france: ReturnType<typeof createFranceSource> }} opts
 */
export function createFranceServer({ france }) {
  return createServer((req, res) => {
    /**
     * @param {number} code
     * @param {string} type
     * @param {string | Buffer} body
     */
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    /**
     * @param {number} code
     * @param {unknown} value
     */
    const json = (code, value) => send(code, 'application/json; charset=utf-8', JSON.stringify(value));
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: '只能读' });
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/' || path === '/index.html') {
      res.writeHead(302, { location: '/france', 'cache-control': 'no-store' });
      return res.end();
    }
    if (path === '/api/ping') return json(200, { app: APP_ID });
    if (path === '/api/france') return json(200, france.read());
    if (path === '/france') {
      // createFranceSource 的 htmlFile 默认是 null：以前直接把 null 交给 readFileSync、抛 ERR_INVALID_ARG_TYPE 落进下面的 500；
      // 现在在这里明说没给页面文件的路径（同样是 500，只是原因写得清楚）
      if (france.htmlFile === null)
        return send(500, 'text/plain; charset=utf-8', '页面文件读不到（没有给页面文件的路径）');
      try {
        return send(200, 'text/html; charset=utf-8', readFileSync(france.htmlFile));
      } catch (e) {
        return send(500, 'text/plain; charset=utf-8', `页面文件读不到（${errCode(e) ?? message(e)}）`);
      }
    }
    return json(404, { error: '没有这个地址' });
  });
}

/**
 * 端口：--port <n>，其次环境变量 FLEET_PROGRESS_PORT，都没有用 1127。认不出返回原因（字符串）。
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @returns {number | string}
 */
export function parsePort(argv, env) {
  const i = argv.indexOf('--port');
  const raw = i >= 0 ? argv[i + 1] : env[PORT_ENV];
  if (raw === undefined || raw === '') return i >= 0 ? '用法：--port <端口>' : DEFAULT_PORT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : `端口要是 0–65535 的整数，「${raw}」不行`;
}

/**
 * 端口上是不是我们自己的页面服务（问 /api/ping）。连不上、回的不对都算不是。
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function isOurs(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return false;
    const body = await r.json();
    return isObj(body) && body.app === APP_ID;
  } catch {
    return false;
  }
}

/**
 * 起页面服务，只听 127.0.0.1。端口上已经是我们的页面服务：说一声、退出码 0（可以放心重复跑）；被别的程序占着：退出码 1。
 * 返回 { code, server?, port? }。
 * @param {{ port: number, france: ReturnType<typeof createFranceSource>, out: (line: string) => void, err: (line: string) => void }} opts
 * @returns {Promise<{ code: number, server?: ReturnType<typeof createFranceServer>, port?: number }>}
 */
export function startFranceServer({ port, france, out, err }) {
  return new Promise((resolve) => {
    const server = createFranceServer({ france });
    server.once('error', async (/** @type {Error} */ e) => {
      if (errCode(e) === 'EADDRINUSE') {
        if (await isOurs(port)) {
          out(`法国引擎页已经在跑：http://127.0.0.1:${port}/france`);
          return resolve({ code: 0 });
        }
        err(`端口 ${port} 被别的程序占着（不是这个页面服务）：换一个，--port <端口> 或 ${PORT_ENV}`);
        return resolve({ code: 1 });
      }
      err(`页面服务起不来：${e.message}`);
      resolve({ code: 1 });
    });
    server.listen(port, '127.0.0.1', () => {
      // 听的是 TCP 端口，address() 在这里一定是 { port }；不是的话（不该发生）退回要的端口，不抛
      const addr = server.address();
      const actual = typeof addr === 'object' && addr !== null ? addr.port : port;
      out(`法国引擎页：http://127.0.0.1:${actual}/france`);
      resolve({ code: 0, server, port: actual });
    });
  });
}
