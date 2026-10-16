// 自动发布单元的入口（法国，root）：fleet-auto-release.timer 每 5 分钟经 fleet-auto-release.service 拉起一轮。
// 它读数，也在主线头 CI 全绿、没有发版在走时请求发版（决定 0088、#2039；#2038 起不再隔 1 小时）：只写一份和驾驶舱按钮一样的请求文件，
// 由法国上的接活单元（deploy/france/release-request）去发。这里不调 release.sh；发版驱动死在中途留下的残局（暂停的任务、关着的总开关）这里收。
// deploy/france.sh 把这个目录装到 /usr/local/lib/fleet-dao/auto-release/（装的是副本：主线上改了它，下一版发完由本入口自己
// 跑 france.sh --auto-tier 换上，不用人重跑；只有防火墙、sudoers、建用户那几个文件改了才要人重跑，/healthz 才标「装机脚本落后」）。判断和流程在 lib.mjs，这里只接真的 git、GitHub 接口、库。
// 手动跑一轮：systemctl start fleet-auto-release（别直接跑本文件：两轮叠着跑会互相盖状态文件）。
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
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
  HUMAN_TIER_PATHS,
  INSTALLED_COPIES,
  MAIN_HISTORY,
  NO_SKILLS_USERS,
  PAUSE_FILE,
  parseEngineStatus,
  RELEASES,
  REPO,
  reasonOf,
  runRound,
  STATE_FILE,
  TRAIN_MARKER,
  TRAIN_STATE,
} from './lib.mjs';

const NODE = '/usr/bin/node';
const SHA = /^[0-9a-f]{40}$/;
// 驾驶舱按钮的接活（deploy/france/release-request；单元是人工档，脚本副本是自动档）：请求目录、接活单元的两个文件、进度和暂停标记。路径同 release-request/lib.mjs。
const REQUEST_DIR = '/var/lib/fleet-dao/release-request';
const REQUEST_FILE = `${REQUEST_DIR}/request.json`;
const RECEIVER_UNIT = '/etc/systemd/system/fleet-release-request.path';
const RECEIVER_SCRIPT = '/usr/local/lib/fleet-dao/release-request/fleet-release-request.mjs';
/** current 那一版的 fleet-api（release continue、engine on|status；同 release-request/lib.mjs 的 FLEET_API、release.sh 的 resume_tasks）。 */
const FLEET_API = `${RELEASES}/current/packages/api/bin/fleet-api`;
/** 失败原因：认得出的关键行加尾几行（lib.mjs 的 reasonOf，#2728）。 */
const tail = (text, n = 3) => reasonOf(text, n);

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

/** 发版进度记录原文；不在回 null，别的读不了抛。 */
function readTrainText() {
  try {
    return readFileSync(TRAIN_STATE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`读不了 ${TRAIN_STATE}：${e.message}`);
    return null;
  }
}

/** 发布锁（release.sh 的 RELEASES/.lock）被占着没有：flock -n 抢一下就放。退出码不是 0/1 抛。 */
function lockBusy() {
  const lock = run('flock', ['-n', `${RELEASES}/.lock`, 'true'], { timeoutMs: 10_000 });
  if (lock.code !== 0 && lock.code !== 1) throw new Error(`flock 退出码 ${lock.code}：${tail(lock.stderr)}`);
  return lock.code === 1;
}

/** 一个单元这次进入 active 的时刻（毫秒）；读不到、没在跑回 null。`--timestamp=unix` 有时带 @ 前缀（同 mirasimActiveEnter）。 */
function activeEnterMs(unit) {
  let r;
  try {
    r = run('systemctl', ['show', '-p', 'ActiveEnterTimestamp', '--timestamp=unix', '--value', unit], {
      timeoutMs: 10_000,
    });
  } catch {
    return null;
  }
  if (r.code !== 0) return null;
  const raw = String(r.stdout).trim().split('\n')[0]?.replace(/^@/, '') ?? '';
  if (!/^[0-9]+$/.test(raw)) return null;
  const sec = Number(raw);
  return sec > 0 ? sec * 1000 : null;
}

/** 发版历史（release.sh 的 HISTORY）最后一行；不在、读不了回 null。 */
function historyLastLine() {
  try {
    return readFileSync(`${RELEASES}/.history`, 'utf8').trim().split('\n').at(-1) ?? null;
  } catch {
    return null;
  }
}

