// 任务页「过程」的切步和小计（#3140）。
import { describe, expect, it } from 'vitest';
import {
  countEditLines,
  cutSteps,
  mergeFiles,
  type ProcessRow,
  stepTitle,
  sumRunCounts,
  toolClass,
} from '../src/task-process.ts';

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
const say = (sec: number, text: string) => row(sec, { kind: 'assistant', text });
const call = (sec: number, tool: string, text: string, extra: Partial<ProcessRow> = {}) =>
  row(sec, { kind: 'tool_call', tool, text, ...extra });
const done = (sec: number, tool: string, ok: boolean | undefined = true, extra: Partial<ProcessRow> = {}) =>
  row(sec, { kind: 'tool_result', tool, ...(ok === undefined ? {} : { ok }), ...extra });

const reset = () => {
  seq = 0;
};

describe('toolClass', () => {
  it('按工具名分类，大小写和 cursor 的 ToolCall 后缀不影响', () => {
    expect(toolClass('Bash')).toBe('command');
    expect(toolClass('shellToolCall')).toBe('command');
    expect(toolClass('Read')).toBe('read');
    expect(toolClass('MultiEdit')).toBe('edit');
    expect(toolClass('Agent')).toBe('agent');
    expect(toolClass('mcp__x__y')).toBe('other');
    expect(toolClass(undefined)).toBe('other');
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
  it('每次顶层 assistant 开口（前一步已有调用）另起一步；连着几句话并成一步，标题取第一句', () => {
    reset();
    const rows = [
      row(0, { kind: 'prompt', text: '提示词' }),
      say(1, '我先看看代码'),
      say(2, '再补一句'),
      call(3, 'Read', 'a.ts'),
      done(4, 'Read'),
      say(10, '改一下'),
      call(11, 'Edit', 'a.ts', { added: 3, removed: 1 }),
      done(12, 'Edit'),
      say(20, '跑测试'),
      call(21, 'Bash', 'pnpm test'),
      done(22, 'Bash', true),
      row(30, { kind: 'result', text: '做完了', ok: true }),
    ];
    const p = cutSteps(rows, { running: false, endedAt: at(31) });
    expect(p.steps.map((s) => s.title)).toEqual(['我先看看代码', '改一下', '跑测试']);
    expect(p.steps[0]).toMatchObject({ reads: 1, calls: 1, firstSeq: 1 });
    // 起止：下一步开始就是这一步结束；最后一步到这一段收场
    expect(p.steps[0]?.endedAt).toBe(at(10));
    expect(p.steps[0]?.durationMs).toBe(9000);
    expect(p.steps[2]?.endedAt).toBe(at(31));
    expect(p.steps[2]?.durationMs).toBe(11000);
    expect(p.steps.every((s) => !s.running)).toBe(true);
    expect(p.counts).toMatchObject({ commands: 1, commandsFailed: 0, reads: 1, added: 3, removed: 1 });
    expect(p.counts.files).toEqual([{ path: 'a.ts', edits: 1, added: 3, removed: 1 }]);
  });

  it('第一句话之前就先调工具：这一步没有标题', () => {
    reset();
    const p = cutSteps([call(0, 'Bash', 'ls'), done(1, 'Bash')], { running: false });
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]?.title).toBeNull();
  });

  it('没成的命令计失败，所在步骤标 failed，别的步骤不受影响', () => {
    reset();
    const p = cutSteps(
      [
        say(0, '跑一下'),
        call(1, 'Bash', 'a'),
        done(2, 'Bash', false),
        call(3, 'Bash', 'b'),
        done(4, 'Bash', true),
        say(5, '再看'),
        call(6, 'Read', 'x'),
        done(7, 'Read'),
      ],
      { running: false },
    );
    expect(p.steps[0]).toMatchObject({ commands: 2, commandsFailed: 1, callsFailed: 1, failed: true });
    expect(p.steps[1]?.failed).toBe(false);
    expect(p.counts).toMatchObject({ commands: 2, commandsFailed: 1 });
  });

  it('报错条目和没成的结论也让步骤 failed', () => {
    reset();
    const p = cutSteps([say(0, '试'), row(1, { kind: 'error', text: '炸了' })], { running: false });
    expect(p.steps[0]?.failed).toBe(true);
    reset();
    const q = cutSteps([say(0, '试'), row(1, { kind: 'result', text: '没成', ok: false })], {
      running: false,
    });
    expect(q.steps[0]?.failed).toBe(true);
  });

  it('同一个工具多个调用按先进先出对结果；子代理里的调用和结果分开对', () => {
    reset();
    const p = cutSteps(
      [
        say(0, '开干'),
        call(1, 'Bash', 'main-1'),
        call(2, 'Bash', 'sub-1', { sub: true }),
        done(3, 'Bash', false, { sub: true }),
        done(4, 'Bash', true),
      ],
      { running: false },
    );
    // 子代理那条失败，主会话那条成功
    expect(p.steps[0]).toMatchObject({ commands: 2, commandsFailed: 1 });
  });

  it('没有结果的命令：段还在跑算在跑，已结束算没读到结果，都不算成功也不算失败', () => {
    reset();
    const rows = [say(0, '跑'), call(1, 'Bash', 'sleep 100')];
    const live = cutSteps(rows, { running: true });
    expect(live.counts).toMatchObject({
      commands: 1,
      commandsFailed: 0,
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

  it('改文件：同一个文件多次编辑合并；没记行数的不拿 0 顶，计入 uncounted；没成的编辑不算改', () => {
    reset();
    const p = cutSteps(
      [
        say(0, '改'),
        call(1, 'Edit', 'a.ts', { added: 2, removed: 1 }),
        done(2, 'Edit'),
        call(3, 'Edit', 'a.ts', { added: 1, removed: 0 }),
        done(4, 'Edit'),
        call(5, 'Write', 'b.ts'), // 没记行数
        done(6, 'Write'),
        call(7, 'Edit', 'c.ts', { added: 9, removed: 9 }),
        done(8, 'Edit', false),
      ],
      { running: false },
    );
    expect(p.counts.files).toEqual([
      { path: 'a.ts', edits: 2, added: 3, removed: 1 },
      { path: 'b.ts', edits: 1 },
    ]);
    expect(p.counts).toMatchObject({ added: 3, removed: 1, uncounted: 1 });
  });

  it('一条都没有 / 只有提示词：没有步骤', () => {
    reset();
    expect(cutSteps([], { running: true }).steps).toEqual([]);
    expect(cutSteps([row(0, { kind: 'prompt', text: 'p' })], { running: false }).steps).toEqual([]);
  });

  it('到了每段的条数上限就标 truncated', () => {
    reset();
    const rows = [say(0, 'a'), call(1, 'Read', 'x'), done(2, 'Read')];
    expect(cutSteps(rows, { running: false, maxEntries: 3 }).truncated).toBe(false);
    expect(cutSteps(rows, { running: false, maxEntries: 2 }).truncated).toBe(true);
  });
});

describe('合并', () => {
  it('mergeFiles 同路径相加；任何一边没记行数的保留已记的那边', () => {
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

  it('sumRunCounts 把几段加起来', () => {
    reset();
    const a = cutSteps([say(0, 'x'), call(1, 'Bash', 'a'), done(2, 'Bash', false)], { running: false });
    const b = cutSteps([say(0, 'y'), call(1, 'Bash', 'b')], { running: true });
    const sum = sumRunCounts([a.counts, b.counts]);
    expect(sum).toMatchObject({ commands: 2, commandsFailed: 1, commandsRunning: 1 });
  });
});

describe('countEditLines：引擎记 Edit / MultiEdit / Write 的增删行数', () => {
  it('Edit 去掉共同的头尾再数', () => {
    expect(countEditLines('Edit', { old_string: 'a\nb\nc', new_string: 'a\nB\nB2\nc' })).toEqual({
      added: 2,
      removed: 1,
    });
    expect(countEditLines('Edit', { old_string: 'x', new_string: 'x' })).toEqual({ added: 0, removed: 0 });
  });
  it('Write 整份按新增，MultiEdit 逐个相加', () => {
    expect(countEditLines('Write', { content: 'a\nb\nc' })).toEqual({ added: 3, removed: 0 });
    expect(countEditLines('Write', { content: '' })).toEqual({ added: 0, removed: 0 });
    expect(
      countEditLines('MultiEdit', {
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: '', new_string: 'x\ny' },
        ],
      }),
    ).toEqual({ added: 3, removed: 1 });
  });
  it('输入里缺字段、别的工具：不猜', () => {
    expect(countEditLines('Edit', { old_string: 'a' })).toBeUndefined();
    expect(countEditLines('MultiEdit', { edits: [{ old_string: 'a' }] })).toBeUndefined();
    expect(countEditLines('Bash', { command: 'ls' })).toBeUndefined();
  });
});
