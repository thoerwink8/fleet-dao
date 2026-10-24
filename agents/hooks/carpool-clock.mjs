#!/usr/bin/env node
// 本机拼车时钟（决定 0120，#3687）：每分钟判一次，到点才打探针、才切组织；没事就不出声。
// 能建计划任务的电脑每分钟跑 `tick`；不让建的（schtasks 拒绝访问）用启动文件夹的 vbs 登录时静默起 `loop`。
//
// 规则（北京时间，周一到周五算工作日）：
// - 拼车一清零就打一枪最小探针点着下一个窗口；点了会盖住下一个工作日 05:30 的不点（空档）。
// - 空档里本机挂独享；工作日 05:30 切到拼车打一枪、立刻切回独享，08:30 上班才切回拼车。周末全程拼车。
// - 清零时刻优先读 reclaude 开放接口（~/.fleet-dao/reclaude-api.key，没有就按上一枪 + 5 小时估）。
// 改这里之前必须知道：
// - 切组织必须抢在任何模型请求之前，所以只在这里切，不交给桌面端定时任务（它一跑就发请求）。
// - org use 退出码不是 0 也可能已经切了：一律切完回读 org list 核对（docs/reference/adapters.md CC-07）。
// - 读不到就照实记「没查成」，不当成没有窗口去乱打；Key 的值不进日志。
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const H = 3600_000;
const M = 60_000;
export const WINDOW_MS = 5 * H;
/** 工作日锚点 05:30、上班 08:30（北京时间，分钟数）。 */
export const ANCHOR_MIN = 5 * 60 + 30;
export const WORK_START_MIN = 8 * 60 + 30;
/** 清零后多久打探针：留够余量，别抢在清零前几秒白打。 */
export const PROBE_AFTER_MS = 2 * M;
/** 窗口结束前多久切独享：别让清零后第一条本机请求在拼车上开窗。 */
export const SOLO_LEAD_MS = 5 * M;
/** 锚点那一枪的宽限：任务计划晚跑几分钟也补上。 */
export const ANCHOR_GRACE_MS = 15 * M;
/** 打过一枪后多久内不再打。 */
export const RECENT_PROBE_MS = 10 * M;
const CST = 8 * H;

/** 北京时间当天 0 点（UTC 毫秒）和星期几（0 = 周日）。 */
function cstDay(ms) {
  const d = new Date(ms + CST);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - CST;
  return { midnight, dow: d.getUTCDay() };
}
const isWeekday = (dow) => dow >= 1 && dow <= 5;

/** 今天（北京时间）的锚点；不是工作日回 null。 */
export function todayAnchor(now) {
  const { midnight, dow } = cstDay(now);
  return isWeekday(dow) ? midnight + ANCHOR_MIN * M : null;
}

/** 严格晚于 now 的下一个工作日锚点。 */
export function nextAnchor(now) {
  for (let i = 0; i <= 7; i++) {
    const { midnight, dow } = cstDay(now + i * 24 * H);
    const a = midnight + ANCHOR_MIN * M;
    if (isWeekday(dow) && a > now) return a;
  }
  throw new Error('算不出下一个工作日锚点');
}

/**
 * 这一分钟该挂哪个组织、要不要打探针。纯函数。
 * s.windowEnd：当前拼车窗口的清零时刻（毫秒）；null = 没有在走的窗口。
 * s.windowSource：'api'（接口读到的）| 'estimate'（按上一枪 + 5 小时估）| 'unknown'（什么都不知道）。
 * s.lastProbeAt：上一枪的时刻，没有为 null。
 */
