// worker.mjs 是外壳：真的 git/gh/pnpm/进程查杀/后台起进程。逻辑都在 worker-lib.mjs。node worker.mjs 不带参数看用法。
// 改这里之前必须知道（09-28 实测撞出来的两个坑，复现方式和过程写在 PR 正文）：
// - pnpm/grok/codex/kimi 在这台机器上 PATH 里解出来的都是 npm 装的 .cmd 套壳：Node 的 spawnSync 不给
//   shell:true 就找不到它们（ENOENT），给 shell:true 又是 Node 自己也警告的「参数只是拼接、没转义」，
//   有命令注入风险。同步调用（pnpm install 那一步）走 runViaCmd：自己拼一条
//   cmd.exe /d /s /c "<按 MSVCRT 和 cmd.exe 两层解析都对的规则转义好的整行>"，windowsVerbatimArguments:true
//   让 Node 别再帮倒忙重新加引号。转义算法在同目录 windows-quote.mjs（出处 https://qntm.org/cmd，cross-spawn
//   等主流工具用的就是这套；单独拆出文件是因为本文件顶层直接跑 runWorker、有副作用，测试没法直接 import
//   它），09-28 拿真的 pnpm.cmd 和一串刁钻字符（空格、双引号、%、&、^、|、反斜杠结尾）来回验证过，golden
//   值配了单元测试（agents/test/worker.test.ts「Windows 引号」）。
//   git、gh、taskkill 在这台是真 .exe（`where git/gh/taskkill` 能看到 .exe 路径），不需要、也不要走这条：
//   Node 直接 spawnSync 真 exe 本来就对，走 cmd.exe 包一层反而多一次没必要的解析。
// - 光会拼命令行不够起模型：detached:true 配 windowsHide 在这个 Claude Code 会话的沙箱里，子进程会在这条
//   node 命令跑完那一刻被杀掉（像是 Windows 任务对象「关闭时清场」，detached 逃不掉）——09-28 实测确认，
//   跟走不走 cmd.exe 无关，Node 直接起、不包 cmd.exe 一样被杀。改用 PowerShell 的 Start-Process（走的是
//   另一条 Win32 路径：ShellExecute 系，不受同一个任务对象管）才能在这条命令退出后照跑：spawnDetached 把
//   「起什么、往哪几个文件读写、带什么环境变量」写成一份 JSON，扔给同目录的 launch-detached.ps1，它调
//   Start-Process 起来、把 PID 打到标准输出，本脚本同步等这一下、读回 PID；真正长跑的那个进程从此和这条
//   node 命令毫无关系，随它退出照跑。launch-detached.ps1 自己的坑（纯 ASCII、不能有 BOM）写在它自己文件头。
// - Start-Process -ArgumentList 给数组时，Windows PowerShell 5.1 只是拿空格 -join，不会给每一项自动加引号：
//   一项里本来的空格会被当成参数分界（09-28 实测撞过：一段单行 JS 代码传进数组的一项，结果在第一个空格处
//   被截断）。所以 argumentLine 必须在这边（JS 这层，array 用 windowsCmdLine 拼好）整条拼成一个字符串，
//   经 JSON 传给 ps1 时就是一个字符串，ps1 那边原样传给 -ArgumentList，不能再拆开成数组。
// - Start-Process 没有「单独给这次调用设几个环境变量」的参数：本脚本把 io.spawnDetached 拿到的整份
//   env（worker-lib.mjs 的 safeEnv 算出来的，只有白名单里的标准路径类变量和代理变量，直连通时再由 mergeNoProxy
//   加上 GitHub 的 NO_PROXY/no_proxy——不是 process.env 整个，见下面「安全」那条）整个透传给 ps1，由它在调用 Start-Process 前
//   Set-Item Env: 逐个设上；传过去时编码成 [{name,value}...] 数组，不是一个普通对象——这台的 Windows
//   PowerShell 5.1 里 ConvertFrom-Json 转出来的对象属性名不分大小写，env 里同时有 NO_PROXY、no_proxy 两个键
//   会被当成重复键，直接报错（09-28 撞过），数组没有这个问题。
// - 【安全，09-28 当场修】这里收到的 env 参数绝不能是没过滤的 process.env：它会整个写进 launch-spec.json
//   明文留在磁盘上（下面那步），而 io.env 就是跑 worker.mjs 这个会话自己的完整环境，真撞见过里面带着
//   GITHUB_PERSONAL_ACCESS_TOKEN、MIRASIM_* 好几个真令牌（09-28 一次真起 grok 干活时留下的 launch-spec.json
//   里现原形）。过滤在 worker-lib.mjs 的 safeEnv 做（白名单，不是「挡像密钥的名字」那种黑名单），这个文件只管
//   把过滤好的 env 原样传下去，不准在这再加回任何东西。
// - 【09-28 晚上另一撞，ETIMEDOUT】光会拼命令行、会 Start-Process 还不够：本脚本一开始是拿默认的管道 stdio
//   调 powershell.exe，结果一次真活（60 秒后报「起不了 powershell.exe（ETIMEDOUT）」）暴露出 Start-Process
//   底下的 CreateProcess 会把这个管道的可继承句柄传给孙进程（cmd.exe -> grok/codex），哪怕孙进程自己的
//   stdout/stderr 已经另外重定向到文件——于是 Node 读这个管道会一直等到孙进程退出才算完，对一个跑好几分钟的
//   模型会话就是一直卡到超时，哪怕 Start-Process 早就成功起来了（那次是真的起来了、一直在跑，status 却查不
//   到，因为没走到写 meta.json 那步）。改用 spawn-detached-support.mjs 的 powershellSpawnOptions（钉死
//   stdio:'ignore'，没有管道就没什么可以被继承）+ 结果文件（pid/出错信息由 launch-detached.ps1 写进
//   launch-result.json，这边读文件而不是读 stdout）。文件里 interpretLaunchResult 认「确认失败」和「不确定」
//   两种失败：只有确认失败才能说「起不了」，不确定（比如结果文件没读到）要往上抛一个带 .uncertain=true 的
//   Error，worker-lib.mjs 的 cmdStart 认这个标记、不说「起不了」，把能写的 meta 先写上。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpretLaunchResult, powershellSpawnOptions } from './spawn-detached-support.mjs';
import { windowsCmdLine } from './windows-quote.mjs';
import { runWorker } from './worker-lib.mjs';

