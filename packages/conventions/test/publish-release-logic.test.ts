import { describe, expect, it } from 'vitest';
import {
  appendFeishuAttemptMark,
  extractReleaseBody,
  feishuAlreadyNotified,
  feishuAttemptMark,
  feishuAttemptWritten,
  feishuNotifiedMark,
  pickOpenMilestone,
  promoteFeishuAttemptToNotified,
  stripFeishuAttemptMark,
} from '../src/publish-release-logic.ts';

describe('pickOpenMilestone：从开放 milestone 里挑要关的那一张', () => {
  it('只有一张 v1 开头 → 找它', () => {
    const r = pickOpenMilestone(
      [
        { number: 1, title: 'v1 Fusion 接活' },
        { number: 2, title: 'v2 后面那版' },
      ],
      'v1',
    );
    expect(r).toEqual({ kind: 'found', milestone: { number: 1, title: 'v1 Fusion 接活' } });
  });

  it('v1 不撞 v10（词边界匹配）：同时开着 v1 和 v10 时，挑到 v1、不撞 v10（第二意见 2026-10-02）', () => {
    const r = pickOpenMilestone(
      [
        { number: 10, title: 'v10 后面那版' },
        { number: 1, title: 'v1 Fusion 接活' },
      ],
      'v1',
    );
    expect(r).toEqual({ kind: 'found', milestone: { number: 1, title: 'v1 Fusion 接活' } });
  });

  it('v1 不撞 v11、v123：版本号末尾必须是词界（不是 0-9）', () => {
    const list = [
      { number: 11, title: 'v11 xxx' },
      { number: 123, title: 'v123 yyy' },
    ];
    const r = pickOpenMilestone(list, 'v1');
    expect(r.kind).toBe('none');
  });

  it('开放 milestone 里没找到 → none：多半已经被关过了，跳（不算错）', () => {
    const r = pickOpenMilestone([{ number: 2, title: 'v2 xxx' }], 'v1');
    expect(r.kind).toBe('none');
    if (r.kind === 'none') expect(r.why).toMatch(/多半已经被关过了/);
  });

  it('同时开着「v1 xxx」和「v1 yyy」两张 → ambiguous：发起人要看一眼，不拿「第一张」糊弄', () => {
    const r = pickOpenMilestone(
      [
        { number: 1, title: 'v1 xxx' },
        { number: 99, title: 'v1 yyy' },
      ],
      'v1',
    );
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.candidates.map((m) => m.number)).toEqual([1, 99]);
      expect(r.message).toMatch(/2 张都以 v1 开头/);
    }
  });

  it('v<非数字> 直接拒绝', () => {
    expect(() => pickOpenMilestone([], 'vNext' as `v${number}`)).toThrow(/不是 v<N>/);
  });
});

describe('extractReleaseBody：从 CHANGELOG.md 拿「## [vN] - 」那一段当正文', () => {
  const LOG = `# Changelog

## [Unreleased]

还没有

## [v2] - 2026-10-02

- 加了发布 vN 这一头
- 加了 CI 检查

## [v1] - 2026-10-01

- 第一版。
`;

  it('正常一份：拿到 v2 那一段的原文', () => {
    const r = extractReleaseBody(LOG, 'v2');
    expect(r).toEqual({ kind: 'ok', body: '- 加了发布 vN 这一头\n- 加了 CI 检查' });
  });

  it('故意造出的失败：CHANGELOG.md 里没有这一版 → 不拿 Unreleased 段顶替（那里多是占位「还没有」，第二意见 2026-10-02）', () => {
    const r = extractReleaseBody(LOG, 'v9');
    expect(r.kind).toBe('missing-heading');
    if (r.kind === 'missing-heading') expect(r.message).toMatch(/假 release/);
  });

  it('故意造出的失败：这一版正文是空的 → 明确失败、不拿空串当正文', () => {
    const text = `# Changelog\n\n## [v2] - 2026-10-02\n\n## [v1] - 2026-10-01\n\n- x\n`;
    const r = extractReleaseBody(text, 'v2');
    expect(r.kind).toBe('empty');
  });

  it('故意造出的失败：这一版正文只剩占位「还没有」→ 明确失败（发起前没写正文不许发）', () => {
    const text = `# Changelog\n\n## [v2] - 2026-10-02\n\n还没有\n\n## [v1] - 2026-10-01\n\n- x\n`;
    const r = extractReleaseBody(text, 'v2');
    expect(r.kind).toBe('placeholder');
  });

  it('不能误伤带「无」的合法正文：「新增无障碍模式」是合法发布内容（第二意见 2026-10-02 小毛病）', () => {
    const text = `# Changelog\n\n## [v2] - 2026-10-02\n\n- 新增无障碍模式
- 修了一个无伤大雅的错

## [v1] - 2026-10-01\n\n- x\n`;
    const r = extractReleaseBody(text, 'v2');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.body).toContain('新增无障碍模式');
    }
  });

  it('整段占位的别的模样：一堆「还没有」「无」各行一条，都整行占位也算占位', () => {
    const text = `# Changelog\n\n## [v2] - 2026-10-02\n\n还没有
无

## [v1] - 2026-10-01\n\n- x\n`;
    const r = extractReleaseBody(text, 'v2');
    expect(r.kind).toBe('placeholder');
  });
});