/** 进程活没活：kill 0 不发信号只问；EPERM 是活着但不归我们（同 release-request 的 pidAlive）。 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
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
    const log = gitOk(
      ['log', '--first-parent', '--format=%H %cI', `${applied}..${head}`, '--', ...HUMAN_TIER_PATHS],
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
  /** 自动发版的闸要的事实（lib.mjs 的 gateVerdict 判）：接活单元装了没有、有没有没被接走的请求、暂停标记、进度记录、发布锁。读不了的抛。 */
  async releaseGate() {
    const missing = [RECEIVER_UNIT, RECEIVER_SCRIPT].filter((f) => !existsSync(f));
    return {
      missing,
      requestPending: existsSync(REQUEST_FILE),
      marker: existsSync(TRAIN_MARKER),
      trainText: readTrainText(),
      lockBusy: lockBusy(),
      // 攒着发（lib.mjs 的 batchVerdict，#2797）：引擎这次起来的时刻、发版历史最后一行（上一版退回过就照发）
      engineSince: activeEnterMs('fleet-engine.service'),
      historyLast: historyLastLine(),
    };
  },
  /**
   * 这一版要不要停引擎（lib.mjs 的 batchStep）：在用那一版的 deploy/lib/runtime-closure.mjs（和 release.sh 同一份判法），
   * 两个提交从部署检出里取（readStep 刚 fetch 过主线）。退出码 0 不停、10 要停，别的（算不出、在用那版还没有这个脚本）是 null。
   */
  async engineRestart(current, target) {
    const script = `${RELEASES}/${current}/deploy/lib/runtime-closure.mjs`;
    if (!existsSync(script))
      return { restart: null, why: `在用的 ${current.slice(0, 12)} 里还没有引用闭包的脚本` };
    let r;
    try {
      r = run(NODE, [script, '--git', CHECKOUT, '--old', current, '--new', target, '--service', 'engine'], {
        timeoutMs: 600_000,
      });
    } catch (e) {
      return { restart: null, why: `引用闭包没算成：${e instanceof Error ? e.message : String(e)}` };
    }
    const line = String(r.stdout).trim().split('\n').at(-1) ?? '';
    if (r.code === 0) return { restart: false, why: line };
    if (r.code === 10) return { restart: true, why: line };
    return { restart: null, why: `引用闭包没算成（退出码 ${r.code}）：${tail(line || r.stderr)}` };
  },
  /** release.sh 的暂停名单遗留（lib.mjs 的 recoverPaused 判）：在不在、放了多久（文件修改时间距今）、发布锁占没占。读不了的抛。 */
  async pausedLeftover() {
    let st = null;
    try {
      st = statSync(PAUSE_FILE);
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`读不了 ${PAUSE_FILE}：${e.message}`);
    }
    return { exists: st !== null, ageMs: st ? Date.now() - st.mtimeMs : null, lockBusy: lockBusy() };
  },
  /** 替没收尾的发版发「继续」：current 那一版的 fleet-api release continue，名单从标准输入喂（同 release.sh 的 resume_tasks）。 */
  async resumePaused() {
    const r = run('bash', [FLEET_API, 'release', 'continue'], {
      input: readFileSync(PAUSE_FILE, 'utf8'),
      timeoutMs: 300_000,
    });
    return {
      code: r.code,
      out: `${r.stdout}\n${r.stderr}`,
    };
  },
  /** 处理过的名单改名留着（不删：事后排查看得到暂停过谁），也不再重试。 */
  async retirePaused(to) {
    renameSync(PAUSE_FILE, to);
  },
  /** 老版发版驱动的残局（lib.mjs 的 recoverTrain 判）：暂停标记、进度记录原文、发布锁、驱动进程活没活、总开关此刻开没开。 */
  async trainLeftover() {
    const marker = existsSync(TRAIN_MARKER);
    // 总开关只在有暂停标记时问（起一次 fleet-api 要几秒，没有标记就用不上）
    let engine = { ok: false, why: '没有暂停标记，没问' };
    if (marker) {
      const s = run('bash', [FLEET_API, 'engine', 'status'], { timeoutMs: 60_000 });
      engine = parseEngineStatus(s.code, `${s.stdout}\n${s.stderr}`);
    }
    return { marker, trainText: readTrainText(), lockBusy: lockBusy(), pidAlive, engine };
  },
  async engineOn(reason) {
    const r = run('bash', [FLEET_API, 'engine', 'on', '--reason', reason], { timeoutMs: 60_000 });
    return {
      code: r.code,
      out: `${r.stdout}\n${r.stderr}`,
    };
  },
  /**
   * 写一条操作记录（audit_log；列见 packages/db/src/schema/ops.ts）：actor 是运维脚本（actor_kind、via 都是 ops，迁移 0069），
   * id 固定 ops:auto-release。写不进抛（lib.mjs 照实报警，不当成记上了）。
   */
  async audit({ action, target, reason, before, after }) {
    sql(
      `insert into audit_log (actor_kind, actor_id, action, target, before, after, reason, via, ok)
values ('ops'::actor_kind, 'ops:auto-release', :'action', :'target', :'before'::jsonb, :'after'::jsonb, :'reason', 'ops'::audit_via, true);`,
      {
        action,
        target,
        reason,
        before: JSON.stringify(before ?? null),
        after: JSON.stringify(after ?? null),
      },
    );
  },
  async clearTrainMarker() {
    unlinkSync(TRAIN_MARKER);
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
  /**
   * 开急修单（lib.mjs 的 emergencyStep）：current 那一版的 fleet-api emergency-issue，正文从标准输入喂；它经「引擎」机器人开单、
   * 过卫生检查、按 key 幂等，最后一行打 { number, url, created }。退出码不是 0、回话认不出都抛（lib.mjs 报警、下一轮再试）。
   */
  async fileIssue({ key, title, body }) {
    const r = run('bash', [FLEET_API, 'emergency-issue', '--key', key, '--title', title, '--json'], {
      input: body,
      timeoutMs: 120_000,
    });
    if (r.code !== 0)
      throw new Error(`fleet-api emergency-issue 退出码 ${r.code}：${tail(r.stderr || r.stdout)}`);
    const line = r.stdout.trim().split('\n').at(-1) ?? '';
    let got;
    try {
      got = JSON.parse(line);
    } catch {
      throw new Error(`fleet-api emergency-issue 的回话认不出：${tail(r.stdout)}`);
    }
    return got;
  },
  /** 脚本副本和在用那一版的原件（lib.mjs 的 installedStep）：没装、在用那一版里没有的给 null；别的读不了抛。 */
  async readInstalled(current) {
    const read = (file) => {
      try {
        return readFileSync(file, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw new Error(`读不了 ${file}：${e.message}`);
      }
    };
    return INSTALLED_COPIES.flatMap(({ dir, src, files }) =>
      files.map((f) => ({
        name: `${dir}/${f}`,
        installed: read(`${dir}/${f}`),
        release: read(`${RELEASES}/${current}/${src}/${f}`),
      })),
    );
  },
  /** 发版进度记录原文（lib.mjs 的 supersededStep）；不在回 null，别的读不了抛。 */
  async readTrain() {
    return readTrainText();
  },
  /** 在用那一版依赖的 .modules.yaml 原文（lib.mjs 的 depsStep）；读不了抛（不在也抛：发布目录里该有）。 */
  async readDeps(current) {
    return readFileSync(`${RELEASES}/${current}/node_modules/.modules.yaml`, 'utf8');
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
  /**
   * fleet-mirasim-session 这次进入 active 的时刻（毫秒）。冷启动窗口从这里起算（lib.mjs 的 TIER_BOOT_MS）：
   * 刚 ActiveEnter 时 4318 还没 listen，curl 退出 7 不是装机失败。读不到回 null，调用方改从第一次看见退出 7 起算。
   * `--timestamp=unix` 有时带 @ 前缀（和 release.sh 的 env_changed_since_start 同一套）。
   */
  async mirasimActiveEnter() {
    const r = run(
      'systemctl',
      ['show', '-p', 'ActiveEnterTimestamp', '--timestamp=unix', '--value', 'fleet-mirasim-session.service'],
      { timeoutMs: 10_000 },
    );
    if (r.code !== 0) return null;
    const raw = String(r.stdout).trim().split('\n')[0]?.replace(/^@/, '') ?? '';
    if (!/^[0-9]+$/.test(raw)) return null;
    const sec = Number(raw);
    return sec > 0 ? sec * 1000 : null;
  },
  /** 冷启动窗口内再探之前歇一会儿（lib.mjs 的 tierStep）。 */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
  async syncRules(user) {
    const flags = NO_SKILLS_USERS.includes(user) ? ['--no-skills'] : [];
    const r = run(
      NODE,
      [`${CHECKOUT}/packages/agents-sync/bin/agents-sync`, '--apply', '--user', user, ...flags],
      {
        timeoutMs: 300_000,
      },
    );
    return { code: r.code, out: `${r.stdout}\n${r.stderr}` };
  },
  /**
   * 报警（卡住报警级）：走 current 那一版 fleet-api 的 notify raise（统一写入口 upsertAlert，#2729），不直写表；同键原地更新、
   * 处理过的重新打开。正文从标准输入喂。没记上抛（lib.mjs 记着没发的，下一轮再发）。
   */
  async alert({ key, title, body }) {
    const r = run(
      'bash',
      [FLEET_API, 'notify', 'raise', '--key', key, '--title', title, '--level', 'alert'],
      {
        input: body,
        timeoutMs: 60_000,
      },
    );
    if (r.code !== 0)
      throw new Error(`fleet-api notify raise 退出码 ${r.code}：${tail(r.stderr || r.stdout)}`);
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
