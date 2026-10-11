// 路由行上「上次」「下次」两句（#1798 片 7，方案 3.6）：只读结构化列，不从原文里抠。
import { describe, expect, test } from 'vitest';
import { formatClock, TIME } from './format';
import { isLegacyQuizCell, probeCellSource } from './probe-history-view';
import { lastProbeLine, nextClockText, nextProbeLine } from './probe-pace-view';

const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime();
const at = (min: number) => new Date(NOW + min * TIME.MIN).toISOString();

describe('上次那一句', () => {
  test('时刻、种类、触发者各一段：「上次 12 分钟前 · 连通 · 定时」', () => {
    expect(lastProbeLine(at(-12), { kind: 'ping', trigger: 'scheduled' }, NOW)).toBe(
      '上次 12 分钟前 · 连通 · 定时',
    );
    expect(lastProbeLine(at(-3), { kind: 'identity', trigger: 'dispatch' }, NOW)).toBe(
      '上次 3 分钟前 · 身份题 · 派前',
    );
  });
  test('五种触发者都有白话', () => {
    const words = (['scheduled', 'dispatch', 'manual', 'break', 'org-switch'] as const).map((trigger) =>
      lastProbeLine(at(-12), { trigger }, NOW).replace('上次 12 分钟前 · ', ''),
    );
    expect(words).toEqual(['定时', '派前', '人点', '断链', '切号']);
  });
  test('库里没写的段不写，不拿默认值顶', () => {
    expect(lastProbeLine(at(-12), {}, NOW)).toBe('上次 12 分钟前');
    expect(lastProbeLine(at(-12), { kind: null }, NOW)).toBe('上次 12 分钟前');
  });
});

describe('下次那一句', () => {
  test('活跃：下次约 钟点（活跃，每小时）', () => {
    const next = nextProbeLine({ probeTier: 'active', probeNextAt: at(60), probeFailStreak: 0 }, NOW);
    expect(next).toEqual({ text: `下次约 ${formatClock(at(60))}（活跃，每小时）`, tone: 'normal' });
  });
  test('不活跃：下次约 明天 钟点（不活跃，每天）', () => {
    const next = nextProbeLine({ probeTier: 'idle', probeNextAt: at(24 * 60 - 5) }, NOW);
    expect(next?.text).toBe(`下次约 明天 ${formatClock(at(24 * 60 - 5))}（不活跃，每天）`);
  });
  test('不在用：不主动探，不写时刻', () => {
    expect(nextProbeLine({ probeTier: 'unused' }, NOW)).toEqual({
      text: '不主动探（没用途在用）',
      tone: 'normal',
    });
  });
  test('退避中：写连着不通几次和下次时刻', () => {
    const next = nextProbeLine({ probeTier: 'active', probeNextAt: at(30), probeFailStreak: 3 }, NOW);
    expect(next).toEqual({ text: `退避中，连着不通 3 次，下次约 ${formatClock(at(30))}`, tone: 'normal' });
  });
  test('到点了还没探（20 分钟内）：提示色，写等这一轮钟', () => {
    const next = nextProbeLine({ probeTier: 'active', probeNextAt: at(-5) }, NOW);
    expect(next?.tone).toBe('warn');
    expect(next?.text).toContain('已到点');
  });
  test('晚于下次加 20 分钟：检测中断，红，写本该几点探、晚了多久', () => {
    const next = nextProbeLine({ probeTier: 'active', probeNextAt: at(-35) }, NOW);
    expect(next).toEqual({
      text: `检测中断：本该 ${formatClock(at(-35))} 探，已过 35 分钟没探`,
      tone: 'fail',
    });
  });
  test('节奏档库里没写：回 null，不编一句', () => {
    expect(nextProbeLine({}, NOW)).toBeNull();
    expect(nextProbeLine({ probeTier: 'active' }, NOW)).toBeNull();
  });
  test('钟点：今天只写钟点，明天加「明天」，再远加日期', () => {
    expect(nextClockText(at(30), NOW)).toBe(formatClock(at(30)));
    expect(nextClockText(at(24 * 60), NOW)).toBe(`明天 ${formatClock(at(24 * 60))}`);
    expect(nextClockText(at(3 * 24 * 60), NOW)).toMatch(/^\d+月\d+日 \d{2}:\d{2}$/);
  });
});

describe('探测记录每一行的种类和触发者', () => {
  test('「身份题 · 派前」；老行没有的段不写', () => {
    expect(probeCellSource({ kind: 'identity', trigger: 'dispatch' })).toBe('身份题 · 派前');
    expect(probeCellSource({ kind: 'ping', trigger: undefined })).toBe('连通');
    expect(probeCellSource({ kind: undefined, trigger: undefined })).toBe('');
  });
  test('算术题时代的老记录（没有种类、带着题）标「旧版降智题」；新记录不标', () => {
    expect(isLegacyQuizCell({ kind: undefined, checkQuestion: '17 乘 23 等于多少？' })).toBe(true);
    expect(isLegacyQuizCell({ kind: 'identity', checkQuestion: '现任日本首相是谁？' })).toBe(false);
    expect(isLegacyQuizCell({ kind: undefined, checkQuestion: null })).toBe(false);
  });
});
