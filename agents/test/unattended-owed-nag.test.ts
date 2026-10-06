import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noteFounderPrompt, readOwed, withOwed } from '../hooks/unattended.mjs';

const sessionId = 'test-session-123';

describe('收尾放行时清掉欠账，不再把它拼进挡回理由', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'owed-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('放行就清账', () => {
    noteFounderPrompt({ dir, sessionId, prompt: '测试欠账信息' });
    const v = withOwed({ block: false }, { dir, sessionId });
    expect(v).toEqual({ block: false });
    expect(readOwed({ dir, sessionId })).toEqual({ ok: true, owed: null });
  });

  it('没有欠账时原样放行', () => {
    const v = withOwed({ block: false }, { dir, sessionId });
    expect(v).toEqual({ block: false });
    expect(existsSync(join(dir, `${sessionId}.owed.json`))).toBe(false);
  });
});
