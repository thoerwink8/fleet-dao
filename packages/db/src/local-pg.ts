// 本机测试用的 Postgres（Windows 开发机：npm 的 @embedded-postgres/windows-x64 装在仓外，默认 D:/Tools/pg-e2e，端口 55432）。
// 入口 bin/local-pg.ts（pnpm pg:local [status|start|stop]）；驾驶舱 e2e 起栈前连不上它时提示同一条命令（web/e2e/support/stack.ts）。
// 改这里之前必须知道：
// - 直接在会话里起（postgres.exe、pg_ctl start 都一样）会落进 Claude Code 会话的作业对象，会话一重启整组被杀，库跟着没了。
//   所以 start 经 WMI（Win32_Process.Create）起 pg_ctl：进程由 WMI 服务替当前用户创建，父进程是 WmiPrvSE，不在会话的
//   作业对象里，会话重启不受影响。只在 Windows 上这么起；别的系统自己装 Postgres（packages/web/e2e/README.md）。
// - 起没起成只认端口连得上（等到 30 秒）：pg_ctl 退出 0 不等于库能连。
import { join } from 'node:path';

export const DEFAULT_PORT = 55432;
export const DEFAULT_DIR = 'D:/Tools/pg-e2e';
/** 起这台库的命令：连不上本机库的地方都提示它。 */
export const START_COMMAND = 'pnpm pg:local start';

export interface LocalPgConfig {
  dir: string;
  port: number;
  /** pg_ctl.exe 的路径（装在 dir 下的 npm 包里）。 */
  pgCtl: string;
  data: string;
  log: string;
}

/** 读 FLEET_LOCAL_PG_DIR、FLEET_LOCAL_PG_PORT（不设走默认）。端口认不出抛错，不悄悄换成默认。 */
export function localPgConfig(env: Readonly<Record<string, string | undefined>>): LocalPgConfig {
  const dir = env.FLEET_LOCAL_PG_DIR?.trim() || DEFAULT_DIR;
  const rawPort = env.FLEET_LOCAL_PG_PORT?.trim();
  const port = rawPort ? Number(rawPort) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`FLEET_LOCAL_PG_PORT 不是 1 到 65535 的整数：${rawPort}`);
  }
  return {
    dir,
    port,
    pgCtl: join(dir, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin', 'pg_ctl.exe'),
    data: join(dir, 'data'),
    log: join(dir, 'pg.log'),
  };
}

/** 管理连接串（嵌入式库 initdb 时是 trust 认证，不带口令）。 */
export const adminUrl = (port: number) => `postgres://postgres@127.0.0.1:${port}/postgres`;

/** PowerShell 单引号字符串：' 写成 ''。 */
const psQuote = (s: string) => `'${s.replaceAll("'", "''")}'`;

/**
 * 交给 powershell -Command 的脚本：经 WMI 起 pg_ctl start（脱离会话的作业对象，见文件头），打出 WMI 的返回码（0 = 起了进程）。
 * 命令行里的路径用双引号包住（D:/Tools 这类不带空格也照包）。
 */
export function wmiStartScript(c: LocalPgConfig): string {
  const cmd = `"${c.pgCtl}" start -D "${c.data}" -l "${c.log}" -o "-p ${c.port}"`;
  return [
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(cmd)}; CurrentDirectory = ${psQuote(c.dir)} }`,
    'Write-Output $r.ReturnValue',
  ].join('; ');
}

export interface LocalPgDeps {
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
  /** 端口连不连得上（127.0.0.1）。 */
  listening: (port: number) => Promise<boolean>;
  /** 跑 powershell 脚本：退出码和标准输出。 */
  powershell: (script: string) => {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error | undefined;
  };
  /** 跑 pg_ctl（stop 用）。 */
  pgCtl: (args: string[]) => {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error | undefined;
  };
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE =
  '用法：pnpm pg:local [status|start|stop]（FLEET_LOCAL_PG_DIR、FLEET_LOCAL_PG_PORT 改位置和端口）';

/** 入口的全部逻辑：回进程退出码。0 = 库在跑（stop：已停）；1 = 没起来 / 没停掉；2 = 参数、配置不对或装得不全。 */
export async function localPg(argv: readonly string[], c: LocalPgConfig, d: LocalPgDeps): Promise<number> {
  const action = argv[0] ?? 'status';
  if (argv.length > 1 || !['status', 'start', 'stop'].includes(action)) {
    d.err(USAGE);
    return 2;
  }
  const up = await d.listening(c.port);
  if (action === 'status') {
    if (up) {
      d.out(`本机 Postgres 在跑：${adminUrl(c.port)}`);
      return 0;
    }
    d.err(`本机 Postgres 没在跑（127.0.0.1:${c.port} 连不上）。起：${START_COMMAND}`);
    return 1;
  }
  if (action === 'stop') {
    if (!up) {
      d.out(`本机 Postgres 本来就没在跑（127.0.0.1:${c.port}）`);
      return 0;
    }
    const r = d.pgCtl(['stop', '-D', c.data, '-m', 'fast']);
    if (r.error || r.status !== 0) {
      d.err(`pg_ctl stop 没成：${r.error?.message ?? (r.stderr.trim() || `退出码 ${r.status}`)}`);
      return 1;
    }
    d.out('本机 Postgres 已停');
    return 0;
  }
  if (up) {
    d.out(`本机 Postgres 已经在跑：${adminUrl(c.port)}`);
    return 0;
  }
  if (d.platform !== 'win32') {
    d.err(
      'pnpm pg:local start 只管 Windows 开发机上的嵌入式 Postgres；别的系统自己装一台（见 packages/web/e2e/README.md）',
    );
    return 2;
  }
  for (const [what, path] of [
    ['pg_ctl', c.pgCtl],
    ['数据目录', c.data],
  ] as const) {
    if (!d.exists(path)) {
      d.err(
        `找不到${what}：${path}。先在 ${c.dir} 装 @embedded-postgres/windows-x64 并 initdb（packages/web/e2e/README.md），或用 FLEET_LOCAL_PG_DIR 指到装好的目录`,
      );
      return 2;
    }
  }
  const r = d.powershell(wmiStartScript(c));
  const code = r.stdout.trim().split(/\r?\n/).pop();
  if (r.error || r.status !== 0 || code !== '0') {
    d.err(
      `经 WMI 起 pg_ctl 没成：${r.error?.message ?? (r.stderr.trim() || `powershell 退出码 ${r.status}，WMI 返回 ${code ?? '（没有）'}`)}`,
    );
    return 1;
  }
  for (let waited = 0; waited < 30_000; waited += 500) {
    if (await d.listening(c.port)) {
      d.out(`本机 Postgres 起来了（脱离会话，会话重启不受影响）：${adminUrl(c.port)}`);
      d.out(`测试要库时：E2E_PG_ADMIN_URL=${adminUrl(c.port)}`);
      return 0;
    }
    await d.sleep(500);
  }
  d.err(`pg_ctl 起了，30 秒内 127.0.0.1:${c.port} 还是连不上：看日志 ${c.log}`);
  return 1;
}
