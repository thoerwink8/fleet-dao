// 法国只读巡查（决定 0034，#1372）：无人值守时指挥官每个监控周期跑一次 patrol.mjs，只读最后一行 VERDICT。
// 监控的主体是这份脚本，不是模型：采集、比基线、判不变量、沉默告警都在这里判；模型只在 ALERT 且有变化时才被叫来摘证据。
// 复用 france-lib.mjs 的 ssh 名字读法（readTarget）、ssh 参数（sshArgs）、起 ssh 收输出（runRemote）、抹字（scrubText）。
// 改这里之前必须知道：
// - 只读：法国上跑的是一段 sh（REMOTE_SCRIPT，从标准输入喂给 `sh -s`），库连接带 default_transaction_read_only=on，
//   agents/test/patrol.test.ts 扫这段脚本钉住不写库、不改文件。
// - 读不成一律 BROKEN，不当 OK：ssh 连不上、输出是空的、少了哪一块、有认不出的行、库查询报错、采集时间和本机差超过
//   STALE_MINUTES 分钟。
// - 基线只由这份脚本写（模型不写）：OK、ALERT 都把这一次的读数写成新基线，BROKEN 不写（不拿坏读数盖掉好基线）。
// - 最后一行永远是 `VERDICT: OK`、`VERDICT: ALERT <条数>` 或 `VERDICT: BROKEN`；退出码 0、1、2 与之对应。
import { readTarget, runRemote, scrubText, sshArgs } from './france-lib.mjs';

/** @typedef {{ ok: false, kind: string, why: string }} Failure 没做成：kind 同 france-lib；why 给人看 */
/** @typedef {{ n: number, repo: string, state: string, phase: string, minutes: number, doing: string }} TaskFact 一张没做完的单 */
/** @typedef {{ job: string, outcome: string, minutes: number, why: string }} JobFact 最近一次跑完不是 ok 的定时任务 */
/** @typedef {{ key: string, title: string }} NoteFact 一条开着的通知（不含提醒类） */
/**
 * 一次巡查读到的。at 是法国的采集时间（ISO）。
 * @typedef {{ at: string, release: string, services: Record<string, string>, diskPct: number, memMb: number, load: number, master: string, tasks: TaskFact[], jobs: JobFact[], notesOpen: number, notes: NoteFact[] }} Facts
 */
/** @typedef {'OK' | 'ALERT' | 'BROKEN'} Verdict */
/** @typedef {{ verdict: Verdict, facts: Facts | null, alerts: string[], delta: string[], broken: string | null, notes: string[] }} Report */

/** 采集时间和本机差超过这么多分钟：当成没读成（沉默告警）。 */
export const STALE_MINUTES = 15;
/** 不变量的线。 */
export const LIMITS = {
  /** 根分区用到这个百分比以上 */
  diskPct: 85,
  /** 可用内存少于这么多 MB */
  memMinMb: 1024,
  /** 单卡住（stalled）或停下等人（phase=parked）超过这么多分钟 */
  stuckMinutes: 30,
};
/** 要 active 的服务。 */
export const SERVICES = ['fleet-api', 'fleet-engine'];
/** 库查询那几块：每块跑完打 ok|<块>，报错打 ERR|<块>|<原因>。 */
export const DB_BLOCKS = ['master', 'tasks', 'jobs', 'notecount', 'notes'];
/** 远端命令：脚本从标准输入喂。 */
export const PATROL_REMOTE_COMMAND = 'sh -s';
/** 基线默认放在仓根 _tmp/（指挥官在主检出里跑）。 */
export const DEFAULT_BASELINE = '_tmp/patrol-baseline.json';
export const BASELINE_SCHEMA = 1;

const NO_NEWLINE = "E'\\n'";
/**
 * 在法国上跑的那段 sh。每行一项，用「|」分隔；最后一行是 end（没有 end 就是被截断了）。
 * 只读：systemctl is-active、df、free、/proc/loadavg、只读事务里的 select。
 */
