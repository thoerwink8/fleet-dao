import { describe, expect, it } from 'vitest';
import {
  appendFeishuAttemptMark,
  decideRelease,
  decideReleaseMilestone,
  decideTag,
  extractReleaseBody,
  feishuAlreadyNotified,
  feishuAttemptMark,
  feishuAttemptWritten,
  feishuNotifiedMark,
  feishuReplyOk,
  type MilestoneState,
  promoteFeishuAttemptToNotified,
  releaseBodyCore,
  releaseMarks,
} from '../src/publish-release-logic.ts';

const open = (number: number, title: string): MilestoneState => ({
  number,
  title,
  state: 'open',
  closedAt: null,
});
const closed = (number: number, title: string, closedAt: string): MilestoneState => ({
  number,
  title,
  state: 'closed',
  closedAt,
});

/** 仓里 2026-10-04 的样子：v1、v2 是早就手动关掉的旧版本（没写过更新日志），开着的是 v3。 */
const REPO_NOW = [
  closed(8, 'v1 Fusion 接活', '2026-10-01T14:58:46Z'),
  closed(9, 'v2 引擎打磨：环节可配、检验制度、经验库', '2026-10-01T14:57:24Z'),
  closed(2, 'P1 核心闭环', '2026-09-26T19:12:28Z'),
  open(10, 'v3 三段一条龙'),
];
const MERGED = '2026-10-05T02:00:00Z';

