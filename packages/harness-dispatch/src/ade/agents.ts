// 本机 ADE 下拉里有哪些 agent（#3924）。只看本机 CLI 装没装、登录了没有，不负责登录。
// claude 经 reclaude；grok 用家里的 ~/.grok/bin/grok（不在 PATH 上也认）。codex、pi 没登录就标出来，不能选。
import { access, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { localHost, makeRedactor } from '@fleet-dao/harness-runner';
import { runCommand } from '../command.ts';

export interface AdeAgentInfo {
  id: string;
  /** 第二次消息会带上这家自己的续跑旗标。 */
  resume: boolean;
  models: string[];
  /** 缺省当能选。false 时下拉里看得见但不能选。 */
  ready?: boolean;
  /** 跟在名字后面的说明，例如「未登录」。 */
  note?: string;
  /** 当前登录的邮箱。读不到就不带，页面写「读不到」，不编一个。 */
  account?: string;
  /** 型号不是从 CLI 列出来的时候，给人看的一句说明。 */
  modelsNote?: string;
}

const ORDER = ['claude', 'grok', 'codex', 'pi'] as const;
export type ListedAgent = (typeof ORDER)[number];

export interface AgentRunResult {
  code: number | null;
  out: string;
  timedOut: boolean;
}

export type AgentRun = (
  bin: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
) => Promise<AgentRunResult>;

const PROBE_MS = 20_000;
const CACHE_MS = 30_000;

export function orderModels(ids: readonly string[], prefer: string): string[] {
  const uniq = [...new Set(ids)];
  const i = uniq.indexOf(prefer);
  if (i > 0) {
    uniq.splice(i, 1);
    uniq.unshift(prefer);
  }
  return uniq;
}

/** `grok models` 的文本。没登录或认不出名单就 models 为空。 */
export function parseGrokModels(text: string): { loggedIn: boolean; models: string[] } {
  if (/not logged in|not authenticated|please (log|sign) in|login required/i.test(text)) {
    return { loggedIn: false, models: [] };
  }
  const models: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[*+-]\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\b/.exec(line);
    if (m?.[1]) models.push(m[1]);
  }
  const def = /Default model:\s*([A-Za-z0-9][A-Za-z0-9._:-]*)/.exec(text);
  if (def?.[1] && !models.includes(def[1])) models.unshift(def[1]);
  const loggedIn = /you are logged in/i.test(text) || models.length > 0;
  return { loggedIn, models: orderModels(models, 'grok-4.7') };
}

function jsonSlice(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

/** `reclaude auth status` 打出来的 JSON。认不出就 null，不当成已登录。 */
export function claudeLoggedIn(text: string): boolean | null {
  const j = jsonSlice(text);
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const logged = (j as { loggedIn?: unknown }).loggedIn;
  return typeof logged === 'boolean' ? logged : null;
}

/** 只认名叫 email 的字段。不扫别的字符串，免得把令牌当成账号。 */
export function emailField(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 5) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = emailField(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if (
      key === 'email' &&
      typeof item === 'string' &&
      item.includes('@') &&
      item.length <= 80 &&
      !/\s/.test(item)
    ) {
      return item;
    }
    const hit = emailField(item, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export function claudeAccount(text: string): string | null {
  return emailField(jsonSlice(text));
}

/** codex login status 一类的短输出。 */
export function cliAuth(text: string, code: number | null): 'in' | 'out' | 'unknown' {
  if (/not logged in|not authenticated|please (log|sign) in|login required|no credentials/i.test(text)) {
    return 'out';
  }
  if (code === 0) return 'in';
  return 'unknown';
}

/** ~/.pi/agent/auth.json。空对象或读不到内容当没登录；解析失败当没查成。 */
export function piAuthReady(raw: string | null): 'in' | 'out' | 'unknown' {
  if (raw === null) return 'out';
  try {
    const j = JSON.parse(raw) as unknown;
    if (!j || typeof j !== 'object' || Array.isArray(j)) return 'unknown';
    return Object.keys(j).length > 0 ? 'in' : 'out';
  } catch {
    return 'unknown';
  }
}

function claudeModels(env: NodeJS.ProcessEnv): { models: string[]; modelsNote?: string } {
  const models = (env.FLEET2_MODELS ?? env.FLEET2_MODEL ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // `default` 不是 reclaude 认的模型名。CLI 没有型号名单，空的时候用 sonnet 这个别名，并写明。
  if (models.length > 0) return { models };
  return { models: ['sonnet'], modelsNote: 'CLI 没有型号名单，这是别名' };
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.USERPROFILE || env.HOME || homedir();
}

export async function findOnPath(cmd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const path = env.PATH ?? env.Path ?? '';
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, cmd + ext);
      try {
        await access(full);
        return full;
      } catch {
        /* 下一个 */
      }
    }
  }
  return null;
}

/** grok 优先家里的二进制，和 PATH 上碰巧同名的分开。 */
export async function findAgentBin(id: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (id === 'claude') return findOnPath('reclaude', env);
  if (id === 'grok') {
    const home = homeOf(env);
    const names = process.platform === 'win32' ? ['grok.exe', 'grok.cmd', 'grok'] : ['grok'];
    for (const name of names) {
      const full = join(home, '.grok', 'bin', name);
      try {
        await access(full);
        return full;
      } catch {
        /* 下一个名字 */
      }
    }
    return findOnPath('grok', env);
  }
  if (id === 'codex') return findOnPath('codex', env);
  if (id === 'pi') return findOnPath('pi', env);
  return null;
}

function probeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  // CI=true 时 reclaude 会当成 claude --print，auth status 起不来。
  delete next.CI;
  return next;
}