export function plan(now, s) {
  const a0 = todayAnchor(now);
  const a = nextAnchor(now);
  const blocked = a - now < WINDOW_MS;
  const morningHold = a0 !== null && now >= a0 && now < cstDay(now).midnight + WORK_START_MIN * M;
  const anchorDue = a0 !== null && now >= a0 && now < a0 + ANCHOR_GRACE_MS && (s.lastProbeAt ?? 0) < a0;

  const windowEnding = s.windowEnd === null || now >= s.windowEnd - SOLO_LEAD_MS;
  const org = morningHold || (blocked && windowEnding) ? 'solo' : 'carpool';

  if (anchorDue) return { org, probe: true, why: '工作日 05:30 锚点' };
  // 刚打过一枪，接口记账可能还没跟上（用量还是 0）：别连着打。
  if (s.lastProbeAt !== null && now - s.lastProbeAt < RECENT_PROBE_MS) return { org, probe: false, why: '' };
  if (blocked || morningHold)
    return {
      org,
      probe: false,
      why: blocked ? '空档：点了会盖住下一个工作日 05:30' : '上班前独享，窗口已在走',
    };
  if (s.windowSource === 'unknown') {
    const due = s.lastProbeAt === null || now - s.lastProbeAt >= WINDOW_MS + PROBE_AFTER_MS;
    return { org, probe: due, why: due ? '读不到清零时刻，按上一枪 + 5 小时打' : '' };
  }
  const due = s.windowEnd === null || now >= s.windowEnd + PROBE_AFTER_MS;
  return { org, probe: due, why: due ? (s.windowEnd === null ? '没有在走的拼车窗口' : '拼车已清零') : '' };
}

/** `reclaude org list` 的输出 → [{ id, kind, current }]。认不出的行跳过（前后的 Syncing config… 之类）。 */
export function parseOrgList(out) {
  const orgs = [];
  for (const line of String(out).split(/\r?\n/)) {
    const m = /^\s*(\*)?\s*(\d+)\t[^\t]*\t(team|personal)\b/.exec(line);
    if (m) orgs.push({ id: m[2], kind: m[3] === 'team' ? 'carpool' : 'solo', current: m[1] === '*' });
  }
  return orgs;
}

// ---- 下面是真执行 ----

const home = homedir();
const dir = join(home, '.fleet-dao');
const stateFile = join(dir, 'state', 'carpool-clock.json');
const logFile = join(dir, 'logs', 'carpool-clock.log');
const keyFile = join(dir, 'reclaude-api.key');
const probeCwd = join(dir, 'tmp', 'carpool-probe');
const BASE = 'https://www.reclaude.ai';

function log(line) {
  mkdirSync(join(dir, 'logs'), { recursive: true });
  appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
}
function readState() {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return {};
  }
}
function writeState(st) {
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(st, null, 2));
}
const oneLine = (s) =>
  String(s)
    .replace(/\s+/g, ' ')
    .replace(/rck_[A-Za-z0-9_-]+/g, 'rck_<抹掉>')
    .slice(0, 300);

function reclaude(args, timeout = 60_000) {
  const r = spawnSync('reclaude', args, {
    encoding: 'utf8',
    timeout,
    shell: process.platform === 'win32',
    cwd: probeCwd,
  });
  return {
    status: r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    error: r.error ? String(r.error.message) : null,
  };
}

