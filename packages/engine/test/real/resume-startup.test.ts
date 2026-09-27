// 续会话等第一帧的时限按会话已有长度放宽（real/sessions.ts 的 resumeStartupMs）、上一个会话留下的没提交改动写进提示词
// （real/prompts.ts 的 leftoverBlock）；没查成的照实说。
import { describe, expect, it } from 'vitest';
import { leftoverBlock } from '../../src/real/prompts.ts';
import { RESUME_STARTUP_MAX_MS, resumeStartupMs, STARTUP_BASE_MS } from '../../src/real/sessions.ts';

const at = (min: number) => new Date(Date.parse('2026-09-28T01:00:00Z') + min * 60_000);

describe('续会话等第一帧', () => {
  it('新开、接力的不读过程记录：照插头默认', () => {
    expect(resumeStartupMs('new', null)).toBeUndefined();
    expect(
      resumeStartupMs('relay', { contextTokens: 900_000, startedAt: null, endedAt: null }),
    ).toBeUndefined();
  });

  it('按上下文多等：每 4 万 token 一分钟，最多 12 分钟', () => {
    expect(resumeStartupMs('resume', { contextTokens: 40_000, startedAt: null, endedAt: null })).toBe(
      STARTUP_BASE_MS + 60_000,
    );
    expect(resumeStartupMs('fork', { contextTokens: 5_000_000, startedAt: null, endedAt: null })).toBe(
      RESUME_STARTUP_MAX_MS,
    );
  });

  it('上下文不知道（Grok 不报）：按上一轮跑了多久，每 10 分钟一分钟——#276 跑了 55 分钟的会话多等 6 分钟', () => {
    expect(resumeStartupMs('resume', { contextTokens: null, startedAt: at(0), endedAt: at(55) })).toBe(
      STARTUP_BASE_MS + 6 * 60_000,
    );
  });

  it('多长都不知道：不拿默认的 3 分钟赌，给放宽的一半', () => {
    const ms = resumeStartupMs('resume', { contextTokens: null, startedAt: null, endedAt: null });
    expect(ms).toBeGreaterThan(STARTUP_BASE_MS);
    expect(ms).toBeLessThan(RESUME_STARTUP_MAX_MS);
  });
});

describe('上一个会话没提交的改动', () => {
  it('有：写明几个、先读 git diff 接着做，不从头重写', () => {
    const text = leftoverBlock([' M src/a.ts', '?? src/b.ts']);
    expect(text).toContain('2 个文件');
    expect(text).toContain('git diff');
    expect(text).toContain('- ?? src/b.ts');
  });

  it('太多只列前 20 个，写明还有几个', () => {
    const many = Array.from({ length: 26 }, (_, i) => ` M src/f${i}.ts`);
    const text = leftoverBlock(many);
    expect(text).toContain('26 个文件');
    expect(text).toContain('还有 6 个');
  });

  it('没有就不写；没查成照实说、让它自己看', () => {
    expect(leftoverBlock([])).toBe('');
    expect(leftoverBlock(undefined)).toBe('');
    expect(leftoverBlock({ error: 'git status 退出码 128' })).toContain('没查成');
  });
});
