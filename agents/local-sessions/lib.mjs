// 本机会话心跳（#1991，母单 #1990）：钩子写心跳、定时任务把心跳推给法国，两边共用的这一份。
// 「我本机其实在做的任务……只要是在做的，有没有办法感知到？」
//
// 怎么跑：
// - heartbeat.mjs 挂在 Claude Code 的 SessionStart / Stop / SubagentStop / SessionEnd 上（async，不让会话等），每次触发把这个会话
//   （子代理单算一个）的心跳写进 ~/.fleet-dao/local-sessions/sessions/<编号>.json。不常驻、不联网、出什么错都 exit 0。
// - push.mjs 由 Windows 计划任务每 2 分钟跑一次：把心跳凑成一份，POST 到法国的 /api/nodes/sessions（通行证和看板多机同一套），
//   结果（成没成、为什么）写进 ~/.fleet-dao/local-sessions/last-push.json。凑的时候读各会话记录的修改时间当「最后一次动」、
//   从记录尾巴读最后在调的工具名（以前靠每次调工具都跑一次心跳，摘掉）：看板误差不超过推送间隔 2 分钟。
// - install.mjs 一条命令装、一条命令卸（pnpm local-sessions install / local-sessions uninstall）。
//
// 改这里之前必须知道（隐私边界，法国那边的 schema 是 strict，多一个字段就整份拒收）：
// - 只写元信息：会话编号、仓（owner/name 或目录名）、分支、工作树目录名（不是整条路径）、是不是子代理和类型、起的时刻、最后一次动、
//   最后一件事、最后在调的工具名。不写提示词、代码、命令参数、文件路径、cwd。钩子输入里的 tool_input、prompt 一个字都不落盘。
// - 常量和 packages/shared/src/web-api/local-sessions.ts 对得上（agents/test/local-sessions.test.ts 钉着）：这份被原样拷到
//   ~/.fleet-dao/local-sessions/bin/ 用纯 node 跑，引不了仓里的 TypeScript。
// - 不往 ~/.fleet-dao/hooks/ 放、不登记成 ~/.fleet-dao/bin/quiet-*.exe：那两处归 agents-sync 管，同步时会被当成它的钩子摘掉。
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const SCHEMA_VERSION = 1;
/** 法国收本机会话的路径（WEB_API_PREFIX + LOCAL_SESSIONS_PATH）。 */
export const PUSH_PATH = '/api/nodes/sessions';
/** 通行证的请求头（NODE_REPORT_HEADER）。 */
export const TOKEN_HEADER = 'X-Fleet-Node-Token';
/** 计划任务多久推一次（LOCAL_SESSIONS_PUSH_EVERY_MS）。 */
export const PUSH_EVERY_MS = 2 * 60_000;
/** 一轮做完、会话收场之后多久以内还推（LOCAL_SESSION_RECENT_STOP_MS）。 */
export const RECENT_STOP_MS = 2 * 60 * 60_000;
/** 一份最多几个会话（LOCAL_SESSIONS_MAX）。 */
export const MAX_SESSIONS = 200;
/** 心跳文件多久没动就当会话早没了、删掉（没收到 SessionEnd 的：崩了、被杀了）。 */
export const DROP_AFTER_MS = 24 * 60 * 60_000;
/** 一次推最多等多久。 */
export const PUSH_TIMEOUT_MS = 20_000;
/** Windows 计划任务的名字。 */
export const TASK_NAME = 'fleet-local-sessions';
/** 退回自启时放在启动文件夹里的 vbs 的文件名。 */
export const STARTUP_VBS = 'fleet-local-sessions.vbs';
/**
 * 挂在哪几个事件上。调工具前（PreToolUse）不挂：每次调用都起一个 node（实测 138-250ms），推送却 2 分钟才一次；
 * 两次之间在不在动，推的时候读会话记录（~/.claude/projects/…/<会话>.jsonl）的修改时间（transcriptOf、withTranscript）。
 * 登记时一律 async：心跳不该让会话等它。
 */