describe('飞书幂等：release 正文末尾的「<!-- fleet-notify-attempt/notified: vN -->」标签', () => {
  it('尝试标记：append → written；发成之后 promote → notified；发失败 strip 剥掉', () => {
    let body = '- 一条\n- 两条';
    expect(feishuAlreadyNotified(body, 'v2')).toBe(false);
    expect(feishuAttemptWritten(body, 'v2')).toBe(false);
    body = appendFeishuAttemptMark(body, 'v2');
    expect(feishuAttemptWritten(body, 'v2')).toBe(true);
    expect(feishuAlreadyNotified(body, 'v2')).toBe(false);
    body = promoteFeishuAttemptToNotified(body, 'v2');
    expect(feishuAttemptWritten(body, 'v2')).toBe(false);
    expect(feishuAlreadyNotified(body, 'v2')).toBe(true);
    expect(body).toContain(feishuNotifiedMark('v2'));
    expect(body).not.toContain(feishuAttemptMark('v2'));
  });

  it('发失败 → stripFeishuAttemptMark 剥掉尝试标记，下一次能再发（第二意见 2026-10-02：发送失败+标记回不去会重复推）', () => {
    let body = '- 一条\n- 两条';
    body = appendFeishuAttemptMark(body, 'v2');
    expect(feishuAttemptWritten(body, 'v2')).toBe(true);
    body = stripFeishuAttemptMark(body, 'v2');
    expect(feishuAttemptWritten(body, 'v2')).toBe(false);
    expect(feishuAlreadyNotified(body, 'v2')).toBe(false);
  });

  it('正文中间出现同样注释不算已发（放宽 includes 会把正文里随手一句「<!-- fleet-notified: v2 -->」当成已发而跳过，第二意见 2026-10-02）', () => {
    const sneaky = `- 一条\n- 顺手写一行 ${feishuNotifiedMark('v2')}\n- 还一条`;
    expect(feishuAlreadyNotified(sneaky, 'v2')).toBe(false);
    // 但独立成行在末尾几行才算
    const real = `- 一条\n\n${feishuNotifiedMark('v2')}\n`;
    expect(feishuAlreadyNotified(real, 'v2')).toBe(true);
  });

  it('v1 和 v10 是两张，vN 的标对不上别的版本', () => {
    const body = appendFeishuAttemptMark('x', 'v1');
    expect(feishuAttemptWritten(body, 'v1')).toBe(true);
    expect(feishuAttemptWritten(body, 'v10')).toBe(false);
    expect(feishuAlreadyNotified(body, 'v1')).toBe(false);
  });

  it('v<非数字> 直接拒绝', () => {
    expect(() => feishuAlreadyNotified('x', 'vNext' as `v${number}`)).toThrow(/不是 v<N>/);
    expect(() => appendFeishuAttemptMark('x', 'vNext' as `v${number}`)).toThrow(/不是 v<N>/);
    expect(() => promoteFeishuAttemptToNotified('x', 'vNext' as `v${number}`)).toThrow(/不是 v<N>/);
    expect(() => stripFeishuAttemptMark('x', 'vNext' as `v${number}`)).toThrow(/不是 v<N>/);
  });
});
