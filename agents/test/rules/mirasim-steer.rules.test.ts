// 钉住「Mirasim 的引导在等，就让这一轮先结束」（#1743，补决定 0078；改标准：agents/test/rules/ 在 standard-paths.json 里）。
// 事实（2026-10-10 17:25 实测，会话 a1138385）：Mirasim 的「引导」（turn.steer）要等这一轮结束才交给 Claude Code，
// 两次工具调用之间送不进来：09:25:23.876Z 发出，之后又调了 4 次工具都没收到，09:26:46Z 这一轮结束、0.4 秒后才作为新的一轮进来。
// 无人值守让一轮几小时不结束，引导就卡几小时（10-10 11:47 发的等了 3 小时 14 分）。所以：
// 1. 主对话每次调工具前（agents/hooks/main-thread.mjs），读 ~/.mirasim/diag/ 当前和上一小时的 ev-<UTC 年月日时>.ndjson，
//    找 sessionId 等于本会话号的 turn.steer；会话记录里那之后没收到创始人的话（不是任务通知的 queue-operation enqueue、
//    创始人的 queued_command、新一轮的用户消息），就拒这次调用，叫它写一句收到、马上结束这一轮。
// 2. 这时无人值守的 Stop 钩子（agents/hooks/stop.mjs）放行收尾，不挡。
// 3. 子代理的调用（输入带 agent_id）不管。
// 4. diag 读不了（不在、读不了、认不出）：不拦，systemMessage 写「引导检查没查成：<原因>」，不当成没有引导。
//    整个 ~/.mirasim 都不在（这台机器没装 Mirasim）：不会有 Mirasim 的引导，不说话。
// 每种各配一条故意造出的失败。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runChild } from '../child.ts';

interface Verdict {
  deny?: string;
  notice?: string;
}
type Steer = { kind: 'none' } | { kind: 'pending'; at: number } | { kind: 'unknown'; why: string };
interface MainThreadLib {
  check(
    raw: string,
    opts?: { settleMs?: number; sleep?: (ms: number) => void; now?: number; mirasim?: string },
  ): Verdict;
  diagFile(root: string, ms: number): string;
  pendingSteer(o: { root: string; sessionId: unknown; transcriptPath: unknown; now: number }): Steer;
  steerDeny(at: number): string;
}
const HOOK = fileURLToPath(new URL('../../hooks/main-thread.mjs', import.meta.url));
const STOP = fileURLToPath(new URL('../../hooks/stop.mjs', import.meta.url));
const UNATTENDED = fileURLToPath(new URL('../../hooks/unattended.mjs', import.meta.url));
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

/** 17:25 那次实测的会话号和时刻（UTC） */
const SID = 'a1138385-f089-4c63-8a4d-3baca0ae42fc';
const OTHER = 'a8378600-7dde-49ad-a8cf-4ab8e3c66d8d';
const SUBMIT = '2026-10-10T09:25:22.018Z';
const STEER = '2026-10-10T09:25:23.876Z';
/** 引导发出后它又调了一次工具：这次就该被拒 */
const NOW = Date.parse('2026-10-10T09:25:40.000Z');

