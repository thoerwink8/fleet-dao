// Mirasim 插头：状态合并（真跑夹具）、起会话 / 订阅 / 叫停 / 判定（假服务端回放夹具）、账本、连接。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProgressEvent } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { judgeRun } from '../src/judge.ts';
import { ledgerRouting, readMirasimLedger } from '../src/mirasim/ledger.ts';
import {
  type MirasimRunSpec,
  mirasimRunSummary,
  runMirasim,
  stopMirasimSession,
} from '../src/mirasim/run.ts';
import { MirasimSession } from '../src/mirasim/session.ts';
import { mirasimConnector } from '../src/mirasim/wire.ts';
import type { SayPayload, TestPayload, ToolPayload } from '../src/types.ts';
import { tempDir } from './helpers.ts';
import { accepted, FakeMirasim, mirasimRecording } from './mirasim-fake.ts';
import { startWsServer } from './ws-server.ts';

const FAST = { resubscribeMs: 30, replyMs: 500, stopConfirmMs: 600, ledgerWaitMs: 300 };
const kimi = mirasimRecording('mira-kimi');
const pi = mirasimRecording('mira-pi');

const spec = (extra: Partial<MirasimRunSpec> = {}): MirasimRunSpec => ({
  runId: 'run-m1',
  cwd: tempDir(),
  prompt: '在 notes.md 末尾追加一行',
  agent: 'kimi',
  route: 'cloud',
  expectModel: 'kimi-code/k3',
  session: { mode: 'new' },
  limits: FAST,
  testCommands: ['git commit'],
  ...extra,
});

/** 中转路由要账本里起针之后有 2xx 才算数：给一份刚写好一行 200 的账本。 */
function okLedger(sessionKey: string): string {
  const dir = tempDir();
  const uuid = sessionKey.split(':')[1] as string;
  mkdirSync(join(dir, uuid));
  writeFileSync(
    join(dir, uuid, 'index-0.ndjson'),
    `${JSON.stringify({ ts: new Date().toISOString(), status: 200, viaRelay: true })}\n`,
  );
  return dir;
}

function replay(recording: typeof kimi) {
  const session = new MirasimSession({
    runId: 'r1',
    cwd: '/tmp/agent-io-p3/x',
    testCommands: ['git commit'],
  });
  const events: ProgressEvent[] = [];
  for (const f of recording.stream) {
    const out =
      f.type === 'snapshot'
        ? session.applySnapshot(Number(f.seq), f.snapshot as Record<string, unknown>)
        : session.applyPatch(Number(f.seq), f.patch as Record<string, unknown>);
    if (out !== 'gap') events.push(...out);
  }
  return { session, events };
}

describe('Mirasim 会话状态（真跑夹具）', () => {
  it('kimi：重复的快照不重发事件；命令在 running 时的 result 里；正文结束时发一次', () => {
    const { session, events } = replay(kimi);
    const tools = events.filter((e) => e.kind === 'tool').map((e) => e.payload as ToolPayload);
    expect(tools.map((t) => [t.phase, t.name, t.action, t.ok])).toEqual([
      ['start', 'Bash', 'run', undefined],
      ['end', 'Bash', 'run', true],
    ]);
    // kimi 开始时只给工具名，命令要等 running 的那一帧；结束事件带上命令
    expect(tools[0]?.summary).toBe('Bash');
    expect(tools[1]?.summary).toBe(
      "printf '%s\\n' '- mirasim 到此一游' >> notes.md && git add -A && git commit -m \"mirasim: 追加一行\"",
    );
    expect(events.filter((e) => e.kind === 'say').map((e) => (e.payload as SayPayload).text)).toEqual([
      '好了',
    ]);
    // 快照里没有退出码：认出的测试只能记结果未知
    expect(events.filter((e) => e.kind === 'test').map((e) => e.payload as TestPayload)).toEqual([
      expect.objectContaining({ unknownBecause: expect.stringContaining('退出码') }),
    ]);
    expect(session.terminal()).toEqual({ isError: false, detail: 'done' });
    expect(session.state).toMatchObject({
      model: 'kimi-code/k3',
      nativeSessionId: expect.stringMatching(/^session_/),
    });
  });

  it('pi：两条命令、累计输出', () => {
    const { session, events } = replay(pi);
    expect(
      events.filter((e) => e.kind === 'tool' && (e.payload as ToolPayload).phase === 'end'),
    ).toHaveLength(2);
    expect(session.state.model).toBe('kimi-k3');
    expect(session.state.usage?.turnOutputTokens).toBe(239);
  });

  it('补丁跳号：回 gap 让调用方重订阅；旧 seq 的快照丢掉', () => {
    const session = new MirasimSession({ runId: 'r1', cwd: '/w' });
    session.applySnapshot(3, { phase: 'streaming' });
    expect(session.applyPatch(5, { set: { phase: 'done' } })).toBe('gap');
    expect(session.applySnapshot(2, { phase: 'done' })).toEqual([]);
    expect(session.state.phase).toBe('streaming');
  });

  it('done 带死因、incomplete：都是失败（MS-10、MS-11）', () => {
    const a = new MirasimSession({ runId: 'r1', cwd: '/w' });
    a.applySnapshot(1, { phase: 'done', error: 'pi turn stalled past 30 minutes' });
    expect(a.terminal()).toEqual({ isError: true, detail: 'done · pi turn stalled past 30 minutes' });
    const b = new MirasimSession({ runId: 'r1', cwd: '/w' });
    b.applySnapshot(1, { phase: 'done', incomplete: true });
    expect(b.terminal()?.isError).toBe(true);
  });
});

