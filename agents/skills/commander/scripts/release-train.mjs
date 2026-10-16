// release-train.mjs 是外壳：真的 ssh、睡眠。逻辑都在 release-train-lib.mjs（往法国递一份和驾驶舱同格式的请求，再读进度）。
// 九步在法国接活脚本里跑，这里不再自己做。发版会等很久，用 run_in_background 起。node release-train.mjs 不带参数看用法。
// 改这里之前必须知道：
// - 登法国的 ssh 名字读法复用 france-lib.mjs 的 readTarget（环境变量 FLEET_FRANCE_SSH，或 ~/.fleet-dao/france-ssh 的第一行）；
//   ssh 的参数同 france-lib.mjs 的 sshArgs（不问口令、连 10 秒连不上就算、开压缩）。名字不进任何输出。
// - 同步的 spawnSync：每条命令都带超时，超时当场杀。pnpm 在 Windows 上是 .cmd 套壳，走 cmd.exe（run 仍留给外壳，薄壳本身只用 ssh）。
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTarget, sshArgs } from './france-lib.mjs';
import { fetchRunningSessions } from './france-sessions-lib.mjs';
import { runTrain } from './release-train-lib.mjs';
import { windowsCmdLine } from './windows-quote.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROXY_VARS = ['https_proxy', 'http_proxy', 'HTTPS_PROXY', 'HTTP_PROXY'];
const stripProxy = (env) => {
  const out = { ...env };
  for (const k of PROXY_VARS) delete out[k];
  return out;
};

function once(command, args, opts, env) {
  const viaCmd = process.platform === 'win32' && command === 'pnpm';
  const r = viaCmd
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', windowsCmdLine(command, args)], {
        cwd: opts.cwd,
        env,
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: true,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
      })
    : spawnSync(command, args, {
        cwd: opts.cwd,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
      });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error?.code ?? r.error?.message,
  };
}

function run(command, args, opts = {}) {
  const net = command === 'gh' || command === 'git' || command === 'pnpm';
  if (!net) return once(command, args, opts, process.env);
  const direct = once(command, args, opts, stripProxy(process.env));
  const hasProxy = PROXY_VARS.some((k) => process.env[k]);
  if (direct.status === 0 || !hasProxy) return direct;
  return once(command, args, opts, process.env);
}

const home = homedir();

/**
 * 异步跑一条命令，等的时候每 tickMs 调一次 onTick（spawnSync 会冻住事件循环，定时器跑不了）。
 * 超时当场杀；输出、错误的形状同 once。
 */
function onceWithTicks(command, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: process.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let error;
    let timedOut = false;
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (e) => {
      error = e?.code ?? e?.message;
    });
    const tick = setInterval(() => {
      try {
        opts.onTick();
      } catch {
        // 心跳写不了不挡发版：判死活时会因心跳变老而被发现
      }
    }, opts.tickMs);
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.on('close', (status) => {
      clearInterval(tick);
      clearTimeout(killer);
      resolve({
        status: timedOut ? null : status,
        stdout,
        stderr,
        error: timedOut ? 'ETIMEDOUT' : error,
      });
    });
  });
}

/** 到法国跑一条命令：名字读不到、起不了 ssh 都放进 error，不抛。给了 onTick 就走异步，等的时候定时回调（第 4 步刷心跳）。 */
function ssh(remoteCommand, opts = {}) {
  const target = readTarget({ env: process.env, home, readText: (f) => readFileSync(f, 'utf8') });
  if (!target.ok) return { status: null, stdout: '', stderr: '', error: `${target.kind}：${target.why}` };
  const args = sshArgs(target.host).slice(0, -1); // 去掉查询脚本那条固定命令，换成这次要跑的
  const timeoutMs = opts.timeoutMs ?? 60_000;
  if (typeof opts.onTick === 'function')
    return onceWithTicks('ssh', [...args, remoteCommand], {
      timeoutMs,
      tickMs: opts.tickMs ?? 30_000,
      onTick: opts.onTick,
    });
  return once('ssh', [...args, remoteCommand], { timeoutMs }, process.env);
}

/** pid 还在不在：kill 0 不发信号只查；没权限（EPERM）也是在。 */
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
};

process.exitCode = await runTrain(process.argv.slice(2), {
  home,
  pid: process.pid,
  host: hostname(),
  isAlive,
  env: process.env,
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  cwd: () => process.cwd(),
  nodePath: process.execPath,
  scriptsDir: SCRIPTS_DIR,
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  run,
  ssh,
  runningSessions: () => fetchRunningSessions(),
});
