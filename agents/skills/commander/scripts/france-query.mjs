// 法国引擎页的查询脚本（#328）：在法国上跑。本机页面服务经 ssh 把这份文件喂给法国的 node：
//   ssh <法国> node --input-type=module - --collect < france-query.mjs
// 只读：查库、读自动发布的读数和在用的版本、看几个服务在不在、翻自动发布的日志，打一行 JSON 到标准输出。
// 改这里之前必须知道：
// - 只许读。起命令一律经 run()，只认 ALLOWED 里那几样；库经 psql 连的时候就把会话设成只读（连接参数里的
//   default_transaction_read_only），库自己拒写。agents/test/france.test.ts 扫这份脚本钉住只读：加了写库、改文件、
//   起停服务的语句，测试会红。
// - 每一块各查各的：一块没查成就是 { ok: false, why }，别的照查；不拿空、0 顶。
// - 不读 /etc/fleet-dao 下的任何文件（那里放密钥）。本机那头拿到后再过一遍抹字（france-lib.mjs 的 scrubDeep）。
// - 表名、列名以 packages/db/src/schema 为准；那边改了列，这里对应的那一块会报「库查询出错」，照着改。
import { spawnSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';

// 类型只写在 JSDoc 里（这份文件经 ssh 喂给法国的 node、本机也直接 import，没有编译步骤）；agents/tsconfig.json 用 checkJs 过严格检查。
/**
 * 一条命令跑完的结果：error 是没起来的原因（起不了、不在名单里），status 是退出码（被信号停了是 null）。
 * @typedef {{ status: number | null, stdout: string, stderr: string, error: string | null }} RunResult
 */
/**
 * 查询用到的外界：时钟、起命令、读文件、读链接。真的在 realIo，测试里换成假的。
 * @typedef {{ now: () => Date, run: (argv: readonly string[], input?: string) => RunResult, readFile: (path: string) => string, readlink: (path: string) => string }} QueryIo
 */
/** @typedef {{ ok: false, why: string } | ({ ok: true } & Record<string, unknown>)} QuerySection 一块：读到了带内容，没读到带原因 */

export const APP = 'fleet-france-query';
export const SCHEMA = 1;
export const RELEASES = '/srv/fleet-dao-releases';
export const STATE_FILE = `${RELEASES}/.auto/state.json`;
export const CURRENT_LINK = `${RELEASES}/current`;
/** 要在的几个服务：驾驶舱后端、引擎、Temporal、自动发布的定时器。 */
export const UNITS = ['fleet-api', 'fleet-engine', 'fleet-temporal', 'fleet-auto-release.timer'];
/** 自动发布的日志翻多久：它每 5 分钟一轮，一轮一行「这轮：…」。 */
export const ROUNDS_SINCE = '-6h';
export const ROUNDS_KEEP = 6;
/** 主线最近的提交只带这么多回去（状态文件里留 300 个）：数落后几个够用，线路慢，少带一点。 */
export const COMMITS_KEEP = 60;

/** 以库的属主身份、本地连接认身份（不用口令）；连接参数把整个会话设成只读。 */
export const PSQL = [
  'sudo',
  '-n',
  '-u',
  'fleet',
  'psql',
  '-X',
  '-q',
  '-t',
  '-A',
  '-d',
  "dbname=fleet options='-c default_transaction_read_only=on'",
  '-f',
  '-',
];

/** 看服务在不在：只有 is-active。 */
export const SERVICES_ARGV = ['systemctl', 'is-active', ...UNITS];
/** 翻自动发布的日志：只读、不翻页。 */
export const ROUNDS_ARGV = [
  'journalctl',
  '-u',
  'fleet-auto-release.service',
  '--since',
  ROUNDS_SINCE,
  '--no-pager',
  '-o',
  'short-iso',
  '-q',
];

/** 能起的命令只有这三条，参数一个不多一个不少（前缀也不行：journalctl 后面加 --rotate 就会动日志）。 */
export const ALLOWED = [PSQL, SERVICES_ARGV, ROUNDS_ARGV];

/** psql 输出里分块的记号：JSON 不会以 @@ 开头。 */
export const MARK = '@@fleet-section';
export const ERR = '@@fleet-error';

/**
 * 每一块一条查询，只能是一条 select，输出一个 jsonb。时刻一律原样给（带时区），多久以前由本机那头按 at 算。
 * 列的意思见 packages/db/src/schema（work.ts、ops.ts、catalog.ts）。
 */
export const SQL = {
  db: `select jsonb_build_object('now', now(), 'readOnly', current_setting('transaction_read_only'))`,

  tasks: `select coalesce(jsonb_agg(x order by x.touched desc), '[]'::jsonb) from (
    select r.owner || '/' || r.name as repo, t.issue_number as n, left(t.title, 200) as title, t.state, t.phase,
           left(t.doing, 300) as doing, left(t.last_problem, 600) as last_problem, t.created_at, t.updated_at,
           coalesce(t.updated_at, t.created_at) as touched
    from tasks t join repos r on r.id = t.repo_id
    where t.state not in ('done', 'stopped', 'failed')
       or coalesce(t.updated_at, t.created_at) > now() - interval '3 days'
       or exists (select 1 from session_runs s where s.task_id = t.id and s.queued_at > now() - interval '3 days')
    order by coalesce(t.updated_at, t.created_at) desc
    limit 300) x`,

  runs: `select coalesce(jsonb_agg(x order by x.queued_at), '[]'::jsonb) from (
    select rp.owner || '/' || rp.name as repo, t.issue_number as n, s.stage, s.route_id,
           ro.model_id as model, m.display_name as model_name, ro.host_id as host, ro.pool_id as pool, ch.billing,
           s.actual_model, s.queued_at, s.started_at, s.ended_at, s.queue_ms, s.run_ms,
           s.input_tokens, s.output_tokens, s.cache_read_tokens, s.cache_write_tokens, s.cost_usd, s.session_cost_usd,
           s.outcome, s.failure_code, left(s.failure_message, 600) as failure_message,
           st.index as subtask_index, left(st.title, 120) as subtask_title
    from session_runs s
    left join tasks t on t.id = s.task_id
    left join repos rp on rp.id = t.repo_id
    left join routes ro on ro.id = s.route_id
    left join models m on m.id = ro.model_id
    left join channels ch on ch.id = ro.channel_id
    left join subtasks st on st.id = s.subtask_id
    where s.queued_at > now() - interval '3 days' or s.ended_at is null
       or t.state not in ('done', 'stopped', 'failed')
       or coalesce(t.updated_at, t.created_at) > now() - interval '3 days'
    order by s.queued_at desc
    limit 3000) x`,

  notifications: `select jsonb_build_object(
    'count', (select count(*) from notifications where resolved_at is null),
    'rows', coalesce((select jsonb_agg(x order by x.created_at desc) from (
      select nt.level, left(nt.dedupe_key, 120) as dedupe_key, left(nt.title, 300) as title, left(nt.body, 600) as body,
             nt.link, nt.created_at, nt.updated_at, t.issue_number as n
      from notifications nt left join tasks t on t.id = nt.task_id
      where nt.resolved_at is null
      order by nt.created_at desc
      limit 30) x), '[]'::jsonb))`,

  jobs: `select coalesce(jsonb_agg(x order by x.id), '[]'::jsonb) from (
    select j.id, j.name, j.schedule, j.expect_every_minutes as every,
      (select jsonb_build_object('started_at', r.started_at, 'ended_at', r.ended_at, 'outcome', r.outcome, 'why', left(r.why, 400))
         from schedule_runs r where r.job = j.id order by r.started_at desc, r.id desc limit 1) as last_run,
      (select jsonb_build_object('started_at', r.started_at, 'ended_at', r.ended_at, 'outcome', r.outcome, 'why', left(r.why, 400))
         from schedule_runs r where r.job = j.id and r.outcome is not null order by r.ended_at desc, r.id desc limit 1) as last_finished,
      (select jsonb_build_object('started_at', r.started_at, 'ended_at', r.ended_at, 'outcome', r.outcome, 'why', left(r.why, 400))
         from schedule_runs r where r.job = j.id and r.outcome in ('ok', 'partial') order by r.ended_at desc, r.id desc limit 1) as last_success
    from scheduled_jobs j) x`,

  // in_use：路由两层里开着、它的模型又排进了某个用途（#574）。和 packages/db 的 routing-layers.ts 里 routesInUse 同一个判法
  // （探针只探这些、选路只派这些），那边改了这里跟着改。不读旧的阶段平铺表 stage_policy_routes；库里还没有两层那两张表
  // （没跑迁移 0025）这一块就报「库查询出错」，不拿旧表顶。
  routes: `select coalesce(jsonb_agg(x order by x.id), '[]'::jsonb) from (
    select ro.id, ro.pool_id as pool, ro.model_id as model, ro.host_id as host, ro.alive, ro.probe_state, ro.probed_at,
           left(ro.probe_detail, 400) as probe_detail, p.org_kind, ch.enabled as channel_enabled, ch.billing,
           exists (select 1 from routing_catalog rc join routing_purpose_models rpm on rpm.model_id = rc.model_id
                   where rc.route_id = ro.id and rc.enabled) as in_use
    from routes ro join pools p on p.id = ro.pool_id join channels ch on ch.id = ro.channel_id) x`,

  orgAudit: `select coalesce(jsonb_agg(x order by x.at desc), '[]'::jsonb) from (
    select a.at, a.action, a.ok, a.before ->> 'org' as from_org, a.after ->> 'org' as to_org, left(a.error, 400) as error
    from audit_log a
    where a.action in ('session-org.switch', 'session-org.verify')
    order by a.at desc
    limit 5) x`,

  repos: `select coalesce(jsonb_agg(x order by x.repo), '[]'::jsonb) from (
    select owner || '/' || name as repo, auto_dispatch_since from repos) x`,
};

/** @param {unknown} e */
const message = (e) => (e instanceof Error ? e.message : String(e));
/**
 * 抛出来的东西上的 code（ENOENT 这类）；不是带 code 的对象就是 undefined。
 * @param {unknown} e
 */
const errCode = (e) => (typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined);
/**
 * @param {unknown} text
 * @param {number} [n]
 */
const firstLines = (text, n = 3) =>
  String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, n)
    .join(' / ');

