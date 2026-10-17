// 钩子的联网任务共用脱离原语；回执只写进程和结果，不保存调用方环境、密钥或命令。
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFallbackProxy } from './git-run.mjs';
import { proxyEnvOf } from './proxy-env.mjs';

const SELF = fileURLToPath(import.meta.url);
// 源码树与安装副本：安装钩子不依赖这台机器另装过 local-sessions。
const detachUrl = ['./_detach.mjs', '../local-sessions/detach.mjs']
  .map((p) => new URL(p, import.meta.url))
  .find((p) => existsSync(p));
const detach = detachUrl ? await import(detachUrl.href) : null;
/** @param {unknown} e */
const message = (e) => (e instanceof Error ? e.message : String(e));
/** @param {unknown} e */
const errorCode = (e) => (e instanceof Error && 'code' in e ? e.code : undefined);

/** @param {number} pid */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errorCode(e) === 'EPERM';
  }
}

/** @param {string} home @param {{ env?: NodeJS.ProcessEnv, stateHome?: string }} [opts] @returns {Record<string,string>} */
export function backgroundEnv(
  home,
  { env = process.env, stateHome = env.FLEET_DAO_HOME || join(home, '.fleet-dao') } = {},
) {
  /** @type {Record<string, string>} */
  const selected = {};
  for (const k of [
    'PATH',
    'Path',
    'SystemRoot',
    'windir',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'APPDATA',
    'LOCALAPPDATA',
    'HOMEDRIVE',
    'HOMEPATH',
    'GH_HOST',
    'GH_REPO',
    'FLEET_UNATTENDED_DIR',
    'FLEET_FRANCE_SSH',
    'NO_PROXY',
    'no_proxy',
  ]) {
    const actual =
      process.platform === 'win32'
        ? Object.keys(env).find((name) => name.toLowerCase() === k.toLowerCase())
        : k;
    const value = actual ? env[actual] : undefined;
    if (typeof value === 'string') selected[k] = value;
  }
  Object.assign(selected, { HOME: home, USERPROFILE: home, FLEET_DAO_HOME: stateHome });
  const fb = readFallbackProxy(home);
  return fb.proxy ? /** @type {Record<string,string>} */ (proxyEnvOf(selected, fb.proxy)) : selected;
}

/** @param {string} path @param {unknown} value */
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

/** @param {string} path */
function readReceipt(path) {
  const done = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !Number.isFinite(done?.at) ||
    !(done.kind === 'done' || (done.kind === 'failed' && typeof done.why === 'string'))
  )
    throw new Error('完成回执形状认不出');
  return done;
}

/** 进程号和完成回执共同判断，不以「起过」冒充「跑完」。
 * @param {string} path @param {{ now?: number, alive?: (pid: number) => boolean }} [opts]
 */
export function backgroundState(path, { now = Date.now(), alive = processAlive } = {}) {
  let state;
  try {
    state = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return errorCode(e) === 'ENOENT'
      ? { kind: 'none' }
      : { kind: 'failed', why: `运行记录读不了（${message(e)}）` };
  }
  if (state?.kind === 'failed' && typeof state.why === 'string' && Number.isFinite(state.at)) return state;
  if (
    typeof state?.receipt !== 'string' ||
    !Number.isFinite(state.startedAt) ||
    !Number.isFinite(state.timeoutMs) ||
    !(state.timeoutMs > 0) ||
    !Number.isInteger(state.pid) ||
    state.pid <= 0
  )
    return { kind: 'failed', why: '运行记录形状认不出' };
  try {
    return { ...readReceipt(state.receipt), startedAt: state.startedAt };
  } catch (e) {
    if (errorCode(e) !== 'ENOENT') return { kind: 'failed', why: `完成回执读不了（${message(e)}）` };
  }
  if (now - state.startedAt > state.timeoutMs + 30_000)
    return { kind: 'failed', why: '后台超时且没有完成回执' };
  if (!alive(state.pid)) {
    // worker 可能恰在第一次读回执之后完成；退出前已原子写完，复读可避免误报早退。
    try {
      return { ...readReceipt(state.receipt), startedAt: state.startedAt };
    } catch {}
    return { kind: 'failed', why: '后台进程已早退，没留下完成回执' };
  }
  return { kind: 'running', pid: state.pid };
}