export const HOOK_EVENTS = ['SessionStart', 'Stop', 'SubagentStop', 'SessionEnd'];
/** Stop 之后会话记录还会晚写几秒（文档：记录是异步写的）：晚这么多以内仍算刚停，超过了才算又在跑。 */
export const STOP_SLACK_MS = 30_000;
/** 读会话记录尾巴找最后一个工具名，最多读这么多字节。 */
const TAIL_BYTES = 64 * 1024;

/**
 * 一个会话的心跳（和 shared 的 LocalSessionSchema 同形）。
 * @typedef {{ id: string, repo: string | null, branch: string | null, worktree: string | null, subagent: boolean, agentType?: string, startedAt: string, lastSeenAt: string, last: 'tool' | 'start' | 'stop' | 'end', lastTool: string | null }} Beat
 */
/**
 * 推的那一份（和 shared 的 LocalSessionsReportSchema 同形）。
 * @typedef {{ schemaVersion: number, reportedAt: string, machine: string, sessions: Beat[], problems: string[] }} Report
 */
/**
 * 装的时候写下的配置：推到哪、带哪把通行证、机器叫什么。
 * @typedef {{ url: string, token: string, machine?: string }} Config
 */
/**
 * 上一次推的结果。
 * @typedef {{ at: string, ok: boolean, status?: number, why?: string, sessions?: number }} PushStatus
 */

/** @param {string} home */
export const baseDir = (home) => join(home, '.fleet-dao', 'local-sessions');
/** @param {string} home */
export const sessionsDir = (home) => join(baseDir(home), 'sessions');
/** @param {string} home */
export const binDir = (home) => join(baseDir(home), 'bin');
/** @param {string} home */
export const configPath = (home) => join(baseDir(home), 'config.json');
/** @param {string} home */
export const loopPidPath = (home) => join(baseDir(home), 'loop.pid');
/** @param {string} home */
export const statusPath = (home) => join(baseDir(home), 'last-push.json');

/**
 * 非空字符串截到 max 个字符；别的一律 null。
 * @param {unknown} v
 * @param {number} max
 * @returns {string | null}
 */
export const clip = (v, max) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null);

/**
 * @param {unknown} e
 * @returns {string}
 */
export const messageOf = (e) => (e instanceof Error ? e.message : String(e));

/**
 * 原子写：先写临时文件再改名，读的一方不会读到写了一半的。
 * @param {string} path
 * @param {string} text
 */
export function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * cwd 在哪个仓、哪个分支、哪棵工作树。只读 .git 里的 HEAD、commondir、config 三个小文件，不起 git 进程。
 * 读不出来的项是 null（不在 git 仓里三项都是 null）。
 * @param {string} cwd
 * @returns {{ repo: string | null, branch: string | null, worktree: string | null }}
 */
export function gitInfo(cwd) {
  const none = { repo: null, branch: null, worktree: null };
  try {
    let dir = resolve(cwd);
    for (let i = 0; i < 40; i += 1) {
      const dotGit = join(dir, '.git');
      if (existsSync(dotGit)) return readGit(dir, dotGit);
      const up = dirname(dir);
      if (up === dir) return none;
      dir = up;
    }
    return none;
  } catch {
    return none;
  }
}

/**
 * @param {string} top 工作树（或主检出）的根
 * @param {string} dotGit
 * @returns {{ repo: string | null, branch: string | null, worktree: string | null }}
 */
function readGit(top, dotGit) {
  let gitDir = dotGit;
  let commonDir = dotGit;
  let worktree = null;
  if (statSync(dotGit).isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!m?.[1]) return { repo: null, branch: null, worktree: null };
    gitDir = resolve(top, m[1].trim());
    const common = join(gitDir, 'commondir');
    commonDir = existsSync(common) ? resolve(gitDir, readFileSync(common, 'utf8').trim()) : gitDir;
    worktree = clip(basename(top), 200);
  }
  let branch = null;
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8');
    branch = clip(/^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1], 200);
  } catch {
    branch = null;
  }
  let repo = null;
  try {
    const config = readFileSync(join(commonDir, 'config'), 'utf8');
    const url = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(config)?.[1];
    const gh = url ? /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url) : null;
    repo = gh?.[1] && gh[2] ? clip(`${gh[1]}/${gh[2]}`, 200) : null;
  } catch {
    repo = null;
  }
  // 没有 GitHub 的 origin：用主检出的目录名（commonDir 是 <主检出>/.git）
  repo ??= clip(basename(dirname(commonDir)), 200);
  return { repo, branch, worktree };
}