describe('Mirasim 起会话到判定（假服务端）', () => {
  it('kimi 回放：发对了 prompt，只认本会话的帧，判正常结束', async () => {
    const foreignDone = {
      type: 'session',
      sessionKey: 'kimi:00000000-0000-4000-8000-000000000000',
      seq: 99,
      patch: { set: { phase: 'done' } },
    };
    const server = new FakeMirasim({ reply: accepted(kimi), stream: [foreignDone, ...kimi.stream] });
    const events: ProgressEvent[] = [];
    const acceptedInfo: unknown[] = [];
    const s = spec();
    const report = await runMirasim(s, {
      connect: server.connect,
      onEvent: (e) => void events.push(e),
      onAccepted: (a) => void acceptedInfo.push(a),
      ledgerDir: okLedger(kimi.sessionKey),
    });
    expect(server.framesOf('prompt')[0]).toMatchObject({
      agent: 'kimi',
      workdir: s.cwd,
      route: 'cloud',
      prompt: s.prompt,
    });
    expect(server.framesOf('prompt')[0]).not.toHaveProperty('sessionKey');
    expect(report).toMatchObject({
      sessionKey: kimi.sessionKey,
      taskId: kimi.taskId,
      serverVersion: '0.0.362',
      foreignFrames: 1,
    });
    expect(acceptedInfo).toEqual([expect.objectContaining({ sessionKey: kimi.sessionKey })]);
    expect(events.map((e) => e.kind)).toEqual(['tool', 'tool', 'test', 'say']);
    const summary = mirasimRunSummary(report);
    expect(summary).toMatchObject({ actualModel: 'kimi-code/k3', sessionId: kimi.sessionKey, usage: {} });
    expect(judgeRun(summary.facts)).toMatchObject({ outcome: 'ok', reason: 'answered' });
  });

  it('续跑：同一个 prompt 帧带上 sessionKey；服务端回了别的 key 就停', async () => {
    const other = 'kimi:11111111-2222-4333-8444-555555555555';
    const server = new FakeMirasim({
      reply: (p) => ({ type: 'accepted', clientRef: p.clientRef, sessionKey: other, taskId: 'task-x' }),
      afterStop: [
        { type: 'session', sessionKey: other, seq: 0, patch: {} },
        { type: 'snapshot', sessionKey: other, seq: 1, snapshot: { phase: 'stopped', taskId: 'task-x' } },
      ],
    });
    const report = await runMirasim(spec({ session: { mode: 'resume', key: kimi.sessionKey } }), {
      connect: server.connect,
    });
    expect(server.framesOf('prompt')[0]?.sessionKey).toBe(kimi.sessionKey);
    expect(report.killed?.reason).toBe('session_mismatch');
    expect(server.framesOf('stop')[0]).toEqual({ type: 'stop', sessionKey: other });
    expect(report.stop).toEqual({ confirmed: true });
  });

  it('续跑：订阅先回上一轮收尾的快照（done、旧 taskId），只当底子；这一轮的工具号重用了也照报（VPS 实跑撞到的）', async () => {
    const last = kimi.stream.at(-1) as Record<string, unknown>;
    const key = kimi.sessionKey;
    const command = JSON.stringify({ command: 'git log -1 --format=%s' });
    const turn2 = (seq: number, patch: Record<string, unknown>) => ({
      type: 'session',
      sessionKey: key,
      seq,
      patch,
    });
    const server = new FakeMirasim({
      reply: (p) => ({ type: 'accepted', clientRef: p.clientRef, sessionKey: key, taskId: 'task-2' }),
      stream: [
        last,
        turn2(19, { set: { phase: 'streaming', taskId: 'task-2', toolCalls: [] } }),
        turn2(20, {
          set: { toolCalls: [{ id: '0:Bash:0', name: 'Bash', status: 'running', result: command }] },
        }),
        turn2(21, {
          set: { toolCalls: [{ id: '0:Bash:0', name: 'Bash', status: 'done', result: 'e2e: 追加一行' }] },
        }),
        turn2(22, { appendText: 'e2e: 追加一行' }),
        turn2(23, { set: { phase: 'done', error: null, incomplete: false } }),
      ],
    });
    const events: ProgressEvent[] = [];
    const report = await runMirasim(spec({ session: { mode: 'resume', key } }), {
      connect: server.connect,
      onEvent: (e) => void events.push(e),
    });
    expect(last).toMatchObject({ type: 'snapshot', snapshot: { phase: 'done' } });
    expect(report.terminal).toEqual({ isError: false, detail: 'done' });
    expect(events.map((e) => e.kind)).toEqual(['tool', 'tool', 'say']);
    expect(events.filter((e) => e.kind === 'say').map((e) => (e.payload as SayPayload).text)).toEqual([
      'e2e: 追加一行',
    ]);
    expect((events[0]?.payload as ToolPayload | undefined)?.summary).toBe('git log -1 --format=%s');
  });

  it('用量：codex 给会话累计值，续跑按上一轮求差；不给上一轮就不带', async () => {
    const key = 'codex:2f868f6f-2f79-48f8-bb63-cd7a3c5c41a0';
    const done = (taskId: string, input: number, output: number, cachedInput: number) => ({
      type: 'snapshot',
      sessionKey: key,
      seq: 1,
      snapshot: {
        phase: 'done',
        taskId,
        model: 'gpt-5.6-luna',
        usage: { turnOutputTokens: 17, sessionTotals: { input, output, cachedInput, cachedIncluded: true } },
      },
    });
    const run = (taskId: string, frame: Record<string, unknown>, resume: boolean) =>
      runMirasim(
        spec({
          agent: 'codex',
          expectModel: 'gpt-5.6-luna',
          session: resume ? { mode: 'resume', key } : { mode: 'new' },
        }),
        {
          connect: new FakeMirasim({
            agents: ['codex'],
            reply: (p) => ({ type: 'accepted', clientRef: p.clientRef, sessionKey: key, taskId }),
            stream: [frame],
          }).connect,
        },
      );
    const first = await run('t1', done('t1', 1000, 50, 800), false);
    expect(mirasimRunSummary(first).usage).toEqual({
      inputTokens: 200,
      cacheReadTokens: 800,
      outputTokens: 50,
    });
    const second = await run('t2', done('t2', 1500, 80, 1100), true);
    expect(mirasimRunSummary(second).usage).toEqual({});
    expect(mirasimRunSummary(second, first).usage).toEqual({
      inputTokens: 200,
      cacheReadTokens: 300,
      outputTokens: 30,
    });
  });

  it('续跑：这一轮的正文是另起的一份（不接在上一轮的「好了」后面）：从头算，开头的字不被吃掉（VPS 实跑撞到的）', async () => {
    const key = kimi.sessionKey;
    const server = new FakeMirasim({
      reply: (p) => ({ type: 'accepted', clientRef: p.clientRef, sessionKey: key, taskId: 'task-2' }),
      stream: [
        kimi.stream.at(-1) as Record<string, unknown>,
        {
          type: 'snapshot',
          sessionKey: key,
          seq: 30,
          snapshot: { phase: 'streaming', taskId: 'task-2', text: 'e2' },
        },
        { type: 'session', sessionKey: key, seq: 31, patch: { appendText: 'e: 追加一行' } },
        { type: 'session', sessionKey: key, seq: 32, patch: { set: { phase: 'done', error: null } } },
      ],
    });
    const said: string[] = [];
    await runMirasim(spec({ session: { mode: 'resume', key } }), {
      connect: server.connect,
      onEvent: (e) => void (e.kind === 'say' && said.push((e.payload as SayPayload).text)),
    });
    expect(said).toEqual(['e2e: 追加一行']);
  });

  it('账本的行在调用结束后才写：会话一结束就读是空的，等它追上来再判', async () => {
    const ledgerDir = tempDir();
    const uuid = kimi.sessionKey.split(':')[1] as string;
    mkdirSync(join(ledgerDir, uuid));
    const file = join(ledgerDir, uuid, 'index-0.ndjson');
    writeFileSync(
      file,
      `${JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', status: 200, viaRelay: true })}\n`,
    );
    setTimeout(() => {
      writeFileSync(
        file,
        `${JSON.stringify({ ts: new Date().toISOString(), status: 200, upstreamHost: 'relay.example', viaRelay: true })}\n`,
        {
          flag: 'a',
        },
      );
    }, 400);
    const report = await runMirasim(spec({ limits: { ...FAST, ledgerWaitMs: 3_000 } }), {
      connect: new FakeMirasim({ reply: accepted(kimi), stream: kimi.stream }).connect,
      ledgerDir,
    });
    expect(report.ledger).toMatchObject({ state: 'read', rows: [{ status: 200, viaRelay: true }] });
    expect(judgeRun(mirasimRunSummary(report).facts).outcome).toBe('ok');
  });

  it('续跑而服务端一直只回上一轮的收尾：不当成这一轮完了，到点按起不来收', async () => {
    const server = new FakeMirasim({
      reply: (p) => ({
        type: 'accepted',
        clientRef: p.clientRef,
        sessionKey: kimi.sessionKey,
        taskId: 'task-2',
      }),
      stream: [kimi.stream.at(-1) as Record<string, unknown>],
    });
    const report = await runMirasim(
      spec({ session: { mode: 'resume', key: kimi.sessionKey }, limits: { ...FAST, startupMs: 200 } }),
      { connect: server.connect },
    );
    expect(report.terminal).toBeUndefined();
    expect(report.killed?.reason).toBe('startup_timeout');
  });

  it('快照里的模型不是声明的那个：停会话，停没停看它翻不翻终态', async () => {
    const server = new FakeMirasim({ reply: accepted(kimi), stream: kimi.stream.slice(0, 6) });
    const report = await runMirasim(spec({ expectModel: 'kimi-code/k2' }), { connect: server.connect });
    expect(report.killed?.reason).toBe('model_mismatch');
    expect(server.framesOf('stop').length).toBeGreaterThanOrEqual(1);
    // 服务端没翻终态：停没查成，不当成停好了
    expect(report.stop?.confirmed).toBe(false);
    expect(judgeRun(mirasimRunSummary(report).facts).reason).toBe('model_mismatch');
  });

  it('服务端没有这个执行体、拒了这一针、连不上、不回 state：都是没起来，原因照实写', async () => {
    const noAgent = await runMirasim(spec({ agent: 'dsh' }), {
      connect: new FakeMirasim({ agents: ['kimi'] }).connect,
    });
    expect(noAgent.launchError).toContain('服务端没有 dsh');
    const refused = await runMirasim(spec(), {
      connect: new FakeMirasim({
        reply: (p) => ({
          type: 'error',
          clientRef: p.clientRef,
          message: '当前是「本地」档，而本机没有这个智能体的账号',
        }),
      }).connect,
    });
    expect(refused.launchError).toBe('服务端拒了这一针：当前是「本地」档，而本机没有这个智能体的账号');
    const down = await runMirasim(spec(), { connect: new FakeMirasim({ refuse: true }).connect });
    expect(down.launchError).toBe('ECONNREFUSED');
    const silent = await runMirasim(spec(), { connect: new FakeMirasim({ silent: true }).connect });
    expect(silent.launchError).toContain('没收到 state 帧');
    for (const r of [noAgent, refused, down, silent])
      expect(judgeRun(mirasimRunSummary(r).facts).reason).toBe('spawn_failed');
  });

  it('prompt 发出去没等到应答：标「没查成」，不当成确定没起、不判成重派的那一类（MS-18）', async () => {
    const report = await runMirasim(spec(), { connect: new FakeMirasim({ reply: () => undefined }).connect });
    expect(report.launchUnknown).toBe(true);
    expect(report.launchError).toContain('别重发');
    expect(judgeRun(mirasimRunSummary(report).facts)).toMatchObject({
      outcome: 'failed',
      reason: 'launch_unknown',
    });
  });

  it('不带本次 clientRef 的 error 帧不算被拒：记下原话接着等，等到 accepted 照常跑，等不到按没查成收', async () => {
    const stray = { type: 'error', message: 'Selected model is at capacity' };
    const unknown = await runMirasim(spec(), {
      connect: new FakeMirasim({
        reply: (p) => [stray, { type: 'error', clientRef: `${String(p.clientRef)}-x`, message: '别人的' }],
      }).connect,
    });
    expect(unknown.launchUnknown).toBe(true);
    expect(unknown.launchError).toContain('Selected model is at capacity');
    expect(judgeRun(mirasimRunSummary(unknown).facts).reason).toBe('launch_unknown');
    const later = await runMirasim(spec(), {
      connect: new FakeMirasim({ reply: (p) => [stray, accepted(kimi)(p)], stream: kimi.stream }).connect,
      ledgerDir: okLedger(kimi.sessionKey),
    });
    expect(later.launchError).toBeUndefined();
    expect(later.sessionKey).toBe(kimi.sessionKey);
    expect(judgeRun(mirasimRunSummary(later).facts).reason).toBe('answered');
  });

  it('一直排队：起不来超时，停掉', async () => {
    const server = new FakeMirasim({
      reply: accepted(kimi),
      stream: [{ type: 'snapshot', sessionKey: kimi.sessionKey, seq: 0, snapshot: { phase: 'queued' } }],
    });
    const report = await runMirasim(spec({ limits: { ...FAST, startupMs: 100 } }), {
      connect: server.connect,
    });
    expect(report.killed?.reason).toBe('startup_timeout');
    expect(server.framesOf('stop')).not.toHaveLength(0);
  });

  it('在跑但进度指纹一直不变、又没有工具在跑：判停滞', async () => {
    const server = new FakeMirasim({
      reply: accepted(kimi),
      stream: [
        {
          type: 'snapshot',
          sessionKey: kimi.sessionKey,
          seq: 0,
          snapshot: { phase: 'streaming', model: 'kimi-code/k3' },
        },
      ],
    });
    const report = await runMirasim(spec({ limits: { ...FAST, idleMs: 150 } }), { connect: server.connect });
    expect(report.killed?.reason).toBe('idle_timeout');
    expect(judgeRun(mirasimRunSummary(report).facts).outcome).toBe('stalled');
  });

  it('引擎叫停：发 stop，看到终态才算停好', async () => {
    const controller = new AbortController();
    const server = new FakeMirasim({
      reply: accepted(kimi),
      stream: kimi.stream.slice(0, 3),
      afterStop: [
        { type: 'session', sessionKey: kimi.sessionKey, seq: 99, patch: {} },
        {
          type: 'snapshot',
          sessionKey: kimi.sessionKey,
          seq: 100,
          snapshot: { phase: 'stopped', error: 'Interrupted by user.' },
        },
      ],
    });
    setTimeout(() => controller.abort(), 100);
    const report = await runMirasim(spec(), { connect: server.connect, signal: controller.signal });
    expect(report.killed?.reason).toBe('aborted');
    expect(report.stop).toEqual({ confirmed: true });
    expect(judgeRun(mirasimRunSummary(report).facts).outcome).toBe('stopped');
  });

  it('补丁跳号：重订阅拿整份快照', async () => {
    const server = new FakeMirasim({
      reply: accepted(kimi),
      stream: [
        { type: 'snapshot', sessionKey: kimi.sessionKey, seq: 0, snapshot: { phase: 'streaming' } },
        { type: 'session', sessionKey: kimi.sessionKey, seq: 5, patch: { set: { phase: 'done' } } },
      ],
    });
    const report = await runMirasim(spec({ limits: { ...FAST, wallClockMs: 400 } }), {
      connect: server.connect,
    });
    // 跳号的补丁不采信：没有翻成 done
    expect(report.terminal).toBeUndefined();
    expect(server.framesOf('subscribe').length).toBeGreaterThan(1);
  });

  it('pi 点名模型只认 profile:<id>；续跑的 key 不是这个执行体的：当场拒', async () => {
    await expect(
      runMirasim(spec({ agent: 'pi', model: 'kimi-k3' }), { connect: new FakeMirasim({}).connect }),
    ).rejects.toThrow('profile:');
    await expect(
      runMirasim(spec({ session: { mode: 'resume', key: pi.sessionKey } }), {
        connect: new FakeMirasim({}).connect,
      }),
    ).rejects.toThrow('不是 kimi 的');
  });

  it('中转路由：账本里起针之后没有 2xx，done 不算数；账本没读成、没给账本目录判「中转没查成」', async () => {
    const ledgerDir = tempDir();
    const uuid = kimi.sessionKey.split(':')[1] as string;
    mkdirSync(join(ledgerDir, uuid));
    writeFileSync(
      join(ledgerDir, uuid, 'index-1.ndjson'),
      `${JSON.stringify({ ts: Date.now(), status: 502, upstreamHost: 'relay.example', viaRelay: true, userId: 'u-secret' })}\n`,
    );
    const bad = await runMirasim(spec(), {
      connect: new FakeMirasim({ reply: accepted(kimi), stream: kimi.stream }).connect,
      ledgerDir,
    });
    expect(bad.ledger).toEqual({
      state: 'read',
      rows: [expect.objectContaining({ status: 502, viaRelay: true })],
      unparsed: 0,
    });
    expect(JSON.stringify(bad.ledger)).not.toContain('u-secret');
    expect(judgeRun(mirasimRunSummary(bad).facts).reason).toBe('agent_error');
    const unknown = await runMirasim(spec(), {
      connect: new FakeMirasim({ reply: accepted(kimi), stream: kimi.stream }).connect,
      ledgerDir: join(ledgerDir, 'nowhere'),
    });
    expect(unknown.ledger?.state).toBe('unknown');
    expect(judgeRun(mirasimRunSummary(unknown).facts)).toEqual({
      outcome: 'failed',
      reason: 'relay_unknown',
      detail:
        '中转没查成：账本没读成：账本里没有这个会话的目录（可能一次上游调用都没有，也可能账本换了地方）',
    });
    const noLedger = await runMirasim(spec(), {
      connect: new FakeMirasim({ reply: accepted(kimi), stream: kimi.stream }).connect,
    });
    expect(noLedger.ledger).toBeUndefined();
    expect(judgeRun(mirasimRunSummary(noLedger).facts).reason).toBe('relay_unknown');
    // 交付查到了也一样：上游有没有真干活没核实，不判完成
    const delivered = {
      state: 'delivered' as const,
      target: 'refs/remotes/origin/main',
      detail: '这一轮新提交 1 个',
    };
    expect(judgeRun(mirasimRunSummary(noLedger).facts, delivered).reason).toBe('relay_unknown');
    // 不走中转：不看账本
    const local = await runMirasim(spec({ route: 'local' }), {
      connect: new FakeMirasim({ reply: accepted(kimi), stream: kimi.stream }).connect,
    });
    expect(judgeRun(mirasimRunSummary(local).facts).reason).toBe('answered');
  });

  it('引擎重启后收旧会话：看到终态才算收好', async () => {
    const server = new FakeMirasim({
      afterStop: [{ type: 'snapshot', sessionKey: kimi.sessionKey, seq: 7, snapshot: { phase: 'stopped' } }],
    });
    expect(await stopMirasimSession(server.connect, kimi.sessionKey, 500)).toEqual({
      confirmed: true,
      detail: 'stopped',
    });
    const deaf = new FakeMirasim({});
    expect((await stopMirasimSession(deaf.connect, kimi.sessionKey, 200)).confirmed).toBe(false);
  });
});

