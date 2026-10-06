// 起一个「脱离会话」的后台进程（worker.mjs start --detached 的工人就是这么起的）。从 worker.mjs 拆出来：worker.mjs
// 顶层直接跑 runWorker（有副作用），detach-job-check.mjs 这类验证脚本没法 import 它。
//
// 为什么走 launch-detached.ps1 的 Win32_Process.Create（WMI），不再是 Start-Process（2026-10-06 实测的根因）：
// Start-Process 起的子进程（CreateProcess）仍留在调用者的 Windows Job Object 和进程树里。创始人发新消息时 Mirasim
// 把当前 Claude Code 会话进程掐掉——整个 Job Object 关闭（kill-on-close）或整棵树 taskkill /T——工人 overnight（pid
// 77744）、overnight2（pid 68528）都是日志戛然而止、没有收尾输出，时间差 2~18 秒。WMI 起的进程父进程是 WmiPrvSE.exe，
// 不在我们的 Job 里、也不在我们的进程树下，这两种掐法都够不着。detach-job-check.mjs 用真的 kill-on-close Job Object
// 对旧做法（会死）和新做法（不死）做了对照验证。
//
// WMI 起的进程环境变量是「整份替换」：只有 spec.env（worker-lib.mjs 的 safeEnv 白名单 + FLEET_WORKER 等）加 COMSPEC/
// PATHEXT/PROMPT 默认值，不继承会话里的令牌（旧的 Start-Process 是整份继承，白名单只防写盘）。所以 env 值直接进 spec 文件，
// 不准把没过滤的 process.env 传进来（09-28 修过的安全坑，见 worker-lib.mjs 文件头）。
//
// WMI 本身不管重定向：输出、错误、标准输入的重定向写在 cmd.exe 的命令行里（> out 2> err < in；没有 stdinFile 就 < NUL，
// 和原来 stdio:'ignore' 起的 Start-Process 一致）。重定向路径用普通双引号，所以路径里不准有 cmd.exe 会再解释的字符，
// 有就当「确认没起」报错，不硬拼。
//
// 两种失败的区分（和 09-28 一样，只有确认失败才能说「起不了」）见 spawn-detached-support.mjs 的 interpretLaunchResult。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpretLaunchResult, powershellSpawnOptions } from './spawn-detached-support.mjs';
import { windowsCmdLine } from './windows-quote.mjs';

export const LAUNCH_PS1 = fileURLToPath(new URL('./launch-detached.ps1', import.meta.url));
/** WMI 起进程比 Start-Process 慢一点（要连 WMI 服务），给慢盘/杀毒/WMI 冷启动留的上限，不是正常耗时（实测 1~3 秒）。 */
export const LAUNCH_TIMEOUT_MS = 30_000;

/** cmd.exe 在双引号里还会解释的字符（%var%、!var!、^、&|<>、引号）：重定向路径里有就不拼。 */
const UNSAFE_REDIRECT_PATH = /[%!^&|<>"\r\n]/;

/**
 * 纯函数：spawnDetached 写给 launch-detached.ps1 的 spec。commandLine 是塞进 `cmd.exe /d /s /c "…"` 里的那一整串。
 * @returns {{ commandLine: string, cwd: string, env: { name: string, value: string }[] }}
 */
export function buildLaunchSpec({ command, args, cwd, env, stdinFile, outFile, errFile }) {
  for (const [what, path] of [
    ['stdinFile', stdinFile],
    ['outFile', outFile],
    ['errFile', errFile],
  ]) {
    if (path && UNSAFE_REDIRECT_PATH.test(path)) {
      throw new Error(`${what} 路径里有 cmd.exe 会再解释的字符，不拼重定向：${path}`);
    }
  }
  // windowsCmdLine 给的是 "<inner>"（外面包了一层引号给 /c 剥），这里要把重定向接在 inner 后面，所以剥掉外层。
  const wrapped = windowsCmdLine(command, args);
  const inner = wrapped.slice(1, -1);
  const commandLine = `${inner} > "${outFile}" 2> "${errFile}" < ${stdinFile ? `"${stdinFile}"` : 'NUL'}`;
  return {
    commandLine,
    cwd,
    // {name,value} 数组，不是对象：见 launch-detached.ps1 里的说明。env 到这里之前已过白名单，这里只转格式。
    env: Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => ({ name, value: String(value) })),
  };
}

/**
 * 起一个脱离会话的后台进程，同步等到拿到 pid。
 * - 成功：{ pid }。
 * - 确认起不来：抛 Error（没有 .uncertain）：powershell.exe 自己没能跑，或 Win32_Process.Create 明确没成。
 * - 不确定（.uncertain = true）：没能确认成没成，可能已经在跑，不能说「起不了」。
 * @param {{ command: string, args: string[], cwd: string, env: Record<string, string | undefined>,
 *   stdinFile?: string | null, outFile: string, errFile: string }} o
 * @param {{ ps1?: string }} [opts] ps1 只给测试用（验证脚本拿旧的做对照）。
 */
export function spawnDetached(o, opts = {}) {
  const dir = dirname(o.outFile);
  const resultFile = join(dir, 'launch-result.json');
  const spec = buildLaunchSpec(o);
  const specFile = join(dir, 'launch-spec.json');
  writeFileSync(specFile, JSON.stringify(spec, null, 2));

  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      opts.ps1 ?? LAUNCH_PS1,
      '-Spec',
      specFile,
      '-Result',
      resultFile,
    ],
    powershellSpawnOptions({ timeoutMs: LAUNCH_TIMEOUT_MS }),
  );

  let resultText = null;
  try {
    resultText = readFileSync(resultFile, 'utf8');
  } catch {
    // 没有就是没有：交给 interpretLaunchResult 按「不确定」处理，不当成确认失败。
  }
  const interpreted = interpretLaunchResult({
    spawnError: r.error ? String(r.error.code ?? r.error.message) : null,
    spawnStatus: r.status,
    resultText,
  });
  if (interpreted.ok) return { pid: interpreted.pid };
  const err = new Error(interpreted.why);
  if (!interpreted.confirmed) err.uncertain = true;
  throw err;
}