/** @type {Record<string, Beat['last']>} */
const LAST_OF = {
  SessionStart: 'start',
  PreToolUse: 'tool',
  Stop: 'stop',
  SubagentStop: 'stop',
  SessionEnd: 'end',
};

/**
 * 钩子输入 → 这次要写的心跳。只挑元信息，输入里别的（tool_input、prompt、transcript_path……）一概不碰。
 * 认不出的输入（没有会话编号、不认识的事件）返回 null。
 * @param {Beat | null} prev 这个会话上一次的心跳
 * @param {Record<string, unknown>} input 钩子从 stdin 收到的 JSON
 * @param {Date} now
 * @returns {Beat | null}
 */
export function beatOf(prev, input, now) {
  const sessionId = clip(input.session_id, 60);
  const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : '';
  const last = LAST_OF[event];
  if (!sessionId || !last) return null;
  const agentId = clip(input.agent_id, 36);
  const subagent = agentId !== null;
  const agentType = subagent ? clip(input.agent_type, 100) : null;
  const at = now.toISOString();
  const git =
    typeof input.cwd === 'string' ? gitInfo(input.cwd) : { repo: null, branch: null, worktree: null };
  /** @type {Beat} */
  const beat = {
    id: subagent ? `${sessionId}~${agentId}` : sessionId,
    repo: git.repo ?? prev?.repo ?? null,
    branch: git.branch ?? prev?.branch ?? null,
    worktree: git.repo === null ? (prev?.worktree ?? null) : git.worktree,
    subagent,
    startedAt: prev?.startedAt ?? at,
    lastSeenAt: at,
    last,
    lastTool: event === 'PreToolUse' ? clip(input.tool_name, 100) : (prev?.lastTool ?? null),
  };
  if (agentType) beat.agentType = agentType;
  return beat;
}

/** @param {string} id */
const fileOf = (id) => `${id.replace(/[^\w.-]/g, '_')}.json`;

/**
 * 认一份心跳文件：形状对得上才算。
 * @param {unknown} v
 * @returns {v is Beat}
 */
export function isBeat(v) {
  if (typeof v !== 'object' || v === null) return false;
  const b = /** @type {Record<string, unknown>} */ (v);
  const strOrNull = (/** @type {unknown} */ x) => x === null || typeof x === 'string';
  return (
    typeof b.id === 'string' &&
    strOrNull(b.repo) &&
    strOrNull(b.branch) &&
    strOrNull(b.worktree) &&
    typeof b.subagent === 'boolean' &&
    (b.agentType === undefined || typeof b.agentType === 'string') &&
    typeof b.startedAt === 'string' &&
    !Number.isNaN(Date.parse(b.startedAt)) &&
    typeof b.lastSeenAt === 'string' &&
    !Number.isNaN(Date.parse(b.lastSeenAt)) &&
    (b.last === 'tool' || b.last === 'start' || b.last === 'stop' || b.last === 'end') &&
    strOrNull(b.lastTool)
  );
}

/**
 * 钩子那一头：收到一次触发，写（覆盖）这个会话的心跳文件。返回写下的心跳；认不出的输入什么都不写、返回 null。
 * @param {Record<string, unknown>} input
 * @param {{ home: string, now: Date }} opts
 * @returns {Beat | null}
 */
