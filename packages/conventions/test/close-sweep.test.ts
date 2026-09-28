// 关单对账（#241）的纯判断：哪张做完了没关、哪张母单的子单都关了、哪张关成完成却没有结果；判不了的交回 unchecked。
import { describe, expect, it } from 'vitest';
import {
  CLOSE_ALERT_LINES,
  type CloseFinding,
  type CloseSweepFacts,
  closeAlert,
  closeComment,
  closeSweep,
} from '../src/close-sweep.ts';

const NOW = new Date('2026-09-28T01:00:00Z');
const noSubs = { total: 0, open: [], closed: [] };
const facts = (over: Partial<CloseSweepFacts> = {}): CloseSweepFacts => ({
  specsFiles: ['specs/12-登录/需求.md', 'specs/12-登录/结果.md', 'specs/13-x/需求.md'],
  openIssues: [
    { number: 12, title: '登录', subIssues: noSubs },
    { number: 13, title: '还在做', subIssues: noSubs },
  ],
  closedIssues: [],
  openPulls: [],
  mergedPulls: [],
  ...over,
});
const pr = (body: string, title = 't') => ({ number: 90, title, body });

describe('做完了没关（due）：主线上有结果、没有开着的 PR 还引用它、下面没有子单', () => {
  it('有结果、没人引用：提醒；没结果的不提醒', () => {
    expect(closeSweep(facts(), NOW)).toEqual({
      findings: [{ kind: 'due', issue: 12, title: '登录', result: 'specs/12-登录/结果.md' }],
      unchecked: [],
    });
  });

  it.each([
    ['「需求」栏写着它', pr('**需求**：#12\n')],
    ['标题里 (#12)', pr('', 'fix: 登录 (#12)')],
    ['正文写了关单词', pr('做完了\n\nCloses #12')],
  ])('开着的 PR %s：还在做，不提醒', (_name, p) => {
    expect(closeSweep(facts({ openPulls: [p] }), NOW).findings).toEqual([]);
  });

  it('关单词写的是别的仓：不算引用这张', () => {
    const got = closeSweep(facts({ openPulls: [pr('fixes other/repo#12')] }), NOW, 'o/r');
    expect(got.findings.map((f) => f.issue)).toEqual([12]);
  });
});

describe('合并了的 PR 填了是却没关（merged，#460）：挂的单还开着才提醒', () => {
  const yesPr = (body: string, title = 't') => pr(`**这个 PR 做完就关单**：是\n${body}`, title);

  it('填了是、挂的单（需求栏）还开着：提醒，带 PR 号和单号', () => {
    const got = closeSweep(facts({ mergedPulls: [yesPr('**需求**：#13')] }), NOW);
    expect(got.findings).toContainEqual({ kind: 'merged', issue: 13, title: '还在做', pr: 90 });
  });

  it('号从标题的 (#号) 取（需求栏没写）：一样提醒', () => {
    const got = closeSweep(facts({ mergedPulls: [yesPr('没写需求', 'fix: 还在做 (#13)')] }), NOW);
    expect(got.findings).toContainEqual({ kind: 'merged', issue: 13, title: '还在做', pr: 90 });
  });

  it('填了否：不管挂没挂单都不提醒', () => {
    const got = closeSweep(facts({ mergedPulls: [pr('**这个 PR 做完就关单**：否\n**需求**：#13')] }), NOW);
    expect(got.findings.filter((f) => f.kind === 'merged')).toEqual([]);
  });

  it('填了是、挂的单不在开着的单里（已经关了，或号本来就没有）：不提醒', () => {
    const got = closeSweep(facts({ mergedPulls: [yesPr('**需求**：#999')] }), NOW);
    expect(got.findings.filter((f) => f.kind === 'merged')).toEqual([]);
    expect(got.unchecked).toEqual([]);
  });

  it('【故意造出的失败】填了是却认不出挂的是哪张单（需求栏、标题都没号）：判不了，记没查成，不当成没关系', () => {
    const got = closeSweep(facts({ mergedPulls: [yesPr('没写需求', 'fix: 一些事')] }), NOW);
    expect(got.findings.filter((f) => f.kind === 'merged')).toEqual([]);
    expect(got.unchecked).toEqual([{ kind: 'merged', text: expect.stringContaining('PR #90') }]);
  });
});

