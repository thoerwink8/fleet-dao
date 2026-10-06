import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearOwed, noteFounderPrompt, withOwed } from '../hooks/unattended.mjs';

const sessionId = 'test-session-123';

describe('withOwed 只把欠账提醒放最前一次', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'owed-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('欠账第一次挡住收尾时把欠账那句放最前，第二次只放收尾理由', () => {
    noteFounderPrompt({ dir, sessionId, prompt: '测试欠账信息' });

    // 第一次 block：含欠账提醒在最前
    const first = withOwed({ block: true as const, reason: '后台活在跑' }, { dir, sessionId });
    expect(first.block).toBe(true);
    if (first.block) {
      expect(first.reason).toContain('测试欠账信息');
      expect(first.reason.indexOf('测试欠账信息')).toBeLessThan(first.reason.indexOf('后台活在跑'));
    }

    // 第二次 block：只有收尾理由，不再重复欠账提醒
    const second = withOwed({ block: true as const, reason: '后台还在跑' }, { dir, sessionId });
    expect(second.block).toBe(true);
    if (second.block) {
      expect(second.reason).not.toContain('测试欠账信息');
      expect(second.reason).toBe('后台还在跑');
    }
  });

  it('放行时（不 block）清账，之后欠账就没了', () => {
    noteFounderPrompt({ dir, sessionId, prompt: '欠账一' });
    clearOwed({ dir, sessionId });
    const v = withOwed({ block: true as const, reason: '活没干完' }, { dir, sessionId });
    if (v.block) {
      expect(v.reason).toBe('活没干完');
      expect(v.reason).not.toContain('欠账一');
    }
  });

  it('没有欠账时原样通过', () => {
    const v = withOwed({ block: true as const, reason: '理由' }, { dir, sessionId });
    if (v.block) expect(v.reason).toBe('理由');
  });
});