export const REMOTE_SCRIPT = [
  'set -u',
  `CONN="dbname=fleet options='-c default_transaction_read_only=on'"`,
  'q() {',
  `  if out=$(runuser -u fleet -- psql "$CONN" -X -q -At -F '|' -v ON_ERROR_STOP=1 -c "$2" 2>&1); then`,
  `    [ -n "$out" ] && printf '%s\\n' "$out"`,
  '    echo "ok|$1"',
  '  else',
  `    echo "ERR|$1|$(printf '%s' "$out" | tail -n 1 | tr '|' '/')"`,
  '  fi',
  '}',
  'echo "at|$(date +%s)"',
  'echo "release|$(basename "$(readlink -f /srv/fleet-dao-releases/current)" | cut -c1-8)"',
  `for u in ${SERVICES.join(' ')}; do echo "svc|$u|$(systemctl is-active "$u")"; done`,
  `echo "disk|$(df -P / | awk 'NR==2{sub("%","",$5); print $5}')"`,
  `echo "mem|$(free -m | awk 'NR==2{print $7}')"`,
  `echo "load|$(cut -d' ' -f1 /proc/loadavg)"`,
  `q master "select 'master', coalesce((select value::text from settings where key = 'engine.master'), 'none')"`,
  `q tasks "select 'task', t.issue_number, r.name, t.state, coalesce(t.phase, ''), floor(extract(epoch from now() - coalesce(t.updated_at, t.created_at)) / 60)::int, replace(left(coalesce(t.doing, ''), 80), ${NO_NEWLINE}, ' ') from tasks t join repos r on r.id = t.repo_id where t.state not in ('done', 'stopped', 'failed', 'queued') order by t.issue_number"`,
  `q jobs "select 'job', r.job, r.outcome, floor(extract(epoch from now() - coalesce(r.ended_at, r.started_at)) / 60)::int, replace(left(coalesce(r.why, ''), 100), ${NO_NEWLINE}, ' ') from schedule_runs r join scheduled_jobs j on j.id = r.job and j.removed_at is null where r.id in (select max(id) from schedule_runs where outcome is not null group by job) and r.outcome not in ('ok', 'partial') order by r.job"`,
  `q notecount "select 'notes', count(*) from notifications where resolved_at is null and dedupe_key not like 'remind:%'"`,
  `q notes "select 'note', left(dedupe_key, 80), replace(left(title, 100), ${NO_NEWLINE}, ' ') from notifications where resolved_at is null and dedupe_key not like 'remind:%' order by id desc limit 50"`,
  'echo end',
  '',
].join('\n');

/** @param {string} s */
const isInt = (s) => /^-?\d+$/.test(s);
/** @param {string} s */
const isNum = (s) => /^-?\d+(?:\.\d+)?$/.test(s);
/** @param {string} line */
const shown = (line) => scrubText(line.length > 80 ? `${line.slice(0, 80)}…` : line);

/**
 * 认法国回来的那一屏。成功 { ok: true, facts }；认不出、少了块、库查询报错都回 { ok: false, why }，不拿空顶。
 * @param {string} text
 * @returns {{ ok: true, facts: Facts } | { ok: false, why: string }}
 */
