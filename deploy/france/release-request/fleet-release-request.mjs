// 驾驶舱「发布到法国」按钮的接活入口（法国，root）：fleet-release-request.path 盯着请求文件，一有就经 fleet-release-request.service 起这里。
// 判断和流程都在 lib.mjs，这里只接真的 git、GitHub 接口、fleet-api、发布脚本、状态文件。
// deploy/france.sh（整套和自动档 --auto-tier 的 setup_release_request_scripts）把本目录装到 /usr/local/lib/fleet-dao/release-request/，别在机器上手改。
// 手动看一趟：journalctl -u fleet-release-request -n 100；进度在 /srv/fleet-dao-releases/.train/release-train.json。
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { reasonOf } from '../auto-release/lib.mjs';
import {
  CHECKOUT,
  ENGINE_ENV,
  ENGINE_SERVICE,
  ENGINE_STATE_DEFAULT,
  fleetApiCommand,
  HISTORY_FILE,
  LAST_FILE,
  MARKER_FILE,
  notifyArgv,
  parseDrain,
  parseRepoSwitches,
  RELEASE_SH,
  RELEASES,
  runRequest,
  STATE_FILE,
  safeReadRequest,
  TRAIN_DIR,
} from './lib.mjs';

const REPO = 'thoerwink8/fleet-dao';
const CI_WORKFLOW_FILE = 'ci.yml';

/** 失败原因：认得出的关键行加尾几行（auto-release/lib.mjs 的 reasonOf，#2728）。 */
const tail = (text, n = 3) => reasonOf(text, n);

function run(cmd, args, { timeoutMs = 120_000, input } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    cwd: '/',
    maxBuffer: 16 << 20,
    ...(input === undefined ? {} : { input }),
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ...(r.error ? { error: r.error.message } : {}),
  };
}

const git = (args, opts) => run('git', ['-C', CHECKOUT, ...args], opts);

/** 单元在不在跑：true/false；systemctl 起不来、读不成回 null（不当成「没在跑」）。 */
function serviceActive(unit) {
  const r = run('systemctl', ['is-active', unit], { timeoutMs: 15_000 });
  if (r.error) return null;
  const s = String(r.stdout).trim();
  if (s === 'active') return true;
  // systemctl is-active 对 inactive/failed/unknown 回非 0 也打状态字；只有当它打得出状态字时才信
  if (['inactive', 'failed', 'unknown', 'activating', 'deactivating'].includes(s)) return false;
  return null;
}

/** systemd 的一个属性值（同 release.sh 的 unit_prop）；读不到回 null。 */
function unitProp(unit, prop) {
  const r = run('systemctl', ['show', '-p', prop, '--value', unit], { timeoutMs: 15_000 });
  if (r.error || r.status !== 0) return null;
  const v = String(r.stdout).trim();
  return v === '' ? null : v;
}

/** 引擎写 drain.json 的地方：engine.env 的 FLEET_ENGINE_STATE_DIR，没写取默认（同 release.sh 的 engine_drain_status）。 */
function engineStateDir() {
  try {
    for (const line of readFileSync(ENGINE_ENV, 'utf8').split('\n')) {
      if (line.startsWith('FLEET_ENGINE_STATE_DIR=')) {
        const v = line.slice('FLEET_ENGINE_STATE_DIR='.length).trim();
        if (v !== '') return v;
      }
    }
  } catch {
    // engine.env 不在、读不了：用默认目录
  }
  return ENGINE_STATE_DEFAULT;
}

/**
 * 驾驶舱接口的地址：读 release.sh 里的 COCKPIT 常量（docs/ops.md 端口表：改监听地址要几处一起改，这里不另抄一份）。
 * 读不到抛，体检那一项记读不到。
 */
function cockpitAddr() {
  const m = /^COCKPIT=([0-9.:a-z-]+)/m.exec(readFileSync(RELEASE_SH, 'utf8'));
  if (!m) throw new Error(`${RELEASE_SH} 里认不出 COCKPIT=`);
  return m[1];
}

/** 以 fleet 经本机 socket 读库 fleet（peer 认证，同自动发布的 sql）；只读。 */
function sqlRead(text) {
  return run(
    'runuser',
    [
      '-u',
      'fleet',
      '--',
      'env',
      'PGHOST=/var/run/postgresql',
      'PGUSER=fleet',
      'PGCONNECT_TIMEOUT=10',
      'psql',
      '-X',
      '-q',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      '-d',
      'fleet',
      '-c',
      text,
    ],
    { timeoutMs: 30_000 },
  );
}

