// 发版命令行薄壳（release-train-lib.mjs）：往法国递一份和驾驶舱同格式的请求，再跟着进度读到结束。
// 九步在法国接活脚本里，这里不再测。ssh、睡眠是假的（sleep 只把时间往前拨）。
// 法国在跑会话数的只读查询仍在这个文件里测（france-sessions-query.mjs / france-sessions-lib.mjs）。
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

const SCRIPTS = fileURLToPath(new URL('../skills/commander/scripts/', import.meta.url));
const load = async (file: string) => import(pathToFileURL(join(SCRIPTS, file)).href);

interface CmdResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string | null | undefined;
}
interface TrainIo {
  uuid?: () => string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  out: (t: string) => void;
  err: (t: string) => void;
  limits?: { followMs?: number; pollMs?: number };
  cwd?: () => string;
  nodePath?: string;
  scriptsDir?: string;
  run?: (command: string, args: string[], opts?: unknown) => CmdResult | Promise<CmdResult>;
  ssh: (command: string, opts?: unknown) => CmdResult | Promise<CmdResult>;
}
interface Train {
  COMMANDER_BY: string;
  ONEKEY_PREFLIGHT_FOUNDER_OK: string;
  REQUEST_FILE: string;
  TRAIN_FILE: string;
  LAST_FILE: string;
  requestText(
    kind: string,
    fields: { sha?: string | null; at: string; by?: string; requestId?: string },
  ): string;
  writeRequestCommand(text: string): string;
  readProgressCommand(): string;
  readArchivedRequestCommand(requestId: string): string;
  parseProgressReply(stdout: string): {
    ok: boolean;
    why?: string;
    train?: unknown;
    last?: unknown;
  };
  runTrain(argv: string[], io: TrainIo): Promise<number>;
}
interface SessionsResult {
  ok: boolean;
  running?: number;
  rows?: unknown[];
  kind?: string;
  why?: string;
}
interface SessionsLib {
  parseSessions(text: string): SessionsResult;
  fetchRunningSessions(o: Record<string, unknown>): Promise<SessionsResult>;
}
interface SessionsQuery {
  PSQL: string[];
  SQL: string;
  collect(
    run: (argv: readonly string[], input: string) => CmdResult,
    now?: () => Date,
  ): { ok: boolean; running?: number; rows?: unknown[]; why?: string };
  realRun(argv: readonly string[], input: string): CmdResult;
}

const train = (await load('release-train-lib.mjs')) as Train;
const sessionsLib = (await load('france-sessions-lib.mjs')) as SessionsLib;
const sessionsQuery = (await load('france-sessions-query.mjs')) as SessionsQuery;
const franceQuery = (await load('france-query.mjs')) as { PSQL: string[] };
const franceLib = (await load('france-lib.mjs')) as {
  RELEASE_ALERT_PREFIXES: string[];
  VERIFY_RETRY_PREFIXES: string[];
};
/** 直接拿法国接活脚本的 parseRequest，请求文本认不认由它说了算。提醒前缀也从这份对，不在命令行再留一份。 */
const releaseRequest = (await import(
  pathToFileURL(fileURLToPath(new URL('../../deploy/france/release-request/lib.mjs', import.meta.url))).href
)) as {
  parseRequest(text: string): {
    ok: boolean;
    kind: string;
    sha: string | null;
    by: string | null;
    at?: string;
    why?: string;
  };
  RELEASE_ALERT_PREFIXES: string[];
  VERIFY_RETRY_PREFIXES: string[];
};
const { parseRequest } = releaseRequest;

const SHA = 'ab12cd34'.repeat(5);
const FOUNDER = '发版吧';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const T0 = Date.parse('2026-10-16T05:00:00.000Z');

/** 跟 readProgressCommand 同一份切法：文件之间有一个空行。 */
function frame(trainBody: unknown, lastBody: unknown): string {
  const t = trainBody === null ? '' : JSON.stringify(trainBody);
  const l = lastBody === null ? '' : JSON.stringify(lastBody);
  return `---TRAIN---\n${t}\n\n---LAST---\n${l}\n`;
}

