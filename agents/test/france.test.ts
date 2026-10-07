// 法国引擎页（#328）：在法国跑的只读查询（france-query.mjs）、本机这头的读、认、判、缓存和页面服务（france-lib.mjs，
// 外壳 server.mjs）、命令行 france.mjs。不连法国：ssh 换成本机的 node（跑同一份查询脚本，或假的输出），库、systemctl 换成假的 io。
// 每一种「没读到」各有一条故意造出来的失败：没配 ssh 名字、ssh 连不上、超时、法国上脚本没跑成、库查询出错、库连不上、
// 读数文件读不了或认不出、回来的不是 JSON、形状不对。
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPTS = fileURLToPath(new URL('../skills/commander/scripts/', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const QUERY_FILE = join(SCRIPTS, 'france-query.mjs');
// 按网址动态加载：.mjs 脚本和 shared 的 .ts 都不进 agents 的类型工程（composite 工程不许引工程外的文件）
const load = async (file: string) => import(pathToFileURL(file).href);

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}
interface QueryIo {
  now(): Date;
  run(argv: string[], input?: string): RunResult;
  readFile(path: string): string;
  readlink(path: string): string;
}
type RawSection = { ok: boolean; why?: string; [k: string]: unknown };
interface Snapshot {
  app: string;
  schema: number;
  at: string;
  sections: Record<string, RawSection>;
}
interface QueryLib {
  APP: string;
  SCHEMA: number;
  PSQL: string[];
  SERVICES_ARGV: string[];
  ROUNDS_ARGV: string[];
  ALLOWED: string[][];
  SQL: Record<string, string>;
  UNITS: string[];
  MARK: string;
  ERR: string;
  STATE_FILE: string;
  CURRENT_LINK: string;
  allowed(argv: string[]): boolean;
  psqlScript(sql?: Record<string, string>): string;
  parsePsql(stdout: string, names: string[]): Record<string, { ok: boolean; why?: string; value?: unknown }>;
  collect(io: QueryIo): Snapshot;
  realIo(): QueryIo;
}
interface Anomaly {
  level: 'bad' | 'unread' | 'note';
  what: string;
  where: string;
}
interface Totals {
  runs: number;
  running: number;
  inputEquivalent: number;
  missingEquivalent: number;
  costUsd: number;
  missingCost: number;
  queueMs: number;
  runMs: number;
  [k: string]: unknown;
}
interface Usage {
  total: Totals;
  byModel: (Totals & { model: string; modelName: string })[];
  byStage: (Totals & { stage: string })[];
}
interface TaskView {
  key: string;
  n: number;
  state: string;
  openRuns: number;
  usage: Usage | null;
  runs: { stage: string; queueMs: number; runMs: number; inputEquivalent: number | null }[] | null;
  runsWhy: string | null;
}
interface View {
  at: string;
  anomalies: Anomaly[];
  counts: { bad: number; unread: number; note: number };
  tasks: { ok: boolean; why?: string; active: TaskView[]; queued: TaskView[]; finished: TaskView[] };
  usage24h: {
    ok: boolean;
    why?: string;
    total: Totals;
    byStage: Totals[];
    byModel: Totals[];
    failed: number;
  };
  health: Record<string, { ok: boolean; why?: string; [k: string]: unknown }>;
}
type Failure = { ok: false; kind: string; why: string };
type Parsed = { ok: true; data: { at: string; sections: Record<string, RawSection> } } | Failure;
interface SourceState {
  refreshMs: number;
  loading: { since: string } | null;
  lastTry: { ok: boolean; kind?: string; why?: string; tookMs: number } | null;
  good: { fetchedAt: string; tookMs: number; view: View } | null;
}
interface FranceSource {
  htmlFile: string | null;
  read(): SourceState;
  refresh(): Promise<void>;
}
interface FranceLib {
  ENV_NAME: string;
  LIMITS: Record<string, number>;
  probeStaleMinutes(host: string): number;
  scrubText(text: string): string;
  scrubDeep(value: unknown): unknown;
  readTarget(opts: {
    env: Record<string, string | undefined>;
    home: string;
    readText: (file: string) => string;
  }): { ok: true; host: string } | Failure;
  sshArgs(host: string): string[];
  runRemote(opts: {
    command: string;
    args: string[];
    script: string;
    timeoutMs?: number;
    maxBytes?: number;
  }): Promise<{ ok: true; stdout: string } | Failure>;
  parseSnapshot(text: string): Parsed;
  summarizeUsage(runs: unknown[]): Usage;
  mountedOrg(
    routes: unknown[],
    audits: unknown[],
  ): { ok: boolean; org?: string; name?: string; why?: string; at?: string };
  jobStatus(job: unknown, at: string): string;
  buildView(data: { at: string; sections: Record<string, RawSection> }): View;
  franceFetcher(opts: {
    home: string;
    env: Record<string, string | undefined>;
    scriptFile: string;
    command?: string;
    argsFor?: (host: string) => string[];
    timeoutMs?: number;
  }): () => Promise<Parsed>;
  createFranceSource(opts: {
    fetchOnce: () => Promise<Parsed>;
    now?: () => Date;
    refreshMs?: number;
    htmlFile?: string;
  }): FranceSource;
  DEFAULT_PORT: number;
  APP_ID: string;
  createFranceServer(opts: { france: FranceSource }): Server;
  parsePort(argv: string[], env: Record<string, string | undefined>): number | string;
  isOurs(port: number): Promise<boolean>;
  startFranceServer(opts: {
    port: number;
    france: FranceSource;
    out: (text: string) => void;
    err: (text: string) => void;
  }): Promise<{ code: number; server?: Server; port?: number }>;
}

const query = (await load(QUERY_FILE)) as QueryLib;
const lib = (await load(join(SCRIPTS, 'france-lib.mjs'))) as FranceLib;
// 驾驶舱那边的算法：页面上的额度、探针过期线要和它一样
const sharedUsage = (await load(join(ROOT, 'packages/shared/src/usage.ts'))) as {
  summarizeUsage(runs: Record<string, unknown>[]): Usage;
};
const sharedWebApi = (await load(join(ROOT, 'packages/shared/src/web-api.ts'))) as {
  routeProbeStaleMinutes(host: string): number;
};

const made: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'france-'));
  made.push(dir);
  return dir;
}

// —— 造一份法国回来的快照：默认什么毛病都没有 ——

const AT = '2026-09-27T14:00:00.000Z';
const ago = (min: number) => new Date(Date.parse(AT) - min * 60_000).toISOString();
const SHA = 'aaaaaaaaaaaa';

