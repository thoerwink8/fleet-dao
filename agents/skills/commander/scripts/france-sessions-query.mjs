// 法国现在有几个会话在跑（#618，发版前「等收尾」那一步要的数）：在法国上跑的只读查询。本机经 ssh 把这份文件喂给法国的 node：
//   ssh <法国> node --input-type=module - --sessions < france-sessions-query.mjs
// 数的是库里 session_runs 中 ended_at 为空的（引擎起了、还没收尾的会话），打一行 JSON 到标准输出。
// 改这里之前必须知道：
// - 只许读。库经 psql 连，连接参数把会话设成只读（和 france-query.mjs 的 PSQL 一字不差，agents/test/release-train.test.ts 核对）。
// - 这份文件是单独喂给 node 的，不能 import 同目录的别的文件，所以 psql 那几项在这里写一遍。
// - 读不到就是读不到：psql 没起来、连不上、回来的认不出，一律 { ok: false, why }，退出码非 0；不拿 0 顶。
import { spawnSync } from 'node:child_process';

export const APP = 'fleet-france-sessions';
export const SCHEMA = 1;

/** 以库的属主身份、本地连接认身份；连接参数把整个会话设成只读（同 france-query.mjs 的 PSQL）。 */
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

/** 一条 select：没收尾的会话数，和最久的几个是谁的（单、环节、什么时候排的队），给「拖后腿」的名单用。 */
export const SQL = `select jsonb_build_object(
  'running', (select count(*) from session_runs where ended_at is null),
  'rows', coalesce((select jsonb_agg(x order by x.queued_at) from (
    select rp.owner || '/' || rp.name as repo, t.issue_number as n, s.stage, s.queued_at, s.started_at
    from session_runs s
    left join tasks t on t.id = s.task_id
    left join repos rp on rp.id = t.repo_id
    where s.ended_at is null
    order by s.queued_at
    limit 20) x), '[]'::jsonb));`;

/** @param {unknown} e */
const message = (e) => (e instanceof Error ? e.message : String(e));

/**
 * 查一遍。run(argv, input) 回 { status, stdout, stderr, error }；真的在 realRun，测试里换成假的。
 * @param {(argv: readonly string[], input: string) => { status: number | null, stdout: string, stderr: string, error: string | null }} run
 * @param {() => Date} [now]
 */
export function collect(run, now = () => new Date()) {
  const at = now().toISOString();
  const r = run(PSQL, `\\set ON_ERROR_STOP on\n${SQL}\n`);
  if (r.error) return { app: APP, schema: SCHEMA, at, ok: false, why: `起不了 psql（${r.error}）` };
  if (r.status !== 0)
    return {
      app: APP,
      schema: SCHEMA,
      at,
      ok: false,
      why: `查库没成（psql 退出码 ${r.status}）：${
        String(r.stderr ?? '')
          .trim()
          .split('\n')[0] || '没说为什么'
      }`,
    };
  try {
    const v = JSON.parse(String(r.stdout ?? '').trim());
    if (
      typeof v !== 'object' ||
      v === null ||
      !Number.isInteger(v.running) ||
      v.running < 0 ||
      !Array.isArray(v.rows)
    )
      return {
        app: APP,
        schema: SCHEMA,
        at,
        ok: false,
        why: '库回的形状不对（要 running 整数和 rows 列表）',
      };
    return { app: APP, schema: SCHEMA, at, ok: true, running: v.running, rows: v.rows };
  } catch (e) {
    return { app: APP, schema: SCHEMA, at, ok: false, why: `库回的不是 JSON（${message(e)}）` };
  }
}

/** 真的起 psql：命令必须就是 PSQL 那一条，别的一律不起。 */
export function realRun(/** @type {readonly string[]} */ argv, /** @type {string} */ input) {
  if (argv.length !== PSQL.length || !PSQL.every((part, i) => argv[i] === part))
    return { status: null, stdout: '', stderr: '', error: '不许起这条命令' };
  const [command = '', ...args] = argv;
  const r = spawnSync(command, args, {
    input,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error ? r.error.message : null,
  };
}

// 经 stdin 喂给 node 时 argv[1] 是「-」；测试里按文件加载这份模块时不跑。
if (process.argv[1] === '-' && process.argv.includes('--sessions')) {
  const result = collect(realRun);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) {
    process.stderr.write(`${result.why}\n`); // 本机那头只看得到退出码和标准错误
    process.exitCode = 1;
  }
}
