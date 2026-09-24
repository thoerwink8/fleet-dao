// 给执行体进程的环境变量：每次起会话都现场显式构造，不继承宿主进程的环境块。
// 长驻进程的环境会陈旧（旧系统里守护进程带着一周前的 env 起会话，排查了两小时），所以只从宿主抄一小撮基础变量。
import { delimiter } from 'node:path';

/** 只从宿主环境抄这些。后半截是 Windows 开发机上起 node 必需的系统变量，Linux 上没有它们。 */
const BASE_KEYS = new Set([
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

export interface SessionEnvInput {
  /** 宿主环境，一般传 process.env；只会抄白名单里的键。 */
  base: Readonly<Record<string, string | undefined>>;
  /** fleet 命令的后端地址。 */
  fleetApi: string;
  /** 只对本任务这次会话有效的通行证。 */
  fleetToken: string;
  /** 限时的 GitHub 令牌（「干活的」机器人），给 gh 和 git 推分支用。 */
  githubToken?: string;
  /** 放到 PATH 最前面的目录，例如装着 fleet 命令的目录。 */
  pathPrepend?: string[];
  /** 其余要带的变量，最后合并。 */
  extra?: Record<string, string>;
}

export function buildSessionEnv(input: SessionEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (BASE_KEYS.has(upper) || upper.startsWith('LC_')) env[key] = value;
  }
  if (input.pathPrepend?.length) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    env[key] = [...input.pathPrepend, env[key]].filter((part) => part).join(delimiter);
  }
  env.FLEET_API = input.fleetApi;
  env.FLEET_TOKEN = input.fleetToken;
  if (input.githubToken) Object.assign(env, githubTokenEnv(input.githubToken));
  if (input.extra) Object.assign(env, input.extra);
  return env;
}

/**
 * gh 直接读 GH_TOKEN；git 走 HTTPS 时由这里配的凭据助手从 GH_TOKEN 取令牌。
 * 先清空宿主已配的凭据助手（系统或全局配置里的），免得弹窗等人，或者拿到别的账号。
 */
export function githubTokenEnv(token: string): Record<string, string> {
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1:
      '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f',
  };
}