function run(o: {
  n?: number | null;
  stage: string;
  queued: number;
  started?: number | null;
  ended?: number | null;
  route?: string;
  model?: string;
  modelName?: string;
  host?: string;
  billing?: string;
  input?: number | null;
  output?: number | null;
  read?: number | null;
  write?: number | null;
  cost?: number | null;
  outcome?: string | null;
  code?: string | null;
  message?: string | null;
}) {
  const ended = o.ended === undefined ? o.queued - 5 : o.ended;
  return {
    repo: o.n === null ? null : 'o/fleet-dao',
    n: o.n === undefined ? 12 : o.n,
    stage: o.stage,
    route_id: o.route ?? 'claude-carpool:opus-5.5:claude-code',
    model: o.model ?? 'opus-5.5',
    model_name: o.modelName ?? 'Opus 5.5',
    host: o.host ?? 'claude-code',
    pool: 'claude-carpool',
    billing: o.billing ?? 'subscription',
    actual_model: 'claude-opus-5-5',
    queued_at: ago(o.queued),
    started_at: o.started === null ? null : ago(o.started ?? o.queued - 0.02),
    ended_at: ended === null ? null : ago(ended),
    queue_ms: null,
    run_ms: null,
    input_tokens: o.input === undefined ? 10 : o.input,
    output_tokens: o.output === undefined ? 1000 : o.output,
    cache_read_tokens: o.read === undefined ? 50_000 : o.read,
    cache_write_tokens: o.write === undefined ? 2000 : o.write,
    cost_usd: o.cost === undefined ? 0.4 : o.cost,
    session_cost_usd: null,
    outcome: ended === null ? null : (o.outcome ?? 'ok'),
    failure_code: o.code ?? null,
    failure_message: o.message ?? null,
    subtask_index: null,
    subtask_title: null,
  };
}
function job(id: string, every: number, last: { start: number; end: number | null; outcome: string | null }) {
  const fact = {
    started_at: ago(last.start),
    ended_at: last.end === null ? null : ago(last.end),
    outcome: last.outcome,
    why: null,
  };
  const finished = last.outcome === null ? null : fact;
  return {
    id,
    name: `任务 ${id}`,
    schedule: '每 15 分钟',
    every,
    last_run: fact,
    last_finished: finished,
    last_success: last.outcome === 'ok' || last.outcome === 'partial' ? fact : null,
  };
}
function route(o: {
  id: string;
  host?: string;
  alive?: boolean;
  state?: string | null;
  probed?: number | null;
  detail?: string;
  org?: string | null;
  inUse?: boolean;
}) {
  return {
    id: o.id,
    pool: o.id.split(':')[0],
    model: o.id.split(':')[1],
    host: o.host ?? 'claude-code',
    alive: o.alive ?? true,
    probe_state: o.state === undefined ? 'ok' : o.state,
    probed_at: o.probed === null ? null : ago(o.probed ?? 5),
    probe_detail: o.detail ?? '回答了',
    org_kind: o.org ?? null,
    channel_enabled: true,
    billing: 'subscription',
    in_use: o.inUse ?? true,
  };
}
function healthy(): Snapshot {
  return {
    app: 'fleet-france-query',
    schema: 1,
    at: AT,
    sections: {
      db: { ok: true, now: AT, readOnly: 'on' },
      tasks: {
        ok: true,
        rows: [
          {
            repo: 'o/fleet-dao',
            n: 12,
            title: '写一个功能',
            state: 'running',
            phase: 'fusion:execute',
            doing: '写码',
            last_problem: null,
            created_at: ago(30),
            updated_at: ago(2),
          },
          {
            repo: 'o/fleet-dao',
            n: 13,
            title: '排着的',
            state: 'queued',
            phase: null,
            doing: null,
            last_problem: null,
            created_at: ago(10),
            updated_at: null,
          },
          {
            repo: 'o/fleet-dao',
            n: 11,
            title: '做完的',
            state: 'done',
            phase: 'fusion:done',
            doing: '做完了',
            last_problem: null,
            created_at: ago(300),
            updated_at: ago(100),
          },
        ],
      },
      runs: {
        ok: true,
        rows: [
          run({ n: 11, stage: 'plan', queued: 290 }),
          run({ n: 12, stage: 'plan', queued: 28, cost: 0.5 }),
          run({
            n: 12,
            stage: 'execute',
            queued: 19,
            ended: null,
            route: 'grok:grok-4.7:grok',
            model: 'grok-4.7',
            modelName: 'Grok 4.7',
            host: 'grok',
            input: null,
            output: null,
            read: null,
            write: null,
            cost: null,
          }),
        ],
      },
      notifications: { ok: true, count: 0, rows: [] },
      jobs: { ok: true, rows: [job('route-probe', 45, { start: 5, end: 4, outcome: 'ok' })] },
      routes: {
        ok: true,
        rows: [
          route({ id: 'claude-carpool:opus-5.5:claude-code', org: 'carpool' }),
          route({
            id: 'claude-solo:opus-5.5:claude-code',
            org: 'solo',
            alive: false,
            state: 'skipped',
            detail: '会话用户现在挂的是拼车组织：这时探独享池，扣的是拼车的额度、探的也是拼车，不探',
          }),
          route({ id: 'grok:grok-4.7:grok', host: 'grok', probed: 100 }),
        ],
      },
      orgAudit: { ok: true, rows: [] },
      repos: { ok: true, rows: [{ repo: 'o/fleet-dao', auto_dispatch_since: ago(1000) }] },
      services: { ok: true, units: query.UNITS.map((unit) => ({ unit, state: 'active' })) },
      current: { ok: true, sha: SHA },
      autoRelease: {
        ok: true,
        state: {
          schema: 1,
          ranAt: ago(3),
          main: {
            head: SHA,
            headAt: ago(60),
            checkedAt: ago(3),
            commits: [
              [SHA, ago(60)],
              ['bbbbbbbbbbbb', ago(120)],
            ],
          },
          mainError: null,
          ci: { sha: SHA, verdict: 'green', detail: 'CI 全绿', checkedAt: ago(3) },
          hold: null,
          waitingSince: null,
          attempt: { sha: SHA, startedAt: ago(58), endedAt: ago(55), result: 'ok', detail: '' },
          rules: { commit: SHA, at: ago(55), result: 'ok', detail: '' },
          system: { appliedSha: 'cccccccccccc', behind: 0, oldestAt: null },
          last: { action: 'up-to-date', detail: '', at: ago(3) },
        },
      },
      rounds: {
        ok: true,
        since: '-6h',
        rows: [{ at: ago(3), text: `主线头 ${SHA}，CI green；在用 ${SHA}，跟上了；这轮：up-to-date` }],
      },
    },
  };
}
type Sections = Snapshot['sections'];
function parsed(raw: Snapshot) {
  const r = lib.parseSnapshot(JSON.stringify(raw));
  if (!r.ok) throw new Error(r.why);
  return r.data;
}
function viewOf(change?: (s: Sections) => void): View {
  const raw = healthy();
  change?.(raw.sections);
  return lib.buildView(parsed(raw));
}
const serious = (v: View) => v.anomalies.filter((a) => a.level !== 'note');
const whats = (v: View, level?: Anomaly['level']) =>
  v.anomalies.filter((a) => !level || a.level === level).map((a) => a.what);
const rows = (s: RawSection) => s.rows as Record<string, unknown>[];
const state = (s: Sections) => s.autoRelease?.state as Record<string, unknown>;

// —— 在法国跑的查询脚本：只读 ——

/** 去掉注释再扫（注释里写「不许写库」这类字不算）。 */
const codeOf = (file: string) =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