describe('decideReleaseMilestone：发 vN 时关哪张里程碑（打 tag 之前核、关的时候再判，同一份）', () => {
  it('开着的当前版本就是这一版 → close 它（合并时间用不着，没给也行）', () => {
    expect(decideReleaseMilestone({ version: 'v3', milestones: REPO_NOW })).toEqual({
      kind: 'close',
      milestone: open(10, 'v3 三段一条龙'),
    });
  });

  // 【故意造出的失败】#593：版本号按 CHANGELOG.md「上一版 +1」算成了 v1。原先开着的里没有 v1，就去关了的里找、
  // 找到「v1 Fusion 接活」判「多半已经关过了」退出码 0——开着的 v3 不关、整轮报绿。
  it('版本号贴错（开着的是 v3、这次发成 v1，v1 那张早在合并之前就关了）→ error，不当成已经关过了', () => {
    const r = decideReleaseMilestone({ version: 'v1', milestones: REPO_NOW, mergedAt: MERGED });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toContain('开着的版本里程碑是「v3 三段一条龙」（当前版本 v3）');
      expect(r.message).toContain('「v1 Fusion 接活」在 2026-10-01T14:58:46Z 就关了');
      expect(r.message).toMatch(/早于这次发布合并[\s\S]*对不上/);
    }
  });

  it('重跑：开着的里没有这一版、它在这次发布合并之后关了（下一版 v4 都开出来了）→ already-closed，不再动它', () => {
    const milestones = [
      ...REPO_NOW.slice(0, 3),
      closed(10, 'v3 三段一条龙', '2026-10-05T02:01:30Z'),
      open(11, 'v4 下一版'),
    ];
    const r = decideReleaseMilestone({ version: 'v3', milestones, mergedAt: MERGED });
    expect(r.kind).toBe('already-closed');
    if (r.kind === 'already-closed') {
      expect(r.milestone.number).toBe(10);
      expect(r.why).toMatch(/晚于这次发布合并/);
    }
  });

  it('故意造出的失败：开着、关了的里都没有这一版（被删了或改名了）→ error', () => {
    const r = decideReleaseMilestone({ version: 'v7', milestones: REPO_NOW, mergedAt: MERGED });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/关了的里程碑里也没有 v7 的（被删了或改名了）/);
  });

  it('故意造出的失败：开着的里有这一版，可还开着更小的版本（跳版）→ error', () => {
    const r = decideReleaseMilestone({ version: 'v4', milestones: [...REPO_NOW, open(11, 'v4 下一版')] });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/当前版本是 v3[\s\S]*版本跳了/);
  });

  it('故意造出的失败：开着的里有两张都是这一版 → error，不拿「第一张」糊弄', () => {
    const r = decideReleaseMilestone({
      version: 'v3',
      milestones: [open(10, 'v3 三段一条龙'), open(12, 'v3 另一张')],
    });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/有 2 张都是 v3/);
  });

  it.each([
    ['没给', undefined, '没拿到'],
    ['是空串', '', '没拿到'],
    ['认不出', '上周三', '认不出（「上周三」）'],
  ])(
    '故意造出的失败：开着的里没有这一版、合并时间%s → error，不猜「已经关过了」',
    (_name, mergedAt, words) => {
      const milestones = [closed(10, 'v3 三段一条龙', '2026-10-05T02:01:30Z')];
      const r = decideReleaseMilestone({ version: 'v3', milestones, mergedAt });
      expect(r.kind).toBe('error');
      if (r.kind === 'error') expect(r.message).toContain(words);
    },
  );

  it('版本号认法和派活、开单同一份：v1 不撞 v10、v11；「v1.5 …」「V1 …」不算 v1', () => {
    const milestones = [
      open(10, 'v10 后面'),
      open(11, 'v11 再后面'),
      open(15, 'v1.5 小版本'),
      open(16, 'V1 大写'),
    ];
    const r = decideReleaseMilestone({ version: 'v1', milestones, mergedAt: MERGED });
    expect(r.kind).toBe('error');
    if (r.kind === 'error')
      expect(r.message).toContain('开着的版本里程碑是「v10 后面」、「v11 再后面」（当前版本 v10）');
  });

  it('v<非数字> 直接拒绝', () => {
    expect(() => decideReleaseMilestone({ version: 'vNext' as `v${number}`, milestones: [] })).toThrow(
      /不是 v<N>/,
    );
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

  it('故意造出的失败：版本标题不是 YYYY-MM-DD（## [v2] - nonsense）→ 拒绝（Keep a Changelog 钉死，第二意见 2026-10-02）', () => {
    const text = `# Changelog\n\n## [v2] - nonsense\n\n- x\n\n## [v1] - 2026-10-01\n\n- y\n`;
    const r = extractReleaseBody(text, 'v2');
    expect(r.kind).toBe('missing-heading');
    if (r.kind === 'missing-heading') expect(r.message).toMatch(/YYYY-MM-DD/);
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
  it('尝试标记：append → written；发成之后 promote → notified', () => {
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

  it('发失败 → 尝试标记留着（看得见「试过、没确认」），判「发没发过」只看 notified，下一轮照样再发；再写一次尝试标记不叠', () => {
    const body = appendFeishuAttemptMark('- 一条\n- 两条', 'v2');
    expect(feishuAttemptWritten(body, 'v2')).toBe(true);
    expect(feishuAlreadyNotified(body, 'v2')).toBe(false);
    expect(appendFeishuAttemptMark(body, 'v2')).toBe(body);
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
  });
});

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('decideTag：打 tag 这一步怎么走', () => {
  it('不在 → 打', () => {
    expect(decideTag('v3', undefined, SHA_A)).toEqual({ kind: 'create' });
  });

  it('故意造出的失败之一（打 tag 已存在）：在、指着本次发布合并 → 跳（重跑）', () => {
    expect(decideTag('v3', SHA_A, SHA_A).kind).toBe('skip');
  });

  it('故意造出的失败：在、但指着别的提交 → 红（撞名的 tag 不当成这一版、也不挪它）', () => {
    const d = decideTag('v3', SHA_B, SHA_A);
    expect(d.kind).toBe('error');
    expect(d.kind === 'error' && d.message).toMatch(
      /tag v3 已经在，但指的是 bbbbbbb，不是本次发布合并 aaaaaaa/,
    );
  });

  it('故意造出的失败：本次发布合并的提交认不出（空、短号）→ 红，不知道打在哪', () => {
    expect(decideTag('v3', undefined, '').kind).toBe('error');
    expect(decideTag('v3', undefined, 'abc1234').kind).toBe('error');
  });

  it('v<非数字> 直接拒绝', () => {
    expect(() => decideTag('vNext' as `v${number}`, undefined, SHA_A)).toThrow(/不是 v<N>/);
  });
});

describe('decideRelease：建 Release 这一步怎么走', () => {
  const want = '### 新增\n\n- 一条';

  it('不在 → 建，正文就是 CHANGELOG.md 那一段', () => {
    expect(decideRelease('v3', undefined, want)).toEqual({ kind: 'create', body: want });
  });

  it('在、正文一样（末尾带飞书标记、换行是 CRLF、行尾多空格都不算不一样）→ 跳', () => {
    const existing = `### 新增  \r\n\r\n- 一条\r\n\r\n${feishuNotifiedMark('v3')}\r\n`;
    expect(decideRelease('v3', { tagName: 'v3', body: existing }, want).kind).toBe('skip');
    const attempt = `${want}\n\n${feishuAttemptMark('v3')}\n`;
    expect(decideRelease('v3', { tagName: 'v3', body: attempt }, want).kind).toBe('skip');
  });

  it('在、正文被人手改过 → 改回 CHANGELOG.md 那一段，飞书标记原样留在末尾（不抹掉「发过」的证据）', () => {
    const existing = `人手改的\n\n${feishuNotifiedMark('v3')}\n`;
    const d = decideRelease('v3', { tagName: 'v3', body: existing }, want);
    expect(d.kind).toBe('update');
    expect(d.kind === 'update' && d.body).toBe(`${want}\n\n${feishuNotifiedMark('v3')}\n`);
    expect(d.kind === 'update' && feishuAlreadyNotified(d.body, 'v3')).toBe(true);
  });

  it('在、正文被改过、没有标记 → 改回原文，不凭空加标记', () => {
    const d = decideRelease('v3', { tagName: 'v3', body: '人手改的' }, want);
    expect(d).toMatchObject({ kind: 'update', body: want });
  });

  it('故意造出的失败：同名 Release 挂的 tag 不是 vN → 红', () => {
    const d = decideRelease('v3', { tagName: 'v3-old', body: want }, want);
    expect(d.kind).toBe('error');
    expect(d.kind === 'error' && d.message).toMatch(/挂的 tag 是「v3-old」/);
  });

  it('releaseBodyCore 只剥整行的标记：正文里随手写的一句不剥；releaseMarks 照先后取出整行标记', () => {
    const body = `- 写了 ${feishuNotifiedMark('v3')} 一句\n\n${feishuAttemptMark('v3')}\n${feishuNotifiedMark('v2')}`;
    expect(releaseBodyCore(body)).toBe(`- 写了 ${feishuNotifiedMark('v3')} 一句`);
    expect(releaseMarks(body)).toEqual([feishuAttemptMark('v3'), feishuNotifiedMark('v2')]);
  });
});

describe('feishuReplyOk：飞书 webhook 回包算不算发成', () => {
  it('{ code: 0 } 和老格式 { StatusCode: 0 } 算发成', () => {
    expect(feishuReplyOk({ code: 0, msg: 'success', data: {} })).toEqual({ ok: true });
    expect(feishuReplyOk({ StatusCode: 0, StatusMessage: 'success' })).toEqual({ ok: true });
  });

  it.each([
    [
      '业务码不是 0（关键词没对上）',
      { code: 19024, msg: 'Key Words Not Found' },
      /code=19024，msg=Key Words Not Found/,
    ],
    ['老格式业务码不是 0', { StatusCode: 9499, StatusMessage: 'Bad Request' }, /StatusCode=9499/],
    ['没有 code', { msg: 'success' }, /没有 code/],
    ['不是对象', 'ok', /不是 JSON 对象/],
    ['是 null', null, /不是 JSON 对象/],
  ])('故意造出的失败：%s → 算没发成', (_name, reply, re) => {
    const r = feishuReplyOk(reply);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(re);
  });
});
