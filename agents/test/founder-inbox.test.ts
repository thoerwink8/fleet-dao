import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lineageOf, readFounderHistory, sentByFounder } from '../hooks/founder-inbox.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const now = Date.parse('2026-10-18T04:00:00Z');
function world(turns: unknown[]) {
  const home = mkdtempSync(join(tmpdir(), 'founder-history-'));
  dirs.push(home);
  const base = join(home, '.mirasim', 'sessions', 'claude');
  const mine = join(base, 'family');
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, 'record.json'), JSON.stringify({ nativeSessionId: 'new', workdir: 'D:/repo' }));
  writeFileSync(join(mine, 'turns.jsonl'), turns.map((t) => JSON.stringify(t)).join('\n'));
  return { home, base, mine };
}
describe('实际Mirasim历史原文供进度命令使用，不判断送达', () => {
  it('上一轮95分钟窗口保留原文、重复短句、带下文重发；别家窗口不扩本家', () => {
    const w = world([
      {
        sessionId: 'old',
        startedAt: now - 95 * 60000,
        prompt: '原始 开场\n全文',
        steers: [
          { at: now - 94 * 60000, text: '短句' },
          { at: now - 90 * 60000, text: '短句' },
          { at: now - 85 * 60000, text: '短句 带下文' },
        ],
      },
      { sessionId: 'new', startedAt: now - 60000, prompt: '新轮' },
    ]);
    const result = sentByFounder({ home: w.home, now, env: {}, only: 'family' });
    expect(result.absent).toBe(false);
    if (result.absent) throw new Error('missing');
    expect(result.problems).toEqual([]);
    expect(result.entries.map((e) => e.text)).toEqual([
      '原始 开场\n全文',
      '短句',
      '短句',
      '短句 带下文',
      '新轮',
    ]);
    expect(result.since).toBe(now - 95 * 60000);
    const other = join(w.base, 'other');
    mkdirSync(other);
    writeFileSync(
      join(other, 'turns.jsonl'),
      JSON.stringify({ sessionId: 'other', startedAt: now - 3 * 3600000, prompt: '其他会话' }),
    );
    expect(sentByFounder({ home: w.home, now, env: {}, only: 'family' })).toEqual(result);
  });
  it('24小时封顶，过滤系统/机器/斜杠；附图原文保留，不按前缀匹配去重', () => {
    const w = world([
      {
        sessionId: 'old',
        startedAt: now - 25 * 3600000,
        prompt: '太久',
        steers: [{ at: now - 24 * 3600000 + 1, text: '上限内' }],
      },
      {
        sessionId: 'new',
        startedAt: now - 1000,
        prompt: '新轮',
        steers: [
          { at: now - 900, text: '/help' },
          { at: now - 800, text: '<system-reminder>系统' },
          { at: now - 700, text: '[The image above is also on disk at: /tmp/a.png]\n原始图片问题' },
        ],
      },
    ]);
    const result = sentByFounder({ home: w.home, now, env: {}, only: 'family' });
    if (result.absent) throw new Error('missing');
    expect(result.entries.map((e) => e.text)).toEqual([
      '上限内',
      '新轮',
      '[The image above is also on disk at: /tmp/a.png]\n原始图片问题',
    ]);
  });
  it('record新native号不要求当前turn行；API无投递字段，读历史不改文件', () => {
    const w = world([{ sessionId: 'old', startedAt: now - 1000, prompt: '只有turns里的话' }]);
    const before = readFileSync(join(w.mine, 'turns.jsonl'));
    const line = lineageOf({ home: w.home, sessionId: 'new', env: {} });
    expect(line.status).toBe('found');
    const result = readFounderHistory({ home: w.home, now, sessionId: 'new', env: {} });
    expect(result.status).toBe('ok');
    expect(result).not.toHaveProperty('lost');
    expect(result).not.toHaveProperty('matched');
    expect(result).not.toHaveProperty('relayed');
    expect(readFileSync(join(w.mine, 'turns.jsonl'))).toEqual(before);
  });
});
it('本家合法JSON的坏prompt/at明确诊断，别家坏时间不误报，正常历史仍显示', () => {
  const w = world([{ sessionId: 'old', startedAt: now - 1000, prompt: '开场' }]);
  const log = join(w.home, '.fleet-dao', 'prompt-log');
  mkdirSync(log, { recursive: true });
  const file = join(log, '2026-10-18.jsonl');
  for (const broken of [
    { sessionId: 'old', prompt: '本家', at: 'bad-date' },
    { sessionId: 'old', prompt: 35, at: new Date(now).toISOString() },
    { sessionId: 'old', prompt: '本家', at: 123 },
  ]) {
    writeFileSync(
      file,
      [
        broken,
        { sessionId: 'foreign', prompt: '别家', at: 'bad-date' },
        { sessionId: 'old', prompt: '本家正常历史', at: new Date(now - 1000).toISOString() },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );
    const result = readFounderHistory({ home: w.home, now, sessionId: 'new', env: {} });
    if (result.status !== 'ok') throw new Error('missing family');
    expect(result.readError).toContain(file);
    expect(result.readError).toContain('本血缘记录的 prompt 或 at 认不出');
    expect(result.received.map((e) => e.text)).toEqual(['本家正常历史']);
  }
  writeFileSync(file, JSON.stringify({ sessionId: 'foreign', prompt: '别家', at: 'bad-date' }));
  const foreign = readFounderHistory({ home: w.home, now, sessionId: 'new', env: {} });
  expect(foreign.status).toBe('ok');
  if (foreign.status === 'ok') expect(foreign.readError).toBeNull();
});
