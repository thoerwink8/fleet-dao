// 钉住「Mirasim 的引导由钩子取原文、当场转给模型」（#1743，补决定 0078；改标准：agents/test/rules/ 在 standard-paths.json 里）。
// 事实（指挥官 2026-10-11 03:05–03:58 四轮真 Mirasim 会话实测）：Mirasim 收到引导当场就写进 Claude Code 的 stdin
// （steers[].at = 03:37:01），是 Claude Code 要等后台子代理都跑完才读进来（03:39:39 子代理收场后才进会话）。
// 叫这一轮结束没用：结束了引导照样等子代理（晚 2 分 05 秒）；后台子代理一轮结束也不会被杀。所以：
// 1. 主对话每次调工具前（agents/hooks/main-thread.mjs）读 ~/.mirasim/diag/ 当前和上一小时的 ev-<UTC 年月日时>.ndjson，
//    找本会话的 turn.steer；会话记录里那之后没收到创始人的话，就从 Mirasim 取引导原文（ui-cli raw 订阅这个会话，snapshot.steers），
//    拒这次调用、理由带原文，叫它先回一句、接着干活、不用结束这一轮；记下转过的（steer-shown/<会话号>.json），同一条不再拦。
// 2. 收尾钩子（agents/hooks/stop.mjs）收尾时有没转过的引导：decision block，reason 带原文（写最后一段话时到的，调工具前钩子没机会拦）。
//    PR 原来「有引导在等就放行收尾」那段删了：开着无人值守照旧挡。
// 3. 取不到原文（ui-cli 起不来、回的认不出、这一轮里没有它）：不拦，systemMessage 写「引导检查没查成：…读不到原文（原因）」。
// 4. 后台任务完成通知（<task-notification>）开的新一轮、Stop 钩子挡回来的「Stop hook feedback:」不是创始人的话，不算送到。
// 5. 子代理的调用（输入带 agent_id）不管；diag 读不了明说没查成；没装 Mirasim 不说话。
// 测试不起真 ui-cli、不读真 ~/.mirasim、不写真 ~/.fleet-dao：取原文那一步在进程内换成假的，从命令行进来时换成临时目录里的假 server.cjs。
// 每种各配一条故意造出的失败。
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runChild } from '../child.ts';

interface Verdict {
  deny?: string;
  notice?: string;
}
interface SteerText {
  text: string;
  at: number;
}
type Fetch = (root: string, sessionId: string) => SteerText[];
interface Opts {
  settleMs?: number;
  sleep?: (ms: number) => void;
  now?: number;
  mirasim?: string;
  fetchSteers?: Fetch;
  shownDir?: string;
}
interface MainThreadLib {
  check(raw: string, opts?: Opts): Verdict;
  diagFile(root: string, ms: number): string;
  fetchSteers: Fetch;
  mirasimServer(root: string): string;
  shownFile(dir: string, sessionId: string): string;
  steerRelay(steers: SteerText[]): string;
}
const HOOKS = fileURLToPath(new URL('../../hooks/', import.meta.url));
const HOOK = join(HOOKS, 'main-thread.mjs');
const STOP = join(HOOKS, 'stop.mjs');
const UNATTENDED = join(HOOKS, 'unattended.mjs');
const lib = (await import(pathToFileURL(HOOK).href)) as MainThreadLib;

