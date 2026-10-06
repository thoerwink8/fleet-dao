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
// - 后台起模型的那一步（spawnDetached）拆在同目录 spawn-detached.mjs：用 launch-detached.ps1 的 Win32_Process.Create
//   （WMI）起进程，不再用 Start-Process 或 Node 的 detached:true——它们起的子进程仍在会话的 Job Object / 进程树里，
//   Mirasim 掐会话时一起被杀（09-28 实测 detached 逃不掉，10-06 实测 Start-Process 也逃不掉：两个过夜工人都在创始人发
//   新消息的那一刻日志戛然而止）。env 白名单（worker-lib.mjs 的 safeEnv）、launch-result.json 协议、stdio:'ignore'
//   防 ETIMEDOUT 这些坑和原因都写在 spawn-detached.mjs、spawn-detached-support.mjs、launch-detached.ps1 各自文件头。
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { spawnDetached } from './spawn-detached.mjs';
import { windowsCmdLine } from './windows-quote.mjs';
import { runWorker } from './worker-lib.mjs';

const TIMEOUT_MS = 120_000;

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

/**
 * 不挡着别的调用的 run：巡看并发查各工人的 PR 用（worker-lib.mjs 的 fillPrs）。回话形状同 run；
 * 超时 error 是 'ETIMEDOUT'，被 opts.signal 叫停是 'ABORT_ERR'——两种都当场杀掉子进程，不留着拖住这条命令退出。
 */
function runAsync(command, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let error;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    let child;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ status: null, stdout: '', stderr: '', error: e?.code ?? e?.message });
      return;
    }
    const kill = (why) => {
      error = why;
      child.kill();
    };
    const onAbort = () => kill('ABORT_ERR');
    const timer = setTimeout(() => kill('ETIMEDOUT'), opts.timeoutMs ?? TIMEOUT_MS);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort);
    child.stdout.setEncoding('utf8').on('data', (d) => {
      stdout += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d) => {
      stderr += d;
    });
    child.on('error', (e) => finish({ status: null, stdout, stderr, error: error ?? e.code ?? e.message }));
    child.on('close', (code) => finish({ status: error ? null : code, stdout, stderr, error }));
  });
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

process.exitCode = await runWorker(process.argv.slice(2), {
  env: process.env,
  home: homedir(),
  now: () => new Date(),
  nodePath: process.execPath,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  cwd: () => process.cwd(),
  git: (args, opts) => run('git', args, { ...opts, env: netEnv(opts) }),
  gh: (args, opts) => run('gh', args, { ...opts, env: netEnv(opts) }),
  ghAsync: (args, opts) => runAsync('gh', args, { ...opts, env: netEnv(opts) }),
  pnpm: (args, opts) => runViaCmd('pnpm', args, opts),
  spawnDetached,
  isRunning,
  killTree,
  out: (text) => console.log(text),
  err: (text) => console.error(text),
});
