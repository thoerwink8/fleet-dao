// 进程 cwd 和 current 对得上没有。这一份给三处共用：/healthz 的 deploy_lag、驾驶舱「在用版本」、
// 自动发版 journal 的 summary、发版卡「法国在用」。
// 放在自动发版目录里：装到 /usr/local/lib/fleet-dao/auto-release/ 的副本没有 node_modules，不能引 @fleet-dao/store。
// store 从 packages/store/src/running-release.mjs 再导出这一份，不要在别的文件里再写一份判法。
import { spawnSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { join } from 'node:path';

const SHA = /^[0-9a-f]{40}$/;
/** 装机检出（fleet 可读）。裸仓读不到时再试发布目录里的 .repo.git（release.sh 的 CACHE）。 */
const DEPLOY_CHECKOUT = '/srv/fleet-dao';

const short = (sha) => (sha ? sha.slice(0, 12) : '（没有）');

/** 和 deploy/release.sh 的 runtime_unchanged 同一份白名单：只改这些不算要重启（#2359）。空列表 = 树一样，允许沿用。 */
export function diffIsDocsOnly(paths) {
  return paths.every((path) => {
    if (path.endsWith('.md')) return true;
    if (path.startsWith('docs/') || path.startsWith('specs/')) return true;
    if (path.startsWith('agents/test/') || path.startsWith('deploy/test/')) return true;
    return /^packages\/[^/]+\/test\//.test(path);
  });
}

function lagDetail(lags) {
  const groups = new Map();
  for (const lag of lags) {
    const units = groups.get(lag.sha);
    if (units) units.push(lag.unit);
    else groups.set(lag.sha, [lag.unit]);
  }
  return [...groups.entries()]
    .map(([sha, units]) => `${units.join('、')} 的主进程还在 ${short(sha)}`)
    .join('；');
}

/**
 * 对不上、又不是只改文档：sha 是进程所在的旧提交（盘面不要标成 current 链接上的新提交），problem 对外一句不带提交号。
 * 读不到进程目录：sha 为 null，不当成已经切过去。没给 running、或还没有 current：sha 仍是链接上的提交。
 */
export function assessRunningRelease(input) {
  const symlink = input.current && 'sha' in input.current ? input.current.sha : null;
  const running = input.running;
  if (!running || symlink === null) return { sha: symlink, problem: null };

  const slots = [{ unit: 'fleet-engine', proc: running.engine }];
  if (running.api) slots.push({ unit: 'fleet-api', proc: running.api });
  const lags = [];
  const errors = [];
  for (const slot of slots) {
    if ('error' in slot.proc) {
      errors.push(`${slot.unit}：${slot.proc.error}`);
      continue;
    }
    if (slot.proc.sha === null || slot.proc.sha === symlink) continue;
    const diff = running.diffs?.[slot.proc.sha];
    if (diff && diffIsDocsOnly(diff)) continue;
    lags.push({ unit: slot.unit, sha: slot.proc.sha });
  }
  if (lags.length > 0) {
    return {
      sha: lags[0].sha,
      problem: {
        code: 'process_cwd',
        message: '进程还在旧 release 目录',
        steady: '进程还在旧 release 目录',
        detail: lagDetail(lags),
      },
    };
  }
  if (errors.length > 0) {
    return {
      sha: null,
      problem: {
        code: 'unchecked',
        message: '没查成：读不到进程在哪一版',
        steady: '读不到进程在哪一版',
        detail: errors.join('；'),
      },
    };
  }
  return { sha: symlink, problem: null };
}

function spawnText(cmd, args, timeout) {
  try {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error) return { ok: false, error: String(r.error) };
    if (r.status !== 0) {
      return { ok: false, error: (r.stderr || `${cmd} 退出 ${r.status}`).trim().slice(0, 240) };
    }
    return { ok: true, stdout: r.stdout };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** cwd 是「发布目录/提交号」才认出提交；子目录、别的路径认不出。 */
function shaOfReleaseCwd(dir, cwd) {
  const root = dir.replace(/[\\/]+$/, '');
  const normalized = cwd.replace(/[\\/]+$/, '');
  const prefix = `${root}/`;
  if (!normalized.startsWith(prefix)) return null;
  const rest = normalized.slice(prefix.length);
  if (rest.includes('/') || rest.includes('\\')) return null;
  return SHA.test(rest) ? rest : null;
}

function defaultReadProc(dir, unit) {
  const got = spawnText('systemctl', ['show', '-p', 'MainPID', '--value', unit], 5_000);
  if (!got.ok) return { error: got.error };
  const pid = got.stdout.trim();
  if (!/^[1-9][0-9]*$/.test(pid)) return { sha: null };
  let cwd;
  try {
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch (err) {
    return { error: `读不了 /proc/${pid}/cwd：${String(err)}` };
  }
  const sha = shaOfReleaseCwd(dir, cwd);
  if (!sha) return { error: `主进程目录不是发布目录下的提交（${cwd.slice(0, 80)}）` };
  return { sha };
}

function defaultDiffNames(dir, oldSha, newSha) {
  let last = '没有可用的检出';
  for (const repo of [DEPLOY_CHECKOUT, join(dir, '.repo.git')]) {
    const got = spawnText('git', ['-C', repo, 'diff', '--name-only', '--no-renames', oldSha, newSha], 20_000);
    if (!got.ok) {
      last = got.error;
      continue;
    }
    return got.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  return { error: last };
}

/** 主进程 cwd。io.readProc / io.diffNames 给了就用给的（测试）；没给就问 systemctl 和 git。 */
export function readRunningRelease(dir, current, io) {
  const readProc = io?.readProc ?? ((unit) => defaultReadProc(dir, unit));
  const engine = readProc('fleet-engine.service');
  const api = readProc('fleet-api.service');
  const running = { engine, api };
  const symlink = current && 'sha' in current ? current.sha : null;
  if (!symlink) return running;
  const olds = new Set();
  for (const proc of [engine, api]) {
    if ('sha' in proc && proc.sha && proc.sha !== symlink) olds.add(proc.sha);
  }
  if (olds.size === 0) return running;
  const diffNames = io?.diffNames ?? ((old, neu) => defaultDiffNames(dir, old, neu));
  const diffs = {};
  for (const old of olds) {
    const got = diffNames(old, symlink);
    if (Array.isArray(got)) diffs[old] = got;
  }
  return { ...running, diffs };
}
