// 任务页「过程」的切步和小计（#3140）：步骤怎么开、标题怎么取、调用和结果怎么对、命令成败怎么算、小计怎么折。
import { describe, expect, it } from 'vitest';
import {
  cutSteps,
  mergeFiles,
  type ProcessRow,
  processRowOf,
  RunProcessSchema,
  stepTitle,
  stepVerb,
  sumTallies,
  tallyOf,
  toolClass,
} from '../src/index.ts';

let seq = 0;
const T0 = Date.parse('2026-10-18T08:00:00.000Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const row = (sec: number, r: Partial<ProcessRow> & Pick<ProcessRow, 'kind'>): ProcessRow => ({
  seq: seq++,
  at: at(sec),
  text: '',
  sub: false,
  ...r,
});
const say = (sec: number, text: string, extra: Partial<ProcessRow> = {}) =>
  row(sec, { kind: 'assistant', text, ...extra });
const call = (
  sec: number,
  id: string | undefined,
  tool: string,
  text: string,
  extra: Partial<ProcessRow> = {},
) => row(sec, { kind: 'tool_call', tool, text, ...(id === undefined ? {} : { callId: id }), ...extra });
const done = (
  sec: number,
  id: string | undefined,
  tool: string,
  ok: boolean | undefined = true,
  extra: Partial<ProcessRow> = {},
) =>
  row(sec, {
    kind: 'tool_result',
    tool,
    ...(ok === undefined ? {} : { ok }),
    ...(id === undefined ? {} : { callId: id }),
    ...extra,
  });
const reset = () => {
  seq = 0;
};

describe('工具分类', () => {
  it('按工具名分类：大小写、cursor 的 ToolCall 后缀、grok 的名字都认', () => {
    expect(toolClass('Bash')).toBe('command');
    expect(toolClass('shellToolCall')).toBe('command');
    expect(toolClass('run_terminal_command')).toBe('command');
    expect(toolClass('search_replace')).toBe('edit');
    expect(toolClass('Read')).toBe('read');
    expect(toolClass('codegraph_explore')).toBe('search');
    expect(toolClass('Agent')).toBe('agent');
    expect(toolClass('mcp__x__y')).toBe('other');
    expect(stepVerb('Write')).toBe('创建');
    expect(stepVerb('Edit')).toBe('编辑');
    expect(stepVerb('mcp__x__y')).toBe('调用 mcp__x__y');
  });
});

describe('stepTitle', () => {
  it('取第一行有字的，去掉标记，过长截短', () => {
    expect(stepTitle('\n## **先读** `a.ts`\n后面')).toBe('先读 a.ts');
    expect(stepTitle('- 列表项')).toBe('列表项');
    expect(stepTitle('   ')).toBeNull();
    expect(stepTitle('字'.repeat(300))?.length).toBe(121);
  });
});