/** Windows 上直接 spawn .cmd/.bat 会 EINVAL。经 cmd.exe /c 跑；别的原样。 */
export function probeLaunch(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const com = env.ComSpec || env.COMSPEC || 'cmd.exe';
    const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const inner = [quote(bin), ...args.map(quote)].join(' ');
    // /s 剥掉最外一层引号。windowsVerbatimArguments 才不会被再包一层。
    return { file: com, args: ['/d', '/s', '/c', `"${inner}"`], verbatim: true };
  }
  return { file: bin, args: [...args], verbatim: false };
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') next[k] = v;
  }
  return next;
}

const probeRedact = makeRedactor([]);

export const realRun: AgentRun = async (bin, args, timeoutMs, env) => {
  const clean = stringEnv(probeEnv(env));
  const spec = probeLaunch(bin, args, clean);
  // 登录探测是短命令。Windows 的 .cmd 要原样命令行；jobrun 会再包一层引号，所以走 localHost。
  const r = await runCommand({
    command: [spec.file, ...spec.args],
    cwd: tmpdir(),
    timeoutMs,
    redact: probeRedact,
    trustedEnv: clean,
    maxOutputChars: 16_000,
    host: localHost,
    ...(spec.verbatim ? { windowsVerbatimArguments: true } : {}),
  });
  const out = [r.stdout, r.stderrTail].filter((part) => part !== '').join('\n');
  if (r.spawnError) return { code: null, out: r.spawnError, timedOut: false };
  return { code: r.killed ? null : r.exitCode, out, timedOut: Boolean(r.killed) };
};

function offline(
  id: string,
  resume: boolean,
  how: 'in' | 'out' | 'unknown',
  models: string[],
  extra?: Pick<AdeAgentInfo, 'account' | 'modelsNote'>,
): AdeAgentInfo {
  if (how === 'in') return { id, resume, models, ready: true, ...extra };
  return { id, resume, models: [], ready: false, note: how === 'out' ? '未登录' : '没查成登录' };
}

async function describe(
  id: ListedAgent,
  bin: string,
  env: NodeJS.ProcessEnv,
  run: AgentRun,
  readText: (p: string) => Promise<string | null>,
): Promise<AdeAgentInfo> {
  const envp = probeEnv(env);
  if (id === 'claude') {
    const r = await run(bin, ['auth', 'status'], PROBE_MS, envp);
    const logged = r.timedOut ? null : claudeLoggedIn(r.out);
    const how = logged === true ? 'in' : logged === false ? 'out' : 'unknown';
    const models = claudeModels(env);
    const account = r.timedOut ? null : claudeAccount(r.out);
    return offline(id, true, how, models.models, {
      ...(account ? { account } : {}),
      ...(models.modelsNote ? { modelsNote: models.modelsNote } : {}),
    });
  }
  if (id === 'grok') {
    const r = await run(bin, ['models'], PROBE_MS, envp);
    if (r.timedOut) return offline(id, true, 'unknown', []);
    const parsed = parseGrokModels(r.out);
    if (!parsed.loggedIn || parsed.models.length === 0) return offline(id, true, 'out', []);
    const account = emailField(jsonSlice((await readText(join(homeOf(env), '.grok', 'auth.json'))) ?? ''));
    return { id, resume: true, models: parsed.models, ready: true, ...(account ? { account } : {}) };
  }
  if (id === 'codex') {
    const r = await run(bin, ['login', 'status'], PROBE_MS, envp);
    const how = r.timedOut ? 'unknown' : cliAuth(r.out, r.code);
    return offline(id, false, how, ['default']);
  }
  const raw = await readText(join(homeOf(env), '.pi', 'agent', 'auth.json'));
  return offline(id, false, piAuthReady(raw), ['default']);
}

export interface DiscoverDeps {
  run?: AgentRun;
  readText?: (p: string) => Promise<string | null>;
  binFor?: (id: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
}

let cache: { at: number; key: string; list: AdeAgentInfo[] } | null = null;

async function defaultRead(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/** 装了的才出现。顺序固定：claude、grok、codex、pi。默认探测缓存 30 秒，免得每次打开页面都起一遍 CLI。 */
export async function discoverAgents(env: NodeJS.ProcessEnv, deps?: DiscoverDeps): Promise<AdeAgentInfo[]> {
  const run = deps?.run ?? realRun;
  const readText = deps?.readText ?? defaultRead;
  const binFor = deps?.binFor ?? findAgentBin;
  const key = `${env.PATH ?? env.Path ?? ''}\n${homeOf(env)}`;
  if (!deps && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.list;
  const found = await Promise.all(
    ORDER.map(async (id) => {
      try {
        const bin = await binFor(id, env);
        if (!bin) return null;
        return await describe(id, bin, env, run, readText);
      } catch {
        // 一家探测抛了不能让整个下拉 500。认不出登录就不让选。
        return {
          id,
          resume: id === 'claude' || id === 'grok',
          models: [],
          ready: false,
          note: '没查成登录',
        } satisfies AdeAgentInfo;
      }
    }),
  );
  const list = found.filter((a): a is AdeAgentInfo => a !== null);
  if (!deps) cache = { at: Date.now(), key, list };
  return list;
}