/** 读接口里的清零时刻。读不到回 { source: 'unknown', why }。 */
async function readWindow(st) {
  if (!existsSync(keyFile)) return estimate(st, '没有 Key 文件');
  const key = readFileSync(keyFile, 'utf8').trim();
  if (!key.startsWith('rck_')) return estimate(st, 'Key 文件里不是 rck_ 开头的 Key');
  try {
    const res = await fetch(`${BASE}/api/v1/carpool/quota`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return estimate(st, `接口 ${res.status}`);
    const body = await res.json();
    const r = Number(body.resets_at_ms);
    // 零用量时接口给的清零时刻是「读取时刻 + 5 小时」、一直在漂（quota.md Q27），不是在走的窗口。
    if (Number(body.used_usd) === 0) return { windowEnd: null, source: 'api' };
    return { windowEnd: Number.isFinite(r) && r > Date.now() ? r : null, source: 'api' };
  } catch (e) {
    return estimate(st, `接口没读成：${oneLine(e.message)}`);
  }
}
function estimate(st, why) {
  const end = st.lastProbeAt ? st.lastProbeAt + WINDOW_MS : null;
  if (end !== null && end > Date.now()) return { windowEnd: end, source: 'estimate', why };
  return { windowEnd: null, source: st.lastProbeAt ? 'estimate' : 'unknown', why };
}

/** 切到 want 组织并回读核对。回 { ok, why }。 */
function useOrg(want) {
  const list = reclaude(['org', 'list']);
  const orgs = parseOrgList(list.out);
  if (orgs.length === 0) return { ok: false, why: `org list 没读成：${oneLine(list.error ?? list.out)}` };
  if (orgs.find((o) => o.current)?.kind === want) return { ok: true, why: '已经挂着' };
  const target = orgs.filter((o) => o.kind === want);
  if (target.length !== 1) return { ok: false, why: `${want} 类型的组织有 ${target.length} 个` };
  const use = reclaude(['org', 'use', target[0].id]);
  const after = parseOrgList(reclaude(['org', 'list']).out).find((o) => o.current);
  if (after?.kind === want) return { ok: true, why: '切了' };
  return { ok: false, why: `org use 没切成（退出 ${use.status}：${oneLine(use.out)}）` };
}

function probe() {
  const r = reclaude(
    ['-p', '--model', 'haiku', '--setting-sources', 'project', '--no-session-persistence', '只回复 ok'],
    180_000,
  );
  return {
    ok: r.status === 0,
    why: r.status === 0 ? '' : `探针退出 ${r.status}：${oneLine(r.error ?? r.out)}`,
  };
}

export async function tick(now = Date.now()) {
  mkdirSync(probeCwd, { recursive: true });
  const st = readState();
  const w = await readWindow(st);
  const p = plan(now, {
    windowEnd: w.windowEnd,
    windowSource: w.source,
    lastProbeAt: st.lastProbeAt ?? null,
  });

  if (p.probe) {
    const sw = useOrg('carpool');
    if (!sw.ok) {
      log(`探针前切拼车没成，这一枪不打：${sw.why}`);
    } else {
      const r = probe();
      if (r.ok) st.lastProbeAt = Date.now();
      log(`探针（${p.why}，清零时刻来源 ${w.source}${w.why ? `：${w.why}` : ''}）：${r.ok ? '成' : r.why}`);
    }
  }
  if (st.org !== p.org || p.probe) {
    const sw = useOrg(p.org);
    if (sw.ok) {
      if (st.org !== p.org) log(`组织 → ${p.org === 'solo' ? '独享' : '拼车'}（${sw.why}）`);
      st.org = p.org;
    } else {
      log(`切${p.org === 'solo' ? '独享' : '拼车'}没成：${sw.why}`);
    }
  }
  writeState(st);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cmd = process.argv[2];
  if (cmd === 'tick') {
    await tick().catch((e) => {
      log(`这一轮出错：${oneLine(e.stack ?? e.message)}`);
      process.exitCode = 1;
    });
  } else if (cmd === 'loop') {
    // 这台电脑不让建计划任务（schtasks 拒绝访问）时的退路：启动文件夹的 vbs 登录时静默起这一条，每分钟 tick 一次。
    // pid 文件挡重复：已经有一份活着就退出。
    const pidFile = join(dir, 'state', 'carpool-clock.pid');
    mkdirSync(join(dir, 'state'), { recursive: true });
    try {
      const old = Number(readFileSync(pidFile, 'utf8'));
      if (old && old !== process.pid) {
        process.kill(old, 0);
        process.exit(0);
      }
    } catch {
      // 没有 pid 文件，或那个进程已经没了：接着起。
    }
    writeFileSync(pidFile, String(process.pid));
    log(`常驻循环起来了（pid ${process.pid}）`);
    for (;;) {
      await tick().catch((e) => log(`这一轮出错：${oneLine(e.stack ?? e.message)}`));
      await new Promise((r) => setTimeout(r, 60_000 - (Date.now() % 60_000) + 1_000));
    }
  } else if (cmd === 'plan') {
    const st = readState();
    const w = await readWindow(st);
    console.log(
      JSON.stringify({
        window: { ...w, windowEnd: w.windowEnd && new Date(w.windowEnd).toISOString() },
        plan: plan(Date.now(), {
          windowEnd: w.windowEnd,
          windowSource: w.source,
          lastProbeAt: st.lastProbeAt ?? null,
        }),
      }),
    );
  } else {
    console.log('用法：node carpool-clock.mjs tick | loop | plan');
    process.exitCode = 2;
  }
}