type Row = Record<string, unknown>;
/** Mirasim diag 的几种行，照本机 ~/.mirasim/diag/ev-2026101009.ndjson 的真形状造 */
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
  submit: (ts: string, sessionId = SID): Row => ({
    ts,
    bootId: '8053f523dc6c',
    seq: 37247,
    kind: 'event',
    name: 'turn.submit',
    sessionId,
    surface: 'desktop',
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
  prompt: (ts: string, text = '做 6 次 sleep 15'): Row => ({
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
  notification: (ts: string): Row => ({
    type: 'attachment',
    isSidechain: false,
    attachment: {
      type: 'queued_command',
      prompt: '<task-notification>子代理跑完了</task-notification>',
      commandMode: 'task-notification',
      origin: { kind: 'task-notification' },
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

/** 17:25 那一轮：09:25:22 开口，第 1、2 次 sleep；引导 09:25:23.876 发出；之后还在调工具 */
const turnRows = (): Row[] => [
  tr.enqueue('2026-10-10T09:25:22.030Z'),
  tr.dequeue('2026-10-10T09:25:22.031Z'),
  tr.prompt('2026-10-10T09:25:22.040Z'),
  tr.toolUse('2026-10-10T09:25:23.000Z', 't1'),
  tr.result('2026-10-10T09:25:38.100Z', 't1'),
  tr.toolUse('2026-10-10T09:25:39.000Z', 't2'),
];

function transcript(rows: Row[]): string {
  seq += 1;
  const file = join(dir, `t${seq}.jsonl`);
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return file;
}

/** 一份 Mirasim 家目录：当前这一小时的 diag 里有 17:25 那条引导 */
function mirasimWithSteer(rows: Row[] = [ev.submit(SUBMIT), ev.steerFrame(STEER), ev.steer(STEER)]): string {
  const root = fresh('mirasim');
  writeDiag(root, NOW - 3_600_000, [ev.noise('2026-10-10T08:59:59.000Z')]);
  writeDiag(root, NOW, [ev.noise('2026-10-10T09:00:01.000Z'), ...rows]);
  return root;
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

const check = (raw: string, mirasim: string, now = NOW) => lib.check(raw, { settleMs: 0, now, mirasim });

describe('引导还没送进来：拒这次调用，叫它马上结束这一轮', () => {
  it('17:25 那次：引导发出后又要调工具，拒；理由写明北京时刻、写一句收到、马上结束这一轮、后台子代理不受影响', () => {
    const v = check(input(transcript(turnRows())), mirasimWithSteer());
    expect(v.deny).toBe(
      '创始人 10-10 17:25 在 Mirasim 发了一条引导，要等这一轮结束才送进来：写一句收到、马上结束这一轮，不要再调工具；后台子代理不受影响。',
    );
    expect(v.deny).toBe(lib.steerDeny(Date.parse(STEER)));
    expect(v.notice).toBeUndefined();
  });

  it('整点刚过、当前这一小时的文件还没开写：上一小时里的引导照样认', () => {
    const root = fresh('mirasim');
    writeDiag(root, Date.parse('2026-10-10T09:59:50.000Z'), [ev.steer('2026-10-10T09:59:50.000Z')]);
    const v = check(input(transcript(turnRows())), root, Date.parse('2026-10-10T10:00:05.000Z'));
    expect(v.deny).toContain('创始人 10-10 17:59 在 Mirasim 发了一条引导');
  });

  it('引导之后只来了任务通知（enqueue 带 <task-notification>、queued_command 是 task-notification）、子代理交回的话、引导之前的开口：都不算送到，照拒', () => {
    const after = [
      tr.enqueue(
        '2026-10-10T09:25:30.000Z',
        '<task-notification>\n<status>completed</status>\n</task-notification>',
      ),
      tr.notification('2026-10-10T09:25:30.001Z'),
      tr.directive('2026-10-10T09:25:31.000Z', '子代理交回的报告', { kind: 'peer' }),
    ];
    const v = check(input(transcript([...turnRows(), ...after])), mirasimWithSteer());
    expect(v.deny).toContain('马上结束这一轮');
  });

  it('【故意造出的失败】把「那之后」的时刻比较去掉（任何一条 enqueue 都当送到）：17:25 那次就放过去了，第一条查得出来', async () => {
    const src = readFileSync(HOOK, 'utf8');
    const want = 'if (ts < since) return false;';
    expect(src).toContain(want);
    const mutant = join(dir, 'main-thread-no-since.mjs');
    writeFileSync(mutant, src.replace(want, ''));
    const bad = (await import(pathToFileURL(mutant).href)) as MainThreadLib;
    const v = bad.check(input(transcript(turnRows())), {
      settleMs: 0,
      now: NOW,
      mirasim: mirasimWithSteer(),
    });
    expect(v.deny).toBeUndefined();
  });
});

describe('引导已经送进来了：不拦', () => {
  it.each([
    [
      '这一轮结束后作为新的一轮进来（enqueue 不带内容 + 用户消息）',
      [
        tr.stopSummary('2026-10-10T09:26:46.400Z'),
        tr.enqueue('2026-10-10T09:26:46.407Z'),
        tr.dequeue('2026-10-10T09:26:46.408Z'),
        tr.prompt('2026-10-10T09:26:46.420Z', '你是什么时候看到这条的？'),
      ],
    ],
    ['只有 enqueue（还没写用户消息）', [tr.enqueue('2026-10-10T09:26:46.407Z')]],
    [
      '两次工具调用之间作为 queued_command 送进来（命令行的送法）',
      [
        tr.result('2026-10-10T09:25:38.100Z', 't2'),
        tr.directive('2026-10-10T09:25:38.101Z', '你是什么时候看到这条的？'),
      ],
    ],
  ])('%s：不再叫它结束这一轮', (_name, after) => {
    const v = check(input(transcript([...turnRows(), ...after])), mirasimWithSteer());
    expect(v.deny ?? '').not.toContain('马上结束这一轮');
    expect(v.notice).toBeUndefined();
  });

  it('送到之后：新一轮开头直接放行；中途作为 queued_command 送进来的，照第 1 条先回一句', () => {
    const asNewTurn = [
      tr.enqueue('2026-10-10T09:26:46.407Z'),
      tr.prompt('2026-10-10T09:26:46.420Z', '几点看到的？'),
    ];
    expect(check(input(transcript([...turnRows(), ...asNewTurn])), mirasimWithSteer())).toEqual({});
    const midTurn = [
      tr.result('2026-10-10T09:25:38.100Z', 't2'),
      tr.directive('2026-10-10T09:25:38.101Z', '几点看到的？'),
    ];
    expect(check(input(transcript([...turnRows(), ...midTurn])), mirasimWithSteer()).deny).toContain(
      '先用一句话回它',
    );
  });

  it('diag 里的引导是别的会话的、或者只有 steer 帧没有 turn.steer 事件：不算这个会话的引导', () => {
    expect(check(input(transcript(turnRows())), mirasimWithSteer([ev.steer(STEER, OTHER)]))).toEqual({});
    expect(check(input(transcript(turnRows())), mirasimWithSteer([ev.steerFrame(STEER)]))).toEqual({});
  });

  it('【故意造出的失败】送到的那条早于引导（是这一轮开头那次开口）：不算，照拒', () => {
    const before = [
      tr.enqueue('2026-10-10T09:25:23.000Z'),
      tr.prompt('2026-10-10T09:25:23.100Z', '更早的话'),
    ];
    const rows = [...turnRows().slice(0, 3), ...before, ...turnRows().slice(3)];
    expect(check(input(transcript(rows)), mirasimWithSteer()).deny).toContain('马上结束这一轮');
  });
});

describe('子代理的调用：不管', () => {
  it('输入带 agent_id：有没送进来的引导也放行', () => {
    expect(check(input(transcript(turnRows()), { agent_id: 'a1b2' }), mirasimWithSteer())).toEqual({});
  });

  it('【故意造出的失败】agent_id 是空串、不是字符串：不算子代理，照拒', () => {
    for (const bad of ['', 7, null]) {
      const v = check(input(transcript(turnRows()), { agent_id: bad }), mirasimWithSteer());
      expect(v.deny, JSON.stringify(bad)).toContain('马上结束这一轮');
    }
  });
});

describe('diag 读不了：不拦，明说「引导检查没查成」', () => {
  const t = () => transcript(turnRows());

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
          'ts=2026-10-10T09:25:23Z name=turn.steer\nts=… name=turn.finish\n',
        );
        return root;
      },
    ],
    ['本会话的 turn.steer 时刻认不出', () => mirasimWithSteer([{ ...ev.steer(STEER), ts: '昨天' }])],
  ])('%s', (_name, make) => {
    const v = check(input(t()), make());
    expect(v.deny).toBeUndefined();
    expect(v.notice).toMatch(/^引导检查没查成：.+/);
  });

  it('有引导、但会话记录读不了：判不了送没送到，也明说没查成、不拦', () => {
    const v = check(input(join(dir, 'gone.jsonl')), mirasimWithSteer());
    expect(v.deny).toBeUndefined();
    expect(v.notice).toMatch(/^引导检查没查成：/);
  });

  it('最后一行还没写完：跳过它，不算认不出', () => {
    const root = fresh('mirasim');
    writeDiag(root, NOW, [ev.steer(STEER)], '{"ts":"2026-10-10T09:25:39.000Z","kind":"fr');
    expect(check(input(t()), root).deny).toContain('马上结束这一轮');
  });

  it('整个 Mirasim 家目录都不在（这台机器没装 Mirasim）：不会有它的引导，不说话', () => {
    expect(check(input(t()), join(dir, 'no-mirasim-here'))).toEqual({});
  });

  it('【故意造出的失败】把「认不出」吞成「没有引导」：格式坏了那条就不报没查成了', async () => {
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
    writeFileSync(lib.diagFile(root, NOW), 'ts=2026-10-10T09:25:23Z name=turn.steer\n');
    const v = bad.check(input(t()), { settleMs: 0, now: NOW, mirasim: root });
    expect(v.notice).toBeUndefined();
  });
});

describe('无人值守的 Stop 钩子：有引导在等就放行收尾', { timeout: 0 }, () => {
  /** 真起 stop.mjs：无人值守开着（这个会话自己跑过 on），一个工人都没有；Mirasim 家目录指到临时目录 */
  function setup(steerSession: string, received: boolean) {
    const state = fresh('state');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FLEET_UNATTENDED_DIR: state,
      FLEET_WORKERS_DIR: fresh('workers'),
      FLEET_WORKER: '',
      CLAUDE_CODE_SESSION_ID: SID,
      FLEET_MIRASIM_DIR: fresh('mirasim'),
    };
    expect(runChild(process.execPath, [UNATTENDED, 'on'], { env }).status).toBe(0);
    const steerMs = Date.now() - 30_000;
    const steerIso = new Date(steerMs).toISOString();
    writeDiag(String(env.FLEET_MIRASIM_DIR), steerMs, [ev.steer(steerIso, steerSession)]);
    const rows = [tr.prompt(new Date(steerMs - 60_000).toISOString())];
    if (received) rows.push(tr.enqueue(new Date(steerMs + 1_000).toISOString()));
    const stdin = JSON.stringify({
      session_id: SID,
      transcript_path: transcript(rows),
      cwd: fresh('cwd'),
      hook_event_name: 'Stop',
      stop_hook_active: true,
    });
    return runChild(process.execPath, [STOP], { input: stdin, env });
  }

  it('无人值守开着、Mirasim 里有这个会话没送进来的引导：不挡（没有 decision），systemMessage 说明为什么放行', () => {
    const r = setup(SID, false);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('"decision"');
    expect((JSON.parse(r.stdout) as { systemMessage?: string }).systemMessage).toContain('引导');
  });

  it('【故意造出的失败】引导已经送到了、或者引导是别的会话的：照旧挡（证明放行只因为有引导在等）', () => {
    for (const [sid, received] of [
      [SID, true],
      [OTHER, false],
    ] as const) {
      const r = setup(sid, received);
      expect(r.status).toBe(0);
      expect((JSON.parse(r.stdout) as { decision?: string }).decision, `${sid} ${received}`).toBe('block');
    }
  });
});

describe('从命令行进来', { timeout: 0 }, () => {
  it('有没送进来的引导：stdout 是 permissionDecision deny、退出码 0', () => {
    // 命令行里用真时钟：引导写在「现在」前 20 秒
    const root = fresh('mirasim');
    const steerMs = Date.now() - 20_000;
    writeDiag(root, steerMs, [ev.steer(new Date(steerMs).toISOString())]);
    const t = transcript([tr.prompt(new Date(steerMs - 60_000).toISOString())]);
    const r = runChild(process.execPath, [HOOK], {
      input: input(t),
      env: { ...process.env, FLEET_MIRASIM_DIR: root },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('马上结束这一轮');
  });
});