function receipt(kind = 'release', sha: string | null = SHA) {
  return { requestId: REQUEST_ID, requestAt: new Date(T0).toISOString(), requestKind: kind, requestSha: sha };
}
interface AttemptCheck extends Record<string, unknown> {
  attemptId: string;
  sha: string;
  at: string;
  ok: boolean;
}
interface AttemptNode {
  identity: { requestId: string; kind: string; sha: string | null; at: string; by: string };
  parent: string | null;
  supersededBy: string | null;
  target: string;
  status: string;
  why: string | null;
  startedAt: string;
  check: AttemptCheck | null;
}
interface SignedTrain extends Record<string, unknown> {
  requestId: string;
  rootRequestId: string;
  requests: AttemptNode[];
  target: { kind: string; value: string };
  check: AttemptCheck | null;
}
function signed(body: Record<string, unknown>, kind = 'release', sha: string | null = SHA): SignedTrain {
  const identity = { requestId: REQUEST_ID, kind, sha, at: new Date(T0).toISOString(), by: 'commander' };
  const check = body.check
    ? ({ ...(body.check as object), attemptId: REQUEST_ID, sha: SHA } as AttemptCheck)
    : null;
  return {
    schema: 1,
    ...body,
    target: { kind: 'sha', value: SHA },
    check,
    requestId: REQUEST_ID,
    rootRequestId: REQUEST_ID,
    requests: [
      {
        identity,
        parent: null,
        supersededBy: null,
        target: SHA,
        status: String(body.status),
        why: typeof body.why === 'string' ? body.why : null,
        startedAt: new Date(T0).toISOString(),
        check,
      },
    ],
  };
}

const accepted = {
  ...receipt(),
  v: 1,
  at: '2026-10-16T05:00:01.000Z',
  outcome: 'accepted',
  sha: SHA,
  by: 'commander',
  why: null,
};

function running(phase: number) {
  return signed({
    schema: 1,
    status: 'running',
    phase,
    waiting: phase === 4 ? '发布还在跑' : null,
    why: null,
    target: { kind: 'sha', value: SHA },
    check: null,
  });
}

function world(opts: { ssh?: (cmd: string, w: { reads: number }) => CmdResult; frames?: string[] }) {
  const w = {
    t: T0,
    reads: 0,
    sshCalls: [] as string[],
    out: [] as string[],
    err: [] as string[],
  };
  const ssh = (cmd: string): CmdResult => {
    w.sshCalls.push(cmd);
    if (opts.ssh) return opts.ssh(cmd, w);
    if (cmd === 'readlink /srv/fleet-dao-releases/current')
      return { status: 0, stdout: `${SHA}\n`, stderr: '' };
    if (cmd.includes('/request-segments/by-request/')) return { status: 44, stdout: '', stderr: '' };
    if (cmd.includes(train.REQUEST_FILE)) return { status: 0, stdout: '', stderr: '' };
    if (cmd.includes('---TRAIN---')) {
      const frames = opts.frames ?? [frame(null, null)];
      const text = frames[Math.min(w.reads, frames.length - 1)] ?? frame(null, null);
      w.reads += 1;
      return { status: 0, stdout: text, stderr: '' };
    }
    return { status: 127, stdout: '', stderr: `假法国不认识：${cmd}` };
  };
  const io = (): TrainIo => ({
    uuid: () => REQUEST_ID,
    now: () => new Date(w.t),
    sleep: async (ms) => {
      w.t += ms;
    },
    out: (t) => w.out.push(t),
    err: (t) => w.err.push(t),
    limits: { pollMs: 1000, followMs: 60_000 },
    ssh,
  });
  return { w, io };
}

/** 从写请求的 ssh 命令里把单引号包着的正文取出来。 */
function payloadOf(cmd: string): string {
  const m = /printf %s ('(?:[^']|'\\'')*') >/.exec(cmd);
  if (!m?.[1]) throw new Error(`写请求的命令里没有正文：${cmd}`);
  return m[1].slice(1, -1).replace(/'\\''/g, "'");
}

describe('请求文本：四种 kind 法国 parseRequest 都认', () => {
  it('命令行拼出的正文交给 parseRequest，release / retry / restore / abort 各一条', () => {
    const at = '2026-10-16T05:00:00.000Z';
    const by = train.COMMANDER_BY;
    const cases = [
      ['release', train.requestText('release', { sha: SHA, at, by }), ['at', 'by', 'sha', 'v'], SHA],
      ['retry', train.requestText('retry', { sha: SHA, at, by }), ['at', 'by', 'kind', 'sha', 'v'], SHA],
      ['restore', train.requestText('restore', { at, by }), ['at', 'by', 'kind', 'v'], null],
      ['abort', train.requestText('abort', { at, by }), ['at', 'by', 'kind', 'v'], null],
    ] as const;
    for (const [kind, text, keys, sha] of cases) {
      expect(Object.keys(JSON.parse(text)).sort(), kind).toEqual([...keys]);
      expect(parseRequest(text), kind).toMatchObject({ ok: true, kind, sha, at, by });
    }
  });
});

describe('提醒口径：法国接活脚本和 france-lib 同一份', () => {
  it('两边的发版相关前缀、重启打断前缀逐项相等', () => {
    expect(franceLib.RELEASE_ALERT_PREFIXES).toEqual([
      'auto-release:',
      'engine-drain',
      'engine-session-io',
      'cli-upgrade:',
      'retired-schedule:',
    ]);
    expect(franceLib.VERIFY_RETRY_PREFIXES).toEqual(['watchdog:job:', 'watchdog-down:', 'deploy-lag:']);
    expect(releaseRequest.RELEASE_ALERT_PREFIXES).toEqual(franceLib.RELEASE_ALERT_PREFIXES);
    expect(releaseRequest.VERIFY_RETRY_PREFIXES).toEqual(franceLib.VERIFY_RETRY_PREFIXES);
  });
});

