// @vitest-environment happy-dom
// 阶段记录（stage-trace.ts，#3372）：测试卡住时日志里要能读到时间花在了哪一步。这里核它自己：
// ① 调用栈里认得出测试文件的行号；② 阶段有上限、没结束的写成「…」；③ 事件循环晚到能量出来，并用时间区间的交集（不是「发生在那一步」）关联等待；
// ④ 离超时还差一截没收尾会打一行，收尾后不再打；输出口抛错不外冒；⑤ 字段和整行有字节上限、写明截断；
// ⑥ 装到测试文件里后 findBy / waitFor 按异步链归属：串行超时的旧测试迟到的等待不会算到下一个测试，并发的各算各的；asyncWrapper 用完还原；
// ⑦ harness 外层 Profiler 报的 React 渲染耗时记进它发生时的那次等待，render() 首屏这种不在等待里的单列。
import { cleanup, configure, getConfig, screen, waitFor } from '@testing-library/react';
import { createElement, useEffect, useState } from 'react';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { renderApp } from './harness';
import {
  boundLine,
  callerOf,
  clipBytes,
  format,
  installStageTrace,
  LINE_MAX_BYTES,
  STAGE_AT_MAX_BYTES,
  STAGE_CAP,
  StageTrace,
  TEST_NAME_MAX_BYTES,
} from './stage-trace';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const busyWait = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* 故意占住本线程 */
  }
};
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