/** 以 fleet 写库 fleet；值用 -v 传、SQL 里写 :'名字'，经 stdin 喂给 psql（-c 不展开变量）。写不进抛。 */
function sqlWrite(text, vars) {
  const args = [
    '-u',
    'fleet',
    '--',
    'env',
    'PGHOST=/var/run/postgresql',
    'PGUSER=fleet',
    'PGCONNECT_TIMEOUT=10',
    'psql',
    '-X',
    '-q',
    '-tA',
    '-v',
    'ON_ERROR_STOP=1',
    '-d',
    'fleet',
  ];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  args.push('-f', '-');
  const r = run('runuser', args, { input: text, timeoutMs: 30_000 });
  if (r.error || r.status !== 0)
    throw new Error(`写库没成（psql 退出码 ${r.status}）：${tail(r.error ?? r.stderr)}`);
}

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
  markerExists: () => existsSync(MARKER_FILE),
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
  /**
   * 引擎手上在干的活（权威口径；lib.mjs 第 3 步已不再等收尾（#2038），接口保留）：读引擎写的 drain.json（同 release.sh 的 engine_drain_status）——
   * 起会话过了闸才登记，额度探针这类辅助 scope 不登记，所以数不进常驻探针（#2002）。引擎没在跑就没会话；读不到照实说，不当成 0。
   */
  async drain() {
    const active = await serviceActive(ENGINE_SERVICE);
    if (active === null) return { ok: false, engineDown: false, why: `${ENGINE_SERVICE} 在不在跑读不到` };
    if (active === false) return { ok: true, engineDown: true, running: [] };
    const pid = unitProp(ENGINE_SERVICE, 'MainPID');
    if (pid === null) return { ok: false, engineDown: false, why: `${ENGINE_SERVICE} 的主进程号读不到` };
    let text = null;
    try {
      text = readFileSync(join(engineStateDir(), 'drain.json'), 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT')
        return { ok: false, engineDown: false, why: `drain.json 读不成：${e.code ?? e.message}` };
    }
    return parseDrain(text, pid, active);
  },
  /** 部署检出快进到要发的提交（同自动发布的 prepareCheckout）：release.sh 取自己的新版本。 */
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
  /** 法国在用的提交：发布目录的 current 链接（同 packages/store 的 readDeployLagInput）。 */
  async currentRelease() {
    try {
      const target = readlinkSync(`${RELEASES}/current`);
      if (!/^[0-9a-f]{40}$/.test(target))
        return { ok: false, why: `current 指着认不出的「${target.slice(0, 60)}」` };
      return { ok: true, sha: target };
    } catch (e) {
      return { ok: false, why: `读不了 ${RELEASES}/current（${e.code ?? e.message}）` };
    }
  },
  async healthz() {
    try {
      const res = await fetch(`http://${cockpitAddr()}/healthz`, { signal: AbortSignal.timeout(10_000) });
      return { status: res.status, body: await res.text() };
    } catch (e) {
      return { status: null, body: '', error: e instanceof Error ? e.message : String(e) };
    }
  },
  /** 取最新主线，主线头是哪个、比刚发的多几个提交（「再跑一遍预检」：已是最新＝0）。 */
  async mainHead(sha) {
    const f = git(['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'], {
      timeoutMs: 180_000,
    });
    if (f.status !== 0) return { ok: false, why: `从 GitHub 取主线没成：${tail(f.stderr || f.error)}` };
    const h = git(['rev-parse', 'refs/remotes/origin/main']);
    if (h.status !== 0) return { ok: false, why: `读主线头没成：${tail(h.stderr || h.error)}` };
    const c = git(['rev-list', '--count', `${sha}..refs/remotes/origin/main`]);
    if (c.status !== 0) return { ok: false, why: `数主线比刚发的多几个没成：${tail(c.stderr || c.error)}` };
    return { ok: true, sha: h.stdout.trim(), behind: Number(c.stdout.trim()) };
  },
  /** 各仓「让 AI 接活」开关（repos.auto_dispatch_since；接活读的就是它，同 fleet-api dispatch status）。只读。 */
  async repoSwitches() {
    const r = sqlRead(
      "select owner || '/' || name || '|' || coalesce(auto_dispatch_since::text, '') from repos order by owner, name;",
    );
    if (r.error || r.status !== 0)
      return { ok: false, why: `读库没成（psql 退出码 ${r.status}）：${tail(r.error ?? r.stderr)}` };
    return parseRepoSwitches(r.stdout);
  },
  /**
   * 发版提醒：只有卡住、失败、体检没过（note.level = 'alert'，卡住报警级，不是要你拍）才记一条提醒（重开已撤的同键行）：走 fleet-api
   * notify raise（统一写入口 upsertAlert，#2729），不直写表。开始、成功等（note.level 是 null）不写通知。
   * 发成功时把之前开着的 release: 提醒（含老版本记成要你拍的）收掉（只改已有行的处理状态，值走 psql -v）。
   */
  async notify(text, note) {
    if (note.level !== null) {
      const r = run('bash', notifyArgv(note), { input: text, timeoutMs: 60_000 });
      if (r.error || r.status !== 0)
        throw new Error(
          `fleet-api notify raise 退出码 ${r.status}：${tail(r.error ?? (r.stderr || r.stdout))}`,
        );
    }
    if (note.kind !== 'done') return;
    sqlWrite(
      `update notifications set resolved_at = now(), resolved_by = 'release-request', updated_at = now()
where starts_with(dedupe_key, 'release:') and level in ('decision', 'alert') and resolved_at is null;`,
      {},
    );
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
