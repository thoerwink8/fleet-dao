// 隔离集进出（src/e2e-quarantine-sync.ts）：假仓里的 quarantine.json，核对放进、移出、同一条不重复开 PR。
import { describe, expect, test } from 'vitest';
import { outcomesOf, parseQuarantine } from '../src/e2e-flaky.ts';
import {
  planQuarantineSync,
  QUARANTINE_PATH,
  type QuarantineDay,
  shiftDay,
} from '../src/e2e-quarantine-sync.ts';
import { memRepo } from './helpers.ts';

const TODAY = '2026-10-17';
const FILE = '02-home.e2e.ts';
const TITLE = '主页三块';
const ISSUE_TITLE = `e2e 偶发：${FILE} › ${TITLE}`;

function repo(text: string) {
  return memRepo({ [QUARANTINE_PATH]: text });
}

function emptyFile(): string {
  return '{ "tests": [] }\n';
}

function day(date: string, status: string): QuarantineDay {
  return {
    day: date,
    outcomes: outcomesOf({
      suites: [{ specs: [{ title: TITLE, file: FILE, tests: [{ status }] }] }],
    }),
  };
}

/** 从今天往回 n 天，每天这条例都是 passed。 */
function passedDays(n: number): QuarantineDay[] {
  return Array.from({ length: n }, (_, i) => day(shiftDay(TODAY, -i), 'expected'));
}

const entry = {
  file: FILE,
  title: TITLE,
  issue: 12,
  until: '2026-10-20',
};

describe('隔离集进出', () => {
  test('进：开着的偶发单放进隔离集，说明里带单号', () => {
    const moves = planQuarantineSync({
      repo: repo(emptyFile()),
      openIssues: [
        { number: 12, title: ISSUE_TITLE },
        { number: 9, title: 'e2e 偶发：多条用例达阈值（汇总）' },
        { number: 8, title: '主线 e2e 整轮坏了' },
      ],
      openPulls: [],
      days: [],
      today: TODAY,
    });
    expect(moves).toHaveLength(1);
    const move = moves[0];
    expect(move?.kind).toBe('enter');
    expect(move?.open).toBe(true);
    expect(move?.issue).toBe(12);
    expect(move?.body).toContain('Refs #12');
    expect(move?.prTitle).toBe('隔离集：放进 #12');
    expect(parseQuarantine(move?.content ?? '')).toEqual([
      { file: FILE, title: TITLE, issue: 12, until: '2026-10-24' },
    ]);
    // 已经在文件里：不再开
    const again = planQuarantineSync({
      repo: repo(move?.content ?? ''),
      openIssues: [{ number: 12, title: ISSUE_TITLE }],
      openPulls: [],
      days: [],
      today: TODAY,
    });
    expect(again).toEqual([]);
  });

  test('出：连续 7 天全过就移出；少一天、中间有偶发都不移', () => {
    const held = `${JSON.stringify({ tests: [entry] }, null, 2)}\n`;
    const moves = planQuarantineSync({
      repo: repo(held),
      openIssues: [{ number: 12, title: ISSUE_TITLE }],
      openPulls: [],
      days: passedDays(7),
      today: TODAY,
    });
    expect(moves).toHaveLength(1);
    const move = moves[0];
    expect(move?.kind).toBe('exit');
    expect(move?.open).toBe(true);
    expect(move?.body).toContain('Refs #12');
    expect(move?.prTitle).toBe('隔离集：移出 #12');
    expect(parseQuarantine(move?.content ?? '')).toEqual([]);

    const six = planQuarantineSync({
      repo: repo(held),
      openIssues: [],
      openPulls: [],
      days: passedDays(6),
      today: TODAY,
    });
    expect(six).toEqual([]);

    const flaky = passedDays(7);
    const mid = flaky[3];
    if (!mid) throw new Error('天数不够');
    flaky[3] = day(mid.day, 'flaky');
    const broken = planQuarantineSync({
      repo: repo(held),
      openIssues: [],
      openPulls: [],
      days: flaky,
      today: TODAY,
    });
    expect(broken).toEqual([]);
  });

  test('同一条不重复开 PR：放进的不再开；移出的 PR 已在就只留关单', () => {
    const held = `${JSON.stringify({ tests: [entry] }, null, 2)}\n`;
    const pull = { number: 40, title: '隔离集：放进 #12', body: '**需求**：Refs #12\n' };
    const enter = planQuarantineSync({
      repo: repo(emptyFile()),
      openIssues: [{ number: 12, title: ISSUE_TITLE }],
      openPulls: [pull],
      days: [],
      today: TODAY,
    });
    expect(enter).toEqual([]);

    const exit = planQuarantineSync({
      repo: repo(held),
      openIssues: [],
      openPulls: [{ number: 41, title: '隔离集：移出 #12', body: '**需求**：Refs #12\n' }],
      days: passedDays(7),
      today: TODAY,
    });
    expect(exit).toHaveLength(1);
    expect(exit[0]?.open).toBe(false);
    expect(exit[0]?.kind).toBe('exit');
    // #123 不能把 #12 认成已经挂上
    const other = planQuarantineSync({
      repo: repo(emptyFile()),
      openIssues: [{ number: 12, title: ISSUE_TITLE }],
      openPulls: [{ number: 42, title: '别的', body: 'Refs #123' }],
      days: [],
      today: TODAY,
    });
    expect(other).toHaveLength(1);
    expect(other[0]?.open).toBe(true);
  });
});