describe('薄壳：递请求、跟着法国进度', () => {
  const start = ['start', '--sha', SHA, '--founder-ok', FOUNDER];

  it('递请求：ssh 写到法国的正文就是 release，by 是 commander，parseRequest 认', async () => {
    const done = signed({
      schema: 1,
      status: 'done',
      phase: 8,
      waiting: null,
      why: null,
      target: { kind: 'sha', value: SHA },
      check: { ok: true, items: [], at: '2026-10-16T05:10:00.000Z' },
    });
    const { w, io } = world({
      frames: [frame(null, null), frame(done, { ...accepted, outcome: 'done', check: done.check })],
    });
    const code = await train.runTrain(start, io());
    expect(code).toBe(0);
    const at = new Date(T0).toISOString();
    const text = train.requestText('release', { sha: SHA, at, by: 'commander', requestId: REQUEST_ID });
    const write = w.sshCalls.find((c) => c.includes(train.REQUEST_FILE));
    expect(write).toBe(train.writeRequestCommand(text));
    expect(parseRequest(payloadOf(write ?? ''))).toMatchObject({
      ok: true,
      kind: 'release',
      sha: SHA,
      by: 'commander',
    });
    expect(w.sshCalls.some((c) => c.includes(train.TRAIN_FILE))).toBe(true);
    expect(w.sshCalls.some((c) => c.includes(train.LAST_FILE))).toBe(true);
  });

  it('跟进度到成功：中间步打出来，做完了退出码 0', async () => {
    const done = signed({
      schema: 1,
      status: 'done',
      phase: 8,
      waiting: null,
      why: null,
      check: {
        ok: true,
        items: [{ name: '在用', ok: true, text: '是这个提交' }],
        at: '2026-10-16T05:10:00.000Z',
      },
    });
    const { w, io } = world({
      frames: [
        frame(null, null),
        frame(running(0), accepted),
        frame(running(4), accepted),
        frame(done, { ...accepted, outcome: 'done', check: done.check }),
      ],
    });
    const code = await train.runTrain(start, io());
    expect(code).toBe(0);
    const out = w.out.join('\n');
    expect(out).toContain('第 0 步「预检」');
    expect(out).toContain('第 4 步「发版」');
    expect(out).toContain('在等：发布还在跑');
    expect(out).toContain('这一趟做完了，发后体检通过。');
    expect(w.err.join('\n')).not.toContain('卡住了');
  });

  it('跟进度到卡住：退出码 3，和法国接活脚本的卡住一致', async () => {
    const why = '等收尾到点还有拖后腿的';
    const blocked = signed({
      schema: 1,
      status: 'blocked',
      phase: 3,
      waiting: null,
      why,
      target: { kind: 'sha', value: SHA },
    });
    const { w, io } = world({
      frames: [
        frame(null, null),
        frame(running(3), accepted),
        frame(blocked, { v: 1, outcome: 'blocked', sha: SHA, by: 'commander', why, phase: 3 }),
      ],
    });
    const code = await train.runTrain(start, io());
    expect(code).toBe(3);
    expect(w.err.join('\n')).toContain(`卡住了：${why}`);
    expect(w.out.join('\n')).toContain('第 3 步「等收尾」');
    expect(w.out.join('\n')).not.toContain('发后体检通过');
  });

  it('孤立暂停标记的撤销只改 last-request：进度文件还是上一趟也算做完，退出码 0，不等到超时', async () => {
    const prev = {
      schema: 1,
      status: 'done',
      phase: 8,
      waiting: null,
      why: '上一趟做完了',
      check: { ok: true, items: [], at: '2026-10-16T04:00:00.000Z' },
    };
    const why = '没有在走的一趟：暂停标记是留下来的，已清；引擎总开关没动';
    const { w, io } = world({
      frames: [
        frame(prev, { v: 1, outcome: 'done', sha: SHA, by: 'cockpit', why: '上一趟做完了' }),
        frame(prev, {
          v: 1,
          ...receipt('abort', null),
          outcome: 'accepted',
          sha: null,
          by: 'commander',
          kind: 'abort',
          why: null,
        }),
        frame(prev, {
          v: 1,
          ...receipt('abort', null),
          outcome: 'aborted',
          sha: null,
          by: 'commander',
          kind: 'abort',
          why,
        }),
      ],
    });
    const code = await train.runTrain(['abort'], io());
    expect(code).toBe(0);
    expect(w.out.join('\n')).toContain(why);
    expect(w.err.join('\n')).not.toContain('还没看到这一趟结束');
    expect(w.out.join('\n')).not.toContain('发后体检通过');
    expect(w.t - T0).toBeLessThan(60_000);
  });

  it('刚写上 accepted、进度还是上一趟的做完了：不当成这次成功', async () => {
    const prev = {
      schema: 1,
      status: 'done',
      phase: 8,
      waiting: null,
      why: null,
      check: { ok: true, items: [], at: '2026-10-16T04:00:00.000Z' },
    };
    const { w, io } = world({
      frames: [frame(prev, null), frame(prev, accepted)],
    });
    const code = await train.runTrain(start, io());
    expect(code).toBe(2);
    expect(w.err.join('\n')).toContain('还没看到这一趟结束');
    expect(w.out.join('\n')).not.toContain('做完了');
  });

  it('ssh 失败照实报没成：退出码 2，不说做完了', async () => {
    const { w, io } = world({
      ssh: () => ({
        status: 255,
        stdout: '',
        stderr: 'client_loop: send disconnect: Connection reset by peer',
      }),
    });
    const code = await train.runTrain(start, io());
    expect(code).toBe(2);
    const err = w.err.join('\n');
    expect(err).toContain('没做成');
    expect(err).toContain('Connection reset by peer');
    expect(w.out.join('\n')).not.toContain('做完了');
    expect(w.out.join('\n')).not.toContain('已写到法国');
  });

  it('status：进度文件读失败回 2，不说没有发版在走', async () => {
    const { w, io } = world({
      ssh: () => ({ status: 1, stdout: '---TRAIN---\n', stderr: 'cat: Permission denied' }),
    });
    const code = await train.runTrain(['status'], io());
    expect(code).toBe(2);
    expect(w.err.join('\n')).toContain('Permission denied');
    expect(w.out.join('\n')).not.toContain('没有发版在走');
  });
});

