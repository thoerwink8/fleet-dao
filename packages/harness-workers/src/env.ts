// 工人进程的环境：每次现场显式构造，只从宿主抄一小撮基础变量（长驻进程的环境会陈旧），从旧 adapters/src/env.ts 复制改写。
// 工人拿不到任何推送凭据（讨论稿第五节 3：影子工人光靠令牌不够，能 git push、curl 绕过）：对外写只经内核的 outbox。

/** 只从宿主环境抄这些。后半截是 Windows 开发机上起 node 必需的系统变量。 */
export const WORKER_BASE_KEYS: ReadonlySet<string> = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'HOMEDRIVE',
  'HOMEPATH',
]);

/** 工人环境里不许有的：能拿到 GitHub 或别的推送凭据的、像密钥的。 */
export const FORBIDDEN_ENV: readonly RegExp[] = [
  /^GH_/i,
  /^GITHUB_/i,
  /^GIT_ASKPASS$/i,
  /^GIT_CONFIG_/i,
  /^SSH_AUTH_SOCK$/i,
  /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)/i,
];

export class ForbiddenEnvError extends Error {
  constructor(keys: string[]) {
    super(`工人环境里不许有这些变量（推送凭据或像密钥）：${keys.join('、')}`);
    this.name = 'ForbiddenEnvError';
  }
}

export interface WorkerEnvInput {
  /** 宿主环境，一般传 process.env；只抄白名单里的键。 */
  base: Readonly<Record<string, string | undefined>>;
  /** 这个工人自己的临时目录（绝对路径），TMPDIR、TEMP、TMP 都指向它，跑完整个删。 */
  tmpDir: string;
  /** 额外的变量（例如假执行体的模式开关）；同样过禁表。 */
  extra?: Readonly<Record<string, string>>;
}

export function buildWorkerEnv(input: WorkerEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of WORKER_BASE_KEYS) {
    const v = input.base[key];
    if (v !== undefined) env[key] = v;
  }
  Object.assign(env, input.extra ?? {}, { TMPDIR: input.tmpDir, TEMP: input.tmpDir, TMP: input.tmpDir });
  assertNoForbiddenEnv(env);
  return env;
}

export function assertNoForbiddenEnv(env: Readonly<Record<string, string>>): void {
  const bad = Object.keys(env).filter((k) => FORBIDDEN_ENV.some((re) => re.test(k)));
  if (bad.length) throw new ForbiddenEnvError(bad);
}