const traces: StageTrace[] = [];
function newTrace(watchAtMs: number, emit: (l: string) => void = () => {}, name = '用例'): StageTrace {
  const t = new StageTrace(name, watchAtMs, emit);
  traces.push(t);
  return t;
}
afterEach(() => {
  vi.restoreAllMocks();
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

describe('字节上限', () => {
  test('clipBytes 按 UTF-8 字节截、不切断字符、去掉控制字符并写明截断', () => {
    const long = '测'.repeat(1000);
    const clipped = clipBytes(long, 100);
    expect(bytes(clipped)).toBeLessThanOrEqual(100);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped).not.toContain('�');
    expect(clipBytes('a\nb\r\tc\u0000d', 50)).toBe('a b  c d');
    expect(clipBytes('短', 50)).toBe('短');
  });

  test('boundLine 超限时截断并写明原来多少字节', () => {
    const line = `x${'好'.repeat(100_000)}`;
    const out = boundLine(line);
    expect(bytes(out)).toBeLessThanOrEqual(LINE_MAX_BYTES);
    expect(out).toContain(`已截断，原 ${bytes(line)} 字节`);
    expect(boundLine('不长')).toBe('不长');
  });

  test('测试名、位置各有字节上限；整行经输出口时不超过上限，STAGE_CAP 条之外只计数', () => {
    const lines: string[] = [];
    const t = newTrace(60_000, (l) => lines.push(l), '长'.repeat(100_000));
    for (let i = 0; i < STAGE_CAP + 40; i++) t.leave(t.enter(`${'位'.repeat(100_000)}:${i}`));
    const r = t.report();
    expect(bytes(r.test)).toBeLessThanOrEqual(TEST_NAME_MAX_BYTES);
    expect(r.stages).toHaveLength(STAGE_CAP);
    for (const s of r.stages) expect(bytes(s.at)).toBeLessThanOrEqual(STAGE_AT_MAX_BYTES);
    expect(r.droppedStages).toBe(40);
    expect(t.send(format(r))).toBe(true);
    expect(lines).toHaveLength(1);
    expect(bytes(lines[0] as string)).toBeLessThanOrEqual(LINE_MAX_BYTES);
    expect(lines[0]).toContain('另有 40 次未展开');
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

  test('本线程被同步工作占住：晚到的次数、最长一次和它的区间量得出来，区间与占住期间的那一步有交集', async () => {
    const t = newTrace(60_000);
    const e = t.enter('x.test.tsx:9');
    busyWait(300);
    await sleep(60);
    t.leave(e);
    const r = t.report();
    expect(r.blocked.count).toBeGreaterThanOrEqual(1);
    expect(r.blocked.maxMs).toBeGreaterThanOrEqual(150);
    expect(r.blocked.overlapStages).toEqual([1]);
    expect(r.blocked.overlapComplete).toBe(true);
    expect(r.loopUtilization).toBeGreaterThan(0);
    expect(format(r)).toContain('与等待 #1 的区间有交集');
  });

  test('占住发生在这一步里、探针到这一步收尾之后才晚到：区间仍和这一步有交集（旧写法会记成第 0 次）', async () => {
    const t = newTrace(60_000);
    const e = t.enter('x.test.tsx:10');
    busyWait(220);
    t.leave(e);
    await sleep(50);
    const r = t.report();
    expect(r.blocked.count).toBeGreaterThanOrEqual(1);
    expect(r.stages[0]?.endMs).toBeGreaterThanOrEqual(200);
    expect(r.blocked.overlapStages).toEqual([1]);
  });

  test('占住时没有任何等待，之后才进的等待与区间无交集，写明无交集而不是归到某一步', async () => {
    const t = newTrace(60_000);
    busyWait(220);
    await sleep(50);
    t.leave(t.enter('x.test.tsx:11'));
    const r = t.report();
    expect(r.blocked.count).toBeGreaterThanOrEqual(1);
    expect(r.blocked.overlapStages).toEqual([]);
    expect(format(r)).toContain('与已记的等待区间都无交集');
  });

  test('有等待没展开时，交集标成可能不全', async () => {
    const t = newTrace(60_000);
    for (let i = 0; i < STAGE_CAP + 1; i++) t.leave(t.enter(`x.test.tsx:${i}`));
    busyWait(220);
    await sleep(50);
    const r = t.report();
    expect(r.blocked.count).toBeGreaterThanOrEqual(1);
    expect(r.blocked.overlapComplete).toBe(false);
    expect(format(r)).toContain('交集可能不全');
  });

  test('读数的含义：负载在 Windows 上是未知而不是 0；CPU 写明含所有线程', () => {
    const r = newTrace(60_000).report();
    if (process.platform === 'win32') {
      expect(r.loadavg1).toBeNull();
      expect(format(r)).toContain('负载 未知');
    } else {
      expect(typeof r.loadavg1).toBe('number');
    }
    expect(format(r)).toContain('含所有线程');
  });

  test('React 渲染耗时记进最近一次还没结束的等待，没有等待时单列；收尾后、非数的不记', () => {
    const t = newTrace(60_000);
    t.noteRender(30);
    const a = t.enter('x.test.tsx:1');
    t.noteRender(50);
    t.noteRender(Number.NaN);
    t.noteRender(-1);
    t.leave(a);
    t.leave(t.enter('x.test.tsx:2'));
    const r = t.finish();
    t.noteRender(1000);
    expect(r.stages.map((s) => s.renderMs)).toEqual([50, 0]);
    expect(r.render).toEqual({ commits: 2, totalMs: 80, outsideWaitsMs: 30 });
    const line = format(r);
    expect(line).toContain('React 提交 2 次、组件渲染合计 80ms（不在已记等待里的 30ms');
    expect(line).toMatch(/#1 x\.test\.tsx:1 \d+→\d+ms（渲染 50ms）/);
    expect(line).not.toMatch(/#2 x\.test\.tsx:2 \d+→\d+ms（渲染/);
    expect(format(newTrace(60_000).report())).toContain('React 没有提交');
  });

  test('收尾之后才到的等待不记，只计迟到', () => {
    const t = newTrace(60_000);
    t.finish();
    expect(t.enter('x.test.tsx:1')).toBeNull();
    expect(t.lateWaits).toBe(1);
    expect(t.stages).toEqual([]);
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

  test('输出口抛错：watchdog 回调不外冒，计成输出失败并在 stderr 留一行', async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => {
      written.push(String(s));
      return true;
    }) as typeof process.stderr.write);
    const t = newTrace(20, () => {
      throw new Error('输出口坏了');
    });
    t.enter('x.test.tsx:4');
    await sleep(80);
    const r = t.finish();
    expect(r.outputFailures).toBe(1);
    expect(format(r)).toContain('输出失败 1 次');
    expect(written.join('')).toContain('输出失败');
    expect(written.join('')).toContain('输出口坏了');
  });

  test('输出口和 stderr 都坏：仍不外冒，输出失败照计', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation((() => {
      throw new Error('stderr 也坏了');
    }) as typeof process.stderr.write);
    const t = newTrace(20, () => {
      throw new Error('输出口坏了');
    });
    await sleep(60);
    expect(t.finish().outputFailures).toBe(1);
    expect(t.send('再来一行')).toBe(false);
    expect(t.finish().outputFailures).toBe(2);
  });
});

describe('installStageTrace：串行超时的旧测试迟到的等待不算到下一个测试', () => {
  const lines: string[] = [];
  const original = getConfig().asyncWrapper;
  installStageTrace({ watchAtMs: 500, reportOverMs: 0, emit: (l) => lines.push(l) });

  // A 在 30ms 超时，它的后续 80ms 才调 waitFor；这时 B 正在跑。
  test.fails('A：超时，之后迟到的等待', { timeout: 30 }, async () => {
    await sleep(80);
    await waitFor(() => expect(true).toBe(true));
  });

  test('B：自己只等一次，别人迟到的那一次不能出现在它名下', async () => {
    await sleep(120);
    await waitFor(() => expect(true).toBe(true));
  });

  test('C：完全没有等待', async () => {
    await sleep(20);
  });

  afterAll(() => {
    const lineOf = (name: string) => lines.find((l) => l.includes(`test=${name}`)) ?? '';
    // 收尾时 asyncWrapper 已还原
    expect(getConfig().asyncWrapper).toBe(original);
    const b = lineOf('installStageTrace：串行超时的旧测试迟到的等待不算到下一个测试 > B');
    expect(b).not.toBe('');
    expect(b.match(/#\d+ stage-trace\.test\.ts:\d+/g)).toHaveLength(1);
    expect(b).toMatch(/#1 stage-trace\.test\.ts:\d+ \d+→\d+ms/);
    const c = lineOf('installStageTrace：串行超时的旧测试迟到的等待不算到下一个测试 > C');
    expect(c).not.toBe('');
    expect(c).not.toMatch(/#\d+ stage-trace/);
    expect(lines.some((l) => l.includes('归属未知'))).toBe(false);
    configure({ asyncWrapper: original });
  });
});

describe('installStageTrace：并发的测试各记各的，收尾后全部还原', () => {
  const lines: string[] = [];
  const original = getConfig().asyncWrapper;
  installStageTrace({ watchAtMs: 500, reportOverMs: 0, emit: (l) => lines.push(l) });

  test.concurrent('P：等一次', async () => {
    await sleep(10);
    await waitFor(() => expect(true).toBe(true));
    await sleep(100);
  });

  test.concurrent('Q：等两次', async () => {
    await waitFor(() => expect(true).toBe(true));
    await sleep(40);
    await waitFor(() => expect(true).toBe(true));
    await sleep(40);
  });

  afterAll(() => {
    expect(getConfig().asyncWrapper).toBe(original);
    const stagesOf = (name: string) =>
      (
        lines.find((l) =>
          l.includes(`test=installStageTrace：并发的测试各记各的，收尾后全部还原 > ${name}`),
        ) ?? ''
      ).match(/#\d+ stage-trace\.test\.ts:\d+/g) ?? [];
    expect(stagesOf('P：等一次')).toHaveLength(1);
    expect(stagesOf('Q：等两次')).toHaveLength(2);
    configure({ asyncWrapper: original });
  });
});

describe('installStageTrace + harness 的 Profiler：渲染耗时记进它发生时的那次等待', () => {
  const lines: string[] = [];
  const original = getConfig().asyncWrapper;
  installStageTrace({ watchAtMs: 60_000, reportOverMs: 0, emit: (l) => lines.push(l) });

  // 首屏渲染占 60ms，数据「回来」后的那次占 120ms：前者在 render() 里（不在等待里），后者在 findByText 里。
  function Slow() {
    const [ready, setReady] = useState(false);
    useEffect(() => {
      const t = setTimeout(() => setReady(true), 20);
      return () => clearTimeout(t);
    }, []);
    busyWait(ready ? 120 : 60);
    return createElement('p', null, ready ? '好了' : '等着');
  }

  test('首屏算在等待外，数据回来后的渲染算进 findBy', async () => {
    renderApp(createElement(Slow));
    await screen.findByText('好了');
    cleanup();
  });

  afterAll(() => {
    expect(getConfig().asyncWrapper).toBe(original);
    const line = lines.find((l) => l.includes('首屏算在等待外')) ?? '';
    const inWait = /#1 stage-trace\.test\.ts:\d+ \d+→\d+ms（渲染 (\d+)ms）/.exec(line);
    const outside = /不在已记等待里的 (\d+)ms/.exec(line);
    expect(Number(inWait?.[1])).toBeGreaterThanOrEqual(110);
    // 外壳里的 Provider 首屏后可能再渲染一遍，等待外不设上限；120ms 那次进了 findBy 才说明归属是对的。
    expect(Number(outside?.[1])).toBeGreaterThanOrEqual(55);
    configure({ asyncWrapper: original });
  });
});

describe('installStageTrace 装进测试文件：慢用例的记录', () => {
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
