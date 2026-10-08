// 驾驶舱「发布到法国」按钮的接活入口（法国，root）：fleet-release-request.path 盯着请求文件，一有就经 fleet-release-request.service 起这里。
// 判断和流程都在 lib.mjs，这里只接真的 git、GitHub 接口、fleet-api、发布脚本、状态文件。
// deploy/france.sh（人工档，deploy/lib/human-tier.sh）把本目录装到 /usr/local/lib/fleet-dao/release-request/，别在机器上手改。
// 手动看一趟：journalctl -u fleet-release-request -n 100；进度在 /srv/fleet-dao-releases/.train/release-train.json。
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  AGENT_SCOPE,
  CHECKOUT,
  fleetApiCommand,
  HISTORY_FILE,
  LAST_FILE,
  MARKER_FILE,
  RELEASE_SH,
  RELEASES,
  runRequest,
  STATE_FILE,
  safeReadRequest,
  TRAIN_DIR,
} from './lib.mjs';

const REPO = 'thoerwink8/fleet-dao';
const CI_WORKFLOW_FILE = 'ci.yml';

const tail = (text, n = 3) =>
  String(text ?? '')
    .trim()
    .split('\n')
    .slice(-n)
    .join(' ')
    .slice(0, 400);

function run(cmd, args, { timeoutMs = 120_000 } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, cwd: '/', maxBuffer: 16 << 20 });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ...(r.error ? { error: r.error.message } : {}),
  };
}

const git = (args, opts) => run('git', ['-C', CHECKOUT, ...args], opts);

/** 落盘：先写临时文件再换名（TRAIN_DIR 归 root，fleet 碰不到，写它不会被符号链接带去别处）。 */
function writeAtomic(file, text) {
  mkdirSync(TRAIN_DIR, { recursive: true, mode: 0o755 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, file);
}

export const realIo = {
  now: () => new Date(),
  sleep: (ms) => delay(ms),
  pid: process.pid,
  pidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  },
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  readRequest: () => safeReadRequest(),
  readState() {
    let text;
    try {
      text = readFileSync(STATE_FILE, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return { ok: true, state: null };
      return { ok: false, why: `${STATE_FILE} 读不了（${e.code ?? e.message}）` };
    }
    try {
      const s = JSON.parse(text);
      if (s === null || typeof s !== 'object' || s.schema !== 1) {
        return { ok: false, why: `${STATE_FILE} 认不出（不是这个脚本写的）` };
      }
      return { ok: true, state: s };
    } catch (e) {
      return { ok: false, why: `${STATE_FILE} 不是 JSON（${e.message}）` };
    }
  },
  writeState: (state) => {
    state.updatedAt = new Date().toISOString();
    writeAtomic(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  },
  writeLast: (obj) => writeAtomic(LAST_FILE, `${JSON.stringify(obj)}\n`),
  writeMarker: (obj) => writeAtomic(MARKER_FILE, `${JSON.stringify(obj)}\n`),
  clearMarker() {
    rmSync(MARKER_FILE, { force: true });
  },
  async releaseBusy() {
    const r = run('flock', ['-n', `${RELEASES}/.lock`, 'true'], { timeoutMs: 10_000 });
    if (r.status === 0) return false;
    if (r.status === 1) return true;
    throw new Error(`flock 退出码 ${r.status}：${tail(r.stderr)}`);
  },
  /** 取最新主线（连 tag 不用），再看这个提交是不是 origin/main 的祖先；提交时间给 CI 判「还没开跑」用。 */
  async mainline(sha) {
    const f = git(['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'], {
      timeoutMs: 180_000,
    });
    if (f.status !== 0) return { ok: false, why: `从 GitHub 取主线没成：${tail(f.stderr || f.error)}` };
    const has = git(['cat-file', '-e', `${sha}^{commit}`]);
    if (has.status !== 0) return { ok: true, onMain: false, at: '' };
    const a = git(['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main']);
    if (a.status !== 0 && a.status !== 1)
      return { ok: false, why: `比祖先没成：${tail(a.stderr || a.error)}` };
    const t = git(['log', '-1', '--format=%cI', sha]);
    if (t.status !== 0) return { ok: false, why: `读提交时间没成：${tail(t.stderr || t.error)}` };
    return { ok: true, onMain: a.status === 0, at: t.stdout.trim() };
  },
  async ciRuns() {
    const url =
      `https://api.github.com/repos/${REPO}/actions/workflows/${CI_WORKFLOW_FILE}/runs` +
      '?branch=main&event=push&exclude_pull_requests=true&per_page=100';
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'fleet-dao-release-request',
      },
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, body: await res.text() };
  },
  async fleetApi(args, timeoutMs) {
    return run('bash', ['-c', fleetApiCommand(args)], { timeoutMs });
  },
  async sessions() {
    const r = run(AGENT_SCOPE, ['list'], { timeoutMs: 30_000 });
    if (r.error || r.status !== 0)
      return { ok: false, why: `${AGENT_SCOPE} list 没成：${tail(r.stderr || r.error)}` };
    const running = [];
    for (const line of r.stdout.split('\n')) {
      if (line.trim() === '') continue;
      const m = /^(\S+) ([a-z-]+)$/.exec(line.trim());
      if (!m) return { ok: false, why: `会话列表认不出（有一行是「${line.slice(0, 80)}」）` };
      if (m[2] !== 'inactive' && m[2] !== 'failed') running.push(m[1]);
    }
    return { ok: true, running };
  },
  /** 部署检出快进到要发的提交，入口脚本和装机脚本才是这一版。release.sh 还会再交给目标提交自带的那份（#1294）。 */
  async prepareCheckout(sha) {
    const dirty = git(['status', '--porcelain', '--untracked-files=no']);
    if (dirty.status !== 0)
      return { ok: false, why: `看部署检出有没有改动没成：${tail(dirty.stderr || dirty.error)}` };
    if (dirty.stdout.trim())
      return { ok: false, why: `部署检出 ${CHECKOUT} 有没提交的改动：${tail(dirty.stdout)}` };
    const at = git(['rev-parse', 'HEAD']);
    if (at.status !== 0) return { ok: false, why: `读部署检出的提交没成：${tail(at.stderr || at.error)}` };
    const head = at.stdout.trim();
    if (head === sha || git(['merge-base', '--is-ancestor', sha, head]).status === 0) return { ok: true };
    if (git(['merge-base', '--is-ancestor', head, sha]).status !== 0) {
      return { ok: false, why: `部署检出在 ${head.slice(0, 12)}，和主线分叉了` };
    }
    const m = git(['merge', '--ff-only', '--quiet', sha]);
    if (m.status !== 0)
      return { ok: false, why: `快进部署检出到 ${sha.slice(0, 12)} 没成：${tail(m.stderr || m.error)}` };
    return { ok: true };
  },
  async runRelease(sha, timeoutMs) {
    return run('bash', [RELEASE_SH, sha], { timeoutMs });
  },
  async releaseCheck(timeoutMs) {
    return run('bash', [RELEASE_SH, '--check'], { timeoutMs });
  },
  async historyLast() {
    try {
      const lines = readFileSync(HISTORY_FILE, 'utf8').trim().split('\n');
      return { ok: true, line: lines.at(-1) ?? '' };
    } catch (e) {
      return { ok: false, why: `${HISTORY_FILE} 读不了（${e.code ?? e.message}）` };
    }
  },
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runRequest(realIo).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`没做成：${e instanceof Error ? e.stack : String(e)}`);
      process.exit(2);
    },
  );
}