describe('母单（mother）：子单都关了就提醒照目标看能不能关', () => {
  it('【故意造出的失败】子单全关了：提醒母单（有没有结果都提醒，写明）；它自己不再按「做完了没关」提醒', () => {
    const got = closeSweep(
      facts({
        openIssues: [
          { number: 12, title: '母单', subIssues: { total: 2, open: [], closed: [31, 30] } },
          { number: 20, title: '另一张母单', subIssues: { total: 1, open: [], closed: [40] } },
        ],
      }),
      NOW,
    );
    expect(got.findings).toEqual([
      { kind: 'mother', issue: 12, title: '母单', subs: [30, 31], result: 'specs/12-登录/结果.md' },
      { kind: 'mother', issue: 20, title: '另一张母单', subs: [40], result: undefined },
    ]);
  });

  it('还有开着的子单：不提醒', () => {
    const open = { number: 12, title: '母单', subIssues: { total: 2, open: [31], closed: [30] } };
    expect(closeSweep(facts({ openIssues: [open] }), NOW)).toEqual({ findings: [], unchecked: [] });
  });

  it('【故意造出的失败】子单一页没读全：判不了，记没查成，不当成都关了', () => {
    const many = { number: 12, title: '母单', subIssues: { total: 60, open: [], closed: [1, 2, 3] } };
    expect(closeSweep(facts({ openIssues: [many] }), NOW)).toEqual({
      findings: [],
      unchecked: [{ kind: 'mother', text: '#12 有 60 张子单，只读到 3 张，判不了是不是都关了' }],
    });
  });
});

describe('关了却没有结果（no-result）：最近 30 天关成「完成」、主线上没有 结果.md', () => {
  const closed = (number: number, stateReason: string | null, closedAt: string) => ({
    number,
    title: `单 ${number}`,
    stateReason,
    closedAt,
  });

  it('关成完成、没结果：提醒；不做了、重复、30 天以前、有结果的不提醒', () => {
    const got = closeSweep(
      facts({
        openIssues: [],
        closedIssues: [
          closed(50, 'completed', '2026-09-27T10:00:00Z'),
          closed(51, 'not_planned', '2026-09-27T10:00:00Z'),
          closed(52, 'duplicate', '2026-09-27T10:00:00Z'),
          closed(53, 'completed', '2026-08-01T10:00:00Z'),
          closed(12, 'completed', '2026-09-27T10:00:00Z'),
        ],
      }),
      NOW,
    );
    expect(got).toEqual({
      findings: [{ kind: 'no-result', issue: 50, title: '单 50', closedAt: '2026-09-27T10:00:00Z' }],
      unchecked: [],
    });
  });

  it('【故意造出的失败】关单时刻认不出：记没查成，不当成没事', () => {
    const got = closeSweep(facts({ openIssues: [], closedIssues: [closed(50, 'completed', '昨天')] }), NOW);
    expect(got).toEqual({
      findings: [],
      unchecked: [{ kind: 'no-result', text: '#50 的关单时刻认不出（昨天）' }],
    });
  });
});

describe('留言和驾驶舱提醒的字', () => {
  const due: CloseFinding = { kind: 'due', issue: 12, title: '登录', result: 'specs/12-登录/结果.md' };

  it('留言说清下一步（pnpm issue:close <号>）；不写别的单号（写了会在那张单上多一条「被提到」）', () => {
    const text = closeComment(due);
    expect(text).toContain('`pnpm issue:close 12`');
    expect(text).toContain('specs/12-登录/结果.md');
    expect(text).not.toMatch(/#\d/);
    const noResult = closeComment({
      kind: 'no-result',
      issue: 50,
      title: 'x',
      closedAt: '2026-09-27T10:00:00Z',
    });
    expect(noResult).toContain('specs/50-<短名>/结果.md');
    expect(noResult).not.toMatch(/#\d/);
    expect(
      closeComment({ kind: 'mother', issue: 20, title: 'x', subs: [40, 41], result: undefined }),
    ).toContain('子单都关了（#40、#41）');
    // merged 也不写「#PR 号」：写了 GitHub 会在那个 PR 上加一条「被提到」，用不带 # 的「编号 91」代替（#460）
    const merged = closeComment({ kind: 'merged', issue: 13, title: 'x', pr: 91 });
    expect(merged).toContain('`pnpm issue:close 13`');
    expect(merged).toContain('编号 91');
    expect(merged).not.toMatch(/#\d/);
  });

  it(`提醒一个仓一种一条，最多列 ${CLOSE_ALERT_LINES} 张，多的写「另有」`, () => {
    const list: CloseFinding[] = Array.from({ length: CLOSE_ALERT_LINES + 2 }, (_, i) => ({
      ...due,
      issue: i + 1,
    }));
    const a = closeAlert('o/r', 'due', list);
    expect(a.title).toBe(`o/r：${CLOSE_ALERT_LINES + 2} 张单看着做完了没关`);
    expect(a.body).toContain('- #1 登录：specs/12-登录/结果.md');
    expect(a.body).toContain('- ……另有 2 张');
    expect(a.body.split('\n').filter((l) => l.startsWith('- #'))).toHaveLength(CLOSE_ALERT_LINES);
  });

  it('merged 的驾驶舱提醒：标题、正文都带得上 PR 号（这里不是 GitHub 评论，写 # 没事）', () => {
    const a = closeAlert('o/r', 'merged', [{ kind: 'merged', issue: 13, title: '还在做', pr: 91 }]);
    expect(a.title).toBe('o/r：1 张单的 PR 填了是、合并了却没关');
    expect(a.body).toContain('- #13 还在做：PR #91 填了是、合并了');
  });
});