/** 每条 SQL 哪里不是「只读的一条 select」：不以 select 开头、带分号（多条）、有写库改结构锁表开事务设参数的字、调函数动文件。 */
function sqlProblems(sql: Record<string, string>): string[] {
  const banned =
    /\b(insert|update|delete|merge|upsert|drop|alter|truncate|create|grant|revoke|copy|vacuum|analyze|reindex|cluster|lock|call|do|refresh|comment|security|execute|prepare|deallocate|notify|listen|unlisten|into|share|nextval|setval|set|reset|begin|start|commit|rollback|savepoint|discard|checkpoint|load)\b/i;
  const out: string[] = [];
  for (const [name, text] of Object.entries(sql)) {
    if (!text.trimStart().toLowerCase().startsWith('select')) out.push(`${name}：不以 select 开头`);
    if (text.includes(';')) out.push(`${name}：带分号`);
    const word = banned.exec(text)?.[0];
    if (word) out.push(`${name}：${word}`);
    const fn = /\b(pg_\w+|lo_\w+|dblink\w*)\s*\(/i.exec(text)?.[0];
    if (fn) out.push(`${name}：${fn}`);
  }
  return out;
}

/** 脚本代码（去掉注释）里写文件、删文件、起 shell、读密钥目录、停机的写法。 */
function codeProblems(code: string): string[] {
  return [
    /writeFile|appendFile|createWriteStream|\bwriteSync\b|\bopenSync\b/,
    /\brmSync\b|\brm\(|\bunlink|\brename|\bmkdir|\bcopyFile|\bcpSync\b|\bchmod|\bchown|\bsymlink|\btruncate|\butimes/,
    // 正则的 .exec( 不算：只拦 child_process 的 exec、execSync、execFile、fork、spawn
    /shell:\s*true|\bexecSync\b|(?<![.\w])exec\(|\bexecFile|\bfork\(|\bspawn\(/,
    /\/etc\/fleet-dao/,
    /\b(kill|reboot|shutdown|poweroff)\b/,
  ].flatMap((re) => {
    const hit = re.exec(code)?.[0];
    return hit ? [hit] : [];
  });
}

describe('只读：法国上的查询脚本不许写库、改文件、起停服务', () => {
  it('每条 SQL 都只是一条 select：没有写库、改结构、锁表、开事务、设参数的字', () => {
    expect(Object.keys(query.SQL).length).toBeGreaterThan(5);
    expect(sqlProblems(query.SQL)).toEqual([]);
  });

  it('会话那一块两处都读：session_runs（老 Fusion）和 runs（任务工作流的动手、验收），只读前者会误报「手上没有会话」', () => {
    expect(query.SQL.runs).toMatch(/from session_runs s/);
    expect(query.SQL.runs).toMatch(/from runs r/);
    expect(query.SQL.tasks).toMatch(/from runs r where r\.task_id = t\.id/);
  });

  it('这两道检查真拦得住：往 SQL 里加一句改库、往脚本里加写文件和起 shell，都被认出来', () => {
    expect(
      sqlProblems({
        a: 'select 1; update tasks set state = 1',
        b: 'delete from tasks',
        c: 'select pg_terminate_backend(1)',
      }),
    ).toEqual(['a：带分号', 'a：update', 'b：不以 select 开头', 'b：delete', 'c：pg_terminate_backend(']);
    expect(
      codeProblems("writeFileSync('/srv/x', ''); execSync('systemctl restart fleet-engine'); /x/.exec(s);"),
    ).toEqual(['writeFile', 'execSync']);
  });

  it('psql 脚本里除了这几条 select，只有记号、报错、分块用的几条 psql 自己的命令', () => {
    const script = query.psqlScript();
    const meta = script.split('\n').filter((l) => l.startsWith('\\'));
    for (const line of meta) {
      expect(
        /^\\(set ON_ERROR_STOP off|set VERBOSITY terse|echo @@fleet-(section \w+|error :LAST_ERROR_MESSAGE)|if :ERROR|endif)$/.test(
          line,
        ),
        line,
      ).toBe(true);
    }
    const sqlPart = script
      .split('\n')
      .filter((l) => !l.startsWith('\\'))
      .join('\n');
    expect(sqlPart.trim()).toBe(
      Object.values(query.SQL)
        .map((s) => `${s};`)
        .join('\n'),
    );
  });

  it('连库时就把会话设成只读；能起的命令只有三条，一字不差才起（前缀对上也不行）', () => {
    expect(query.PSQL.slice(0, 5)).toEqual(['sudo', '-n', '-u', 'fleet', 'psql']);
    expect(query.PSQL).toContain("dbname=fleet options='-c default_transaction_read_only=on'");
    expect(query.PSQL).toContain('-X');
    expect(query.ALLOWED).toEqual([query.PSQL, query.SERVICES_ARGV, query.ROUNDS_ARGV]);
    expect(query.SERVICES_ARGV.slice(0, 2)).toEqual(['systemctl', 'is-active']);
    expect(query.ROUNDS_ARGV[0]).toBe('journalctl');
    expect(query.ROUNDS_ARGV.filter((a) => a.startsWith('--'))).toEqual(['--since', '--no-pager']);
    for (const bad of [
      ['systemctl', 'restart', 'fleet-engine'],
      [...query.ROUNDS_ARGV, '--rotate'],
      ['journalctl', '--vacuum-size=1M'],
      ['sudo', '-n', '-u', 'root', 'psql'],
      [...query.PSQL.slice(0, -2), '-c', 'drop table tasks'],
      ['rm', '-rf', '/srv/fleet-dao-releases'],
    ]) {
      expect(query.allowed(bad), bad.join(' ')).toBe(false);
      expect(query.realIo().run(bad).error, bad.join(' ')).toContain('不许起这条命令');
    }
    for (const ok of query.ALLOWED) expect(query.allowed(ok)).toBe(true);
  });

  it('脚本里没有写文件、删文件、起 shell、读 /etc/fleet-dao 的写法', () => {
    const code = codeOf(QUERY_FILE);
    expect(codeProblems(code)).toEqual([]);
    // 起命令只有 realIo 里那一处 spawnSync，而且它先查 allowed
    expect(code.match(/spawnSync\(/g)).toHaveLength(1);
    expect(code).toMatch(/if \(!allowed\(argv\)\)\s*return/);
  });

  it('查一遍起的命令全在名单里，库只连一次', () => {
    const calls: string[][] = [];
    const io = fakeIo({ onRun: (argv) => calls.push(argv) });
    query.collect(io);
    expect(calls.length).toBe(3);
    for (const argv of calls) expect(query.allowed(argv), argv.join(' ')).toBe(true);
    expect(calls.filter((a) => a[4] === 'psql')).toHaveLength(1);
  });
});

// —— 在法国跑的查询脚本：每一块各查各的 ——

/** 假的法国：psql 按记号回每一块，systemctl、journalctl、文件各给一份。 */
function fakeIo(
  o: {
    psql?: (script: string) => RunResult;
    services?: RunResult;
    rounds?: RunResult;
    state?: () => string;
    link?: () => string;
    onRun?: (argv: string[]) => void;
  } = {},
): QueryIo {
  const psqlOk = (script: string): RunResult => {
    const names = [...script.matchAll(/^\\echo @@fleet-section (\w+)$/gm)].map((m) => m[1] ?? '');
    const value: Record<string, unknown> = {
      db: { now: AT, readOnly: 'on' },
      notifications: { count: 0, rows: [] },
    };
    const out = names.map((n) => `${query.MARK} ${n}\n${JSON.stringify(value[n] ?? [])}`).join('\n');
    return { status: 0, stdout: `${out}\n`, stderr: '', error: null };
  };
  return {
    now: () => new Date(AT),
    run(argv, input) {
      o.onRun?.(argv);
      if (argv[4] === 'psql') return (o.psql ?? psqlOk)(input ?? '');
      if (argv[0] === 'systemctl')
        return (
          o.services ?? { status: 0, stdout: 'active\nactive\nactive\nactive\n', stderr: '', error: null }
        );
      if (argv[0] === 'journalctl')
        return (
          o.rounds ?? {
            status: 0,
            stdout: [
              `2026-09-27T21:53:50+08:00 vmi0000000 node[123]: 主线头 ${SHA}，CI pending；这轮：ci-pending（CI 在跑）`,
              '2026-09-27T21:53:50+08:00 vmi0000000 systemd[1]: fleet-auto-release.service: Deactivated successfully.',
              `2026-09-27T21:58:50+08:00 vmi0000000 node[124]: 主线头 ${SHA}，CI green；这轮：up-to-date`,
            ].join('\n'),
            stderr: '',
            error: null,
          }
        );
      throw new Error(`没料到的命令 ${argv.join(' ')}`);
    },
    readFile: (path) => {
      if (path !== query.STATE_FILE) throw new Error(`没料到的文件 ${path}`);
      return o.state ? o.state() : JSON.stringify(state(healthy().sections));
    },
    readlink: (path) => {
      if (path !== query.CURRENT_LINK) throw new Error(`没料到的链接 ${path}`);
      return o.link ? o.link() : `/srv/fleet-dao-releases/${SHA}${'0'.repeat(28)}`;
    },
  };
}

describe('查询脚本：每一块查成就给数，查不成就写原因，一块坏了不连累别的', () => {
  it('都查成：每一块 ok，日志只留「这轮」那几行、不带主机名和进程号', () => {
    const snap = query.collect(fakeIo());
    expect(snap).toMatchObject({ app: query.APP, schema: query.SCHEMA, at: AT });
    for (const [name, s] of Object.entries(snap.sections)) expect(s.ok, `${name}：${s.why ?? ''}`).toBe(true);
    expect(snap.sections.current).toEqual({ ok: true, sha: SHA });
    expect(snap.sections.rounds?.rows).toEqual([
      { at: '2026-09-27T21:53:50+08:00', text: `主线头 ${SHA}，CI pending；这轮：ci-pending（CI 在跑）` },
      { at: '2026-09-27T21:58:50+08:00', text: `主线头 ${SHA}，CI green；这轮：up-to-date` },
    ]);
    expect(JSON.stringify(snap)).not.toContain('vmi0000000');
    expect(query.parsePsql('', ['db']).db).toEqual({ ok: false, why: '库那头没回这一块（psql 中途停了？）' });
  });

  it('库查询出错：只有出错的那一块写「库查询出错」和 psql 的原话，别的块照样有数', () => {
    const io = fakeIo({
      psql: (script) => {
        const names = [...script.matchAll(/^\\echo @@fleet-section (\w+)$/gm)].map((m) => m[1] ?? '');
        const out = names.map((n) =>
          n === 'runs'
            ? `${query.MARK} runs\n${query.ERR} column s.nope does not exist`
            : `${query.MARK} ${n}\n${n === 'db' ? JSON.stringify({ now: AT, readOnly: 'on' }) : n === 'notifications' ? '{"count":0,"rows":[]}' : '[]'}`,
        );
        return { status: 0, stdout: out.join('\n'), stderr: 'psql:<stdin>:9: ERROR: …', error: null };
      },
    });
    const s = query.collect(io).sections;
    expect(s.runs).toEqual({ ok: false, why: '库查询出错：column s.nope does not exist' });
    expect(s.tasks).toEqual({ ok: true, rows: [] });
    expect(s.db?.ok).toBe(true);
  });

  it('库回的不是 JSON、什么都没回：那一块明说', () => {
    const out = query.parsePsql(`${query.MARK} tasks\n{写坏了\n${query.MARK} runs\n`, ['tasks', 'runs']);
    expect(out.tasks?.ok).toBe(false);
    expect(out.tasks?.why).toContain('库回的不是 JSON');
    expect(out.runs).toEqual({ ok: false, why: '库什么都没回' });
  });

  it('连不上库（psql 退出码 2、没有记号）：库的每一块都写同一个原因，别的块照查', () => {
    const io = fakeIo({
      psql: () => ({
        status: 2,
        stdout: '',
        stderr:
          'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory',
        error: null,
      }),
    });
    const s = query.collect(io).sections;
    for (const name of Object.keys(query.SQL)) {
      expect(s[name]?.ok, name).toBe(false);
      expect(s[name]?.why, name).toContain('连不上库（psql 退出码 2）');
    }
    expect(s.services?.ok).toBe(true);
    expect(s.autoRelease?.ok).toBe(true);
  });

  it('起不了 psql（sudo 不在）：库的每一块写「起不了 psql」', () => {
    const s = query.collect(
      fakeIo({ psql: () => ({ status: null, stdout: '', stderr: '', error: 'ENOENT' }) }),
    ).sections;
    expect(s.tasks).toEqual({ ok: false, why: '起不了 psql（ENOENT）' });
  });

  it('读数文件读不了、不是 JSON：自动发布那一块写原因', () => {
    const missing = query.collect(
      fakeIo({
        state: () => {
          throw Object.assign(new Error('no'), { code: 'ENOENT' });
        },
      }),
    ).sections.autoRelease;
    expect(missing?.ok).toBe(false);
    expect(missing?.why).toContain('自动发布的读数读不了');
    expect(missing?.why).toContain('ENOENT');
    const broken = query.collect(fakeIo({ state: () => '{写坏了' })).sections.autoRelease;
    expect(broken?.ok).toBe(false);
    expect(broken?.why).toContain('自动发布的读数不是 JSON');
    const notObject = query.collect(fakeIo({ state: () => '[1,2]' })).sections.autoRelease;
    expect(notObject).toEqual({ ok: false, why: '自动发布的读数认不出（不是一个对象）' });
  });

  it('配置对账（#323）：只带结论和不一致的是哪几项（名字），不带别的', () => {
    const withConfig = {
      ...state(healthy().sections),
      config: {
        checkedAt: ago(3),
        commit: SHA,
        result: 'drift',
        drift: [{ id: 'engine.env:FLEET_X', kind: 'value' }],
        unchecked: [],
        selfHeal: false,
      },
    };
    const s = query.collect(fakeIo({ state: () => JSON.stringify(withConfig) })).sections;
    expect(state(s).config).toEqual({
      checkedAt: ago(3),
      result: 'drift',
      drift: ['engine.env:FLEET_X'],
      unchecked: [],
    });
  });

  it('失败记录被更新的版本取代（supersededBy）：原样带回来，本机才知道旧失败已过期（#1157）', () => {
    const superseded = {
      ...state(healthy().sections),
      attempt: {
        sha: 'dddddddddddddddddddddddddddddddddddddddd',
        startedAt: ago(900),
        endedAt: ago(899),
        result: 'failed',
        detail: '旧的',
        supersededBy: { sha: `${SHA}ffff`, at: ago(2) },
      },
    };
    const s = query.collect(fakeIo({ state: () => JSON.stringify(superseded) })).sections;
    expect(state(s).attempt).toMatchObject({
      sha: 'dddddddddddd',
      result: 'failed',
      supersededBy: { sha: SHA.slice(0, 12), at: ago(2) },
    });
  });

  it('【故意造出的失败】自动发布单元不发版以后（#1258）写的状态里没有 hold、waitingSince、attempt：照样认得，版本块有数；老状态带着这三项也认得', () => {
    const slim = healthy();
    const st = state(slim.sections);
    for (const k of ['hold', 'waitingSince', 'attempt']) delete st[k];
    expect(lib.parseSnapshot(JSON.stringify(slim)).ok).toBe(true);
    expect(lib.buildView(parsed(slim)).health.release).toMatchObject({
      ok: true,
      current: SHA,
      behind: 0,
      hold: null,
      waitingSince: null,
      attempt: null,
    });
    // 老状态（带着这三项）：和以前一样
    expect(lib.parseSnapshot(JSON.stringify(healthy())).ok).toBe(true);
    // 三项里有认不出的（不是 undefined、null）照样挡
    st.waitingSince = '不是时间';
    expect(lib.buildView(parsed(slim)).health.release).toMatchObject({ ok: false });
  });

  it('在用的版本：链接读不了、指的不是提交号，都明说', () => {
    const gone = query.collect(
      fakeIo({
        link: () => {
          throw Object.assign(new Error('no'), { code: 'ENOENT' });
        },
      }),
    ).sections.current;
    expect(gone?.ok).toBe(false);
    expect(gone?.why).toContain('读不了在用的版本');
    const odd = query.collect(fakeIo({ link: () => '/srv/fleet-dao-releases/latest' })).sections.current;
    expect(odd).toEqual({ ok: false, why: '在用的版本认不出（链接指向的不是提交号）' });
  });

  it('systemctl 回的行数不对、journalctl 没跑成：那一块写原因', () => {
    const s = query.collect(
      fakeIo({
        services: { status: 1, stdout: 'active\n', stderr: 'Failed to connect to bus', error: null },
        rounds: { status: 1, stdout: '', stderr: 'No journal files were found.', error: null },
      }),
    ).sections;
    expect(s.services?.ok).toBe(false);
    expect(s.services?.why).toContain('systemctl 回了 1 行，要 4 行');
    expect(s.rounds).toEqual({ ok: false, why: 'journalctl 退出码 1：No journal files were found.' });
  });

  it('一块查的时候抛了：只关在那一块里', () => {
    const io = fakeIo();
    const s = query.collect({
      ...io,
      readlink: () => {
        throw new Error('炸了');
      },
    }).sections;
    expect(s.current?.ok).toBe(false);
    expect(s.tasks?.ok).toBe(true);
  });

  it('当真经 node 的标准输入跑（和 ssh 过去一样）：这台机器上没有法国的库和服务，照样打出一份认得出的 JSON，每一块有结论', () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-', '--collect'], {
      input: readFileSync(QUERY_FILE, 'utf8'),
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const p = lib.parseSnapshot(r.stdout);
    expect(p.ok, p.ok ? '' : p.why).toBe(true);
    if (!p.ok) return;
    for (const [name, s] of Object.entries(p.data.sections)) {
      expect(typeof s.ok, name).toBe('boolean');
      if (!s.ok) expect(s.why, name).toBeTruthy();
    }
  }, 90_000);
});

describe('定时任务只查没摘除的（#1140）', () => {
  it('查询带 removed_at is null：退役摘除的任务不再报「上次跑成是 N 分钟前」，和后端 scheduleHealth 同一个口径', () => {
    const sql = query.SQL.jobs ?? '';
    expect(sql).toMatch(/from scheduled_jobs j\s+where j\.removed_at is null\) x/);
  });
});

describe('路由「在用」按路由两层算（#574）', () => {
  it('在用 = 路由两层里开着、它的模型排进了某个用途（和 db 的 routesInUse 同一个判法）；不读旧的阶段平铺表', () => {
    const sql = query.SQL.routes ?? '';
    expect(sql).not.toMatch(/stage_polic/);
    expect(sql).toMatch(
      /exists \(select 1 from routing_catalog rc join routing_purpose_models rpm on rpm\.model_id = rc\.model_id\s+where rc\.route_id = ro\.id and rc\.enabled\) as in_use/,
    );
  });

  it('法国库还没有两层那两张表（没跑迁移 0025）：路由那一块明说库查询出错，不拿旧表顶、也不当成「都没在用」，别的块照样有数', () => {
    const io = fakeIo({
      psql: (script) => {
        const names = [...script.matchAll(/^\\echo @@fleet-section (\w+)$/gm)].map((m) => m[1] ?? '');
        const out = names.map((n) =>
          n === 'routes'
            ? `${query.MARK} routes\n${query.ERR} relation "routing_catalog" does not exist`
            : `${query.MARK} ${n}\n${n === 'db' ? JSON.stringify({ now: AT, readOnly: 'on' }) : n === 'notifications' ? '{"count":0,"rows":[]}' : '[]'}`,
        );
        return { status: 0, stdout: out.join('\n'), stderr: 'psql:<stdin>:30: ERROR: …', error: null };
      },
    });
    const s = query.collect(io).sections;
    expect(s.routes).toEqual({ ok: false, why: '库查询出错：relation "routing_catalog" does not exist' });
    expect(s.tasks).toEqual({ ok: true, rows: [] });
    expect(s.orgAudit).toEqual({ ok: true, rows: [] });
  });
});

// —— 本机这头：从哪读 ——

describe('登法国的 ssh 名字：从本机配置读，不进仓', () => {
  const read = (files: Record<string, string | Error>) => (file: string) => {
    const v = files[file];
    if (v === undefined) throw Object.assign(new Error('no'), { code: 'ENOENT' });
    if (v instanceof Error) throw v;
    return v;
  };
  const home = join(tmpdir(), 'home-x');
  const file = join(home, '.fleet-dao', 'france-ssh');

  it('环境变量优先，其次 ~/.fleet-dao/france-ssh 第一行（跳过空行和 # 注释）', () => {
    expect(
      lib.readTarget({ env: { FLEET_FRANCE_SSH: ' fr ' }, home, readText: read({ [file]: 'other' }) }),
    ).toEqual({
      ok: true,
      host: 'fr',
    });
    expect(lib.readTarget({ env: {}, home, readText: read({ [file]: '# 法国\n\nroot@fr-box\n' }) })).toEqual({
      ok: true,
      host: 'root@fr-box',
    });
  });

  it('没配：not-configured，写清在哪配；原因里不带名字本身', () => {
    const r = lib.readTarget({ env: {}, home, readText: read({}) });
    expect(r).toMatchObject({ ok: false, kind: 'not-configured' });
    expect(r.ok ? '' : r.why).toContain(file);
    expect(r.ok ? '' : r.why).toContain('FLEET_FRANCE_SSH');
  });

  it('空的、读不了、认不出（以横线开头会被 ssh 当成选项）：bad-config', () => {
    expect(lib.readTarget({ env: {}, home, readText: read({ [file]: '\n# 只有注释\n' }) })).toMatchObject({
      ok: false,
      kind: 'bad-config',
    });
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    expect(lib.readTarget({ env: {}, home, readText: read({ [file]: denied }) })).toMatchObject({
      ok: false,
      kind: 'bad-config',
    });
    for (const bad of ['-oProxyCommand=calc', 'a b', 'x;rm -rf /', '$(id)']) {
      const r = lib.readTarget({ env: { FLEET_FRANCE_SSH: bad }, home, readText: read({}) });
      expect(r, bad).toMatchObject({ ok: false, kind: 'bad-config' });
      expect(r.ok ? '' : r.why).not.toContain(bad);
    }
  });

  it('ssh 的参数：不问口令、开压缩、限连接时长，名字放在选项后面，远端只跑固定的一条', () => {
    const args = lib.sshArgs('fr');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('Compression=yes');
    expect(args.some((a) => a.startsWith('ConnectTimeout='))).toBe(true);
    expect(args.slice(-2)).toEqual(['fr', 'node --input-type=module - --collect']);
  });
});

// —— 本机这头：经 ssh 跑 ——

/** 假的 ssh：一段 node 脚本，照 mode 退出。 */
function fakeSsh(dir: string, body: string): string {
  const file = join(dir, `fake-ssh-${made.length}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, body);
  return file;
}

describe('经 ssh 跑查询：连不上、超时、脚本没跑成都分得开，原因里抹掉 IP', () => {
  it('ssh 连不上（退出码 255）：ssh-failed，带 ssh 的原话，IP 抹掉', async () => {
    const file = fakeSsh(
      tempDir(),
      "process.stderr.write('ssh: connect to host 203.0.113.9 port 22: Connection timed out\\n'); process.exit(255);",
    );
    const r = await lib.runRemote({ command: process.execPath, args: [file], script: 'x' });
    expect(r).toMatchObject({ ok: false, kind: 'ssh-failed' });
    expect(r.ok ? '' : r.why).toContain('ssh 连不上法国：ssh: connect to host <IP> port 22');
    expect(r.ok ? '' : r.why).not.toContain('203.0.113.9');
  });

  it('本机没有 ssh 命令：ssh-failed，叫装 OpenSSH', async () => {
    const r = await lib.runRemote({ command: join(tempDir(), 'no-such-ssh'), args: [], script: 'x' });
    expect(r).toMatchObject({ ok: false, kind: 'ssh-failed' });
    expect(r.ok ? '' : r.why).toContain('找不到');
  });

  it('法国上的脚本没跑成（比如 node 不在，退出码 127）：query-failed', async () => {
    const file = fakeSsh(
      tempDir(),
      "process.stderr.write('bash: node: command not found\\n'); process.exit(127);",
    );
    const r = await lib.runRemote({ command: process.execPath, args: [file], script: 'x' });
    expect(r).toMatchObject({ ok: false, kind: 'query-failed' });
    expect(r.ok ? '' : r.why).toContain('退出码 127');
    expect(r.ok ? '' : r.why).toContain('node: command not found');
  });

  it('一直不回：到点停掉，timeout', async () => {
    const file = fakeSsh(tempDir(), 'setInterval(() => {}, 1000);');
    const r = await lib.runRemote({ command: process.execPath, args: [file], script: 'x', timeoutMs: 300 });
    expect(r).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('回来的太大：不收', async () => {
    const file = fakeSsh(tempDir(), "process.stdout.write('x'.repeat(5000));");
    const r = await lib.runRemote({ command: process.execPath, args: [file], script: 'x', maxBytes: 100 });
    expect(r).toMatchObject({ ok: false, kind: 'bad-json' });
  });

  it('查询脚本从标准输入喂过去，标准输出原样收回', async () => {
    const file = fakeSsh(
      tempDir(),
      "let s = ''; process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => process.stdout.write('收到 ' + s.length + ' 字'));",
    );
    const r = await lib.runRemote({ command: process.execPath, args: [file], script: '一二三' });
    expect(r).toEqual({ ok: true, stdout: '收到 3 字' });
  });
});

// —— 本机这头：回来的认不认得 ——

describe('回来的认不认得：整份认不出就明说，一块不对只标那一块', () => {
  it('什么都没打、不是 JSON：bad-json（开头几个字抹过再给）', () => {
    expect(lib.parseSnapshot('  \n')).toMatchObject({ ok: false, kind: 'bad-json' });
    const r = lib.parseSnapshot('Warning: 10.1.2.3 写坏了');
    expect(r).toMatchObject({ ok: false, kind: 'bad-json' });
    expect(r.ok ? '' : r.why).toContain('<IP>');
  });

  it('不是这份查询脚本打的、版本对不上、缺时刻、缺 sections：bad-shape', () => {
    const base = healthy();
    for (const [bad, word] of [
      [{ ...base, app: 'other' }, '不是这份查询脚本打的'],
      [{ ...base, schema: 2 }, '第 2 版'],
      [{ ...base, at: 'x' }, '没有查的时刻'],
      [{ ...base, sections: [] }, '没有 sections'],
    ] as const) {
      const r = lib.parseSnapshot(JSON.stringify(bad));
      expect(r).toMatchObject({ ok: false, kind: 'bad-shape' });
      expect(r.ok ? '' : r.why).toContain(word);
    }
  });

  it('缺一块、一块形状不对、读数文件认不出（schema 不是 1）：只把那一块标成没读到', () => {
    const raw = healthy();
    delete raw.sections.jobs;
    raw.sections.tasks = { ok: true, rows: [{ n: 'x' }] };
    (state(raw.sections) as Record<string, unknown>).schema = 9;
    const data = parsed(raw);
    expect(data.sections.jobs).toEqual({
      ok: false,
      why: '法国那头没给这一块（查询脚本和本机不是同一版？）',
    });
    expect(data.sections.tasks?.ok).toBe(false);
    expect(data.sections.tasks?.why).toContain('形状认不出');
    expect(data.sections.autoRelease).toEqual({ ok: false, why: '形状认不出：schema 是 9，只认 1' });
    expect(data.sections.routes?.ok).toBe(true);
  });

  it('字都抹过：邮箱、IP、令牌、长串', () => {
    const raw = healthy();
    rows(raw.sections.tasks as RawSection)[0] = {
      ...rows(raw.sections.tasks as RawSection)[0],
      last_problem:
        '连 10.0.0.8 失败，找 someone@example.com，令牌 ghp_abcdefghijklmnop，串 0123456789abcdef0123456789abcdef',
    };
    const text = JSON.stringify(parsed(raw));
    for (const leaked of [
      '10.0.0.8',
      'someone@example.com',
      'ghp_abcdefghijklmnop',
      '0123456789abcdef0123456789abcdef',
    ])
      expect(text).not.toContain(leaked);
    expect(text).toContain('<IP>');
    expect(text).toContain('<邮箱>');
  });
});

describe('抹字：该抹的抹，时刻、路由名、短提交号不动', () => {
  it.each([
    ['ssh root@203.0.113.9', 'ssh root@<IP>'],
    ['找 a.b@example.com 问', '找 <邮箱> 问'],
    ['Bearer abc.def-123', 'Bearer <令牌>'],
    ['key sk-abcdefghijk', 'key <密钥>'],
    ['https://x/?token=abc123&y=1', 'https://x/?token=<令牌>&y=1'],
    ['addr fe80:1:2:3:4:5', 'addr <IP>'],
    [`sha ${'a'.repeat(40)}`, 'sha <长串>'],
  ])('%s', (input, want) => {
    expect(lib.scrubText(input)).toBe(want);
  });

  it('不动正常的字', () => {
    for (const keep of [
      '2026-09-27T21:52:56.37+08:00',
      'claude-carpool:opus-5.5:claude-code',
      'grok-4.7',
      '发了 4df4e9d9432b（退出码 2）',
      '9c9b4dd8-979f-425c-9d07-95cc25ac6365',
    ])
      expect(lib.scrubText(keep)).toBe(keep);
  });
});

// —— 额度：跟 shared 的 usage.ts 同一个算法 ——

describe('额度汇总和驾驶舱（packages/shared/src/usage.ts）算出来一样', () => {
  it('一组有读到、有没读到、有在跑、有没起来、分计费方式的会话：合计、按模型、按环节全一样', () => {
    const raw = healthy();
    rows(raw.sections.runs as RawSection).push(
      run({
        n: 12,
        stage: 'verify',
        queued: 15,
        started: null,
        ended: 14,
        input: null,
        output: null,
        read: null,
        write: null,
        cost: null,
        outcome: 'failed',
      }),
      run({ n: 12, stage: 'plan', queued: 12, billing: 'metered', cost: 1.25, read: null }),
      run({
        n: 12,
        stage: 'execute',
        queued: 11,
        model: 'x',
        modelName: 'X',
        billing: 'weird',
        input: 1,
        output: 2,
        read: 3,
        write: 4,
        cost: 0.001,
      }),
    );
    const data = parsed(raw);
    const task = lib.buildView(data).tasks.active.find((t) => t.n === 12);
    expect(task?.usage).toBeTruthy();
    const mine = rows(data.sections.runs as RawSection).filter((r) => r.n === 12);
    const drop = (v: unknown) => (v === null ? undefined : v);
    const sharedRuns = mine.map((r) =>
      Object.fromEntries(
        Object.entries({
          stage: r.stage,
          queuedAt: r.queued_at,
          startedAt: drop(r.started_at),
          endedAt: drop(r.ended_at),
          inputTokens: drop(r.input_tokens),
          outputTokens: drop(r.output_tokens),
          cacheReadTokens: drop(r.cache_read_tokens),
          cacheWriteTokens: drop(r.cache_write_tokens),
          costUsd: drop(r.cost_usd),
          model: r.model,
          modelName: r.model_name,
          billing: drop(r.billing),
        }).filter(([, v]) => v !== undefined),
      ),
    );
    const want = sharedUsage.summarizeUsage(sharedRuns);
    const got = task?.usage as Usage;
    expect(got.total.runs + got.total.running).toBe(5);
    expect(got.total).toEqual(want.total);
    expect(got.byModel).toEqual(want.byModel);
    expect(got.byStage.map(({ stageName: _n, ...rest }) => rest)).toEqual(want.byStage);
  });

  it('探针过期线和 shared 的 routeProbeStaleMinutes 一样', () => {
    for (const host of ['claude-code', 'codex', 'cursor-agent', 'grok', 'mirasim', 'api-shell'])
      expect(lib.probeStaleMinutes(host), host).toBe(sharedWebApi.routeProbeStaleMinutes(host));
  });
});

// —— 断链排查的判法 ——

describe('断链排查：什么都正常时一条异常都没有', () => {
  it('健康的快照：没有异常、没有没读到；在跑、排队、结束的单各归各', () => {
    const v = viewOf();
    expect(serious(v)).toEqual([]);
    expect(v.tasks.active.map((t) => t.n)).toEqual([12]);
    expect(v.tasks.queued.map((t) => t.n)).toEqual([13]);
    expect(v.tasks.finished.map((t) => t.n)).toEqual([11]);
    expect(v.tasks.active[0]?.openRuns).toBe(1);
    expect(v.health.org).toMatchObject({ ok: true, org: 'carpool', name: '拼车' });
    expect(v.health.release).toMatchObject({ ok: true, current: SHA, behind: 0 });
  });
});

describe('断链排查：每一种异常都标得出来，写清去哪看', () => {
  const has = (v: View, level: Anomaly['level'], text: string) => {
    const hit = v.anomalies.find((a) => a.level === level && a.what.includes(text));
    expect(hit, `${level}「${text}」；实际：${JSON.stringify(v.anomalies)}`).toBeTruthy();
    expect(hit?.where).toBeTruthy();
  };

  it('服务不在', () => {
    has(
      viewOf((s) => {
        (s.services?.units as { unit: string; state: string }[])[1] = {
          unit: 'fleet-engine',
          state: 'failed',
        };
      }),
      'bad',
      '服务 fleet-engine 是 failed',
    );
  });

  it('查库的会话不是只读的', () => {
    has(
      viewOf((s) => {
        (s.db as RawSection).readOnly = 'off';
      }),
      'bad',
      '不是只读的',
    );
  });

  it('自动发布 20 分钟没跑一轮；一轮跑了 60 分钟还没完', () => {
    has(
      viewOf((s) => {
        state(s).ranAt = ago(25);
      }),
      'bad',
      '自动发布 25 分钟没跑过一轮',
    );
    has(
      viewOf((s) => {
        state(s).attempt = { sha: SHA, startedAt: ago(70), endedAt: null, result: 'running', detail: '' };
      }),
      'bad',
      '这一轮跑了 70 分钟还没完',
    );
  });

  it('【故意造出的失败】落后主线落了很久也不标异常，读数照旧写落后几个、卡在哪（发布只由按钮发，#1271）', () => {
    const behind = (waited: number) =>
      viewOf((s) => {
        const st = state(s);
        (st.main as Record<string, unknown>).commits = [
          ['dddddddddddd', ago(waited)],
          [SHA, ago(2000)],
        ];
        st.last = { action: 'ci-pending', detail: 'CI 在跑', at: ago(3) };
      });
    for (const waited of [30, 50, 1500]) {
      expect(whats(behind(waited), 'bad'), `等了 ${waited} 分钟`).toEqual([]);
      expect(behind(waited).health.release).toMatchObject({ behind: 1 });
    }
  });

  it('在用的不在主线最近的提交里：人手动切过的只是留意', () => {
    const off = (hold: boolean) =>
      viewOf((s) => {
        const st = state(s);
        (st.main as Record<string, unknown>).commits = [['dddddddddddd', ago(10)]];
        if (hold) st.hold = { since: ago(30), sha: SHA, event: 'rollback', unmerged: false };
      });
    has(off(false), 'bad', '不在主线最近 1 个提交里');
    has(off(true), 'note', '人手动切过版本');
  });

  it('配置对账带到版本那一块；旧的状态文件没有这一项也认得；形状不对就是没读到', () => {
    const v = viewOf((s) => {
      state(s).config = { checkedAt: ago(3), result: 'drift', drift: ['engine.env:FLEET_X'], unchecked: [] };
    });
    expect(v.health.release).toMatchObject({
      ok: true,
      config: { result: 'drift', drift: ['engine.env:FLEET_X'] },
    });
    expect(viewOf().health.release).toMatchObject({ ok: true, config: null });
    const bad = viewOf((s) => {
      state(s).config = { checkedAt: ago(3), result: 'drift', drift: [{ id: 1 }], unchecked: [] };
    });
    expect(bad.health.release).toMatchObject({ ok: false });
    expect(whats(bad, 'unread').join('')).toContain('config.drift');
  });

  it('上一次发布没成、规矩同步没成、装机脚本落后一天', () => {
    has(
      viewOf((s) => {
        state(s).attempt = {
          sha: SHA,
          startedAt: ago(20),
          endedAt: ago(15),
          result: 'failed',
          detail: '健康检查没过',
        };
      }),
      'bad',
      '最近一次自动发布没成',
    );
    has(
      viewOf((s) => {
        state(s).rules = { commit: SHA, at: ago(5), result: 'failed', detail: 'pilot 家目录写不进' };
      }),
      'bad',
      '规矩同步没成',
    );
    has(
      viewOf((s) => {
        state(s).system = { appliedSha: 'cccccccccccc', behind: 2, oldestAt: ago(26 * 60) };
      }),
      'bad',
      '装机脚本落后主线 2 个相关提交',
    );
  });

  it('自动发布记了「被更新的版本取代」（人手动切到了更新的）：旧失败不再报；取代的记录形状不对就是没读到', () => {
    const failed = { sha: SHA, startedAt: ago(20), endedAt: ago(15), result: 'failed', detail: '旧 stages' };
    const withBy = (supersededBy: unknown) =>
      viewOf((s) => {
        state(s).attempt = { ...failed, supersededBy };
      });
    const gone = withBy({ sha: 'cccccccccccc', at: ago(5) });
    expect(whats(gone, 'bad').join('')).not.toContain('最近一次自动发布没成');
    has(withBy(null), 'bad', '最近一次自动发布没成');
    const broken = withBy('不是对象');
    expect(broken.health.release).toMatchObject({ ok: false });
    expect(whats(broken, 'unread').join('')).toContain('supersededBy');
  });

  it('没处理的提醒：一条一行，日报只是留意，多于 5 条另起一行说还有几条', () => {
    const v = viewOf((s) => {
      const note = (i: number, level: string) => ({
        level,
        dedupe_key: `k${i}`,
        title: i === 0 ? '#12 的提问另开单没成' : `提醒 ${i}`,
        body: '',
        link: null,
        created_at: ago(10 + i),
        updated_at: null,
        n: 12,
      });
      s.notifications = {
        ok: true,
        count: 7,
        rows: [
          note(0, 'alert'),
          note(1, 'daily'),
          note(2, 'decision'),
          note(3, 'alert'),
          note(4, 'alert'),
          note(5, 'alert'),
        ],
      };
    });
    has(v, 'bad', '没处理的提醒：#12 的提问另开单没成（10 分钟前）');
    expect(whats(v).some((w) => w.includes('#12 #12'))).toBe(false);
    has(v, 'note', '提醒 1');
    has(v, 'bad', '提醒 2');
    has(v, 'bad', '还有 2 条提醒没处理');
    expect(whats(v).some((w) => w.includes('提醒 5'))).toBe(false);
  });

  it('定时任务：从没跑过、最近一轮没跑成、一个都没扫到、过期了；只查了一部分是留意', () => {
    const v = viewOf((s) => {
      s.jobs = {
        ok: true,
        rows: [
          {
            ...job('never', 45, { start: 1, end: 1, outcome: 'ok' }),
            last_run: null,
            last_finished: null,
            last_success: null,
          },
          { ...job('failing', 45, { start: 5, end: 4, outcome: 'failed' }), last_success: null },
          job('empty', 45, { start: 5, end: 4, outcome: 'unscanned' }),
          job('stale', 45, { start: 60, end: 59, outcome: 'ok' }),
          job('partial', 45, { start: 5, end: 4, outcome: 'partial' }),
          job('fresh', 45, { start: 5, end: 4, outcome: 'ok' }),
        ],
      };
    });
    has(v, 'bad', '定时任务「任务 never」从没跑过');
    has(v, 'bad', '定时任务「任务 failing」最近一轮没跑成');
    has(v, 'bad', '定时任务「任务 empty」最近一轮一个都没扫到');
    has(v, 'bad', '定时任务「任务 stale」上次跑成是 59 分钟前（该在 45 分钟内再跑成一次）');
    has(v, 'note', '定时任务「任务 partial」最近一轮只查了一部分');
    expect(whats(v).some((w) => w.includes('任务 fresh'))).toBe(false);
  });

  it('定时任务的判法和 scheduleHealth 一样：在跑的那次不算结局，看上一次结束的', () => {
    const running = {
      ...job('j', 45, { start: 5, end: 4, outcome: 'ok' }),
      last_run: { started_at: ago(1), ended_at: null, outcome: null, why: null },
    };
    expect(lib.jobStatus(running, AT)).toBe('ok');
    expect(lib.jobStatus({ ...running, last_success: null }, AT)).toBe('stale');
  });

  it('路由：在线却过了该探的时候没探——平时 45 分钟，贵的执行方式 150 分钟', () => {
    const v = viewOf((s) => {
      s.routes = {
        ok: true,
        rows: [
          route({ id: 'a:m:claude-code', probed: 50 }),
          route({ id: 'g:m:grok', host: 'grok', probed: 140 }),
          route({ id: 'c:m:cursor-agent', host: 'cursor-agent', probed: 160 }),
          route({ id: 'n:m:claude-code', alive: false, state: null, probed: null, inUse: false }),
        ],
      };
    });
    has(v, 'bad', '路由 a:m:claude-code 算在线，但结论 50 分钟没更新');
    has(v, 'bad', '路由 c:m:cursor-agent 算在线，但结论 160 分钟没更新');
    expect(whats(v).some((w) => w.includes('g:m:grok') || w.includes('n:m:claude-code'))).toBe(false);
  });

  it('会话跑了 90 分钟还没完、登记了 30 分钟还没起来；3 小时内没成的列成留意，更早的不列', () => {
    const v = viewOf((s) => {
      s.runs = {
        ok: true,
        rows: [
          run({ n: 12, stage: 'execute', queued: 100, started: 95, ended: null }),
          run({ n: 12, stage: 'plan', queued: 35, started: null, ended: null }),
          run({
            n: 12,
            stage: 'verify',
            queued: 50,
            ended: 40,
            outcome: 'failed',
            code: 'no_result',
            message: '进程退出',
          }),
          run({ n: 11, stage: 'verify', queued: 300, ended: 250, outcome: 'failed', code: 'old' }),
        ],
      };
    });
    has(v, 'bad', '会话跑了 95 分钟还没完：#12 写码');
    has(v, 'bad', '会话登记了 35 分钟还没起来：#12 规划');
    has(v, 'note', '会话没成：#12 开 PR 前验证（claude-carpool:opus-5.5:claude-code） no_result：进程退出');
    expect(whats(v).some((w) => w.includes('old'))).toBe(false);
  });

  it('单：卡住了；在干活却手上没有会话、20 分钟没动（法国巡查）；别的状态 60 分钟没动是留意；等人回答的不算', () => {
    const task = (n: number, st: string, updated: number, problem: string | null = null) => ({
      repo: 'o/fleet-dao',
      n,
      title: `单 ${n}`,
      state: st,
      phase: 'fusion:x',
      doing: null,
      last_problem: problem,
      created_at: ago(500),
      updated_at: ago(updated),
    });
    const v = viewOf((s) => {
      s.tasks = {
        ok: true,
        rows: [
          task(21, 'stalled', 5, '派不出路由'),
          task(22, 'running', 25),
          task(23, 'running', 25),
          task(24, 'planning', 70),
          task(25, 'asking', 300),
          task(26, 'running', 10),
        ],
      };
      s.runs = { ok: true, rows: [run({ n: 23, stage: 'execute', queued: 20, ended: null })] };
    });
    has(v, 'bad', '#21 卡住了：派不出路由');
    has(v, 'bad', '#22 25 分钟没动，手上也没有会话（在干活 · fusion:x）：多半停在等人或等一个派不出的路由');
    has(v, 'note', '#24 70 分钟没动');
    // 稳定类别（#1292）：发版车按它过滤，不匹配文案；其他异常不带这个类别
    const kindOf = (prefix: string) =>
      (v.anomalies as { what: string; kind?: string }[]).find((a) => a.what.startsWith(prefix))?.kind;
    expect(kindOf('#22 ')).toBe('task-idle');
    expect(kindOf('#24 ')).toBe('task-idle');
    expect(kindOf('#21 ')).toBeUndefined();
    for (const quiet of ['#23 ', '#25 ', '#26 '])
      expect(
        whats(v).some((w) => w.startsWith(quiet)),
        quiet,
      ).toBe(false);
  });

  it('任务工作流的会话（runs 表，阶段写成 segment:manual）在跑：算手上有会话、不报「多半停在等人」，阶段认成写码', () => {
    const v = viewOf((s) => {
      s.tasks = {
        ok: true,
        rows: [
          {
            repo: 'o/fleet-dao',
            n: 22,
            title: '单 22',
            state: 'running',
            phase: 'brief',
            doing: null,
            last_problem: null,
            created_at: ago(500),
            updated_at: ago(25),
          },
        ],
      };
      s.runs = { ok: true, rows: [run({ n: 22, stage: 'segment:manual', queued: 10, ended: null })] };
    });
    expect(whats(v).some((w) => w.startsWith('#22 '))).toBe(false);
    expect(JSON.stringify(v)).toContain('写码');
    expect(JSON.stringify(v)).not.toContain('segment:');
  });

  it('会话用户挂的号：看引擎自己记的，取最新的；探针读不出就标出来', () => {
    expect(
      lib.mountedOrg(
        [route({ id: 'claude-carpool:m:claude-code', org: 'carpool', probed: 50 })],
        [
          {
            at: ago(10),
            action: 'session-org.switch',
            ok: true,
            from_org: 'carpool',
            to_org: 'solo',
            error: null,
          },
        ],
      ),
    ).toMatchObject({ ok: true, org: 'solo', name: '独享', how: '引擎切号的记录' });
    expect(
      lib.mountedOrg(
        [
          route({
            id: 's:m:claude-code',
            org: 'solo',
            alive: false,
            state: 'skipped',
            detail: '会话用户现在挂的是独享组织：…',
            probed: 3,
          }),
        ],
        [],
      ),
    ).toMatchObject({ ok: true, org: 'solo' });
    expect(lib.mountedOrg([], [])).toMatchObject({ ok: false });
    const v = viewOf((s) => {
      s.routes = {
        ok: true,
        rows: [
          route({
            id: 'c:m:claude-code',
            org: 'carpool',
            alive: false,
            state: 'failed',
            detail: '会话用户挂的组织认不出（登录失效）：不探',
            probed: 2,
          }),
        ],
      };
    });
    has(v, 'bad', '会话用户挂的号认不出');
  });

  it('接活开关关着是留意', () => {
    has(
      viewOf((s) => {
        s.repos = { ok: true, rows: [{ repo: 'o/fleet-dao', auto_dispatch_since: null }] };
      }),
      'note',
      '仓 fleet-dao 的「让 AI 接活」关着',
    );
  });

  it('没读到的块：库的几块同一个原因并成一行；别的一块一行；异常在前、没读到其次、留意最后', () => {
    const v = viewOf((s) => {
      for (const name of Object.keys(query.SQL))
        s[name] = { ok: false, why: '连不上库（psql 退出码 2）：boom' };
      s.rounds = { ok: false, why: 'journalctl 退出码 1' };
      (s.services?.units as { unit: string; state: string }[])[0] = { unit: 'fleet-api', state: 'inactive' };
    });
    expect(whats(v, 'unread')).toEqual([
      '没读到：库（连不上库（psql 退出码 2）：boom）',
      '没读到：自动发布的日志（journalctl 退出码 1）',
    ]);
    const levels = v.anomalies.map((a) => a.level);
    expect(levels).toEqual(
      [...levels].sort((a, b) => ['bad', 'unread', 'note'].indexOf(a) - ['bad', 'unread', 'note'].indexOf(b)),
    );
    expect(levels[0]).toBe('bad');
    // 没读到的块在页面上也照实写，不给空列表
    expect(v.tasks).toEqual({ ok: false, why: '连不上库（psql 退出码 2）：boom' });
    expect(v.usage24h.ok).toBe(false);
    expect(v.health.jobs).toMatchObject({ ok: false });
  });

  it('只有会话没读到：单子照列，每张单写「会话没读到」，不写成 0 次', () => {
    const v = viewOf((s) => {
      s.runs = { ok: false, why: '库查询出错：x' };
    });
    expect(v.tasks.active[0]?.usage).toBeNull();
    expect(v.tasks.active[0]?.runsWhy).toBe('库查询出错：x');
  });
});

// —— 页面服务里的缓存 ——

describe('页面服务里那一份：有人看才读，30 秒一次，读失败留着上次的', () => {
  function clock(start = Date.parse(AT)) {
    let t = start;
    return { now: () => new Date(t), step: (ms: number) => (t += ms) };
  }

  it('第一次来：马上回「在读」，读完给整理好的；30 秒内再来不重读，过了再读', async () => {
    let calls = 0;
    const c = clock();
    const source = lib.createFranceSource({
      fetchOnce: async () => {
        calls += 1;
        return { ok: true, data: parsed(healthy()) };
      },
      now: c.now,
      refreshMs: 30_000,
    });
    const first = source.read();
    expect(first.loading).not.toBeNull();
    expect(first.good).toBeNull();
    await source.refresh();
    const second = source.read();
    expect(second.good?.view.counts).toMatchObject({ bad: 0, unread: 0 });
    expect(second.loading).toBeNull();
    expect(calls).toBe(1);
    c.step(29_000);
    source.read();
    expect(calls).toBe(1);
    c.step(2_000);
    expect(source.read().loading).not.toBeNull();
    await source.refresh();
    expect(calls).toBe(2);
  });

  it('同时来好几次：只读一次', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const source = lib.createFranceSource({
      fetchOnce: () =>
        new Promise((resolve) => {
          calls += 1;
          release = () => resolve({ ok: true, data: parsed(healthy()) });
        }),
    });
    source.read();
    source.read();
    source.read();
    release();
    await source.refresh();
    expect(calls).toBe(1);
  });

  it('读失败：good 留着上次读成的，lastTry 写明哪种失败和原因（抹过字）', async () => {
    const c = clock();
    let fail = false;
    const source = lib.createFranceSource({
      fetchOnce: async () =>
        fail
          ? { ok: false, kind: 'ssh-failed', why: 'ssh 连不上法国：connect to host 203.0.113.9' }
          : { ok: true, data: parsed(healthy()) },
      now: c.now,
    });
    source.read();
    await source.refresh();
    const good = source.read().good;
    fail = true;
    c.step(31_000);
    source.read();
    await source.refresh();
    const after = source.read();
    expect(after.good).toEqual(good);
    expect(after.lastTry).toMatchObject({ ok: false, kind: 'ssh-failed' });
    expect(after.lastTry?.why).toContain('<IP>');
  });

  it('取数的函数抛了、整理的时候出错：记成 crashed，不把服务弄崩', async () => {
    const boom = lib.createFranceSource({
      fetchOnce: async () => {
        throw new Error('炸了');
      },
    });
    boom.read();
    await boom.refresh();
    expect(boom.read().lastTry).toMatchObject({ ok: false, kind: 'crashed' });
    const odd = lib.createFranceSource({
      fetchOnce: async () => ({ ok: true, data: { at: AT, sections: {} } }),
    });
    odd.read();
    await odd.refresh();
    expect(odd.read().lastTry).toMatchObject({ ok: false, kind: 'crashed' });
    expect(odd.read().good).toBeNull();
  });
});

describe('取一次的整条路：读名字、喂脚本、认回来的', () => {
  it('ssh 换成本机的 node 跑同一份查询脚本：走得通，回来的认得出', async () => {
    const home = tempDir();
    const fetchOnce = lib.franceFetcher({
      home,
      env: { FLEET_FRANCE_SSH: 'fr' },
      scriptFile: QUERY_FILE,
      command: process.execPath,
      argsFor: () => ['--input-type=module', '-', '--collect'],
    });
    const r = await fetchOnce();
    expect(r.ok, r.ok ? '' : r.why).toBe(true);
  }, 90_000);

  it('没配 ssh 名字：not-configured，不去连', async () => {
    const r = await lib.franceFetcher({
      home: tempDir(),
      env: {},
      scriptFile: QUERY_FILE,
      command: join(tempDir(), 'no-ssh'),
    })();
    expect(r).toMatchObject({ ok: false, kind: 'not-configured' });
  });

  it('查询脚本本机读不到：no-script', async () => {
    const r = await lib.franceFetcher({
      home: tempDir(),
      env: { FLEET_FRANCE_SSH: 'fr' },
      scriptFile: join(tempDir(), 'gone.mjs'),
    })();
    expect(r).toMatchObject({ ok: false, kind: 'no-script' });
  });

  it('回来的不是 JSON：bad-json', async () => {
    const file = fakeSsh(tempDir(), "process.stdout.write('Last login: yesterday\\n');");
    const r = await lib.franceFetcher({
      home: tempDir(),
      env: { FLEET_FRANCE_SSH: 'fr' },
      scriptFile: QUERY_FILE,
      command: process.execPath,
      argsFor: () => [file],
    })();
    expect(r).toMatchObject({ ok: false, kind: 'bad-json' });
  });
});

// —— 页面服务、页面、命令行 ——

describe('页面服务：/ 转到 /france，/france 给页面，/api/france 给数据', () => {
  async function serve(france: FranceSource) {
    const server = lib.createFranceServer({ france });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('没拿到端口');
    // 不跟着跳：要看 / 回的是不是转到 /france
    return (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, { redirect: 'manual', ...init });
  }

  it('页面 200、数据是缓存那一份；/ 转到 /france；页面上没有回本机进度页的页签（#530 删了进度页）', async () => {
    const source = lib.createFranceSource({
      htmlFile: join(SCRIPTS, 'france.html'),
      fetchOnce: async () => ({ ok: true, data: parsed(healthy()) }),
    });
    const get = await serve(source);
    const page = await get('/france');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<title>法国引擎</title>');
    expect(html).not.toContain('href="/"');
    expect(html).not.toContain('帅位进度');
    for (const path of ['/', '/index.html']) {
      const root = await get(path);
      expect(root.status, path).toBe(302);
      expect(root.headers.get('location'), path).toBe('/france');
    }
    expect(await (await get('/api/ping')).json()).toEqual({ app: lib.APP_ID });
    await get('/api/france');
    await source.refresh();
    const data = (await (await get('/api/france')).json()) as SourceState;
    expect(data.good?.view.counts).toMatchObject({ bad: 0, unread: 0 });
  });

  it('【故意造出的失败】页面文件读不到：500 带原因，不给空页面；只许读；没有的地址（含进度页原来的几个）404', async () => {
    const missing = lib.createFranceSource({
      htmlFile: join(tmpdir(), 'no-such-france.html'),
      fetchOnce: async () => ({ ok: false, kind: 'x', why: 'x' }),
    });
    const get = await serve(missing);
    const page = await get('/france');
    expect(page.status).toBe(500);
    expect(await page.text()).toContain('页面文件读不到');
    expect((await get('/api/france', { method: 'POST' })).status).toBe(405);
    for (const gone of ['/api/projects', '/api/p/fleet-dao', '/nope']) {
      expect((await get(gone)).status, gone).toBe(404);
    }
  });
});

describe('页面服务的端口和起法', () => {
  const source = () =>
    lib.createFranceSource({
      htmlFile: join(SCRIPTS, 'france.html'),
      fetchOnce: async () => ({ ok: false, kind: 'x', why: 'x' }),
    });

  it('端口：默认 1127，环境变量和 --port 能改，认不出就说', () => {
    expect(lib.parsePort([], {})).toBe(lib.DEFAULT_PORT);
    expect(lib.DEFAULT_PORT).toBe(1127);
    expect(lib.parsePort([], { FLEET_PROGRESS_PORT: '2000' })).toBe(2000);
    expect(lib.parsePort(['--port', '3000'], { FLEET_PROGRESS_PORT: '2000' })).toBe(3000);
    expect(typeof lib.parsePort(['--port', 'abc'], {})).toBe('string');
    expect(typeof lib.parsePort(['--port'], {})).toBe('string');
    expect(typeof lib.parsePort([], { FLEET_PROGRESS_PORT: '70000' })).toBe('string');
  });

  it('再起一遍：端口上已经是这个页面服务就说「已经在跑」、退出码 0；被别的程序占着退出码 1', async () => {
    const lines: string[] = [];
    const log = (t: string) => lines.push(t);
    const first = await lib.startFranceServer({ port: 0, france: source(), out: log, err: log });
    if (first.server) servers.push(first.server);
    expect(first.code).toBe(0);
    expect(await lib.isOurs(first.port ?? -1)).toBe(true);
    const again = await lib.startFranceServer({
      port: first.port ?? -1,
      france: source(),
      out: log,
      err: log,
    });
    expect(again).toEqual({ code: 0 });
    expect(lines.at(-1)).toContain('已经在跑');

    const other = createServer((_req, res) => res.end('别人的'));
    servers.push(other);
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const address = other.address();
    if (address === null || typeof address === 'string') throw new Error('没拿到端口');
    expect(await lib.isOurs(address.port)).toBe(false);
    const taken = await lib.startFranceServer({ port: address.port, france: source(), out: log, err: log });
    expect(taken).toEqual({ code: 1 });
    expect(lines.at(-1)).toContain('被别的程序占着');
  });
});

describe('命令行 france.mjs', () => {
  const cli = (env: Record<string, string>) => {
    const home = tempDir();
    return spawnSync(process.execPath, [join(SCRIPTS, 'france.mjs')], {
      env: { ...process.env, HOME: home, USERPROFILE: home, FLEET_FRANCE_SSH: '', ...env },
      encoding: 'utf8',
      timeout: 30_000,
    });
  };

  it('没配 ssh 名字：退出码 2，说在哪配', () => {
    const r = cli({});
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('没读到法国（not-configured）');
    expect(r.stderr).toContain('france-ssh');
  });

  it('ssh 名字认不出：退出码 2，不去连', () => {
    const r = cli({ FLEET_FRANCE_SSH: '-oProxyCommand=calc' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('bad-config');
  });

  it('--help：退出码 0', () => {
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'france.mjs'), '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('用法：node france.mjs');
  });
});

describe('server.mjs 起来就接了法国引擎页', () => {
  it('/ 转到 /france，/france 是页面，/api/france 回缓存的样子（这台没配名字：马上报 not-configured）', async () => {
    const home = tempDir();
    mkdirSync(join(home, '.fleet-dao'), { recursive: true });
    const child = spawn(process.execPath, [join(SCRIPTS, 'server.mjs'), '--port', '0'], {
      env: { ...process.env, HOME: home, USERPROFILE: home, FLEET_FRANCE_SSH: '' },
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error(`10 秒没起来：${buf}`)), 10_000);
        child.stdout.on('data', (d) => {
          buf += String(d);
          const m = /http:\/\/127\.0\.0\.1:\d+/.exec(buf);
          if (m) {
            clearTimeout(timer);
            resolve(m[0]);
          }
        });
        child.on('exit', (code) => reject(new Error(`退出了（${code}）：${buf}`)));
      });
      expect((await fetch(`${url}/france`)).status).toBe(200);
      const root = await fetch(`${url}/`, { redirect: 'manual' });
      expect(root.status).toBe(302);
      expect(root.headers.get('location')).toBe('/france');
      let last: SourceState | null = null;
      for (let i = 0; i < 50 && !last?.lastTry; i++) {
        last = (await (await fetch(`${url}/api/france`)).json()) as SourceState;
        if (!last.lastTry) await new Promise((r) => setTimeout(r, 100));
      }
      expect(last?.lastTry).toMatchObject({ ok: false, kind: 'not-configured' });
      expect(last?.good).toBeNull();
    } finally {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
    }
  });
});
