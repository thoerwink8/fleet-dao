// 给执行体进程的环境变量：每次起会话都现场显式构造，不继承宿主进程的环境块。
// 长驻进程的环境会陈旧（旧系统里守护进程带着一周前的 env 起会话，排查了两小时），所以只从宿主抄一小撮基础变量。
// 会话里拿不到任何 GitHub 凭据：只在本地提交，推分支、开 PR 由引擎在会话外做（设计第十四节）——
// Claude 会话的网络流量经 reclaude 的代理（VPS 实测会话里 git 也带着它的 HTTPS_PROXY），凭据不能过它。
import { delimiter } from 'node:path';

/** 只从宿主环境抄这些。XDG_RUNTIME_DIR 给 systemd-run --user 用；后半截是 Windows 开发机上起 node 必需的系统变量。 */
export const SESSION_BASE_KEYS: ReadonlySet<string> = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'TERM',
  'XDG_RUNTIME_DIR',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'HOMEDRIVE',
  'HOMEPATH',
]);

/** 任何执行体的会话环境里都不许有：能让会话拿到 GitHub 或别的推送凭据的。 */
export const CREDENTIAL_ENV: readonly RegExp[] = [
  /^GH_/i,
  /^GITHUB_TOKEN$/i,
  /^GIT_ASKPASS$/i,
  /^GIT_CONFIG_/i,
  /^SSH_AUTH_SOCK$/i,
];

export interface SessionEnvInput {
  /** 宿主环境，一般传 process.env；只会抄白名单里的键。 */
  base: Readonly<Record<string, string | undefined>>;
  /** fleet 命令的后端地址。 */
  fleetApi: string;
  /** 只对本任务这次会话有效的通行证。 */
  fleetToken: string;
  /** 放到 PATH 最前面的目录，例如装着 fleet 命令的目录。 */
  pathPrepend?: string[];
  /** 其余要带的变量，最后合并；带凭据类的键会被拒。 */
  extra?: Record<string, string>;
}

export function buildSessionEnv(input: SessionEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (SESSION_BASE_KEYS.has(upper) || upper.startsWith('LC_')) env[key] = value;
  }
  if (input.pathPrepend?.length) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    env[key] = [...input.pathPrepend, env[key]].filter((part) => part).join(delimiter);
  }
  env.FLEET_API = input.fleetApi;
  env.FLEET_TOKEN = input.fleetToken;
  if (input.extra) Object.assign(env, input.extra);
  assertNoForbiddenEnv(
    env,
    CREDENTIAL_ENV,
    '会话里只在本地提交，推分支、开 PR 由引擎在会话外做，凭据不进会话',
  );
  return env;
}

/** 环境里出现命中 rules 的键就拒起，why 写进报错。 */
export function assertNoForbiddenEnv(
  env: Readonly<Record<string, string>>,
  rules: readonly RegExp[],
  why: string,
): void {
  const bad = Object.keys(env).filter((key) => rules.some((re) => re.test(key)));
  if (bad.length) throw new Error(`会话环境里不许带 ${bad.join('、')}：${why}`);
}