export function writeHeartbeat(input, { home, now }) {
  const first = beatOf(null, input, now);
  if (!first) return null;
  const path = join(sessionsDir(home), fileOf(first.id));
  /** @type {Beat | null} */
  let prev = null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (isBeat(parsed)) prev = parsed;
  } catch {
    prev = null;
  }
  const beat = prev ? beatOf(prev, input, now) : first;
  if (!beat) return null;
  writeAtomic(path, `${JSON.stringify(beat)}\n`);
  return beat;
}

/**
 * Claude Code 存会话记录的目录：CLAUDE_CONFIG_DIR 设了用它，否则 <home>/.claude。
 * @param {string} home
 * @param {NodeJS.ProcessEnv} [env]
 */
export const claudeDirOf = (home, env = process.env) => env.CLAUDE_CONFIG_DIR || join(home, '.claude');

/**
 * 一个心跳对应的会话记录在哪：主会话 projects/<任一目录>/<会话>.jsonl，子代理 projects/<任一目录>/<会话>/subagents/agent-<编号>.jsonl。
 * 找不到是 null。projectDirs 是 projects 下的目录名（一轮推只列一次）。
 * @param {string} projects
 * @param {string[]} projectDirs
 * @param {string} id 心跳的 id（子代理是 <会话>~<编号>）
 * @returns {string | null}
 */