/** spawnFn 仅供测试替换；生产始终走 WMI / setsid。
 * @param {{ args: string[], cwd: string, env: Record<string, string>, statePath: string, timeoutMs: number, now?: number, spawnFn?: (file: string, args: string[], opts: { cwd: string, env: Record<string,string> }) => import('../local-sessions/detach.mjs').Detached }} opts
 */
export function launchBackground({
  args,
  cwd,
  env,
  statePath,
  timeoutMs,
  now = Date.now(),
  spawnFn = detach?.spawnDetached,
}) {
  const receipt = `${statePath}.${randomUUID()}.result`;
  /** @param {string} why @returns {{ok:false,why:string}} */
  const failed = (why) => {
    writeJson(statePath, { kind: 'failed', why, at: now });
    return { ok: false, why };
  };
  try {
    try {
      const old = JSON.parse(readFileSync(statePath, 'utf8'));
      if (
        typeof old.receipt === 'string' &&
        old.receipt.startsWith(`${statePath}.`) &&
        /^\.[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.result$/.test(
          old.receipt.slice(statePath.length),
        )
      )
        rmSync(old.receipt, { force: true });
    } catch {}
    if (!spawnFn) return failed('脱离原语没安装，需重新同步钩子');
    const payload = JSON.stringify({ args, cwd, receipt, timeoutMs });
    const r = spawnFn(process.execPath, [SELF, '--run', payload], {
      cwd,
      env,
    });
    if (!r.ok) return failed(r.why);
    writeJson(statePath, { startedAt: now, pid: r.pid, receipt, timeoutMs });
    return r;
  } catch (e) {
    try {
      return failed(message(e));
    } catch {
      return { ok: /** @type {const} */ (false), why: message(e) };
    }
  }
}

/** @param {{ args: string[], cwd: string, receipt: string, timeoutMs: number }} job */
async function runJob({ args, cwd, receipt, timeoutMs }) {
  let timedOut = false;
  const result = await new Promise((done) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: process.env,
      stdio: 'ignore',
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const timer = setTimeout(() => {
      timedOut = true;
      // 这里只结束本 worker 自己创建的子树，绝不根据外部记录杀进程。
      if (child.pid) {
        try {
          if (process.platform === 'win32') {
            const systemRoot = process.env.SystemRoot;
            if (!systemRoot) throw new Error('SystemRoot 没传给后台，无法定位系统 taskkill');
            const killed = spawnSync(
              join(systemRoot, 'System32', 'taskkill.exe'),
              ['/PID', String(child.pid), '/T', '/F'],
              {
                windowsHide: true,
                stdio: 'ignore',
                timeout: 10_000,
              },
            );
            if (killed.error || killed.status !== 0)
              throw new Error(killed.error?.message ?? `taskkill 退出码 ${killed.status}`);
          } else {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch (e) {
          child.unref();
          done({ kind: 'failed', why: `后台超过 ${timeoutMs} 毫秒，结束本任务子树没做成（${message(e)}）` });
        }
      }
    }, timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      done({ kind: 'failed', why: `子任务没起成（${message(e)}）` });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      done(
        timedOut
          ? { kind: 'failed', why: `后台超过 ${timeoutMs} 毫秒，已结束本任务子树` }
          : code === 0
            ? { kind: 'done' }
            : { kind: 'failed', why: `后台早退（退出码 ${code}，信号 ${signal ?? '无'}）` },
      );
    });
  });
  writeJson(receipt, { ...result, at: Date.now() });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SELF) && process.argv[2] === '--run') {
  const job = JSON.parse(process.argv[3] ?? 'null');
  try {
    await runJob(job);
  } catch (e) {
    writeJson(job.receipt, { kind: 'failed', why: `后台自己出错（${message(e)}）`, at: Date.now() });
  }
}
