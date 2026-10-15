import { describe, expect, it } from 'vitest';
import {
  commandFailure,
  FAILURE_MAX,
  NO_OUTPUT,
  resultText,
  searchSummary,
  TOOL_SUMMARY_MAX,
  TRANSCRIPT_SUMMARY_MAX,
  todosSummary,
  toolSummaryText,
} from '../src/stream-kit.ts';

describe('stream-kit 工具摘要与失败原因', () => {
  it('toolSummaryText：读不到是空串，默认截到 200，可指定更长的上限', () => {
    expect(toolSummaryText(undefined)).toBe('');
    expect(toolSummaryText('a'.repeat(300))).toBe(`${'a'.repeat(TOOL_SUMMARY_MAX)}…`);
    expect(toolSummaryText('a'.repeat(300), TRANSCRIPT_SUMMARY_MAX)).toBe('a'.repeat(300));
    expect(toolSummaryText('a'.repeat(2500), TRANSCRIPT_SUMMARY_MAX)).toBe(`${'a'.repeat(2000)}…`);
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

  it('commandFailure：有输出带上，没有只说原因，超长截到 500', () => {
    expect(commandFailure('退出码 1', 'boom')).toBe('退出码 1：boom');
    expect(commandFailure('超时', undefined)).toBe('超时');
    expect(commandFailure('退出码 1', 'x'.repeat(600))).toHaveLength(FAILURE_MAX + 1);
  });

  it('resultText：字符串原样，块数组拼 text，别的形状是空串', () => {
    expect(resultText('hi')).toBe('hi');
    expect(resultText([{ text: 'a' }, { type: 'image' }, { text: 'b' }])).toBe('ab');
    expect(resultText(undefined)).toBe('');
    expect(resultText({ text: 'a' })).toBe('');
  });

  it('NO_OUTPUT 是「（无输出）」', () => {
    expect(NO_OUTPUT).toBe('（无输出）');
  });
});