export function transcriptOf(projects, projectDirs, id) {
  const [session, agent] = id.split('~');
  if (!session || !/^[\w.-]+$/.test(session) || (agent !== undefined && !/^[\w.-]+$/.test(agent)))
    return null;
  const rel = agent === undefined ? `${session}.jsonl` : join(session, 'subagents', `agent-${agent}.jsonl`);
  for (const d of projectDirs) {
    const p = join(projects, d, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 会话记录尾巴里最后一个工具名；读不到、没有是 null。只取名字，参数一个字都不碰。
 * @param {string} path
 * @returns {string | null}
 */
function lastToolIn(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const re = /"type":"tool_use","id":"[^"]*","name":"([^"\\]{1,100})"/g;
    let name = null;
    for (const m of buf.toString('utf8').matchAll(re)) name = m[1] ?? name;
    return clip(name, 100);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * 拿会话记录补一份心跳（只改推出去的这份，不回写心跳文件）：记录比心跳新，最后一次动跟着记录走；
 * 刚开场（start）之后记录在动，算在跑；Stop 之后记录又动了（超过 STOP_SLACK_MS），算又在跑；收场（end）的不改。
 * 工具名有就换成记录里最后一个。没有记录原样返回。
 * @param {Beat} beat
 * @param {string | null} path
 * @returns {Beat}
 */
export function withTranscript(beat, path) {
  if (path === null) return beat;
  let mtime;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    return beat;
  }
  const seen = Date.parse(beat.lastSeenAt);
  if (beat.last === 'end' || !(mtime > seen)) return beat;
  const moved =
    beat.last === 'start' || beat.last === 'tool' || (beat.last === 'stop' && mtime - seen > STOP_SLACK_MS);
  return {
    ...beat,
    lastSeenAt: new Date(mtime).toISOString(),
    ...(moved ? { last: /** @type {const} */ ('tool') } : {}),
    lastTool: lastToolIn(path) ?? beat.lastTool,
  };
}

/** @param {string} dir @returns {string[]} */
function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * 推送那一头：读全部心跳，挑出该推的。早没了的（超过 DROP_AFTER_MS 没动、或收场超过 RECENT_STOP_MS）顺手删掉文件；
 * 认不出的文件不删、记进 problems 照实推上去。每份心跳先按会话记录补过（withTranscript）再判。
 * @param {{ home: string, now: Date, claudeDir?: string }} opts
 * @returns {{ sessions: Beat[], problems: string[] }}
 */
export function collect({ home, now, claudeDir }) {
  // 不给就是 <home>/.claude：测试的假家里不会读到真机器的 CLAUDE_CONFIG_DIR；真推的 push.mjs 按 claudeDirOf 传进来
  const projects = join(claudeDir ?? join(home, '.claude'), 'projects');
  const projectDirs = listDirs(projects);
  const dir = sessionsDir(home);
  /** @type {Beat[]} */
  const sessions = [];
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (e) {
    const code = typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined;
    if (code !== 'ENOENT') problems.push(`心跳目录读不了：${messageOf(e)}`.slice(0, 300));
    return { sessions, problems };
  }
  for (const name of names) {
    const path = join(dir, name);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      if (problems.length < 20) problems.push(`心跳文件 ${name} 读不了：${messageOf(e)}`.slice(0, 300));
      continue;
    }
    if (!isBeat(parsed)) {
      if (problems.length < 20) problems.push(`心跳文件 ${name} 认不出`.slice(0, 300));
      continue;
    }
    const beat = withTranscript(parsed, transcriptOf(projects, projectDirs, parsed.id));
    const age = now.getTime() - Date.parse(beat.lastSeenAt);
    const ended = beat.last === 'stop' || beat.last === 'end';
    if (age > DROP_AFTER_MS || (beat.last === 'end' && age > RECENT_STOP_MS)) {
      rmSync(path, { force: true });
      continue;
    }
    if (ended && age > RECENT_STOP_MS) continue;
    sessions.push(beat);
  }
  sessions.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  return { sessions: sessions.slice(0, MAX_SESSIONS), problems };
}

/**
 * @param {{ home: string, now: Date, machine?: string, claudeDir?: string }} opts
 * @returns {Report}
 */
export function buildReport({ home, now, machine, claudeDir }) {
  const { sessions, problems } = collect({ home, now, ...(claudeDir ? { claudeDir } : {}) });
  return {
    schemaVersion: SCHEMA_VERSION,
    reportedAt: now.toISOString(),
    machine: clip(machine, 60) ?? clip(hostname(), 60) ?? '本机',
    sessions,
    problems,
  };
}

/**
 * 读装的时候写下的配置。没有、坏了都抛错写明白。
 * @param {string} home
 * @returns {Config}
 */
export function readConfig(home) {
  const path = configPath(home);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `没配 ${path}：重装一次（pnpm local-sessions install --url <法国地址>，通行证放环境变量 FLEET_NODE_TOKEN）`,
    );
  }
  /** @type {unknown} */
  let v;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path} 不是 JSON：${messageOf(e)}`);
  }
  if (typeof v !== 'object' || v === null) throw new Error(`${path} 认不出`);
  const c = /** @type {Record<string, unknown>} */ (v);
  if (typeof c.url !== 'string' || !/^https?:\/\//.test(c.url)) throw new Error(`${path} 里 url 不对`);
  if (typeof c.token !== 'string' || c.token === '') throw new Error(`${path} 里没有 token`);
  return {
    url: c.url,
    token: c.token,
    ...(typeof c.machine === 'string' ? { machine: c.machine } : {}),
  };
}

/**
 * 推一次，结果写进 last-push.json（成没成、法国回了什么、为什么）。不抛：失败照实写下、返回。
 * @param {{ home: string, now: Date, fetchImpl?: typeof fetch, claudeDir?: string }} opts
 * @returns {Promise<PushStatus>}
 */
export async function pushOnce({ home, now, fetchImpl = fetch, claudeDir }) {
  /** @type {PushStatus} */
  let result;
  try {
    const config = readConfig(home);
    const report = buildReport({
      home,
      now,
      ...(config.machine ? { machine: config.machine } : {}),
      ...(claudeDir ? { claudeDir } : {}),
    });
    const url = `${config.url.replace(/\/+$/, '')}${PUSH_PATH}`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: config.token },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (res.ok) {
      result = { at: now.toISOString(), ok: true, status: res.status, sessions: report.sessions.length };
    } else {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      result = { at: now.toISOString(), ok: false, status: res.status, why: `法国回 ${res.status}：${text}` };
    }
  } catch (e) {
    result = { at: now.toISOString(), ok: false, why: `推不出去：${messageOf(e)}` };
  }
  try {
    writeAtomic(statusPath(home), `${JSON.stringify(result, null, 2)}\n`);
  } catch {
    // 写不下结果也不抛：计划任务的退出码照样说明成没成
  }
  return result;
}
