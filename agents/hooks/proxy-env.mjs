// 备用代理进会话的 Bash：开会话钩子（项目级 session-start.mjs、用户级 plugin-loader.mjs）
// 往 $CLAUDE_ENV_FILE 追加 export 行，让 Bash 里的 gh、curl、npm 走 ~/.fleet-dao/fallback-proxy（本机是 mihomo 的 127.0.0.1:7890）。
// 为什么：会话进程环境里的 HTTPS_PROXY 是 reclaude 写进 ~/.claude/settings.json env 的 56879，改那里会被写回；
// 非 Claude Code 的流量穿过它约 90 秒后设备被解绑（docs/reference/adapters.md CC-10）。本机实测：github 走 7890 ok 1.0s，
// 走 56879 失败 10.5s，直连失败 21.8s。git 由 agents-sync 设 http.https://github.com/.proxy（packages/agents-sync/src/git-proxy.ts）。
//
// 改这里之前必须知道：
// - CLAUDE_ENV_FILE 只给 SessionStart、Setup、CwdChanged、FileChanged 钩子；每条 Bash 命令前先跑这份文件。要追加，不覆盖别的钩子写的。
// - 一行只写一个 `export NAME=value`：PowerShell 只认这种纯赋值行，有一行不是它就一个变量都不给。值里带 / 的变量 Windows 上的
//   PowerShell 本来就收不到（文档原话），所以这份只管 Bash。
// - NO_PROXY 留着 localhost,127.0.0.1,::1（再并上进程里原有的），本机的口不绕代理。
// - 没配不写、不出声；那一行认不出不写、说一句；同一份文件写过就不再写（两个开会话钩子都调它）。
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { readFallbackProxy } from './git-run.mjs';

const PROXY_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];
const LOCAL = ['localhost', '127.0.0.1', '::1'];

/**
 * 本机地址打底，再并上原有的 NO_PROXY（大小写两个都看），去重、保序。
 * @param {Record<string, string | undefined>} env
 */
export function noProxyOf(env) {
  const have = `${env.NO_PROXY ?? ''},${env.no_proxy ?? ''}`
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...LOCAL, ...have])].join(',');
}

/**
 * 一个子进程的环境：四个代理变量换成 proxy，NO_PROXY 留着本机地址（开会话钩子的后台子进程用：gh、ssh、node 都走它）。
 * @param {Record<string, string | undefined>} env
 * @param {string} proxy
 */
export function proxyEnvOf(env, proxy) {
  const out = { ...env };
  for (const k of PROXY_KEYS) out[k] = proxy;
  const np = noProxyOf(env);
  out.NO_PROXY = np;
  out.no_proxy = np;
  return out;
}

/**
 * 往 envFile 追加代理变量。返回要说给会话的几行（一般是空的）。
 * @param {{ home?: string, envFile: string | undefined, env?: Record<string, string | undefined> }} o
 * @returns {string[]}
 */
export function writeProxyEnv({ home = homedir(), envFile, env = process.env }) {
  if (!envFile) return [];
  const fb = readFallbackProxy(home);
  if (fb.bad)
    return [
      '~/.fleet-dao/fallback-proxy 那一行认不出（只认 http:// 或 socks5:// 开头的 host:port、不带用户名密码），Bash 里的 gh/curl 没改走备用代理。',
    ];
  if (!fb.proxy) return [];
  const np = noProxyOf(env);
  const lines = [
    ...PROXY_KEYS.map((k) => `export ${k}=${fb.proxy}`),
    `export NO_PROXY=${np}`,
    `export no_proxy=${np}`,
  ];
  try {
    let have = '';
    try {
      have = readFileSync(envFile, 'utf8');
    } catch {
      have = '';
    }
    const missing = lines.filter((l) => !have.split(/\r?\n/).includes(l));
    if (missing.length === 0) return [];
    mkdirSync(dirname(envFile), { recursive: true });
    const sep = have !== '' && !have.endsWith('\n') ? '\n' : '';
    appendFileSync(envFile, `${sep}${missing.join('\n')}\n`);
    return [];
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    return [
      `备用代理没写进 CLAUDE_ENV_FILE（${e?.code ?? e?.message ?? String(err)}）：Bash 里的 gh/curl 还走会话环境里的代理。`,
    ];
  }
}