describe('一键预检借 start：只读，发布锁被占着就拒', () => {
  const argv = () => ['start', '--sha', SHA, '--founder-ok', train.ONEKEY_PREFLIGHT_FOUNDER_OK];
  function gate(opts: { lock: number; ci?: string }) {
    const { w, io } = world({
      ssh: (cmd) => {
        if (cmd.startsWith('flock')) return { status: opts.lock, stdout: '', stderr: '' };
        return { status: 127, stdout: '', stderr: `假法国不认识：${cmd}` };
      },
    });
    const base = io();
    const withRun: TrainIo = {
      ...base,
      cwd: () => '/tmp',
      nodePath: 'node-fake',
      scriptsDir: 'scripts',
      run: (command, args) => {
        if (command === 'gh') {
          return {
            status: 0,
            stdout: JSON.stringify({
              total: 1,
              runs: [{ status: 'completed', conclusion: opts.ci ?? 'success' }],
            }),
            stderr: '',
          };
        }
        if (String(args[0]).endsWith('france.mjs')) {
          return {
            status: 0,
            stdout: JSON.stringify({ anomalies: [{ level: 'note', what: '留意', where: 'x' }] }),
            stderr: '',
          };
        }
        return { status: 127, stdout: '', stderr: '假世界不认识', error: null };
      },
    };
    return { w, io: withRun };
  }

  it('锁被占、主线 CI 绿、法国现状是 JSON：回 2，含预检没过，不写请求，不说预检过了', async () => {
    const { w, io } = gate({ lock: 75 });
    const code = await train.runTrain(argv(), io);
    expect(code).toBe(2);
    const text = `${w.out.join('\n')}\n${w.err.join('\n')}`;
    expect(text).toContain('预检没过');
    expect(text).toContain('.lock 被占着');
    expect(w.out.join('\n')).not.toContain('—— 第 1 步');
    expect(w.out.join('\n')).not.toContain('预检过了');
    expect(w.sshCalls.some((c) => c.includes('request.json'))).toBe(false);
  });

  it('锁空着、CI 绿、法国现状认得出：打出法国现状和第 1 步，不写请求', async () => {
    const { w, io } = gate({ lock: 0 });
    const code = await train.runTrain(argv(), io);
    expect(code).toBe(0);
    expect(w.out.join('\n')).toContain('预检：法国现状');
    expect(w.out.join('\n')).toContain('—— 第 1 步');
    expect(w.sshCalls.some((c) => c.includes('request.json'))).toBe(false);
  });
});