export function parseRaw(text) {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 0) return { ok: false, why: '法国回来的是空的（ssh 没打出任何东西）' };
  if (lines[lines.length - 1] !== 'end')
    return { ok: false, why: '法国回来的没有结尾那行 end（被截断了，或脚本中途停了）' };
  /** @type {Record<string, string>} */
  const services = {};
  /** @type {TaskFact[]} */
  const tasks = [];
  /** @type {JobFact[]} */
  const jobs = [];
  /** @type {NoteFact[]} */
  const notes = [];
  /** @type {Set<string>} */
  const blocksOk = new Set();
  /** @type {{ at?: string, release?: string, diskPct?: number, memMb?: number, load?: number, master?: string, notesOpen?: number }} */
  const one = {};
  for (const line of lines.slice(0, -1)) {
    const p = line.split('|');
    const kind = p[0];
    if (kind === 'ERR')
      return { ok: false, why: `库查询「${p[1] ?? '?'}」报错：${shown(p.slice(2).join('|'))}` };
    if (kind === 'ok' && p.length === 2 && DB_BLOCKS.includes(p[1] ?? '')) blocksOk.add(p[1] ?? '');
    else if (kind === 'at' && p.length === 2 && isInt(p[1] ?? ''))
      one.at = new Date(Number(p[1]) * 1000).toISOString();
    else if (kind === 'release' && p.length === 2) one.release = p[1] ?? '';
    else if (kind === 'svc' && p.length === 3) services[p[1] ?? ''] = p[2] ?? '';
    else if (kind === 'disk' && p.length === 2 && isInt(p[1] ?? '')) one.diskPct = Number(p[1]);
    else if (kind === 'mem' && p.length === 2 && isInt(p[1] ?? '')) one.memMb = Number(p[1]);
    else if (kind === 'load' && p.length === 2 && isNum(p[1] ?? '')) one.load = Number(p[1]);
    else if (kind === 'master' && p.length === 2) one.master = p[1] ?? '';
    else if (kind === 'notes' && p.length === 2 && isInt(p[1] ?? '')) one.notesOpen = Number(p[1]);
    else if (kind === 'task' && p.length >= 7 && isInt(p[1] ?? '') && isInt(p[5] ?? ''))
      tasks.push({
        n: Number(p[1]),
        repo: p[2] ?? '',
        state: p[3] ?? '',
        phase: p[4] ?? '',
        minutes: Number(p[5]),
        doing: scrubText(p.slice(6).join('|')),
      });
    else if (kind === 'job' && p.length >= 5 && isInt(p[3] ?? ''))
      jobs.push({
        job: p[1] ?? '',
        outcome: p[2] ?? '',
        minutes: Number(p[3]),
        why: scrubText(p.slice(4).join('|')),
      });
    else if (kind === 'note' && p.length >= 3)
      notes.push({ key: scrubText(p[1] ?? ''), title: scrubText(p.slice(2).join('|')) });
    else return { ok: false, why: `认不出这一行：${shown(line)}` };
  }
  /** @type {string[]} */
  const missing = [];
  for (const k of ['at', 'release', 'diskPct', 'memMb', 'load', 'master', 'notesOpen'])
    if (!(k in one)) missing.push(k);
  for (const u of SERVICES) if (!(u in services)) missing.push(`svc ${u}`);
  for (const b of DB_BLOCKS) if (!blocksOk.has(b)) missing.push(`库查询 ${b}`);
  if (missing.length > 0) return { ok: false, why: `法国回来的少了：${missing.join('、')}` };
  return {
    ok: true,
    facts: {
      at: one.at ?? '',
      release: one.release ?? '',
      services,
      diskPct: one.diskPct ?? 0,
      memMb: one.memMb ?? 0,
      load: one.load ?? 0,
      master: one.master ?? '',
      tasks,
      jobs,
      notesOpen: one.notesOpen ?? 0,
      notes,
    },
  };
}

/** @param {TaskFact} t */
const isStuck = (t) => (t.state === 'stalled' || t.phase === 'parked') && t.minutes > LIMITS.stuckMinutes;
/** @param {TaskFact} t */
const taskWord = (t) => `#${t.n}（${t.repo}）${t.state}${t.phase ? `/${t.phase}` : ''}`;

/**
 * 不变量：命中一条记一行。新通知要有基线才判（没有基线的第一次只记基线）。
 * @param {Facts} f
 * @param {Facts | null} base
 */
export function invariants(f, base) {
  /** @type {string[]} */
  const out = [];
  for (const u of SERVICES)
    if (f.services[u] !== 'active') out.push(`服务 ${u} 是 ${f.services[u] || '（空）'}`);
  if (f.release === '') out.push('在用的版本没读到（/srv/fleet-dao-releases/current 指不到）');
  if (f.diskPct > LIMITS.diskPct) out.push(`磁盘 ${f.diskPct}% 超过 ${LIMITS.diskPct}%`);
  if (f.memMb < LIMITS.memMinMb) out.push(`可用内存 ${f.memMb}M 少于 ${LIMITS.memMinMb}M`);
  if (f.master !== 'true') out.push(`引擎总开关关着（engine.master 是 ${f.master}）`);
  for (const t of f.tasks.filter(isStuck))
    out.push(`单 ${taskWord(t)} 已 ${t.minutes} 分钟没动（超过 ${LIMITS.stuckMinutes}）：${t.doing}`);
  for (const j of f.jobs)
    out.push(`定时任务 ${j.job} 最近一次是 ${j.outcome}（${j.minutes} 分钟前）：${j.why}`);
  if (base) {
    const old = new Set(base.notes.map((n) => n.key));
    for (const n of f.notes) if (!old.has(n.key)) out.push(`新通知 ${n.key}：${n.title}`);
  }
  return out;
}

/**
 * 和基线比出变了什么（不比分钟数这类每次都变的）。没有基线回空。
 * @param {Facts} f
 * @param {Facts | null} base
 */