describe('cutSteps：一步 = Agent 一句话 + 它接着的调用', () => {
  it('主会话每次开口（前一步已有调用）另起一步；连着几句话中间没有调用的并成一步，标题取第一句', () => {
    reset();
    const p = cutSteps(
      [
        row(0, { kind: 'prompt', text: '提示词' }),
        say(1, '我先看看代码'),
        say(2, '再补一句'),
        call(3, 'a', 'Read', 'a.ts'),
        done(4, 'a', 'Read'),
        say(10, '改文件'),
        call(11, 'b', 'Edit', 'a.ts'),
        done(12, 'b', 'Edit', true, { added: 3, removed: 1 }),
        say(20, '跑测试'),
        call(21, 'c', 'Bash', 'pnpm test'),
        done(22, 'c', 'Bash'),
        row(30, { kind: 'result', text: '做完了', ok: true }),
      ],
      { running: false, endedAt: at(31) },
    );
    expect(p.steps.map((s) => s.title)).toEqual(['我先看看代码', '改文件', '跑测试']);
    expect(p.steps[0]).toMatchObject({ reads: 1, calls: 1, firstSeq: 1, titleFromCall: false });
    expect(p.steps[0]?.endedAt).toBe(at(10));
    expect(p.steps[0]?.durationMs).toBe(9000);
    expect(p.steps[2]?.endedAt).toBe(at(31));
    expect(p.steps.every((s) => !s.running && !s.failed)).toBe(true);
    expect(p.counts).toMatchObject({
      commands: 1,
      commandsDone: 1,
      reads: 1,
      added: 3,
      removed: 1,
      uncounted: 0,
    });
    expect(p.counts.files).toEqual([{ path: 'a.ts', edits: 1, added: 3, removed: 1 }]);
    expect(p.truncated).toBe(false);
    expect(RunProcessSchema.safeParse(p).success).toBe(true);
  });

  it('一开头就调工具（还没说话）：单开一步，用第一个调用的动词加对象当标题', () => {
    reset();
    const p = cutSteps([call(0, 'a', 'Bash', 'ls -la'), done(1, 'a', 'Bash'), say(5, '看完了')], {
      running: false,
    });
    expect(p.steps.map((s) => [s.title, s.titleFromCall])).toEqual([
      ['运行 ls -la', true],
      ['看完了', false],
    ]);
  });

  it('整笔一句话都没有：按时间空档切（超过 60 秒没动静另起一步），标题都用第一个调用', () => {
    reset();
    const p = cutSteps(
      [
        call(0, 'a', 'Read', 'a.ts'),
        done(2, 'a', 'Read'),
        call(5, 'b', 'Read', 'b.ts'),
        done(6, 'b', 'Read'),
        call(200, 'c', 'Bash', 'pnpm test'),
        done(201, 'c', 'Bash'),
      ],
      { running: false },
    );
    expect(p.steps.map((s) => s.title)).toEqual(['读取 a.ts', '运行 pnpm test']);
    expect(p.steps[0]?.reads).toBe(2);
    // 有话的笔不按空档切：同一句话下面的调用隔多久都是同一步
    reset();
    const talked = cutSteps(
      [
        say(0, '一直在做'),
        call(1, 'a', 'Bash', 'x'),
        done(2, 'a', 'Bash'),
        call(500, 'b', 'Bash', 'y'),
        done(501, 'b', 'Bash'),
      ],
      {
        running: false,
      },
    );
    expect(talked.steps).toHaveLength(1);
  });

  it('子代理里的条目跟着它出现的位置归当时那一步（步骤的序号范围连续），子代理的调用计入 subCalls', () => {
    reset();
    const sub = { sub: true, subOf: 'agent-1' };
    const p = cutSteps(
      [
        say(0, '派个子代理去查'),
        call(1, 'agent-1', 'Agent', '派了 scout：查 UTC'),
        say(2, '子代理在说话', sub),
        call(3, 'sub-a', 'Grep', 'UTC', sub),
        done(4, 'sub-a', 'Grep', true, sub),
        done(5, 'agent-1', 'Agent'),
        say(10, '查完了，改'),
      ],
      { running: false },
    );
    expect(p.steps).toHaveLength(2);
    expect(p.steps[0]).toMatchObject({ calls: 2, subCalls: 1, firstSeq: 0, lastSeq: 5 });
    expect(p.steps[1]?.firstSeq).toBe(6);
  });

  it('没有标题的步骤（只有报错）标题是 null；报错和没成的结论让步骤 failed', () => {
    reset();
    expect(cutSteps([row(0, { kind: 'error', text: '炸了' })], { running: false }).steps[0]).toMatchObject({
      title: null,
      failed: true,
    });
    reset();
    expect(
      cutSteps([say(0, '试'), row(1, { kind: 'result', text: '没成', ok: false })], { running: false })
        .steps[0]?.failed,
    ).toBe(true);
  });

  it('一条都没有 / 只有提示词：没有步骤', () => {
    reset();
    expect(cutSteps([], { running: true }).steps).toEqual([]);
    expect(cutSteps([row(0, { kind: 'prompt', text: 'p' })], { running: false }).steps).toEqual([]);
  });

  it('记录员到了每段上限补的 truncated 条目：标 truncated，不当步骤', () => {
    reset();
    const p = cutSteps([say(0, 'a'), row(1, { kind: 'truncated', text: '后面还有 5 条没记' })], {
      running: false,
    });
    expect(p.truncated).toBe(true);
    expect(p.steps).toHaveLength(1);
  });
});