/** 把读进度命令里的两份绝对路径换成临时目录，真的用 sh 跑一遍。 */
function runReadCommand(dir: string): CmdResult {
  const cmd = train
    .readProgressCommand()
    .replaceAll(train.TRAIN_FILE, join(dir, 'release-train.json'))
    .replaceAll(train.LAST_FILE, join(dir, 'last-request.json'));
  const r = runChild('sh', ['-c', cmd]);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('读进度命令：没有文件是空，读不了照实失败', () => {
  it('命令不吞 cat 的错误；缺文件退出码 0 且两份都是空；在但读不了退出码不是 0', () => {
    expect(train.readProgressCommand()).not.toContain('2>/dev/null');
    expect(train.readProgressCommand()).not.toContain('|| true');

    const empty = freshHome();
    const missing = runReadCommand(empty);
    expect(missing.status).toBe(0);
    expect(missing.stderr).toBe('');
    expect(train.parseProgressReply(missing.stdout)).toMatchObject({ ok: true, train: null, last: null });

    const okDir = freshHome();
    writeFileSync(
      join(okDir, 'release-train.json'),
      `${JSON.stringify({ schema: 1, status: 'running', phase: 0 })}\n`,
    );
    writeFileSync(
      join(okDir, 'last-request.json'),
      `${JSON.stringify({ v: 1, outcome: 'accepted', by: 'commander' })}`,
    );
    const present = runReadCommand(okDir);
    expect(present.status).toBe(0);
    expect(train.parseProgressReply(present.stdout)).toMatchObject({
      ok: true,
      train: { status: 'running', phase: 0 },
      last: { outcome: 'accepted' },
    });

    const denied = freshHome();
    const blocked = join(denied, 'release-train.json');
    writeFileSync(blocked, '{}\n');
    chmodSync(blocked, 0o000);
    const unreadable = runReadCommand(denied);
    // Windows 不认 chmod 0o000（和 root 一样读得出）；跨平台的「在但读不了」由下面同名目录那段管
    if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
      expect(unreadable.status).toBe(0);
    } else {
      expect(unreadable.status).not.toBe(0);
      expect(unreadable.stderr).toMatch(/Permission denied|权限不够/);
    }

    const dirFile = freshHome();
    mkdirSync(join(dirFile, 'release-train.json'));
    const notAFile = runReadCommand(dirFile);
    expect(notAFile.status).not.toBe(0);
    expect(notAFile.stderr).toMatch(/Is a directory|是目录/);
  });
});

