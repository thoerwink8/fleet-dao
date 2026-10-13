// 自动发布单元的入口（法国，root）：fleet-auto-release.timer 每 5 分钟经 fleet-auto-release.service 拉起一轮。
// 它读数，也在主线绿了、满 1 小时间隔时请求发版（决定 0088、#2039）：只写一份和驾驶舱按钮一样的请求文件，
// 由法国上的接活单元（deploy/france/release-request）去发。这里不调 release.sh。
// deploy/france.sh 把这个目录装到 /usr/local/lib/fleet-dao/auto-release/（装的是副本：主线上改了它，下一版发完由本入口自己
// 跑 france.sh --auto-tier 换上，不用人重跑）。防火墙、sudoers、sshd、被 source 的脚本改了才要人重跑整套。
// 运行时直接读的副本字节已经和主线一样的，不再算「装机脚本落后」。判断和流程在 lib.mjs，这里只接真的 git、GitHub 接口、库。
// 手动跑一轮：systemctl start fleet-auto-release（别直接跑本文件：两轮叠着跑会互相盖状态文件）。
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readLive } from './config.mjs';
import {
  APPLIED_FILE,
  AUTO_DIR,
  CHECKOUT,
  CI_RUNS_PAGE,
  CI_WORKFLOW,
  copyAlreadyInstalled,
  HUMAN_TIER_COPY_CHECKS,
  HUMAN_TIER_PATHS,
  humanTierPathsStillBehind,
  MAIN_HISTORY,
  RELEASES,
  REPO,
  runRound,
  STATE_FILE,
} from './lib.mjs';

const NODE = '/usr/bin/node';
const SHA = /^[0-9a-f]{40}$/;
// 驾驶舱按钮的接活（deploy/france/release-request，人工档）：请求目录、接活单元的两个文件、进度和暂停标记。路径同 release-request/lib.mjs。
const REQUEST_DIR = '/var/lib/fleet-dao/release-request';
const REQUEST_FILE = `${REQUEST_DIR}/request.json`;
const RECEIVER_UNIT = '/etc/systemd/system/fleet-release-request.path';
const RECEIVER_SCRIPT = '/usr/local/lib/fleet-dao/release-request/fleet-release-request.mjs';
const TRAIN_STATE = `${RELEASES}/.train/release-train.json`;
const TRAIN_MARKER = `${RELEASES}/.train/release-train.paused`;
const tail = (text, n = 3) =>
  String(text ?? '')
    .trim()
    .split('\n')
    .slice(-n)
    .join(' ')
    .slice(0, 400);

function run(cmd, args, { timeoutMs = 120_000, input } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    input,
    cwd: '/',
    maxBuffer: 16 << 20,
  });
  if (r.error) throw new Error(`${cmd} 起不来或超时：${r.error.message}`);
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function git(args, opts) {
  return run('git', ['-C', CHECKOUT, ...args], opts);
}

function gitOk(args, what, opts) {
  const r = git(args, opts);
  if (r.code !== 0) throw new Error(`${what}失败（git 退出码 ${r.code}）：${tail(r.stderr || r.stdout)}`);
  return r.stdout;
}

/** 安装位置的字节是不是主线这一版。比不了、单元还没加载，都当没装上（继续算落后，不假装已经换过）。 */
function installedCopyMatches(head, check) {
  const blob = git(['rev-parse', '--verify', `${head}:${check.path}`]);
  if (blob.code !== 0) return false;
  const hashed = run('git', ['hash-object', '--', check.installed]);
  if (hashed.code !== 0) return false;
  let needDaemonReload;
  if (check.unit) {
    const shown = run('systemctl', ['show', '-p', 'NeedDaemonReload', '--value', check.unit]);
    const v = shown.code === 0 ? shown.stdout.trim() : '';
    if (v === 'yes') needDaemonReload = true;
    else if (v === 'no') needDaemonReload = false;
    else needDaemonReload = null;
  }
  return copyAlreadyInstalled(blob.stdout.trim(), hashed.stdout.trim(), needDaemonReload);
}