const dir = mkdtempSync(join(tmpdir(), 'mirasim-steer-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;
const fresh = (name: string) => {
  seq += 1;
  const d = join(dir, `${name}-${seq}`);
  mkdirSync(d, { recursive: true });
  return d;
};

/** 10-11 实测那一轮（UTC）：03:37:01 发引导、03:37:21 回了 PONG；diag 记的时刻和 Mirasim steers[].at 差几毫秒 */
const SID = 'a1138385-f089-4c63-8a4d-3baca0ae42fc';
const OTHER = 'a8378600-7dde-49ad-a8cf-4ab8e3c66d8d';
const STEER = '2026-10-10T19:37:01.200Z';
const STEER_AT = Date.parse('2026-10-10T19:37:01.180Z');
const PROBE = 'STEER-PROBE：收到这句马上回复 PONG';
/** 引导发出后它又要调一次工具：这次就该转 */
const NOW = Date.parse('2026-10-10T19:37:15.000Z');

type Row = Record<string, unknown>;
/** Mirasim diag 的几种行，照本机 ~/.mirasim/diag/ev-<UTC 年月日时>.ndjson 的真形状造 */
const ev = {
  steer: (ts: string, sessionId = SID): Row => ({
    ts,
    bootId: '8053f523dc6c',
    seq: 37251,
    kind: 'event',
    name: 'turn.steer',
    sessionId,
    surface: 'desktop',
    eventId: '3352d4cc-4c3a-4f21-8b9c-3af6f985e251:09a78f6f45b9:731',
  }),
  steerFrame: (ts: string, sessionId = SID): Row => ({
    ts,
    bootId: '8053f523dc6c',
    seq: 37250,
    kind: 'frame.in',
    frame: 'steer',
    sessionKey: `claude:${sessionId}`,
  }),
  noise: (ts: string): Row => ({ ts, bootId: '8053f523dc6c', seq: 1, kind: 'frame.in', frame: 'getConfig' }),
};

/** 在 <root>/diag/ 里写一个小时的事件文件；rows 按真文件的样子一行一份 JSON */
function writeDiag(root: string, hourMs: number, rows: Row[], tail = ''): string {
  const file = lib.diagFile(root, hourMs);
  mkdirSync(join(root, 'diag'), { recursive: true });
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n${tail}`);
  return file;
}

/** 会话记录（transcript）的几种行，照 ~/.claude/projects/D--frank-fleet-dao/<会话号>.jsonl 的真形状造 */
const tr = {
  prompt: (ts: string, text = '做 12 次 sleep 15'): Row => ({
    type: 'user',
    isSidechain: false,
    message: { role: 'user', content: [{ type: 'text', text }] },
    timestamp: ts,
  }),
  enqueue: (ts: string, content?: string): Row => ({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: ts,
    sessionId: SID,
    ...(content === undefined ? {} : { content }),
  }),
  dequeue: (ts: string): Row => ({
    type: 'queue-operation',
    operation: 'dequeue',
    timestamp: ts,
    sessionId: SID,
  }),
  toolUse: (ts: string, id: string): Row => ({
    type: 'assistant',
    isSidechain: false,
    message: {
      id: `m-${id}`,
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: {} }],
    },
    timestamp: ts,
  }),
  result: (ts: string, id: string): Row => ({
    type: 'user',
    isSidechain: false,
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'ok' }] },
    timestamp: ts,
  }),
  /** 命令行里中途打的字：queued_command、commandMode prompt */
  directive: (ts: string, text: string, origin?: Row): Row => ({
    type: 'attachment',
    isSidechain: false,
    attachment: {
      type: 'queued_command',
      prompt: [{ type: 'text', text }],
      commandMode: 'prompt',
      timestamp: ts,
      ...(origin === undefined ? {} : { origin }),
    },
    timestamp: ts,
  }),
  stopSummary: (ts: string): Row => ({
    type: 'system',
    subtype: 'stop_hook_summary',
    isSidechain: false,
    timestamp: ts,
  }),
};

/** 10-11 那一轮：开口、起后台子代理、sleep 15 循环；引导 19:37:01 发出之后还在调工具 */
const turnRows = (): Row[] => [
  tr.enqueue('2026-10-10T19:36:30.030Z'),
  tr.dequeue('2026-10-10T19:36:30.031Z'),
  tr.prompt('2026-10-10T19:36:30.040Z'),
  tr.toolUse('2026-10-10T19:36:40.000Z', 't1'),
  tr.result('2026-10-10T19:36:55.100Z', 't1'),
  tr.toolUse('2026-10-10T19:36:56.000Z', 't2'),
  tr.result('2026-10-10T19:37:11.100Z', 't2'),
];

function transcript(rows: Row[]): string {
  seq += 1;
  const file = join(dir, `t${seq}.jsonl`);
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return file;
}

/** 一份 Mirasim 家目录：当前这一小时的 diag 里有 10-11 那条引导 */
function mirasimWithSteer(rows: Row[] = [ev.steerFrame(STEER), ev.steer(STEER)]): string {
  const root = fresh('mirasim');
  writeDiag(root, NOW - 3_600_000, [ev.noise('2026-10-10T18:59:59.000Z')]);
  writeDiag(root, NOW, [ev.noise('2026-10-10T19:00:01.000Z'), ...rows]);
  return root;
}

/** 进程内替掉取原文那一步：记下被叫了几次、叫的哪个会话 */
function fakeFetch(answer: SteerText[] | Error = [{ text: PROBE, at: STEER_AT }]) {
  const calls: string[] = [];
  const fn: Fetch = (_root, sessionId) => {
    calls.push(sessionId);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fn, calls };
}

const input = (path: unknown, extra: Row = {}) =>
  JSON.stringify({
    session_id: SID,
    transcript_path: path,
    cwd: '/work',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'sleep 15' },
    tool_use_id: 'toolu_now',
    ...extra,
  });

interface Env {
  mirasim: string;
  fetch: Fetch;
  shown: string;
  now?: number;
}
const check = (raw: string, e: Env, l: MainThreadLib = lib) =>
  l.check(raw, {
    settleMs: 0,
    now: e.now ?? NOW,
    mirasim: e.mirasim,
    fetchSteers: e.fetch,
    shownDir: e.shown,
  });
/** 一套全新的：带引导的 Mirasim 家目录、假的取原文、空的 steer-shown 目录 */
const setup = (answer?: SteerText[] | Error, rows?: Row[]) => {
  const f = fakeFetch(answer);
  return { env: { mirasim: mirasimWithSteer(rows), fetch: f.fn, shown: fresh('shown') }, calls: f.calls };
};

describe('有没转过的引导：拒这次调用，理由带原文，叫它先回、接着干、不用结束这一轮', () => {
  it('10-11 那次：引导发出后又要调工具，拒；理由带北京时刻和原文、先回一句、不用结束这一轮、稍后再送进来说前面已回', () => {
    const { env, calls } = setup();
    const v = check(input(transcript(turnRows())), env);
    expect(v.deny).toBe(lib.steerRelay([{ text: PROBE, at: STEER_AT }]));
    expect(v.deny).toContain(`10-11 03:37『${PROBE}』`);
    expect(v.deny).toContain('先用一句话回它');
    expect(v.deny).toContain('不用结束这一轮');
    expect(v.deny).toContain('这条前面已回');
    expect(v.deny).not.toContain('马上结束这一轮');
    expect(v.notice).toBeUndefined();
    expect(calls).toEqual([SID]);
    expect(JSON.parse(readFileSync(lib.shownFile(env.shown, SID), 'utf8'))).toEqual({
      at: Date.parse(STEER),
    });
  });

  it('转过一次后：同一条不再拦、也不再去 Mirasim 取', () => {
    const { env, calls } = setup();
    const t = transcript(turnRows());
    expect(check(input(t), env).deny).toContain(PROBE);
    expect(check(input(t), env)).toEqual({});
    expect(check(input(t), { ...env, now: NOW + 30_000 })).toEqual({});
    expect(calls).toEqual([SID]);
  });

  it('转过之后又来一条：只转新的那条', () => {
    const second = '2026-10-10T19:38:05.000Z';
    /** Mirasim 这一轮记着的引导：第二条到了才加进去 */
    const steers: SteerText[] = [{ text: PROBE, at: STEER_AT }];
    const { env } = setup(steers);
    const t = transcript(turnRows());
    expect(check(input(t), env).deny).toContain(PROBE);
    steers.push({ text: '再加一句：子代理别停', at: Date.parse(second) });
    writeDiag(env.mirasim, NOW, [ev.steer(STEER), ev.steer(second)]);
    const v = check(input(t), { ...env, now: Date.parse('2026-10-10T19:38:10.000Z') });
    expect(v.deny).toContain('再加一句：子代理别停');
    expect(v.deny).not.toContain(PROBE);
  });

  it('diag 里没有这个会话的引导：不去 Mirasim 取（ui-cli 只在有引导在等时才起）', () => {
    const f = fakeFetch();
    const env = {
      mirasim: mirasimWithSteer([ev.steer(STEER, OTHER), ev.steerFrame(STEER)]),
      fetch: f.fn,
      shown: fresh('shown'),
    };
    expect(check(input(transcript(turnRows())), env)).toEqual({});
    expect(f.calls).toEqual([]);
  });

  it('【故意造出的失败】把「转过的不再拦」那句去掉：同一条每次调工具都拦，第二条查得出来', async () => {
    const src = readFileSync(HOOK, 'utf8');
    const want = "if (steer.at <= shownAt) return { kind: 'none' };";
    expect(src).toContain(want);
    const mutant = join(dir, 'main-thread-no-shown.mjs');
    writeFileSync(mutant, src.replace(want, ''));
    const bad = (await import(pathToFileURL(mutant).href)) as MainThreadLib;
    // Mirasim 每次都回一条比上次转过的更晚的（真的 Mirasim 回的是同一条，这里只为让变种走到「转过的不再拦」被去掉的那一步）
    let n = 0;
    const fetch: Fetch = () => {
      n += 1;
      return [{ text: PROBE, at: STEER_AT + n * 1_000 }];
    };
    const env = { mirasim: mirasimWithSteer(), fetch, shown: fresh('shown') };
    const t = transcript(turnRows());
    expect(check(input(t), env, bad).deny).toContain(PROBE);
    expect(check(input(t), env, bad).deny).toContain(PROBE);
    // 同一个取法给原版：第二次不拦、也不去取
    const real = { ...env, shown: fresh('shown') };
    expect(check(input(t), real).deny).toContain(PROBE);
    const before = n;
    expect(check(input(t), real)).toEqual({});
    expect(n).toBe(before);
  });
});

describe('取不到原文：不拦，明说没查成（不当成没有）', () => {
  it.each([
    ['ui-cli 起不来', new Error('connect ECONNREFUSED 127.0.0.1:4970'), 'ECONNREFUSED', null],
    ['这一轮里没有记着它', [], '没有记着它的原文', null],
    [
      '只有上次转过的那条（这条新的还没记进来）',
      [{ text: '老的', at: STEER_AT - 600_000 }],
      '没有记着它的原文',
      STEER_AT - 600_000,
    ],
  ])('%s', (_name, answer, why, shownBefore) => {
    const { env, calls } = setup(answer as SteerText[] | Error);
    const file = lib.shownFile(env.shown, SID);
    if (shownBefore !== null) writeFileSync(file, JSON.stringify({ at: shownBefore }));
    const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const t = transcript(turnRows());
    const v = check(input(t), env);
    expect(v.deny).toBeUndefined();
    expect(v.notice).toMatch(/^引导检查没查成：创始人 10-11 03:37 在 Mirasim 发了一条引导，读不到原文（/);
    expect(v.notice).toContain(why);
    // 没转成就不记：下一次调工具再取一遍
    expect(existsSync(file) ? readFileSync(file, 'utf8') : null).toBe(before);
    check(input(t), env);
    expect(calls).toEqual([SID, SID]);
  });

  it('记不下转过的（steer-shown 位置是个文件）：不拦，明说没查成，免得同一条每次都拦', () => {
    const f = fakeFetch();
    const blocker = join(fresh('shown'), 'not-a-dir');
    writeFileSync(blocker, '');
    const v = check(input(transcript(turnRows())), {
      mirasim: mirasimWithSteer(),
      fetch: f.fn,
      shown: blocker,
    });
    expect(v.deny).toBeUndefined();
    expect(v.notice).toMatch(/^引导检查没查成：.*记不下转过的/);
  });

  it('【故意造出的失败】把「读不到原文」吞成「没有引导」：ui-cli 起不来那条就不报没查成了', async () => {
    const src = readFileSync(HOOK, 'utf8');
    const want = 'miss = why(e);';
    expect(src).toContain(want);
    const mutant = join(dir, 'main-thread-swallow-fetch.mjs');
    writeFileSync(mutant, src.replace(want, "return { kind: 'none' };"));
    const bad = (await import(pathToFileURL(mutant).href)) as MainThreadLib;
    const { env } = setup(new Error('connect ECONNREFUSED'));
    expect(check(input(transcript(turnRows())), env, bad)).toEqual({});
  });
});

describe('真的取原文那一步：读 ui-cli raw 订阅回的 snapshot.steers（临时目录里的假 server.cjs，不起真 ui-cli）', () => {
  /** 在 <root>/app/<版本>/ 放一个假 server.cjs：记下参数，stdout 回 body */
  function fakeServer(root: string, version: string, body: string, exit = 0) {
    const d = join(root, 'app', version);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, 'server.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(join(d, 'args.json'))}, JSON.stringify(process.argv.slice(2)));\n` +
        `process.stdout.write(${JSON.stringify(body)});\nprocess.exit(${exit});\n`,
    );
    return d;
  }
  const reply = (frames: unknown[]) => JSON.stringify({ responses: frames });
  const snapshot = (steers: unknown) => ({ type: 'snapshot', snapshot: { phase: 'running', steers } });

  it('挑最新版本的 server.cjs，订阅 claude:<会话号>、等 snapshot，取出 [{ text, at }]', () => {
    const root = fresh('mirasim');
    fakeServer(root, '0.0.9', reply([]));
    const d = fakeServer(
      root,
      '0.0.465',
      reply([{ type: 'state' }, snapshot([{ text: PROBE, at: STEER_AT }, { text: 7 }])]),
    );
    expect(lib.mirasimServer(root)).toBe(join(d, 'server.cjs'));
    expect(lib.fetchSteers(root, SID)).toEqual([{ text: PROBE, at: STEER_AT }]);
    const args = JSON.parse(readFileSync(join(d, 'args.json'), 'utf8')) as string[];
    expect(args.slice(0, 2)).toEqual(['ui-cli', '--port']);
    expect(args).toContain('raw');
    expect(JSON.parse(args[args.indexOf('raw') + 1] ?? '')).toEqual({
      type: 'subscribe',
      sessionKey: `claude:${SID}`,
    });
    expect(args.slice(args.indexOf('--await'), args.indexOf('--await') + 2)).toEqual(['--await', 'snapshot']);
  });

  it.each([
    ['没有 app 目录', null],
    ['回的不是 JSON', 'oops'],
    ['回的不是 { responses: [] }', JSON.stringify({ ok: true })],
    ['没有 snapshot 帧', reply([{ type: 'state' }])],
    ['steers 不是数组', reply([snapshot('x')])],
  ])('【故意造出的失败】%s：抛出，不当成没有引导', (_name, body) => {
    const root = fresh('mirasim');
    if (body !== null) fakeServer(root, '0.0.1', body);
    expect(() => lib.fetchSteers(root, SID)).toThrow();
  });

  it('ui-cli 退出码不是 0：抛出', () => {
    const root = fresh('mirasim');
    fakeServer(root, '0.0.1', reply([snapshot([{ text: PROBE, at: STEER_AT }])]), 3);
    expect(() => lib.fetchSteers(root, SID)).toThrow();
  });
});