export function delta(f, base) {
  if (!base) return [];
  /** @type {string[]} */
  const out = [];
  if (f.release !== base.release) out.push(`~ 版本 ${base.release} → ${f.release}`);
  for (const u of SERVICES)
    if (f.services[u] !== base.services[u]) out.push(`~ 服务 ${u} ${base.services[u]} → ${f.services[u]}`);
  if (f.master !== base.master) out.push(`~ 总开关 ${base.master} → ${f.master}`);
  const oldTasks = new Map(base.tasks.map((t) => [t.n, t]));
  const newTasks = new Map(f.tasks.map((t) => [t.n, t]));
  for (const t of f.tasks) {
    const o = oldTasks.get(t.n);
    if (!o) out.push(`+ 单 ${taskWord(t)}`);
    else if (o.state !== t.state || o.phase !== t.phase)
      out.push(`~ 单 ${taskWord(o)} → ${t.state}${t.phase ? `/${t.phase}` : ''}`);
  }
  for (const o of base.tasks) if (!newTasks.has(o.n)) out.push(`- 单 ${taskWord(o)}`);
  const oldJobs = new Map(base.jobs.map((j) => [j.job, j]));
  const newJobs = new Set(f.jobs.map((j) => j.job));
  for (const j of f.jobs) {
    const o = oldJobs.get(j.job);
    if (!o) out.push(`+ 定时任务 ${j.job} ${j.outcome}`);
    else if (o.outcome !== j.outcome) out.push(`~ 定时任务 ${j.job} ${o.outcome} → ${j.outcome}`);
  }
  for (const o of base.jobs) if (!newJobs.has(o.job)) out.push(`- 定时任务 ${o.job}（恢复了）`);
  const oldNotes = new Set(base.notes.map((n) => n.key));
  const newNotes = new Set(f.notes.map((n) => n.key));
  for (const n of f.notes) if (!oldNotes.has(n.key)) out.push(`+ 通知 ${n.key}：${n.title}`);
  for (const n of base.notes) if (!newNotes.has(n.key)) out.push(`- 通知 ${n.key}`);
  return out;
}

/**
 * 判一次。raw 是 ssh 回来的结局；base 是上一次的基线（没有为 null）。
 * @param {{ raw: { ok: true, stdout: string } | Failure, now: Date, base: Facts | null }} input
 * @returns {Report}
 */
export function judge({ raw, now, base }) {
  /** @param {string} why @returns {Report} */
  const broken = (why) => ({ verdict: 'BROKEN', facts: null, alerts: [], delta: [], broken: why, notes: [] });
  if (!raw.ok) return broken(`ssh 没读成（${raw.kind}）：${raw.why}`);
  const parsed = parseRaw(raw.stdout);
  if (!parsed.ok) return broken(parsed.why);
  const f = parsed.facts;
  const skew = Math.abs(now.getTime() - Date.parse(f.at)) / 60_000;
  if (!(skew <= STALE_MINUTES))
    return broken(
      `采集时间 ${f.at} 和本机 ${now.toISOString()} 差 ${Math.round(skew)} 分钟，超过 ${STALE_MINUTES}`,
    );
  const alerts = invariants(f, base);
  return {
    verdict: alerts.length > 0 ? 'ALERT' : 'OK',
    facts: f,
    alerts,
    delta: delta(f, base),
    broken: null,
    notes: base ? [] : ['基线 没有：这一次的读数写成第一份基线，新通知从下一次起判'],
  };
}

/**
 * 打出来的样子：每项一行，带计数和采集时间；最后一行是 VERDICT。
 * @param {Report} r
 * @returns {string[]}
 */
