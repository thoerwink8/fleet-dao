import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_RUN,
  commandFailure,
  exitStatusUntrusted,
  FAILURE_MAX,
  failureText,
  firstString,
  NO_OUTPUT,
  resultText,
  searchSummary,
  TOOL_SUMMARY_MAX,
  TRANSCRIPT_SUMMARY_MAX,
  takeFrame,
  tally,
  todosSummary,
  toolSummaryText,
} from '../src/stream-kit.ts';

describe('stream-kit 工具摘要与失败原因', () => {
  it('toolSummaryText：读不到是空串，默认截到 200，刚好到上限不补省略号，可指定更长的上限', () => {
    expect(toolSummaryText(undefined)).toBe('');
    expect(toolSummaryText('')).toBe('');
    expect(toolSummaryText('a'.repeat(TOOL_SUMMARY_MAX))).toBe('a'.repeat(TOOL_SUMMARY_MAX));
    expect(toolSummaryText('a'.repeat(TOOL_SUMMARY_MAX + 1))).toBe(`${'a'.repeat(TOOL_SUMMARY_MAX)}…`);
    expect(toolSummaryText('a'.repeat(300), TRANSCRIPT_SUMMARY_MAX)).toBe('a'.repeat(300));
    expect(toolSummaryText('a'.repeat(TRANSCRIPT_SUMMARY_MAX), TRANSCRIPT_SUMMARY_MAX)).toBe(
      'a'.repeat(TRANSCRIPT_SUMMARY_MAX),
    );
    expect(toolSummaryText('a'.repeat(TRANSCRIPT_SUMMARY_MAX + 1), TRANSCRIPT_SUMMARY_MAX)).toBe(
      `${'a'.repeat(TRANSCRIPT_SUMMARY_MAX)}…`,
    );
  });

  it('firstString：认不出的工具取第一个字符串，空串算读到了，数字和嵌套对象跳过', () => {
    expect(firstString({ n: 1, empty: '', later: 'x' })).toBe('');
    expect(firstString({ n: 1, nested: { a: 'x' }, text: 'y' })).toBe('y');
    expect(firstString({ n: 1 })).toBeUndefined();
    expect(firstString({})).toBeUndefined();
  });

  it('searchSummary：模式 @ 相对路径，缺哪样省哪样', () => {
    expect(searchSummary('foo', '/w/src', '/w')).toBe('foo @ src');
    expect(searchSummary('foo', undefined, '/w')).toBe('foo');
    expect(searchSummary(undefined, '/w/src', '/w')).toBe('src');
    expect(searchSummary(undefined, undefined, '/w')).toBe('');
  });

  it('todosSummary：数条数，不是数组算 0', () => {
    expect(todosSummary([1, 2, 3])).toBe('待办 3 条');
    expect(todosSummary(undefined)).toBe('待办 0 条');
  });

  it('failureText：有说明用冒号接，没有说明或空串就只有标签，超长截到 500', () => {
    expect(failureText('rejected', 'nope')).toBe('rejected：nope');
    expect(failureText('没有结果')).toBe('没有结果');
    expect(failureText('没有结果', '')).toBe('没有结果');
    expect(failureText('', 'a')).toBe('：a');
    expect(failureText('失败', 'x'.repeat(600))).toHaveLength(FAILURE_MAX + 1);
  });

  it('commandFailure：跟 failureText 同一套拼法，有输出带上，没有只说原因', () => {
    expect(commandFailure('退出码 1', 'boom')).toBe(failureText('退出码 1', 'boom'));
    expect(commandFailure('超时', undefined)).toBe('超时');
    expect(commandFailure('超时', '')).toBe('超时');
    expect(commandFailure('退出码 1', 'x'.repeat(600))).toHaveLength(FAILURE_MAX + 1);
  });

  it('resultText：字符串原样，块数组拼 text，别的形状是空串', () => {
    expect(resultText('hi')).toBe('hi');
    expect(resultText([{ text: 'a' }, { type: 'image' }, { text: 'b' }])).toBe('ab');
    expect(resultText(undefined)).toBe('');
    expect(resultText([])).toBe('');
    expect(resultText([{ text: '' }, { text: 'a' }])).toBe('a');
    expect(resultText({ text: 'a' })).toBe('');
  });

  it('NO_OUTPUT 是「（无输出）」', () => {
    expect(NO_OUTPUT).toBe('（无输出）');
  });

  it('BACKGROUND_RUN：后台跑的测试记结果未知，命令末尾带 & 也是这个原因', () => {
    expect(BACKGROUND_RUN).toBe('放到后台跑，命令返回时测试还没跑完');
    expect(exitStatusUntrusted('pnpm check &')).toBe(BACKGROUND_RUN);
  });
});

describe('stream-kit takeFrame', () => {
  it('空行不计数；非 JSON 对象计 nonJsonLines、只留第一条样子（截到 200）；帧计 frames', () => {
    const counts: { frames: number; nonJsonLines: number; nonJsonSample?: string } = {
      frames: 0,
      nonJsonLines: 0,
    };
    expect(takeFrame('   ', counts)).toBeUndefined();
    expect(counts).toEqual({ frames: 0, nonJsonLines: 0 });
    expect(takeFrame(`  ${'x'.repeat(250)}  `, counts)).toBeUndefined();
    expect(takeFrame('[1,2]', counts)).toBeUndefined();
    expect(counts).toEqual({ frames: 0, nonJsonLines: 2, nonJsonSample: `${'x'.repeat(200)}…` });
    expect(takeFrame(' {"type":"x"} ', counts)).toEqual({ type: 'x' });
    expect(counts.frames).toBe(1);
  });
});

describe('stream-kit tally', () => {
  it('没见过的键从 1 起，见过的加一，别的键不动', () => {
    const counts: Record<string, number> = { a: 2 };
    tally(counts, 'b');
    tally(counts, 'a');
    tally(counts, 'b');
    expect(counts).toEqual({ a: 3, b: 2 });
  });
});