describe('调用和结果按调用号对（评审反例）', () => {
  it('并行的两个 Edit，结果倒序回来、a 失败 b 成功：失败记在 a、改了的是 b，增删行不串', () => {
    reset();
    const p = cutSteps(
      [
        say(0, '改两个文件'),
        call(1, 'ea', 'Edit', 'a.ts'),
        call(1, 'eb', 'Edit', 'b.ts'),
        done(2, 'eb', 'Edit', true, { added: 2, removed: 1 }),
        done(3, 'ea', 'Edit', false),
      ],
      { running: false },
    );
    expect(p.counts.files).toEqual([{ path: 'b.ts', edits: 1, added: 2, removed: 1 }]);
    expect(p.steps[0]).toMatchObject({ callsFailed: 1, failed: true });
  });

  it('没有调用号的老记录不强配：命令成败记「结果未知」，legacyCalls 点名有几条；编辑没法确认成没成，不算改', () => {
    reset();
    const p = cutSteps(
      [
        say(0, '老记录'),
        call(1, undefined, 'Bash', 'pnpm test'),
        done(2, undefined, 'Bash', false),
        call(3, undefined, 'Edit', 'a.ts'),
        done(4, undefined, 'Edit', true),
      ],
      { running: false },
    );
    expect(p.legacyCalls).toBe(2);
    expect(p.counts).toMatchObject({ commands: 1, commandsDone: 0, commandsFailed: 0, commandsUnknown: 1 });
    expect(p.counts.files).toEqual([]);
  });

  it('Mirasim 一类没有退出码的流：命令结果「完成」记结果未知，不算成功；明确 ok=false 仍算失败', () => {
    reset();
    const p = cutSteps(
      [
        say(0, '跑命令'),
        call(1, 'm1', 'Bash', 'a'),
        done(2, 'm1', 'Bash', true, { exitKnown: false }),
        call(3, 'm2', 'Bash', 'b'),
        done(4, 'm2', 'Bash', false, { exitKnown: false }),
      ],
      { running: false },
    );
    expect(p.counts).toMatchObject({ commands: 2, commandsDone: 0, commandsFailed: 1, commandsUnknown: 1 });
  });

  it('没有结果的命令：这一笔还在跑算「在跑」，已经结束算「没读到结果」，都不算成功也不算失败', () => {
    reset();
    const rows = [say(0, '跑'), call(1, 'a', 'Bash', 'sleep 100')];
    const live = cutSteps(rows, { running: true });
    expect(live.counts).toMatchObject({
      commands: 1,
      commandsDone: 0,
      commandsRunning: 1,
      commandsUnknown: 0,
    });
    expect(live.steps[0]).toMatchObject({ running: true });
    expect(live.steps[0]?.endedAt).toBeUndefined();
    expect(live.steps[0]?.durationMs).toBeUndefined();
    const over = cutSteps(rows, { running: false });
    expect(over.counts).toMatchObject({ commandsRunning: 0, commandsUnknown: 1 });
    expect(over.steps[0]?.running).toBe(false);
  });

  it('改文件：成功了才算；同一个文件多次编辑合并；没记行数的不拿 0 顶，计入 uncounted；失败的编辑不算改', () => {
    reset();
    const p = cutSteps(
      [
        say(0, '改'),
        call(1, 'e1', 'Edit', 'a.ts'),
        done(2, 'e1', 'Edit', true, { added: 2, removed: 1 }),
        call(3, 'e2', 'Edit', 'a.ts'),
        done(4, 'e2', 'Edit', true, { added: 1, removed: 0 }),
        call(5, 'e3', 'Write', 'b.ts'),
        done(6, 'e3', 'Write'),
        call(7, 'e4', 'Edit', 'c.ts'),
        done(8, 'e4', 'Edit', false),
      ],
      { running: false },
    );
    expect(p.counts.files).toEqual([
      { path: 'a.ts', edits: 2, added: 3, removed: 1 },
      { path: 'b.ts', edits: 1 },
    ]);
    expect(p.counts).toMatchObject({ added: 3, removed: 1, uncounted: 1, callsFailed: 1 });
  });
});