const LAUNCH_PS1 = fileURLToPath(new URL('./launch-detached.ps1', import.meta.url));
const TIMEOUT_MS = 120_000;
/** Start-Process 本身是异步/不等子进程退出就返回的，stdio:'ignore' 修好之后应该几秒内就回来（09-28 实测：
 * 冒烟跑下来是 1~2 秒），这个只是给慢盘/杀毒软件扫描新脚本这类偶发情况留的上限，不是正常耗时。 */
const LAUNCH_TIMEOUT_MS = 20_000;

/** git/gh 连 GitHub 走哪条路由 worker-lib.mjs 判（pickGithubRoute，见那份文件头「代理」）：调用带 proxy: true
 * 就照原样带环境里的代理，不给或为假就去掉代理直连（和帅位交活时手动加的 `env -u` 前缀一个道理）。 */
const PROXY_VARS = ['https_proxy', 'http_proxy', 'HTTPS_PROXY', 'HTTP_PROXY'];
function stripProxy(env) {
  const out = { ...env };
  for (const k of PROXY_VARS) delete out[k];
  return out;
}
const netEnv = (opts) => opts?.env ?? (opts?.proxy ? process.env : stripProxy(process.env));

function run(command, args, opts = {}) {
  const r = spawnSync(command, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts.timeoutMs ?? TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error?.code ?? r.error?.message,
  };
}

/** pnpm 在这台是 .cmd 套壳，得走 cmd.exe（见文件头第一条）。 */
function runViaCmd(command, args, opts = {}) {
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', windowsCmdLine(command, args)], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
    windowsVerbatimArguments: true,
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error?.code ?? r.error?.message,
  };
}

/** 0 号信号只探活、不发送：ESRCH 是真没了，EPERM 是有但连不上（还是活的），别的错误照实抛出去。 */
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    if (e.code === 'EPERM') return true;
    throw e;
  }
}

function killTree(pid) {
  const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  if (r.status === 0) return { ok: true };
  return { ok: false, why: (r.stderr || r.stdout || `taskkill 退出码 ${r.status}`).trim() };
}

/**
 * 后台起一个不受这条命令生死影响的进程（见文件头）：把要起什么写成 JSON，交给同目录的 launch-detached.ps1
 * 用 PowerShell 的 Start-Process 起，PID/出错信息从它写的结果文件读回来（不是 stdout，见文件头 ETIMEDOUT
 * 那条）。Start-Process 自己会新建/清空 outFile、errFile（09-28 实测过：文件已经存在也是直接清空重写，不用
 * 本脚本先手动清）。
 *
 * 起不来时抛出的 Error 分两种（cmdStart 认 .uncertain 这个标记）：
 * - 确认起不来（没有 .uncertain）：powershell.exe 自己都没能跑，或者它明确说了 Start-Process 没拿到 pid。
 * - 不确定（.uncertain = true）：没能确认成没成，可能已经在跑——不能说「起不了」。
 */
function spawnDetached({ command, args, cwd, env, stdinFile, outFile, errFile }) {
  const dir = dirname(outFile);
  const resultFile = join(dir, 'launch-result.json');
  const spec = {
    command: 'cmd.exe',
    argumentLine: ['/d', '/s', '/c', windowsCmdLine(command, args)].join(' '),
    cwd,
    stdinFile: stdinFile ?? null,
    outFile,
    errFile,
    // {name,value} 数组，不是对象：见文件头「Start-Process 没有…」那条。env 到这里之前已经过白名单
    // （worker-lib.mjs 的 safeEnv），这里只是原样转格式，不准再加别的键回去。
    env: Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => ({ name, value })),
  };
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
      LAUNCH_PS1,
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

process.exitCode = await runWorker(process.argv.slice(2), {
  env: process.env,
  home: homedir(),
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  cwd: () => process.cwd(),
  git: (args, opts) => run('git', args, { ...opts, env: netEnv(opts) }),
  gh: (args, opts) => run('gh', args, { ...opts, env: netEnv(opts) }),
  pnpm: (args, opts) => runViaCmd('pnpm', args, opts),
  spawnDetached,
  isRunning,
  killTree,
  out: (text) => console.log(text),
  err: (text) => console.error(text),
});
