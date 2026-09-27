// 自动发布的入口（法国，root）：fleet-auto-release.timer 每 5 分钟经 fleet-auto-release.service 拉起一轮。
// deploy/france.sh 把这个目录装到 /usr/local/lib/fleet-dao/auto-release/（装的是副本：主线上改了它，要重跑 france.sh 才换，
// 后端的 /healthz 会标「装机脚本落后」）。判断和流程在 lib.mjs，这里只接真的 git、GitHub 接口、会话列表、发布脚本、库。
// 手动跑一轮：systemctl start fleet-auto-release（别直接跑本文件：两轮叠着跑会互相盖状态文件）。
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readLive } from './config.mjs';
import {
  APPLIED_FILE,
  AUTO_DIR,
  CHECKOUT,
  INSTALL_PATHS,
  MAIN_HISTORY,
  RELEASES,
  REPO,
  runOnce,
  STATE_FILE,
  summary,
} from './lib.mjs';

const AGENT_SCOPE = '/usr/local/sbin/fleet-agent-scope';
const NODE = '/usr/bin/node';
const SHA = /^[0-9a-f]{40}$/;
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

function isAncestor(a, b) {
  const r = git(['merge-base', '--is-ancestor', a, b]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new Error(`比不出 ${a.slice(0, 12)} 和 ${b.slice(0, 12)} 谁在前：${tail(r.stderr)}`);
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

/** 跑 release.sh <提交> --auto：它自己交给 systemd 跑、这边跟着读日志；留最后几十行找原因，日志路径从第一行取。 */
function runRelease(sha, busyOk) {
  return new Promise((resolve, reject) => {
    const args = [`${CHECKOUT}/deploy/release.sh`, sha, '--auto', ...(busyOk ? ['--busy-ok'] : [])];
    const child = spawn('bash', args, { cwd: '/', stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    let lines = [];
    const take = (d) => {
      const text = String(d);
      if (!log) log = /日志 (\/\S+?\.log)/.exec(text)?.[1] ?? '';
      lines = [...lines, ...text.split('\n')].slice(-60);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => {
      const reds = lines.filter((l) => /^\s*✗/.test(l)).map((l) => l.trim().replace(/^✗\s*/, ''));
      const detail = (reds.length ? reds.slice(-3).join('；') : tail(lines.join('\n'), 2)).slice(0, 600);
      resolve({ code: code ?? -1, log, detail });
    });
  });
}

export const realIo = {
  now: () => new Date(),
  async readMain() {
    gitOk(
      ['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
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
    const log = gitOk(
      ['log', '--first-parent', '--format=%H %cI', `${applied}..${head}`, '--', ...INSTALL_PATHS],
      '数装机相关的提交',
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
  async readHistory() {
    try {
      return readFileSync(`${RELEASES}/.history`, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return '';
      throw e;
    }
  },
  async ciRuns(sha) {
    const url = `https://api.github.com/repos/${REPO}/actions/runs?head_sha=${sha}&event=push&per_page=30`;
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
  async releaseBusy() {
    const r = run('flock', ['-n', `${RELEASES}/.lock`, 'true'], { timeoutMs: 10_000 });
    if (r.code === 0) return false;
    if (r.code === 1) return true;
    throw new Error(`flock 退出码 ${r.code}：${tail(r.stderr)}`);
  },
  async prepareCheckout(sha) {
    try {
      const dirty = gitOk(['status', '--porcelain', '--untracked-files=no'], '看部署检出有没有改动').trim();
      if (dirty) return { ok: false, why: `部署检出 ${CHECKOUT} 有没提交的改动：${tail(dirty, 3)}` };
      const at = gitOk(['rev-parse', 'HEAD'], '读部署检出的提交').trim();
      if (at === sha || isAncestor(sha, at)) return { ok: true };
      if (!isAncestor(at, sha))
        return { ok: false, why: `部署检出在 ${at.slice(0, 12)}，和主线分叉了（不是主线上的祖先）` };
      gitOk(['merge', '--ff-only', '--quiet', sha], `把部署检出快进到 ${sha.slice(0, 12)}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, why: e instanceof Error ? e.message : String(e) };
    }
  },
  async sessions() {
    const r = run(AGENT_SCOPE, ['list'], { timeoutMs: 20_000 });
    if (r.code !== 0) throw new Error(`fleet-agent-scope list 退出码 ${r.code}：${tail(r.stderr)}`);
    return r.stdout;
  },
  runRelease,
  async checkoutHead() {
    return gitOk(['rev-parse', 'HEAD'], '读部署检出的提交').trim();
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
};

async function main() {
  let prev = null;
  try {
    prev = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.log(`上一轮的状态读不出来，从空的起：${e.message}`);
  }
  const st = await runOnce(realIo, prev);
  saveState(st);
  console.log(summary(st));
}

// 被测试 import 时不跑：只有 systemd 直接起这个文件才跑一轮
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`自动发布这一轮崩了：${e instanceof Error ? e.stack : e}`);
    process.exitCode = 1;
  });
}