describe('什么算引导已经送到', () => {
  it.each([
    [
      '这一轮结束后作为新的一轮进来（enqueue 不带内容 + 用户消息）',
      [
        tr.stopSummary('2026-10-10T19:39:39.400Z'),
        tr.enqueue('2026-10-10T19:39:39.407Z'),
        tr.prompt('2026-10-10T19:39:39.420Z', PROBE),
      ],
    ],
    ['只有 enqueue（还没写用户消息）', [tr.enqueue('2026-10-10T19:39:39.407Z')]],
    [
      '两次工具调用之间作为 queued_command 送进来（命令行的送法）',
      [tr.directive('2026-10-10T19:37:11.101Z', PROBE)],
    ],
  ])('送到了 —— %s：不转、不去 Mirasim 取', (_name, after) => {
    const { env, calls } = setup();
    const v = check(input(transcript([...turnRows(), ...after])), env);
    expect(v.deny ?? '').not.toContain('钩子先转给你');
    expect(v.notice).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it.each([
    [
      '后台任务完成通知开的新一轮（用户消息以 <task-notification> 开头）',
      [
        tr.prompt(
          '2026-10-10T19:37:12.000Z',
          '<task-notification>\n<status>completed</status>\n</task-notification>',
        ),
      ],
    ],
    [
      '同上、content 是字符串',
      [
        {
          type: 'user',
          isSidechain: false,
          message: { role: 'user', content: '<task-notification>子代理跑完了</task-notification>' },
          timestamp: '2026-10-10T19:37:12.000Z',
        },
      ],
    ],
    [
      'Stop 钩子挡回来的「Stop hook feedback:」',
      [tr.prompt('2026-10-10T19:37:12.000Z', 'Stop hook feedback:\n继续盯工人')],
    ],
    [
      '带 <task-notification> 的 enqueue',
      [
        tr.enqueue(
          '2026-10-10T19:37:12.000Z',
          '<task-notification>\n<status>completed</status>\n</task-notification>',
        ),
      ],
    ],
    [
      '带 Stop hook feedback 的 enqueue',
      [tr.enqueue('2026-10-10T19:37:12.000Z', 'Stop hook feedback:\n继续盯工人')],
    ],
    [
      '子代理交回的报告（origin.kind: peer）',
      [tr.directive('2026-10-10T19:37:12.000Z', '子代理交回的报告', { kind: 'peer' })],
    ],
    [
      '引导之前的开口（早于引导时刻）',
      [tr.enqueue('2026-10-10T19:37:00.000Z'), tr.prompt('2026-10-10T19:37:00.100Z', '更早的话')],
    ],
  ])('不算送到 —— %s：照转', (_name, after) => {
    const { env } = setup();
    const rows =
      (after[0]?.timestamp as string) < STEER
        ? [...turnRows().slice(0, 3), ...after, ...turnRows().slice(3)]
        : [...turnRows(), ...after];
    expect(check(input(transcript(rows)), env).deny).toContain(PROBE);
  });

  it('【故意造出的失败】把「机器开的一轮」认法去掉：任务通知开的新一轮就当成送到了，不转', async () => {
    const src = readFileSync(HOOK, 'utf8');
    const want = "return t.startsWith('<task-notification>') || t.startsWith('Stop hook feedback:');";
    expect(src).toContain(want);
    const mutant = join(dir, 'main-thread-machine-turn.mjs');
    writeFileSync(mutant, src.replace(want, 'return false;'));
    const bad = (await import(pathToFileURL(mutant).href)) as MainThreadLib;
    const { env } = setup();
    const rows = [
      ...turnRows(),
      tr.prompt('2026-10-10T19:37:12.000Z', '<task-notification>子代理跑完了</task-notification>'),
    ];
    expect(check(input(transcript(rows)), env, bad)).toEqual({});
  });

  it('【故意造出的失败】把「那之后」的时刻比较去掉：这一轮开头那次开口就当成送到了，不转', async () => {
    const src = readFileSync(HOOK, 'utf8');
    const want = 'if (ts < since) return false;';
    expect(src).toContain(want);
    const mutant = join(dir, 'main-thread-no-since.mjs');
    writeFileSync(mutant, src.replace(want, ''));
    const bad = (await import(pathToFileURL(mutant).href)) as MainThreadLib;
    const { env } = setup();
    expect(check(input(transcript(turnRows())), env, bad).deny).toBeUndefined();
  });
});

describe('子代理的调用：不管', () => {
  it('输入带 agent_id：有没转过的引导也放行、不去取', () => {
    const { env, calls } = setup();
    expect(check(input(transcript(turnRows()), { agent_id: 'a1b2' }), env)).toEqual({});
    expect(calls).toEqual([]);
  });

  it('【故意造出的失败】agent_id 是空串、不是字符串：不算子代理，照转', () => {
    for (const bad of ['', 7, null]) {
      const { env } = setup();
      const v = check(input(transcript(turnRows()), { agent_id: bad }), env);
      expect(v.deny, JSON.stringify(bad)).toContain(PROBE);
    }
  });
});

describe('diag 读不了：不拦，明说「引导检查没查成」', () => {
  const t = () => transcript(turnRows());
  const run = (mirasim: string) =>
    check(input(t()), { mirasim, fetch: fakeFetch().fn, shown: fresh('shown') });

  it.each([
    ['diag 目录不在', () => fresh('mirasim')],
    [
      '当前和上一小时的文件都不在',
      () => {
        const root = fresh('mirasim');
        writeDiag(root, NOW - 5 * 3_600_000, [ev.steer(STEER)]);
        return root;
      },
    ],
    [
      '当前这一小时的「文件」是个目录',
      () => {
        const root = fresh('mirasim');
        mkdirSync(lib.diagFile(root, NOW), { recursive: true });
        return root;
      },
    ],
    [
      '格式认不出（不是一行一份 JSON）',
      () => {
        const root = fresh('mirasim');
        mkdirSync(join(root, 'diag'), { recursive: true });
        writeFileSync(
          lib.diagFile(root, NOW),
          'ts=2026-10-10T19:37:01Z name=turn.steer\nts=… name=turn.finish\n',
        );
        return root;
      },
    ],
    ['本会话的 turn.steer 时刻认不出', () => mirasimWithSteer([{ ...ev.steer(STEER), ts: '昨天' }])],
  ])('%s', (_name, make) => {
    const v = run(make());
    expect(v.deny).toBeUndefined();
    expect(v.notice).toMatch(/^引导检查没查成：.+/);
  });

  it('有引导、但会话记录读不了：判不了送没送到，也明说没查成、不拦', () => {
    const v = check(input(join(dir, 'gone.jsonl')), {
      mirasim: mirasimWithSteer(),
      fetch: fakeFetch().fn,
      shown: fresh('shown'),
    });
    expect(v.deny).toBeUndefined();
    expect(v.notice).toMatch(/^引导检查没查成：/);
  });

  it('整点刚过、当前这一小时的文件还没开写：上一小时里的引导照样认', () => {
    const root = fresh('mirasim');
    writeDiag(root, Date.parse('2026-10-10T19:59:50.000Z'), [ev.steer('2026-10-10T19:59:50.000Z')]);
    const f = fakeFetch([{ text: PROBE, at: Date.parse('2026-10-10T19:59:50.000Z') }]);
    const v = check(input(t()), {
      mirasim: root,
      fetch: f.fn,
      shown: fresh('shown'),
      now: Date.parse('2026-10-10T20:00:05.000Z'),
    });
    expect(v.deny).toContain(`10-11 03:59『${PROBE}』`);
  });

  it('最后一行还没写完：跳过它，不算认不出', () => {
    const root = fresh('mirasim');
    writeDiag(root, NOW, [ev.steer(STEER)], '{"ts":"2026-10-10T19:37:09.000Z","kind":"fr');
    expect(run(root).deny).toContain(PROBE);
  });

  it('整个 Mirasim 家目录都不在（这台机器没装 Mirasim）：不会有它的引导，不说话', () => {
    expect(run(join(dir, 'no-mirasim-here'))).toEqual({});
  });

  it('【故意造出的失败】把 diag「认不出」吞成「没有引导」：格式坏了那条就不报没查成了', async () => {
    const src = readFileSync(HOOK, 'utf8');
    // 钩子源码里那一句是模板字符串：这里按原文找，$ 和 { 拆开写，免得被当成这边的占位符
    const tail = '$' + '{file} 的格式认不出';
    const want = `throw new Error(\`${tail}`;
    expect(src).toContain(want);
    const mutant = join(dir, 'main-thread-swallow.mjs');
    writeFileSync(mutant, src.replace(want, `return null; (\`${tail}`));
    const bad = (await import(pathToFileURL(mutant).href)) as MainThreadLib;
    const root = fresh('mirasim');
    mkdirSync(join(root, 'diag'), { recursive: true });
    writeFileSync(lib.diagFile(root, NOW), 'ts=2026-10-10T19:37:01Z name=turn.steer\n');
    expect(
      check(input(t()), { mirasim: root, fetch: fakeFetch().fn, shown: fresh('shown') }, bad).notice,
    ).toBeUndefined();
  });
});

/** 真起钩子用的一套：Mirasim 家目录里带假 server.cjs（回 10-11 那条引导的原文）、diag 里 20 秒前有这个会话的引导 */
function cliSetup(opts: { server?: 'ok' | 'fail' | 'none'; steerSession?: string } = {}) {
  const root = fresh('mirasim');
  const steerMs = Date.now() - 20_000;
  writeDiag(root, steerMs, [ev.steer(new Date(steerMs).toISOString(), opts.steerSession ?? SID)]);
  if (opts.server !== 'none') {
    const d = join(root, 'app', '0.0.465');
    mkdirSync(d, { recursive: true });
    const body = JSON.stringify({
      responses: [{ type: 'snapshot', snapshot: { steers: [{ text: PROBE, at: steerMs }] } }],
    });
    writeFileSync(
      join(d, 'server.cjs'),
      opts.server === 'fail'
        ? "process.stderr.write('connect ECONNREFUSED 127.0.0.1:4970');\nprocess.exit(1);\n"
        : `process.stdout.write(${JSON.stringify(body)});\n`,
    );
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FLEET_MIRASIM_DIR: root,
    FLEET_STEER_SHOWN_DIR: fresh('shown'),
    FLEET_UNATTENDED_DIR: fresh('state'),
    FLEET_WORKERS_DIR: fresh('workers'),
    FLEET_WORKER: '',
    CLAUDE_CODE_SESSION_ID: SID,
  };
  const t = transcript([tr.prompt(new Date(steerMs - 60_000).toISOString())]);
  return { env, t };
}

describe('收尾钩子 stop.mjs：收尾时有没转过的引导就挡回去、reason 带原文', { timeout: 0 }, () => {
  const stopInput = (t: string) =>
    JSON.stringify({
      session_id: SID,
      transcript_path: t,
      cwd: fresh('cwd'),
      hook_event_name: 'Stop',
      stop_hook_active: false,
    });
  const run = (hook: string, env: NodeJS.ProcessEnv, t: string) => {
    const r = runChild(process.execPath, [hook], { input: stopInput(t), env });
    expect(r.status).toBe(0);
    return r.stdout.trim() === ''
      ? {}
      : (JSON.parse(r.stdout) as { decision?: string; reason?: string; systemMessage?: string });
  };

  it('没开无人值守、写最后一段话时来了引导：decision block，reason 带原文；再收尾一次（转过了）不挡', () => {
    const { env, t } = cliSetup();
    const first = run(STOP, env, t);
    expect(first.decision).toBe('block');
    expect(first.reason).toContain(PROBE);
    expect(first.reason).toContain('不用结束这一轮');
    expect(run(STOP, env, t).decision).toBeUndefined();
  });

  it('开着无人值守、引导转过了：照旧按无人值守挡（「有引导在等就放行收尾」已删）', () => {
    const { env, t } = cliSetup();
    expect(runChild(process.execPath, [UNATTENDED, 'on'], { env }).status).toBe(0);
    expect(run(STOP, env, t).reason).toContain(PROBE);
    const again = run(STOP, env, t);
    expect(again.decision).toBe('block');
    expect(again.reason).not.toContain(PROBE);
  });

  it('取不到原文：不挡，systemMessage 写明读不到原文和原因', () => {
    const { env, t } = cliSetup({ server: 'fail' });
    const out = run(STOP, env, t);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toMatch(/引导检查没查成：.*读不到原文/);
  });

  it('没装 Mirasim、或引导是别的会话的：不说话', () => {
    const { env, t } = cliSetup({ steerSession: OTHER });
    expect(run(STOP, env, t)).toEqual({});
    expect(run(STOP, { ...env, FLEET_MIRASIM_DIR: join(dir, 'no-mirasim-here') }, t)).toEqual({});
  });

  it('【故意造出的失败】收尾钩子不转引导：写最后一段话时来的引导就没人转了，第一条查得出来', () => {
    const copy = fresh('hooks');
    for (const f of ['stop.mjs', 'main-thread.mjs', 'unattended.mjs', 'git-run.mjs'])
      copyFileSync(join(HOOKS, f), join(copy, f));
    const src = readFileSync(STOP, 'utf8');
    const want = "if (steer.kind === 'relay') {";
    expect(src).toContain(want);
    writeFileSync(join(copy, 'stop.mjs'), src.replace(want, 'if (false) {'));
    const { env, t } = cliSetup();
    expect(run(join(copy, 'stop.mjs'), env, t).decision).toBeUndefined();
  });
});

describe('调工具前钩子从命令行进来', { timeout: 0 }, () => {
  it('有没转过的引导：stdout 是 permissionDecision deny、理由带原文、退出码 0；再调一次不拦', () => {
    const { env, t } = cliSetup();
    const r = runChild(process.execPath, [HOOK], { input: input(t), env });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain(PROBE);
    const again = runChild(process.execPath, [HOOK], { input: input(t), env });
    expect([again.status, again.stdout]).toEqual([0, '']);
  });
});