describe('processRowOf：接口回的完整条目 → 算法的一行（和库里取的列同口径）', () => {
  it('取调用号、子代理编号、没有退出码、增删行；文本按种类截短；子代理标记是 true 也认', () => {
    const r = processRowOf({
      seq: 4,
      at: at(1),
      kind: 'tool_result',
      tool: 'Edit',
      ok: true,
      text: '很长的结果',
      meta: { callId: 'x', subagent: 'agent-1', exitKnown: false, added: 3, removed: 1 },
    });
    expect(r).toEqual({
      seq: 4,
      at: at(1),
      kind: 'tool_result',
      tool: 'Edit',
      ok: true,
      text: '',
      sub: true,
      subOf: 'agent-1',
      callId: 'x',
      exitKnown: false,
      added: 3,
      removed: 1,
    });
    expect(
      processRowOf({ seq: 0, at: at(0), kind: 'assistant', text: 'x'.repeat(900), meta: { subagent: true } }),
    ).toMatchObject({
      sub: true,
      text: 'x'.repeat(400),
    });
    expect(processRowOf({ seq: 0, at: at(0), kind: 'tool_call', text: 'x'.repeat(900) }).text).toHaveLength(
      300,
    );
  });
});

describe('小计', () => {
  const base = {
    entries: 10,
    calls: 6,
    commands: 5,
    commandsFailed: 1,
    commandsExitUnknown: 1,
    commandsNoResult: 1,
    commandsLegacy: 1,
    reads: 2,
    callsFailed: 1,
    editsOk: 2,
    editsUncounted: 1,
    added: 4,
    removed: 2,
  };

  it('收场了：没结果的算「结果未知」；还在跑：算「在跑」；老记录没调用号、没退出码的都是结果未知', () => {
    expect(tallyOf(base, false)).toMatchObject({
      commands: 5,
      commandsDone: 1,
      commandsFailed: 1,
      commandsUnknown: 3,
      commandsRunning: 0,
      uncounted: 1,
    });
    expect(tallyOf(base, true)).toMatchObject({ commandsDone: 1, commandsUnknown: 2, commandsRunning: 1 });
    expect(
      tallyOf({ ...base, commandsExitUnknown: 0, commandsNoResult: 0, commandsLegacy: 0 }, false)
        .commandsDone,
    ).toBe(4);
  });

  it('几笔加在一起', () => {
    const a = tallyOf(base, false);
    const sum = sumTallies([a, a]);
    expect(sum).toMatchObject({ commands: 10, commandsFailed: 2, reads: 4, editsOk: 4, added: 8 });
  });

  it('mergeFiles：同路径相加；一边没记行数保留已记的那边', () => {
    expect(
      mergeFiles([
        [{ path: 'a', edits: 1, added: 1, removed: 0 }],
        [
          { path: 'a', edits: 2 },
          { path: 'b', edits: 1, added: 4, removed: 4 },
        ],
      ]),
    ).toEqual([
      { path: 'a', edits: 3, added: 1, removed: 0 },
      { path: 'b', edits: 1, added: 4, removed: 4 },
    ]);
  });
});
