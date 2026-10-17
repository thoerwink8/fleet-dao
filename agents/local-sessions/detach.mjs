// 起一个不跟着聊天进程一起死的进程（单 #2761）。
// Mirasim 重启 Claude Code（创始人按停止、插队）用的是 `taskkill /PID <CLI> /T /F`（server.cjs 里就这一句）：/T 顺着「父进程号」把整棵树杀光。
// node 的 spawn({ detached: true }) 在 Windows 上只是新开进程组、不挂控制台，父进程号照样是起它的那个进程，所以照样被 /T 杀掉——
// 心跳推送的 loop.mjs 起始时间正好等于会话 resume 的时刻，就是这么死的。
// Windows 上改用 WMI（Win32_Process.Create）：进程由 WMI 服务（WmiPrvSE）起，父进程号不在聊天进程的树里，也不在它的作业对象里，
// taskkill /T 摸不到它。实验（10-16，PR 里有原始输出）：同一个父进程下 detached spawn 的死了、WMI 起的活着；
// 一次性无头 reclaude -p 的 Bash 工具里起的，照 Mirasim 的做法 taskkill /T /F 掉 reclaude，WMI 起的照样活着。
// 别的平台用 spawn({ detached: true })：setsid 另开会话和进程组，杀父进程组摸不到它。
//
// 改这里之前必须知道：
// - WMI 不继承调用方环境；需要传递时显式给 env，经 Win32_ProcessStartup.EnvironmentVariables 传，不写环境快照。
// - 命令行按 CreateProcess 的规矩转义（quoteArg）；不经 cmd.exe，不用管 ^ & |。
// - 纯 node、不起常驻进程；install.mjs 把它和 loop.mjs 一起拷进 ~/.fleet-dao/local-sessions/bin/。
// - 不抛：起不成返回 { ok: false, why }，调用方照实说没起成。
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** 起 PowerShell 跑 WMI 最多等多久（毫秒）：冷起 PowerShell 本身就要一两秒 */
export const WMI_TIMEOUT_MS = 20_000;

/** @typedef {{ ok: true, pid: number, how: 'wmi' | 'setsid' } | { ok: false, why: string }} Detached 起成了（进程号、怎么起的）或没起成 */
/**
 * @typedef {{
 *   cwd?: string,
 *   env?: Record<string, string>,
 *   platform?: NodeJS.Platform,
 *   runPs?: (env: Record<string, string>) => { status: number | null, stdout: string, stderr: string, error?: Error | undefined },
 * }} DetachOpts
 */

const WMI_SCRIPT =
  '$ErrorActionPreference="Stop";' +
  '$p=@{ShowWindow=[uint16]0};' +
  'if($env:FLEET_DETACH_ENV){$p.EnvironmentVariables=[string[]](ConvertFrom-Json $env:FLEET_DETACH_ENV);$p.CreateFlags=[uint32]1024};' +
  '$si=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property $p;' +
  '$a=@{CommandLine=$env:FLEET_DETACH_CMD;ProcessStartupInformation=$si};' +
  'if($env:FLEET_DETACH_CWD){$a.CurrentDirectory=$env:FLEET_DETACH_CWD};' +
  '$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $a;' +
  'Write-Output ("{0} {1}" -f $r.ReturnValue,$r.ProcessId)';

/** @param {unknown} e */
const why = (e) => (e instanceof Error ? e.message : String(e));

/**
 * 一个参数按 CreateProcess / CommandLineToArgvW 的规矩转义：没有空白和引号原样；否则包双引号，引号前的反斜杠加倍、引号本身加反斜杠，结尾的反斜杠加倍。
 * @param {string} arg
 */
export function quoteArg(arg) {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      slashes += 1;
      continue;
    }
    if (ch === '"') out += `${'\\'.repeat(slashes * 2 + 1)}"`;
    else out += `${'\\'.repeat(slashes)}${ch}`;
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

/**
 * 整条命令行。
 * @param {string} file
 * @param {readonly string[]} args
 */
export const commandLine = (file, args) => [file, ...args].map(quoteArg).join(' ');

/** @param {Record<string, string>} extra */
function realRunPs(extra) {
  // 钩子的 PATH 可能只有 git；系统 PowerShell 不依赖会话把它的目录放进 PATH。
  const ps = process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', WMI_SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, ...extra },
    timeout: WMI_TIMEOUT_MS,
    windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/**
 * 起一个脱离当前进程树的进程，不开窗口、不接标准输入输出（要日志就让它自己写文件）。不抛。
 * @param {string} file 可执行文件（给绝对路径：WMI 起的进程拿的是登录时的 PATH）
 * @param {readonly string[]} args
 * @param {DetachOpts} [opts]
 * @returns {Detached}
 */
export function spawnDetached(file, args, { cwd, env, platform = process.platform, runPs = realRunPs } = {}) {
  try {
    if (platform === 'win32') {
      const r = runPs({
        FLEET_DETACH_CMD: commandLine(file, args),
        FLEET_DETACH_CWD: cwd ?? '',
        ...(env
          ? { FLEET_DETACH_ENV: JSON.stringify(Object.entries(env).map(([k, v]) => `${k}=${v}`)) }
          : {}),
      });
      if (r.error) return { ok: false, why: `WMI 没起成（PowerShell 没跑起来：${r.error.message}）` };
      if (r.status !== 0) {
        return {
          ok: false,
          why: `WMI 没起成（PowerShell 退出码 ${r.status}：${r.stderr.trim().slice(0, 300)}）`,
        };
      }
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(r.stdout);
      if (!m) return { ok: false, why: `WMI 的输出认不出：${r.stdout.trim().slice(0, 200) || '（空）'}` };
      const code = Number(m[1]);
      const pid = Number(m[2]);
      if (code !== 0)
        return { ok: false, why: `WMI 的 Win32_Process.Create 返回 ${code}（不是 0 就是没起成）` };
      if (!(pid > 0)) return { ok: false, why: 'WMI 说起成了，可没给进程号' };
      return { ok: true, pid, how: 'wmi' };
    }
    const child = spawn(file, [...args], { cwd, env, detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // 起不来时 pid 是 undefined，下面照实报；这里只免得没人接的 error 把调用方崩掉
    child.unref();
    if (typeof child.pid !== 'number') return { ok: false, why: `起不来：${file}` };
    return { ok: true, pid: child.pid, how: 'setsid' };
  } catch (e) {
    return { ok: false, why: `起的时候自己出错了（${why(e)}）` };
  }
}
