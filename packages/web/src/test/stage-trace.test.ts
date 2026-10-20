// @vitest-environment happy-dom
// 阶段记录（stage-trace.ts，#3372）：测试卡住时日志里要能读到时间花在了哪一步。这里核它自己：
// ① 调用栈里认得出测试文件的行号；② 阶段有上限、没结束的写成「…」；③ 事件循环被同步工作挡住能量出来；
// ④ 离超时还差一截没收尾会打一行，收尾后不再打；⑤ 装到测试文件里后 findBy / waitFor 的进出都记得到，asyncWrapper 用完还原。
import { configure, getConfig, waitFor } from '@testing-library/react';
import { afterAll, afterEach, describe, expect, test } from 'vitest';
import { callerOf, format, installStageTrace, STAGE_CAP, StageTrace } from './stage-trace';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const busyWait = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* 故意占住本线程 */
  }
};

const traces: StageTrace[] = [];
function newTrace(watchAtMs: number, emit: (l: string) => void = () => {}): StageTrace {
  const t = new StageTrace('用例', watchAtMs, emit);
  traces.push(t);
  return t;
}
afterEach(() => {
  while (traces.length > 0) traces.pop()?.finish();
});

describe('callerOf', () => {
  test('取调用栈里第一个测试文件的 文件名:行，认不出写 ?', () => {
    const stack = [
      'Error',
      '    at waitFor (/repo/node_modules/@testing-library/dom/dist/wait-for.js:20:5)',
      '    at /repo/packages/web/src/routes/france-release.test.tsx:96:9',
      '    at /repo/packages/web/src/routes/other.test.tsx:7:1',
    ].join('\n');
    expect(callerOf(stack)).toBe('france-release.test.tsx:96');
    expect(callerOf('Error\n    at x (/repo/a.ts:1:1)')).toBe('?');
    expect(callerOf(undefined)).toBe('?');
  });
});

describe('StageTrace', () => {
  test('没结束的那一步写成「…」，已结束的写起止毫秒', () => {
    const t = newTrace(60_000);
    const a = t.enter('x.test.tsx:1');
    t.leave(a);
    t.enter('x.test.tsx:2');
    const r = t.report();
    expect(r.stages.map((s) => s.endMs === null)).toEqual([false, true]);
    const line = format(r);
    expect(line).toContain('#1 x.test.tsx:1');
    expect(line).toMatch(/#2 x\.test\.tsx:2 \d+→…ms/);
  });

  test('阶段最多记 STAGE_CAP 条，多的只计数', () => {
    const t = newTrace(60_000);
    for (let i = 0; i < STAGE_CAP + 5; i++) t.leave(t.enter(`x.test.tsx:${i}`));
    const r = t.report();
    expect(r.stages).toHaveLength(STAGE_CAP);
    expect(r.droppedStages).toBe(5);
    expect(format(r)).toContain('另有 5 次未展开');
    expect(format(r).length).toBeLessThan(4000);
  });

  test('本线程被同步工作占住，事件循环被挡的次数和最长一次能量出来，记在当时那一步里', async () => {
    const t = newTrace(60_000);
    const e = t.enter('x.test.tsx:9');
    busyWait(300);
    await sleep(60);
    t.leave(e);
    const r = t.report();
    expect(r.blocked.count).toBeGreaterThanOrEqual(1);
    expect(r.blocked.maxMs).toBeGreaterThanOrEqual(150);
    expect(r.blocked.maxAtStage).toBe(1);
    expect(r.loopUtilization).toBeGreaterThan(0);
  });

  test('离超时还差一截没收尾：打一行；收尾后不再打', async () => {
    const lines: string[] = [];
    const t = newTrace(30, (l) => lines.push(l));
    t.enter('x.test.tsx:3');
    await sleep(120);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('快超时');
    expect(lines[0]).toContain('x.test.tsx:3');

    const lines2: string[] = [];
    const t2 = newTrace(60, (l) => lines2.push(l));
    t2.finish();
    await sleep(120);
    expect(lines2).toEqual([]);
  });
});

describe('installStageTrace 装进测试文件', () => {
  const lines: string[] = [];
  const original = getConfig().asyncWrapper;
  installStageTrace({ watchAtMs: 20, reportOverMs: 0, emit: (l) => lines.push(l) });

  test('waitFor 的进出带着本文件的行号记下来，慢用例在收尾时再打一行', async () => {
    expect(getConfig().asyncWrapper).not.toBe(original);
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 80);
    await waitFor(() => expect(ready).toBe(true));
  });

  afterAll(() => {
    // 收尾后 asyncWrapper 已还原
    expect(getConfig().asyncWrapper).toBe(original);
    expect(lines.some((l) => l.includes('快超时'))).toBe(true);
    const slow = lines.find((l) => l.includes('偏慢'));
    expect(slow).toMatch(/#1 stage-trace\.test\.ts:\d+ \d+→\d+ms/);
    configure({ asyncWrapper: original });
  });
});