export function render(r) {
  if (r.verdict === 'BROKEN' || !r.facts)
    return ['PATROL 法国 没读成', `BROKEN ${r.broken ?? '没说为什么'}`, 'VERDICT: BROKEN'];
  const f = r.facts;
  const at = `@${f.at}`;
  const active = SERVICES.filter((u) => f.services[u] === 'active').length;
  const lines = [
    `PATROL 法国 采集于 ${f.at} 版本 ${f.release || '（没读到）'}`,
    `服务 ${active}/${SERVICES.length} active ${at}`,
    `资源 磁盘 ${f.diskPct}% 可用内存 ${f.memMb}M 负载 ${f.load} ${at}`,
    `总开关 ${f.master === 'true' ? '开着' : `关着（${f.master}）`} ${at}`,
    `单 ${f.tasks.length} 张没做完，卡住或停下超过 ${LIMITS.stuckMinutes} 分钟的 ${f.tasks.filter(isStuck).length} 张 ${at}`,
    `定时任务 最近一次不是 ok 的 ${f.jobs.length} 个 ${at}`,
    `通知 开着 ${f.notesOpen} 条 ${at}`,
    ...r.notes,
    `DELTA ${r.delta.length}`,
    ...r.delta.map((d) => `  ${d}`),
    `ALERT ${r.alerts.length}`,
    ...r.alerts.map((a) => `  ${a}`),
    r.verdict === 'ALERT' ? `VERDICT: ALERT ${r.alerts.length}` : 'VERDICT: OK',
  ];
  return lines;
}

/**
 * 读基线文件的内容。没有文件传 null。认不出回 { ok: false, why }（调用方照「没有基线」办，并打一行说明）。
 * @param {string | null} text
 * @returns {{ ok: true, facts: Facts | null } | { ok: false, why: string }}
 */
export function readBaseline(text) {
  if (text === null) return { ok: true, facts: null };
  try {
    const v = JSON.parse(text);
    if (v?.schema !== BASELINE_SCHEMA || typeof v.facts !== 'object' || v.facts === null)
      return { ok: false, why: `基线文件认不出（schema 不是 ${BASELINE_SCHEMA}，或没有 facts）` };
    const f = v.facts;
    if (
      !Array.isArray(f.tasks) ||
      !Array.isArray(f.jobs) ||
      !Array.isArray(f.notes) ||
      typeof f.services !== 'object'
    )
      return { ok: false, why: '基线文件认不出（tasks、jobs、notes、services 少了一样）' };
    return { ok: true, facts: /** @type {Facts} */ (f) };
  } catch (e) {
    return { ok: false, why: `基线文件不是 JSON（${e instanceof Error ? e.message : String(e)}）` };
  }
}

/** @param {Facts} facts */
export const baselineText = (facts) => `${JSON.stringify({ schema: BASELINE_SCHEMA, facts }, null, 2)}\n`;

/**
 * 跑一次巡查：取、判、打、写基线。io 全部可换（测试不碰 ssh、不碰真文件）。
 * @param {{ fetchRaw: () => Promise<{ ok: true, stdout: string } | Failure>, now: () => Date, loadBaseline: () => string | null, saveBaseline: (text: string) => void }} io
 * @returns {Promise<{ code: number, lines: string[], report: Report }>}
 */
export async function runPatrol(io) {
  /** @type {string[]} */
  const extra = [];
  let base = null;
  try {
    const b = readBaseline(io.loadBaseline());
    if (b.ok) base = b.facts;
    else extra.push(`基线 ${b.why}：这次照没有基线算，读数写成新基线`);
  } catch (e) {
    extra.push(`基线 读不了（${e instanceof Error ? e.message : String(e)}）：这次照没有基线算`);
  }
  const report = judge({ raw: await io.fetchRaw(), now: io.now(), base });
  if (report.facts) {
    try {
      io.saveBaseline(baselineText(report.facts));
    } catch (e) {
      extra.push(`基线 没写成（${e instanceof Error ? e.message : String(e)}）：下一次的 DELTA 不可信`);
    }
  }
  const body = render(report);
  const lines = [...body.slice(0, -1), ...extra, ...body.slice(-1)];
  return { code: report.verdict === 'OK' ? 0 : report.verdict === 'ALERT' ? 1 : 2, lines, report };
}

/**
 * 真去法国取：ssh 名字照 france-lib 的读法，远端换成 `sh -s`、把 REMOTE_SCRIPT 从标准输入喂过去；回来的字抹过 ssh 名字。
 * @param {{ home: string, env: Record<string, string | undefined>, readText: (file: string) => string, timeoutMs?: number, spawnImpl?: Parameters<typeof runRemote>[0]['spawnImpl'] }} opts
 * @returns {Promise<{ ok: true, stdout: string } | Failure>}
 */