/** 以 fleet 经本机 socket 连库 fleet（peer 认证，和备份任务一样）；值一律用 -v 传、SQL 里写 :'名字'，由 psql 加引号。 */
function sql(text, vars) {
  const args = [
    '-u',
    'fleet',
    '--',
    'env',
    'PGHOST=/var/run/postgresql',
    'PGUSER=fleet',
    'PGCONNECT_TIMEOUT=10',
  ];
  args.push('psql', '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', 'fleet');
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  args.push('-f', '-');
  const r = run('runuser', args, { input: text, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`写库没成（psql 退出码 ${r.code}）：${tail(r.stderr)}`);
}

function saveState(st) {
  mkdirSync(AUTO_DIR, { recursive: true, mode: 0o755 });
  const tmp = `${STATE_FILE}.new`;
  writeFileSync(tmp, `${JSON.stringify(st, null, 1)}\n`, { mode: 0o644 });
  renameSync(tmp, STATE_FILE);
}

export const realIo = {
  now: () => new Date(),
  async readMain() {
    // 只取主线：不取 tag（--no-tags）——读数不看版本标记，仓上有没有 tag 都一样
    gitOk(
      ['fetch', '--quiet', '--prune', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      '从 GitHub 取主线',
      { timeoutMs: 180_000 },
    );
    return gitOk(
      ['log', '--first-parent', `-n${MAIN_HISTORY}`, '--format=%H %cI', 'refs/remotes/origin/main'],
      '读主线的提交',
    );
  },
  async readSystem(head) {
    let applied = null;
    try {
      applied = /^commit=([0-9a-f]{40})$/m.exec(readFileSync(APPLIED_FILE, 'utf8'))?.[1] ?? '';
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`读不了 ${APPLIED_FILE}：${e.message}`);
    }
    if (applied === '') throw new Error(`${APPLIED_FILE} 认不出（应为 commit=<提交号>）`);
    if (applied === null) return { applied: null, log: '' };
    const satisfied = {};
    for (const c of HUMAN_TIER_COPY_CHECKS) satisfied[c.path] = installedCopyMatches(head, c);
    // 比不了就抛：不能把「没比成」当成内容没变。比完也不按净 diff 收窄——
    // 空的 diff 只说明主线头和标记那一版字节一样，证明不了防火墙、sudoers、sshd 没被失败安装写成中间版本。
    const diff = git(['diff', '--name-only', applied, head, '--', ...HUMAN_TIER_PATHS]);
    if (diff.code !== 0) {
      throw new Error(
        `比装机人工档的内容失败（git 退出码 ${diff.code}）：${tail(diff.stderr || diff.stdout)}`,
      );
    }
    const changed = diff.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const paths = humanTierPathsStillBehind(satisfied, changed);
    // 空 pathspec 的 git log 会列出全部提交，把没改人工档的也算成落后
    if (paths.length === 0) return { applied, log: '' };
    const log = gitOk(
      ['log', '--first-parent', '--format=%H %cI', `${applied}..${head}`, '--', ...paths],
      '数装机人工档的提交',
    );
    return { applied, log };
  },
  async readCurrent() {
    let target;
    try {
      target = readlinkSync(`${RELEASES}/current`);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new Error(`读不了 ${RELEASES}/current：${e.message}`);
    }
    if (!SHA.test(target)) throw new Error(`${RELEASES}/current 指着认不出的「${target.slice(0, 60)}」`);
    return target;
  },
  /** 法国上一次换版本是什么时候（手动自动都算）：current 这个符号链接自己的修改时间（换版本时新建的）。读不了抛。 */
  async readReleasedAt() {
    return lstatSync(`${RELEASES}/current`).mtime.toISOString();
  },
  /** 自动发版的闸要的事实（lib.mjs 的 gateVerdict 判）：接活单元装了没有、有没有没被接走的请求、暂停标记、进度记录、发布锁。读不了的抛。 */
  async releaseGate() {
    const missing = [RECEIVER_UNIT, RECEIVER_SCRIPT].filter((f) => !existsSync(f));
    let trainText = null;
    try {
      trainText = readFileSync(TRAIN_STATE, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`读不了 ${TRAIN_STATE}：${e.message}`);
    }
    const lock = run('flock', ['-n', `${RELEASES}/.lock`, 'true'], { timeoutMs: 10_000 });
    if (lock.code !== 0 && lock.code !== 1)
      throw new Error(`flock 退出码 ${lock.code}：${tail(lock.stderr)}`);
    return {
      missing,
      requestPending: existsSync(REQUEST_FILE),
      marker: existsSync(TRAIN_MARKER),
      trainText,
      lockBusy: lock.code === 1,
    };
  },
  /**
   * 写发版请求：样子同驾驶舱后端（packages/api/src/release-request.ts 的 requestText：{ v, sha, at, by }，键的先后固定），
   * 先写临时文件再 link 到 request.json（已有一份就失败，不盖掉别人的）。请求目录归 fleet，这里是 root，写得进。
   */
  async requestRelease({ sha, at, by }) {
    const tmp = `${REQUEST_DIR}/.auto-${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, sha, at, by })}\n`, { mode: 0o644 });
    try {
      linkSync(tmp, REQUEST_FILE);
    } finally {
      unlinkSync(tmp);
    }
  },
  /** 主线上 ci.yml 最近 CI_RUNS_PAGE 次 push 触发的运行（新的在前）：一轮只问这一次。 */
  async ciRuns() {
    const workflow = CI_WORKFLOW.split('/').pop();
    const url =
      `https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/runs` +
      `?branch=main&event=push&exclude_pull_requests=true&per_page=${CI_RUNS_PAGE}`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'fleet-dao-auto-release',
      },
      signal: AbortSignal.timeout(20_000),
    });
    const left = res.headers.get('x-ratelimit-remaining');
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const rate =
      left === null
        ? ''
        : `这个钟头还剩 ${left} 次${reset ? `，${new Date(reset * 1000).toISOString()} 恢复` : ''}`;
    return { status: res.status, body: await res.text(), rate };
  },
  async checkoutHead() {
    return gitOk(['rev-parse', 'HEAD'], '读部署检出的提交').trim();
  },
  /**
   * 部署检出快进到在用的提交（lib.mjs 的 alignCheckout；同 release-request 的 prepareCheckout）：
   * 人手动发的版本检出没人快进，规矩和自动档用的脚本就一直停在旧提交上（#1672）。
   * 检出比在用的新（在用的是它的祖先）回 ahead；分叉、有没提交的改动、快进没成回 why。
   */
  async fastForwardCheckout(sha) {
    const dirty = gitOk(['status', '--porcelain', '--untracked-files=no'], '看部署检出有没有改动');
    if (dirty.trim()) return { ok: false, why: `部署检出 ${CHECKOUT} 有没提交的改动：${tail(dirty)}` };
    const head = gitOk(['rev-parse', 'HEAD'], '读部署检出的提交').trim();
    if (head === sha) return { ok: true };
    if (git(['merge-base', '--is-ancestor', sha, head]).code === 0) return { ok: false, ahead: true };
    if (git(['merge-base', '--is-ancestor', head, sha]).code !== 0) {
      return { ok: false, why: `部署检出在 ${head.slice(0, 12)}，和在用的 ${sha.slice(0, 12)} 分叉了` };
    }
    const m = git(['merge', '--ff-only', '--quiet', sha]);
    if (m.code !== 0) {
      return { ok: false, why: `快进部署检出到 ${sha.slice(0, 12)} 没成：${tail(m.stderr || m.stdout)}` };
    }
    return { ok: true };
  },
  /** 装机的自动档：以 root 跑检出里的 france.sh --auto-tier（lib.mjs 的 tierStep）。 */
  async applyAutoTier() {
    const r = run('bash', [`${CHECKOUT}/deploy/france.sh`, '--auto-tier'], { timeoutMs: 600_000 });
    return { code: r.code, out: `${r.stdout}\n${r.stderr}` };
  },
  async syncRules(user) {
    const r = run(NODE, [`${CHECKOUT}/packages/agents-sync/bin/agents-sync`, '--apply', '--user', user], {
      timeoutMs: 300_000,
    });
    return { code: r.code, out: `${r.stdout}\n${r.stderr}` };
  },
  async alert({ key, title, body }) {
    sql(
      `insert into notifications (level, dedupe_key, title, body)
values ('alert'::notification_level, :'key', :'title', :'body')
on conflict (dedupe_key) do update
  set title = excluded.title, body = excluded.body, updated_at = now(), resolved_at = null, resolved_by = null;`,
      { key, title, body },
    );
  },
  async resolve(prefix) {
    sql(
      `update notifications set resolved_at = now(), resolved_by = 'auto-release', updated_at = now()
where starts_with(dedupe_key, :'prefix') and resolved_at is null;`,
      { prefix },
    );
  },
  async resolveKey(key) {
    sql(
      `update notifications set resolved_at = now(), resolved_by = 'auto-release', updated_at = now()
where dedupe_key = :'key' and resolved_at is null;`,
      { key },
    );
  },
  /** 配置对账要的原文：在用那一版里的期望、/etc/fleet-dao 下的环境文件、指纹钥匙（config.mjs 的 readLive）。 */
  async readConfig() {
    return readLive();
  },
  async save(st) {
    saveState(st);
  },
  /** 上一轮的状态文件原文；文件不在回 null（第一次跑），别的读不了就抛（lib.mjs 的 runRound 当「读不出」：这一轮什么都不做、报警）。 */
  async readState() {
    try {
      return readFileSync(STATE_FILE, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  },
};

async function main() {
  // 状态文件读不出不再从空的起（审查 S4）：runRound 这一轮什么都不做、不覆盖它、报警；报警也没发出去就退出非 0，systemd 里看得到
  const r = await runRound(realIo);
  console.log(r.line);
  if (r.alertLost) process.exitCode = 1;
}

// 被测试 import 时不跑：只有 systemd 直接起这个文件才跑一轮
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`自动发布这一轮崩了：${e instanceof Error ? e.stack : e}`);
    process.exitCode = 1;
  });
}