const dirs: string[] = [];
const freshHome = () => {
  const d = mkdtempSync(join(tmpdir(), 'release-train-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('法国在跑会话数的只读查询', () => {
  it('查询脚本：连接参数和 france-query.mjs 的 PSQL 一字不差（会话设成只读）；SQL 只有 select', () => {
    expect(sessionsQuery.PSQL).toEqual(franceQuery.PSQL);
    expect(sessionsQuery.PSQL.join(' ')).toContain('default_transaction_read_only=on');
    expect(sessionsQuery.SQL).toMatch(/^select /);
    expect(sessionsQuery.SQL).not.toMatch(/\b(insert|update|delete|drop|alter|truncate|create|grant)\b/i);
    expect(sessionsQuery.SQL).toContain('ended_at is null');
  });

  // 2026-10-13：预检写「法国在跑的会话 0 个」，release.sh 排空却在等 execute 会话——三段一次性会话只写 runs，不写老会话表（#1995）
  it('查询数 runs（三段一次性会话，排空登记的就是它们）；老 Fusion 的会话表已删（#2357），不许再读它，读了库里报「关系不存在」', () => {
    const sql = sessionsQuery.SQL;
    expect(sql).not.toMatch(/session_runs/);
    expect(sql).toMatch(/from runs r/);
    expect(sql).toMatch(/'running', \(select count\(\*\) from runs where ended_at is null\)/);
    expect(sql).toContain("'segment:' || r.segment");
  });

  it('collect：读到几个就是几个；psql 起不来、退出非 0、回的不是 JSON、形状不对都是明确的失败，不是 0', () => {
    const at = () => new Date('2026-10-05T14:00:00Z');
    const good = sessionsQuery.collect(
      () => ({
        status: 0,
        stdout: '{"running":2,"rows":[{"repo":"o/a","n":1,"stage":"execute"}]}\n',
        stderr: '',
        error: null,
      }),
      at,
    );
    expect(good).toMatchObject({ ok: true, running: 2 });
    const zero = sessionsQuery.collect(
      () => ({ status: 0, stdout: '{"running":0,"rows":[]}', stderr: '', error: null }),
      at,
    );
    expect(zero).toMatchObject({ ok: true, running: 0 });
    for (const bad of [
      { status: null, stdout: '', stderr: '', error: 'ENOENT' },
      { status: 2, stdout: '', stderr: 'FATAL: no pg_hba entry', error: null },
      { status: 0, stdout: '不是 JSON', stderr: '', error: null },
      { status: 0, stdout: '{"running":"2","rows":[]}', stderr: '', error: null },
      { status: 0, stdout: '', stderr: '', error: null },
    ]) {
      const r = sessionsQuery.collect(() => bad, at);
      expect(r.ok).toBe(false);
      expect(r.running).toBeUndefined();
      expect(r.why).toBeTruthy();
    }
  });

  it('realRun：不是那一条 psql 命令就不起', () => {
    expect(sessionsQuery.realRun(['rm', '-rf', 'x'], '')).toMatchObject({
      status: null,
      error: '不许起这条命令',
    });
  });

  it('parseSessions：认得对的；认不出、法国自己报失败都是 ok: false', () => {
    const line = (o: object) => JSON.stringify({ app: 'fleet-france-sessions', schema: 1, at: 'x', ...o });
    expect(sessionsLib.parseSessions(line({ ok: true, running: 3, rows: [] }))).toMatchObject({
      ok: true,
      running: 3,
    });
    expect(sessionsLib.parseSessions(line({ ok: false, why: '连不上库' }))).toMatchObject({
      ok: false,
      kind: 'query-failed',
    });
    expect(sessionsLib.parseSessions(line({ ok: true, running: -1, rows: [] }))).toMatchObject({
      ok: false,
      kind: 'bad-shape',
    });
    expect(sessionsLib.parseSessions('{"app":"别的","schema":1}')).toMatchObject({
      ok: false,
      kind: 'bad-shape',
    });
    expect(sessionsLib.parseSessions('')).toMatchObject({ ok: false, kind: 'bad-json' });
    expect(sessionsLib.parseSessions('<html>')).toMatchObject({ ok: false, kind: 'bad-json' });
  });

  it('fetchRunningSessions：没配 ssh 名字就明说；用本机 node 冒充 ssh 走一遍整条路（读到、读不到、法国那头失败）', async () => {
    const empty = freshHome();
    expect(await sessionsLib.fetchRunningSessions({ home: empty, env: {} })).toMatchObject({
      ok: false,
      kind: 'not-configured',
    });

    const run = (script: string) =>
      sessionsLib.fetchRunningSessions({
        home: empty,
        env: { FLEET_FRANCE_SSH: 'fake-france' },
        scriptFile: join(SCRIPTS, 'france-sessions-query.mjs'),
        command: process.execPath, // 假 ssh：用本机 node 跑一段话，不连任何机器
        argsFor: () => ['-e', script],
        timeoutMs: 15_000,
      });
    const reply = (o: object) =>
      `console.log(JSON.stringify({app:'fleet-france-sessions',schema:1,at:'x',...${JSON.stringify(o)}}))`;
    expect(
      await run(reply({ ok: true, running: 2, rows: [{ repo: 'o/a', n: 3, stage: 'execute' }] })),
    ).toMatchObject({
      ok: true,
      running: 2,
    });
    expect(await run(reply({ ok: true, running: 0, rows: [] }))).toMatchObject({ ok: true, running: 0 });
    expect(await run('process.stderr.write("连不上库\\n"); process.exit(1)')).toMatchObject({
      ok: false,
      kind: 'query-failed',
    });
    expect(await run('process.stderr.write("Permission denied\\n"); process.exit(255)')).toMatchObject({
      ok: false,
      kind: 'ssh-failed',
    });
    expect(await run('console.log("乱的")')).toMatchObject({ ok: false, kind: 'bad-json' });
  });
});

describe('release.sh 发完不再置关（决定 0032 第 4 条、#1256）', () => {
  const releaseSh = readFileSync(fileURLToPath(new URL('../../deploy/release.sh', import.meta.url)), 'utf8');
  /** 发完置关那两层留下的痕迹：函数、命令、记录文件。 */
  const AUTO_OFF_TRACES = [
    'engine_off_after_release',
    'dispatch_off_on_milestone',
    'engine_off_run',
    'dispatch_off_run',
    '.dispatch-off-milestone',
    'fleet-api.ts engine',
    'fleet-api.ts dispatch',
  ];
  const tracesIn = (text: string) => AUTO_OFF_TRACES.filter((x) => text.includes(x));
  it('release.sh 里没有「发完一律置关总开关」「发 v<N> 版置关接活开关」这两层：函数、命令、记录文件都不在', () => {
    expect(tracesIn(releaseSh)).toEqual([]);
  });
  it('【故意造出的失败】放回一个发完置关的调用或命令：检查抓得到', () => {
    expect(tracesIn(`${releaseSh}\nengine_off_after_release "$SHA" || true\n`)).toEqual([
      'engine_off_after_release',
    ]);
    expect(tracesIn(`${releaseSh}\n"$NODE" packages/api/src/bin/fleet-api.ts engine off\n`)).toEqual([
      'fleet-api.ts engine',
    ]);
  });
});

describe('#3409 仅消费本请求的 attempt 与体检', () => {
  const start = ['start', '--sha', SHA, '--founder-ok', FOUNDER];
  const foreignId = '22222222-2222-4222-8222-222222222222';
  const done = () =>
    signed({ status: 'done', phase: 8, check: { ok: true, items: [], at: '2026-10-16T05:10:00.000Z' } });
  const foreign = () => JSON.parse(JSON.stringify(done()).replaceAll(REQUEST_ID, foreignId));

  it('本请求 done 即使 last 已被别的发布覆盖仍成功；不依赖文本变化', async () => {
    const state = done();
    const { w, io } = world({
      frames: [frame(state, null), frame(state, { ...accepted, requestId: foreignId, outcome: 'done' })],
    });
    expect(await train.runTrain(start, io())).toBe(0);
    expect(w.sshCalls).toContain('readlink /srv/fleet-dao-releases/current');
  });

  it.each([
    ['accepted 加 foreign train', () => foreign(), { ...accepted }],
    [
      '本请求 done last 加 foreign train',
      () => foreign(),
      { ...accepted, outcome: 'done', check: { ok: true } },
    ],
    [
      'foreign done last 加本请求 running',
      () => running(4),
      { ...accepted, requestId: foreignId, outcome: 'done', check: { ok: true } },
    ],
  ])('%s 不串线', async (_label, state, last) => {
    const { w, io } = world({ frames: [frame(null, null), frame(state(), last)] });
    expect(await train.runTrain(start, io())).toBe(2);
    expect(w.out.join('\n')).not.toContain('做完了');
  });

  it.each(['metadata', 'different-sha', 'old-same-sha'])('旧记录 %s 不能变成本次成功', async (scenario) => {
    const stale = foreign();
    if (scenario === 'metadata') stale.updatedAt = '2026-10-16T05:11:00.000Z';
    if (scenario === 'different-sha') {
      stale.target.value = 'b'.repeat(40);
      stale.requests[0].target = 'b'.repeat(40);
      stale.requests[0].identity.sha = 'b'.repeat(40);
    }
    const { w, io } = world({ frames: [frame(null, null), frame(stale, accepted)] });
    expect(await train.runTrain(start, io())).toBe(2);
    expect(w.out.join('\n')).not.toContain('做完了');
  });

  it.each(['attemptId', 'sha', 'at', 'ok'])('done 的 check.%s 不合格必须非 0', async (field) => {
    const state = done();
    const check = state.requests[0]?.check;
    if (!check) throw new Error('测试缺少体检');
    check[field] = field === 'ok' ? false : field === 'at' ? '2026-10-15T00:00:00Z' : 'wrong';
    const { w, io } = world({ frames: [frame(null, null), frame(state, accepted)] });
    expect(await train.runTrain(start, io())).toBe(3);
    expect(w.sshCalls).not.toContain('readlink /srv/fleet-dao-releases/current');
  });

  it.each(['wrong-sha', 'unreadable', 'malformed'])('独立 current 复核 %s 都明确失败', async (problem) => {
    const state = done();
    const { w, io } = world({ frames: [frame(null, null), frame(state, accepted)] });
    const inner = io();
    const ssh = inner.ssh;
    inner.ssh = (cmd) =>
      cmd.startsWith('readlink')
        ? {
            status: problem === 'unreadable' ? 1 : 0,
            stdout: problem === 'wrong-sha' ? 'b'.repeat(40) : problem === 'malformed' ? './current' : '',
            stderr: problem === 'unreadable' ? 'Permission denied' : '',
          }
        : ssh(cmd);
    expect(await train.runTrain(start, inner)).toBe(2);
    expect(w.out.join('\n')).not.toContain('这一趟做完了');
  });

  it('本请求拒绝优先；另一趟相同目标成功不翻案', async () => {
    const { w, io } = world({
      frames: [frame(null, null), frame(foreign(), { ...accepted, outcome: 'refused', why: '已有发布' })],
    });
    expect(await train.runTrain(start, io())).toBe(1);
    expect(w.err.join('\n')).toContain('已有发布');
  });

  it('显式多跳后继可核实成功，原失败仍返回 2 且标明哪次后继', async () => {
    const state = done();
    const original = state.requests[0];
    if (!original || !state.check) throw new Error('测试缺少 attempt/体检');
    original.status = 'failed';
    original.why = '原发布失败';
    original.supersededBy = foreignId;
    const successor = structuredClone(original);
    successor.identity.requestId = foreignId;
    successor.identity.by = '自动发版 决定0088';
    successor.parent = REQUEST_ID;
    successor.supersededBy = '33333333-3333-4333-8333-333333333333';
    const third = structuredClone(successor);
    third.identity.requestId = successor.supersededBy;
    third.parent = foreignId;
    third.supersededBy = null;
    third.status = 'done';
    third.check = { ...state.check, attemptId: third.identity.requestId };
    state.requests.push(successor, third);
    state.requestId = third.identity.requestId;
    state.check = third.check;
    const { w, io } = world({
      frames: [
        frame(null, null),
        frame(state, { ...accepted, requestId: third.identity.requestId, outcome: 'done' }),
      ],
    });
    expect(await train.runTrain(start, io())).toBe(2);
    expect(w.err.join('\n')).toContain('原发布失败');
    expect(w.err.join('\n')).toContain('33333333');
    expect(w.err.join('\n')).toContain('后继已完成并核实在用版本');
  });

  it.each(['cycle', 'limit', 'one-way'])('身份链 %s 明确失败', async (problem) => {
    const state = done();
    const original = state.requests[0];
    if (!original) throw new Error('测试缺少 attempt');
    if (problem === 'cycle') original.parent = REQUEST_ID;
    if (problem === 'one-way') original.supersededBy = foreignId;
    if (problem === 'limit') state.requests = Array.from({ length: 17 }, () => structuredClone(original));
    const { io } = world({ frames: [frame(null, null), frame(state, accepted)] });
    expect(await train.runTrain(start, io())).toBe(2);
  });

  it('已 accepted 后读失败不能当成空或成功', async () => {
    const { io } = world({ frames: [frame(null, null), frame(running(4), accepted)] });
    const inner = io();
    const ssh = inner.ssh;
    let reads = 0;
    inner.ssh = (cmd) =>
      cmd.includes('---TRAIN---') && ++reads > 2
        ? { status: 1, stdout: '', stderr: 'Permission denied' }
        : ssh(cmd);
    expect(await train.runTrain(start, inner)).toBe(2);
  });
});

describe('#3409 UUID 直读归档', () => {
  const start = ['start', '--sha', SHA, '--founder-ok', FOUNDER];
  const foreignId = '22222222-2222-4222-8222-222222222222';
  function currentSegment() {
    const state = JSON.parse(
      JSON.stringify(
        signed({ status: 'done', phase: 8, check: { ok: true, items: [], at: '2026-10-16T05:10:00.000Z' } }),
      ).replaceAll(REQUEST_ID, foreignId),
    );
    state.previousSegment = `${REQUEST_ID}--${REQUEST_ID}--${'a'.repeat(64)}.json`;
    return state;
  }
  it('跨段原失败来自真实归档，保留非 0；不把当前同 SHA 成功说成其后继', async () => {
    const current = currentSegment();
    const old = signed({ status: 'failed', phase: 7, why: '归档里的原失败', check: null });
    const { w, io } = world({
      frames: [frame(null, null), frame(current, { ...accepted, requestId: foreignId, outcome: 'done' })],
    });
    const inner = io();
    const ssh = inner.ssh;
    inner.ssh = (cmd) =>
      cmd.includes('/request-segments/by-request/')
        ? { status: 0, stdout: JSON.stringify(old), stderr: '' }
        : ssh(cmd);
    expect(await train.runTrain(start, inner)).toBe(2);
    expect(w.err.join('\n')).toContain('归档里的原失败');
    expect(w.err.join('\n')).toContain('承接关系未核实');
    expect(w.sshCalls).not.toContain('readlink /srv/fleet-dao-releases/current');
  });
  it.each(['bad-pointer', 'unreadable', 'wrong-identity', 'bad-json'])(
    '归档 %s 明确失败',
    async (problem) => {
      const current = currentSegment();
      if (problem === 'bad-pointer') current.previousSegment = '../../somewhere';
      const { io } = world({ frames: [frame(null, null), frame(current, accepted)] });
      const inner = io();
      const ssh = inner.ssh;
      inner.ssh = (cmd) =>
        cmd.includes('/request-segments/by-request/')
          ? {
              status: problem === 'unreadable' ? 1 : 0,
              stdout: problem === 'bad-json' ? '{' : JSON.stringify(current),
              stderr: 'archive unavailable',
            }
          : ssh(cmd);
      expect(await train.runTrain(start, inner)).toBe(2);
    },
  );
  it('归档读取受同一总截止约束，路径只收小写 UUID', async () => {
    expect(() => train.readArchivedRequestCommand('../escape')).toThrow();
    expect(() => train.readArchivedRequestCommand('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')).toThrow();
    const current = currentSegment();
    const { w, io } = world({ frames: [frame(null, null), frame(current, accepted)] });
    const inner = io();
    const ssh = inner.ssh;
    inner.ssh = (cmd) => {
      if (cmd.includes('/request-segments/by-request/')) {
        w.t += 60_001;
        return { status: 0, stdout: JSON.stringify(signed({ status: 'failed', why: '旧失败' })), stderr: '' };
      }
      return ssh(cmd);
    };
    expect(await train.runTrain(start, inner)).toBe(2);
    expect(w.err.join('\n')).toContain('总时限已到');
  });
});