export async function fetchFrance({ home, env, readText, timeoutMs = 55_000, spawnImpl }) {
  const target = readTarget({ env, home, readText });
  if (!target.ok) return target;
  const r = await runRemote({
    command: 'ssh',
    args: [...sshArgs(target.host).slice(0, -1), PATROL_REMOTE_COMMAND],
    script: REMOTE_SCRIPT,
    timeoutMs,
    ...(spawnImpl ? { spawnImpl } : {}),
  });
  if (!r.ok) return r;
  return { ok: true, stdout: r.stdout.split(target.host).join('<host>') };
}

// —— 自检：一份固定的假输出，验证 ALERT、BROKEN 的判法还灵 ——

/**
 * 造一份法国回来的样子（自检和测试用）。默认是一切正常；over 改哪项就坏哪项。
 * @param {{ at: Date, disk?: number, mem?: number, engine?: string, master?: string, tasks?: string[], jobs?: string[], notes?: string[], noEnd?: boolean, err?: string }} o
 */
export function sampleRaw(o) {
  const notes = o.notes ?? ['note|deploy-lag|发布落后'];
  const lines = [
    `at|${Math.floor(o.at.getTime() / 1000)}`,
    'release|abcd1234',
    'svc|fleet-api|active',
    `svc|fleet-engine|${o.engine ?? 'active'}`,
    `disk|${o.disk ?? 40}`,
    `mem|${o.mem ?? 3000}`,
    'load|0.50',
    `master|${o.master ?? 'true'}`,
    'ok|master',
    ...(o.tasks ?? ['task|12|fleet-dao|running||3|在写代码']),
    'ok|tasks',
    ...(o.jobs ?? []),
    'ok|jobs',
    `notes|${notes.length}`,
    'ok|notecount',
    ...notes,
    o.err ?? 'ok|notes',
    ...(o.noEnd ? [] : ['end']),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * 自检：几份已知结局的假输出逐个过 judge，结局不对就算失败。回 { ok, lines }。
 * @param {Date} now
 */
export function selftest(now) {
  const good = parseRaw(sampleRaw({ at: now }));
  const base = good.ok ? good.facts : null;
  /** @type {[name: string, raw: { ok: true, stdout: string } | Failure, want: Verdict, alerts?: number][]} */
  const cases = [
    ['一切正常', { ok: true, stdout: sampleRaw({ at: now }) }, 'OK', 0],
    [
      '已知坏样本（引擎服务挂了、磁盘满、内存紧、总开关关、单卡住 45 分钟、定时任务失败、新通知）',
      {
        ok: true,
        stdout: sampleRaw({
          at: now,
          engine: 'failed',
          disk: 91,
          mem: 512,
          master: 'false',
          tasks: ['task|12|fleet-dao|stalled||45|等路由'],
          jobs: ['job|probe|failed|7|探针连不上'],
          notes: ['note|deploy-lag|发布落后', 'note|task-stuck:12|单卡住了'],
        }),
      },
      'ALERT',
      7,
    ],
    ['空输出', { ok: true, stdout: '' }, 'BROKEN'],
    ['ssh 连不上', { ok: false, kind: 'ssh-failed', why: '假的：连不上' }, 'BROKEN'],
    ['没有结尾 end（截断）', { ok: true, stdout: sampleRaw({ at: now, noEnd: true }) }, 'BROKEN'],
    [
      '库查询报错',
      { ok: true, stdout: sampleRaw({ at: now, err: 'ERR|notes|permission denied' }) },
      'BROKEN',
    ],
    [
      '采集时间比现在早 20 分钟',
      { ok: true, stdout: sampleRaw({ at: new Date(now.getTime() - 20 * 60_000) }) },
      'BROKEN',
    ],
  ];
  /** @type {string[]} */
  const lines = [];
  let failed = 0;
  for (const [name, raw, want, alerts] of cases) {
    const r = judge({ raw, now, base });
    const okVerdict = r.verdict === want;
    const okCount = alerts === undefined || r.alerts.length === alerts;
    if (okVerdict && okCount)
      lines.push(`自检 过 ${name}：${r.verdict}${alerts ? ` ${r.alerts.length}` : ''}`);
    else {
      failed += 1;
      lines.push(
        `自检 没过 ${name}：要 ${want}${alerts !== undefined ? ` ${alerts}` : ''}，判成 ${r.verdict} ${r.alerts.length}`,
      );
    }
  }
  lines.push(failed === 0 ? 'SELFTEST: OK' : `SELFTEST: FAILED ${failed}`);
  return { ok: failed === 0, lines };
}
