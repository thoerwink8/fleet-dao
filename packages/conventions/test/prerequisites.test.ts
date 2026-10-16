// 单正文里「前置：」那一行的解析（#2783）：本机队列（work-queue.ts）和引擎拉单（packages/engine/src/jobs/intake.ts）共用这一份。
// 这里写明认哪些写法、不认哪些写法；认不出的一律按「没有前置」算、不抛。
import { describe, expect, it } from 'vitest';
import { beijingDate, parsePrerequisites, waitingUntil } from '../src/prerequisites.ts';

describe('parsePrerequisites：认「前置：」开头的那一行', () => {
  it('一行写几个单号：按出现先后、去重', () => {
    expect(parsePrerequisites('前置：#2725、#2737、#2725')).toEqual({ issues: [2725, 2737], until: null });
  });

  it('后面跟说明文字也认：括号里、句尾的话不影响单号', () => {
    expect(parsePrerequisites('前置：#2736（拉单查验收条能不能从 diff 判）合并后再做')).toEqual({
      issues: [2736],
      until: null,
    });
    expect(parsePrerequisites('前置：#2725（能力下限）和 #2737 合并后再做')).toEqual({
      issues: [2725, 2737],
      until: null,
    });
  });

  it('半角冒号、行首空白、CRLF 换行都认；正文里写了好几行「前置：」都算', () => {
    expect(parsePrerequisites('## 场景\r\n\r\n  前置:#5\r\n别的话\r\n前置：#6')).toEqual({
      issues: [5, 6],
      until: null,
    });
  });

  it('日期前置：前置：2026-11-12 复查日（#1960 就是这种）', () => {
    expect(parsePrerequisites('改完了，要到 11-12 复查。\n\n前置：2026-11-12 复查日')).toEqual({
      issues: [],
      until: '2026-11-12',
    });
  });

  it('单号和日期可以写在同一行；日期取最晚的一个', () => {
    expect(parsePrerequisites('前置：#7 合并后，且不早于 2026-11-12（再等 2026-11-20 复查）')).toEqual({
      issues: [7],
      until: '2026-11-20',
    });
    expect(parsePrerequisites('前置：2026-11-20\n前置：2026-11-12')).toEqual({
      issues: [],
      until: '2026-11-20',
    });
  });

  it('不认的写法按没有前置算、不抛：别处写的 #N、不在行首、列表项、引用、行内引号、没有冒号', () => {
    const none = { issues: [], until: null };
    expect(parsePrerequisites('正文里别处写 #83 不算前置')).toEqual(none);
    expect(parsePrerequisites('不是前置：#1')).toEqual(none);
    expect(parsePrerequisites('- 前置：#3')).toEqual(none);
    expect(parsePrerequisites('> 前置：#3')).toEqual(none);
    expect(parsePrerequisites('「前置：#3」')).toEqual(none);
    expect(parsePrerequisites('前置 #3')).toEqual(none);
    expect(parsePrerequisites('前置条件：#3')).toEqual(none);
    expect(parsePrerequisites('前置：无')).toEqual(none);
    expect(parsePrerequisites('')).toEqual(none);
  });

  it('代码块里的「前置：」是举例，不算', () => {
    expect(parsePrerequisites('举例：\n\n```\n前置：#9\n```\n\n~~~md\n前置：2030-01-01\n~~~\n')).toEqual({
      issues: [],
      until: null,
    });
    // 代码块结束以后又恢复
    expect(parsePrerequisites('```\n前置：#9\n```\n前置：#10')).toEqual({ issues: [10], until: null });
  });

  it('日期只认 YYYY-MM-DD 且是真有的那天：2026-13-45、2026-02-30、11-12、2026/11/12 都不认', () => {
    for (const line of [
      '前置：2026-13-45',
      '前置：2026-02-30',
      '前置：11-12 复查',
      '前置：2026/11/12',
      '前置：2026-1-2',
    ]) {
      expect(parsePrerequisites(line)).toEqual({ issues: [], until: null });
    }
    expect(parsePrerequisites('前置：2028-02-29')).toEqual({ issues: [], until: '2028-02-29' });
  });

  it('单号：0、超出安全整数的不算', () => {
    expect(parsePrerequisites('前置：#0 #99999999999999999999 #4')).toEqual({ issues: [4], until: null });
  });
});

describe('beijingDate / waitingUntil：按北京时间到那天之前算「等到」', () => {
  it('beijingDate：UTC 16:00 就已经是北京时间的第二天', () => {
    expect(beijingDate(new Date('2026-11-11T15:59:59Z'))).toBe('2026-11-11');
    expect(beijingDate(new Date('2026-11-11T16:00:00Z'))).toBe('2026-11-12');
  });

  it('没写日期：不等', () => {
    expect(waitingUntil({ issues: [3], until: null }, new Date('2026-10-16T00:00:00Z'))).toBeNull();
  });

  it('到那天之前（含前一天的北京时间 23:59）等；北京时间那天 0 点起不再等', () => {
    const pre = { issues: [], until: '2026-11-12' };
    expect(waitingUntil(pre, new Date('2026-10-16T09:00:00Z'))).toBe('2026-11-12');
    expect(waitingUntil(pre, new Date('2026-11-11T15:59:59Z'))).toBe('2026-11-12');
    expect(waitingUntil(pre, new Date('2026-11-11T16:00:00Z'))).toBeNull();
    expect(waitingUntil(pre, new Date('2026-11-13T00:00:00Z'))).toBeNull();
  });
});