describe('Mirasim 账本', () => {
  it('读本会话的行、只挑路由字段、按起针时间过滤；认不出的行计数', async () => {
    const dir = tempDir();
    const uuid = '9adf4d07-32a6-4ee4-b5cf-61b324c985e3';
    mkdirSync(join(dir, uuid));
    writeFileSync(
      join(dir, uuid, 'index-a.ndjson'),
      [
        JSON.stringify({
          ts: '2026-09-25T00:00:00.000Z',
          status: 200,
          upstreamHost: 'relay.example',
          viaRelay: true,
          model: 'kimi-k3',
          accountId: 'acc-1',
        }),
        JSON.stringify({
          ts: '2026-09-25T00:10:00.000Z',
          status: 200,
          upstreamHost: 'relay.example',
          viaRelay: true,
          model: 'kimi-k3',
        }),
        'not json',
      ].join('\n'),
    );
    const reading = await readMirasimLedger(dir, `pi:${uuid}`, Date.parse('2026-09-25T00:05:00.000Z'));
    expect(reading).toEqual({
      state: 'read',
      rows: [
        {
          at: Date.parse('2026-09-25T00:10:00.000Z'),
          status: 200,
          upstreamHost: 'relay.example',
          viaRelay: true,
          model: 'kimi-k3',
        },
      ],
      unparsed: 1,
    });
    if (reading.state === 'read') {
      expect(ledgerRouting(reading.rows)).toEqual({
        calls: 1,
        ok: 1,
        viaRelay: 1,
        hosts: ['relay.example'],
        models: ['kimi-k3'],
      });
    }
  });

  it('没有目录、没有 index 文件、会话号认不出：没查成，不当成零次调用', async () => {
    const dir = tempDir();
    expect((await readMirasimLedger(dir, 'pi:9adf4d07-32a6-4ee4-b5cf-61b324c985e3')).state).toBe('unknown');
    mkdirSync(join(dir, '9adf4d07-32a6-4ee4-b5cf-61b324c985e3'));
    expect(await readMirasimLedger(dir, 'pi:9adf4d07-32a6-4ee4-b5cf-61b324c985e3')).toEqual({
      state: 'unknown',
      detail: '账本目录里没有 index 文件',
    });
    expect((await readMirasimLedger(dir, 'pi:../../etc')).state).toBe('unknown');
  });
});