/**
 * 这条命令是不是 ALLOWED 里的某一条（一字不差）。是的话它一定非空（类型上跟着认）。
 * @param {readonly string[]} argv
 * @returns {argv is [string, ...string[]]}
 */
export function allowed(argv) {
  return ALLOWED.some((a) => a.length === argv.length && a.every((part, i) => argv[i] === part));
}

/**
 * 所有块的查询拼成一份 psql 脚本：一块一个记号，查错了在记号后面报 psql 读到的错，接着查下一块。
 * @param {Record<string, string>} [sql]
 */
export function psqlScript(sql = SQL) {
  const lines = ['\\set ON_ERROR_STOP off', '\\set VERBOSITY terse'];
  for (const [name, text] of Object.entries(sql)) {
    lines.push(
      `\\echo ${MARK} ${name}`,
      `${text};`,
      '\\if :ERROR',
      `\\echo ${ERR} :LAST_ERROR_MESSAGE`,
      '\\endif',
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 按记号切开 psql 的输出，每块解析成 JSON；没见到记号的块算没回。
 * @param {unknown} stdout
 * @param {string[]} names
 * @returns {Record<string, { ok: true, value: unknown } | { ok: false, why: string }>}
 */
export function parsePsql(stdout, names) {
  /** @type {Map<string, { lines: string[], error: string | null }>} */
  const raw = new Map();
  /** @type {{ lines: string[], error: string | null } | null} */
  let current = null;
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith(`${MARK} `)) {
      current = { lines: [], error: null };
      raw.set(line.slice(MARK.length + 1).trim(), current);
    } else if (current !== null && line.startsWith(`${ERR} `)) {
      current.error = line.slice(ERR.length + 1).trim() || '（没说为什么）';
    } else if (current !== null) {
      current.lines.push(line);
    }
  }
  /** @type {Record<string, { ok: true, value: unknown } | { ok: false, why: string }>} */
  const out = {};
  for (const name of names) {
    const got = raw.get(name);
    if (!got) {
      out[name] = { ok: false, why: '库那头没回这一块（psql 中途停了？）' };
      continue;
    }
    if (got.error !== null) {
      out[name] = { ok: false, why: `库查询出错：${got.error}` };
      continue;
    }
    const text = got.lines.join('\n').trim();
    if (text === '') {
      out[name] = { ok: false, why: '库什么都没回' };
      continue;
    }
    try {
      out[name] = { ok: true, value: JSON.parse(text) };
    } catch (e) {
      out[name] = { ok: false, why: `库回的不是 JSON（${message(e)}）` };
    }
  }
  return out;
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * @param {unknown} v
 * @returns {v is { rows: unknown[], count?: unknown }}
 */
const hasRows = (v) => isObj(v) && Array.isArray(v.rows);

/**
 * 库的几块：一次 psql 查完。连不上、起不来：每一块都报同一个原因。
 * @param {QueryIo} io
 * @returns {Record<string, QuerySection>}
 */
export function dbSections(io) {
  const names = Object.keys(SQL);
  const r = io.run(PSQL, psqlScript());
  const found = String(r.stdout ?? '').includes(MARK);
  if (r.error || (r.status !== 0 && !found)) {
    const why = r.error
      ? `起不了 psql（${r.error}）`
      : `连不上库（psql 退出码 ${r.status}）：${firstLines(r.stderr) || '没说为什么'}`;
    return Object.fromEntries(names.map((n) => [n, { ok: false, why }]));
  }
  const parsed = parsePsql(r.stdout, names);
  /**
   * @template T
   * @param {string} name
   * @param {(v: unknown) => v is T} check
   * @param {(v: T) => Record<string, unknown>} pick
   * @returns {QuerySection}
   */
  const shaped = (name, check, pick) => {
    const s = parsed[name];
    // parsePsql 给 names 里的每一块都回了一条；取不到只会是它出了岔子，说法同「库那头没回」
    if (!s) return { ok: false, why: '库那头没回这一块（psql 中途停了？）' };
    if (!s.ok) return s;
    return check(s.value) ? { ok: true, ...pick(s.value) } : { ok: false, why: '库回的形状不对' };
  };
  return {
    db: shaped('db', isObj, (v) => ({ now: v.now, readOnly: v.readOnly })),
    tasks: shaped('tasks', Array.isArray, (v) => ({ rows: v })),
    runs: shaped('runs', Array.isArray, (v) => ({ rows: v })),
    notifications: shaped('notifications', hasRows, (v) => ({ count: v.count, rows: v.rows })),
    jobs: shaped('jobs', Array.isArray, (v) => ({ rows: v })),
    routes: shaped('routes', Array.isArray, (v) => ({ rows: v })),
    orgAudit: shaped('orgAudit', Array.isArray, (v) => ({ rows: v })),
    repos: shaped('repos', Array.isArray, (v) => ({ rows: v })),
  };
}

/**
 * 几个服务在不在（systemctl is-active 一个服务一行）。
 * @param {QueryIo} io
 * @returns {QuerySection}
 */
export function servicesSection(io) {
  const r = io.run(SERVICES_ARGV);
  if (r.error) return { ok: false, why: `起不了 systemctl（${r.error}）` };
  const lines = String(r.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length !== UNITS.length)
    return {
      ok: false,
      why: `systemctl 回了 ${lines.length} 行，要 ${UNITS.length} 行：${firstLines(r.stderr) || firstLines(r.stdout) || '什么都没回'}`,
    };
  return {
    ok: true,
    units: UNITS.map((unit, i) => {
      const state = lines[i];
      // 行数刚核过和服务数相等，取不到不会发生；真发生了也别拿空顶，交给 collect 的 guard 报「这一块查的时候出错」
      if (state === undefined) throw new RangeError(`systemctl 的第 ${i + 1} 行取不到`);
      return { unit, state };
    }),
  };
}

/**
 * 在用的是哪一版：current 链接指的目录名就是提交号。
 * @param {QueryIo} io
 * @returns {QuerySection}
 */
export function currentSection(io) {
  /** @type {string} */
  let target;
  try {
    target = io.readlink(CURRENT_LINK);
  } catch (e) {
    return { ok: false, why: `读不了在用的版本（${CURRENT_LINK}：${errCode(e) ?? message(e)}）` };
  }
  const sha = String(target).split('/').filter(Boolean).at(-1) ?? '';
  if (!/^[0-9a-f]{40}$/.test(sha)) return { ok: false, why: `在用的版本认不出（链接指向的不是提交号）` };
  return { ok: true, sha: sha.slice(0, 12) };
}

/** @param {unknown} v */
const sha12 = (v) => (typeof v === 'string' ? v.slice(0, 12) : v);

/**
 * 自动发布的读数（deploy/france/auto-release/lib.mjs 每一轮写的状态文件）：只取要用的几样，提交号截成 12 位。
 * 这里只是搬运、不认形状：认不认得由本机那头（france-lib.mjs 的 autoReleaseProblem）核。
 * @param {QueryIo} io
 * @returns {QuerySection}
 */
export function autoReleaseSection(io) {
  /** @type {string} */
  let text;
  try {
    text = io.readFile(STATE_FILE);
  } catch (e) {
    return { ok: false, why: `自动发布的读数读不了（${STATE_FILE}：${errCode(e) ?? message(e)}）` };
  }
  /** @type {unknown} */
  let s;
  try {
    s = JSON.parse(text);
  } catch (e) {
    return { ok: false, why: `自动发布的读数不是 JSON（${message(e)}）` };
  }
  if (!isObj(s)) return { ok: false, why: '自动发布的读数认不出（不是一个对象）' };
  const rawMain = s.main;
  const main = isObj(rawMain)
    ? {
        head: sha12(rawMain.head),
        headAt: rawMain.headAt,
        checkedAt: rawMain.checkedAt,
        commits: Array.isArray(rawMain.commits)
          ? rawMain.commits
              .slice(0, COMMITS_KEEP)
              .map((/** @type {unknown} */ c) => (Array.isArray(c) ? [sha12(c[0]), c[1]] : c))
          : rawMain.commits,
      }
    : rawMain;
  const rawAttempt = s.attempt;
  const attempt = isObj(rawAttempt)
    ? {
        sha: sha12(rawAttempt.sha),
        startedAt: rawAttempt.startedAt,
        endedAt: rawAttempt.endedAt ?? null,
        result: rawAttempt.result,
        detail: rawAttempt.detail ?? '',
      }
    : rawAttempt;
  /**
   * @param {unknown} o
   * @param {string} key
   */
  const pickSha = (o, key) => (isObj(o) ? { ...o, [key]: sha12(o[key]) } : o);
  return {
    ok: true,
    state: {
      schema: s.schema,
      ranAt: s.ranAt,
      main,
      mainError: s.mainError ?? null,
      ci: pickSha(s.ci, 'sha'),
      hold: pickSha(s.hold, 'sha'),
      waitingSince: s.waitingSince ?? null,
      attempt,
      rules: pickSha(s.rules, 'commit'),
      system: pickSha(s.system, 'appliedSha'),
      last: s.last ?? null,
      // 配置对账（#323）：只带结论、不一致的是哪几项、没查成的原因；线上的值本来就不进状态文件
      config: isObj(s.config)
        ? {
            checkedAt: s.config.checkedAt,
            result: s.config.result,
            drift: Array.isArray(s.config.drift)
              ? s.config.drift.map((/** @type {unknown} */ d) => (isObj(d) ? d.id : d))
              : s.config.drift,
            unchecked: s.config.unchecked,
          }
        : null,
    },
  };
}

/**
 * 自动发布最近几轮的结论：日志里每轮一行「…这轮：…」。只留时刻和那一行的话（不带主机名、进程号）。
 * @param {QueryIo} io
 * @returns {QuerySection}
 */
export function roundsSection(io) {
  const r = io.run(ROUNDS_ARGV);
  if (r.error) return { ok: false, why: `起不了 journalctl（${r.error}）` };
  if (r.status !== 0)
    return { ok: false, why: `journalctl 退出码 ${r.status}：${firstLines(r.stderr) || '没说为什么'}` };
  /** @type {{ at: string, text: string }[]} */
  const rows = [];
  for (const line of String(r.stdout ?? '').split('\n')) {
    if (!line.includes('这轮：')) continue;
    const m = /^(\S+)\s+\S+\s+[^:]+:\s(.*)$/.exec(line);
    const at = m?.[1];
    const text = m?.[2];
    if (at !== undefined && text !== undefined) rows.push({ at, text: text.trim() });
  }
  return { ok: true, since: ROUNDS_SINCE, rows: rows.slice(-ROUNDS_KEEP) };
}

/**
 * 查一遍。io：{ now(), run(argv, input?), readFile(path), readlink(path) }；每一块出错都关在自己那一块里。
 * @param {QueryIo} io
 */
export function collect(io) {
  /** @param {(io: QueryIo) => QuerySection} fn */
  const guard = (fn) => {
    try {
      return fn(io);
    } catch (e) {
      return { ok: false, why: `这一块查的时候出错：${message(e)}` };
    }
  };
  /** @type {Record<string, QuerySection>} */
  let db;
  try {
    db = dbSections(io);
  } catch (e) {
    const why = `查库的时候出错：${message(e)}`;
    db = Object.fromEntries(Object.keys(SQL).map((n) => [n, { ok: false, why }]));
  }
  return {
    app: APP,
    schema: SCHEMA,
    at: io.now().toISOString(),
    sections: {
      ...db,
      services: guard(servicesSection),
      current: guard(currentSection),
      autoRelease: guard(autoReleaseSection),
      rounds: guard(roundsSection),
    },
  };
}

/**
 * 真的 io：命令不在 ALLOWED 里一律不起。
 * @returns {QueryIo}
 */
export function realIo() {
  return {
    now: () => new Date(),
    run(argv, input) {
      if (!allowed(argv))
        return {
          status: null,
          stdout: '',
          stderr: '',
          error: `不许起这条命令：${argv.slice(0, 3).join(' ')}`,
        };
      const r = spawnSync(argv[0], argv.slice(1), {
        ...(input === undefined ? {} : { input }),
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      return {
        status: r.status,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        error: r.error ? String(errCode(r.error) ?? r.error.message) : null,
      };
    },
    readFile: (path) => readFileSync(path, 'utf8'),
    readlink: (path) => readlinkSync(path),
  };
}

// 经 stdin 喂给 node 时 argv[1] 是「-」；测试里按文件加载这份模块时不跑。
if (process.argv[1] === '-' && process.argv.includes('--collect')) {
  process.stdout.write(`${JSON.stringify(collect(realIo()))}\n`);
}