describe('Mirasim 连接', () => {
  it('测试里连真服务一律拒绝：旧服务的端口，或令牌在 .mirasim 目录下（新服务端口不定）', () => {
    expect(() => mirasimConnector({ port: 4316, tokenFile: '/nowhere' })).toThrow(
      '测试里不许连真的 Mirasim 服务',
    );
    expect(() =>
      mirasimConnector({ port: 4400, tokenFile: '/home/someone/.mirasim/run/local-4400.token' }),
    ).toThrow('测试里不许连真的 Mirasim 服务');
  });

  it('真 ws：每次建连现读令牌、帧来回、服务端关了之后 next 回 closed', async () => {
    const dir = tempDir();
    const tokenFile = join(dir, 'local.token');
    writeFileSync(tokenFile, 'tok-1\n');
    const urls: string[] = [];
    const server = await startWsServer((conn) => {
      urls.push(conn.url);
      conn.onMessage((frame) => {
        if (frame.type === 'getState') conn.send({ type: 'state', state: { version: 'x' } });
        if (frame.type === 'bye') conn.close();
      });
    });
    try {
      const connect = mirasimConnector({ port: server.port, tokenFile, connectTimeoutMs: 2_000 });
      const a = await connect();
      a.send({ type: 'getState' });
      expect(await a.next(2_000)).toEqual({ type: 'state', state: { version: 'x' } });
      expect(await a.next(50)).toBe('timeout');
      a.send({ type: 'bye' });
      expect(await a.next(2_000)).toBe('closed');
      // 服务重启会换令牌：下一次建连读新的
      writeFileSync(tokenFile, 'tok 2');
      (await connect()).close();
      expect(urls).toEqual(['/ws?token=tok-1', '/ws?token=tok%202']);
    } finally {
      await server.close();
    }
  });

  it('服务端不在：重试到期限再报连不上', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 't'), 'tok');
    const server = await startWsServer(() => {});
    const port = server.port;
    await server.close();
    const t0 = Date.now();
    await expect(
      mirasimConnector({ port, tokenFile: join(dir, 't'), connectTimeoutMs: 1_200 })(),
    ).rejects.toThrow('连不上 Mirasim');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });

  it('令牌文件读不了、是空的：明说，不连', async () => {
    const dir = tempDir();
    await expect(mirasimConnector({ port: 1, tokenFile: join(dir, 'missing.token') })()).rejects.toThrow(
      '读不了 Mirasim 的回环令牌',
    );
    writeFileSync(join(dir, 'empty.token'), '\n');
    await expect(mirasimConnector({ port: 1, tokenFile: join(dir, 'empty.token') })()).rejects.toThrow(
      '是空的',
    );
  });
});
