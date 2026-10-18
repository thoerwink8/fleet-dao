import { type ChangelogVersion, renderChangelogVersion } from '@fleet-dao/conventions';
import type { ScheduleResult } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import {
  CHANGELOG_JOB,
  type ChangelogJobDeps,
  changelogReleases,
  type OpenChangelogPrInput,
  runChangelogJob,
} from '../src/jobs/changelog.ts';
import { changelogSchedule } from '../src/jobs/schedules.ts';

const HEAD = 'a'.repeat(40);
const SHA = 'b'.repeat(40);
const BASE: ChangelogVersion = {
  version: 4,
  start: '2026-10-12',
  end: '2026-10-18',
  cutHead: HEAD,
  deliveries: { state: 'ok', commits: [] },
  issues: [],
};
function world() {
  const opened: OpenChangelogPrInput[] = [];
  const finished: ScheduleResult[] = [];
  const milestones = [4, 5].map((v) => ({
    number: v,
    title: `v${v}`,
    state: 'closed' as const,
    closedAt: '2026-10-26T01:00:00Z',
    dueOn: v === 4 ? '2026-10-18T23:59:59Z' : '2026-10-25T23:59:59Z',
    description: `<!-- fleet:cut -->\n## 收口\n- 收口时主线头：${HEAD}\n<!-- /fleet:cut -->`,
  }));
  const deps: ChangelogJobDeps = {
    github: {
      readHead: async () => ({ commit: HEAD, text: '# Changelog\n\n## [v3] - 历史\n' }),
      milestones: async () => milestones,
      milestoneIssues: async (n) => [
        {
          number: n * 10,
          title: '能导出任务',
          state: 'closed',
          stateReason: 'completed',
          isPr: false,
          labels: ['需求'],
          createdAt: '2026-10-12T00:00:00Z',
          milestone: `v${n}`,
          subIssues: 0,
        },
      ],
      openPr: async (input) => {
        opened.push(input);
        return { number: 100, url: 'https://github.com/thoerwink8/fleet-dao/pull/100' };
      },
    },
    history: async () => `2026-10-18T15:59:59Z ${SHA} release\n2026-10-18T16:00:00Z ${HEAD} rollback\n`,
    runs: {
      start: async (job) => {
        expect(job).toBe(CHANGELOG_JOB.id);
        return 7;
      },
      finish: async (_id, result) => {
        finished.push(result);
      },
    },
    now: () => new Date('2026-10-27T00:00:00Z'),
    log: () => {},
  };
  return { deps, milestones, opened, finished };
}

describe('每天补齐更新日志', () => {
  it('一次从读到的主线头补齐全部缺版，v4起倒序；法国提交按北京时间归对应时间盒', async () => {
    const w = world();
    expect(await runChangelogJob(w.deps)).toEqual({ outcome: 'ok', scanned: 2, found: 2 });
    expect(w.opened).toHaveLength(1);
    expect(w.opened[0]).toMatchObject({ baseCommit: HEAD, version: 5, versions: [4, 5] });
    const content = w.opened[0]?.content ?? '';
    expect(content.indexOf('## [v5]')).toBeLessThan(content.indexOf('## [v4]'));
    const v4 = content.split('## [v4]')[1] ?? '';
    expect(v4).toContain(SHA);
    expect(v4).not.toContain(`发到法国的提交：\`${HEAD}`);
    expect(content.split('## [v4]')[0]).toContain(`发到法国的提交：\`${HEAD}`);
    expect(w.finished.at(-1)?.outcome).toBe('ok');
  });
  it('主线已有全部版本不重复开，也不要求重读发布历史', async () => {
    const w = world();
    w.deps.github.readHead = async () => ({
      commit: HEAD,
      text: `${renderChangelogVersion(BASE)}\n${renderChangelogVersion({ ...BASE, version: 5 })}`,
    });
    w.deps.history = async () => {
      throw new Error('本场景不应读历史');
    };
    expect(await runChangelogJob(w.deps)).toMatchObject({ outcome: 'ok', found: 0 });
    expect(w.opened).toEqual([]);
  });
  it.each(['github', 'history', 'bad-history', 'head', 'cut', 'issues'])(
    '【故意失败】%s 没查成：记failed，不生成部分PR',
    async (failure) => {
      const w = world();
      if (failure === 'github')
        w.deps.github.milestones = async () => {
          throw new Error('GitHub 503');
        };
      if (failure === 'history')
        w.deps.history = async () => {
          throw new Error('ENOENT .history');
        };
      if (failure === 'bad-history') w.deps.history = async () => 'garbage';
      if (failure === 'head') w.deps.github.readHead = async () => ({ commit: 'short', text: '# Changelog' });
      if (failure === 'cut' && w.milestones[1])
        w.milestones[1].description = '<!-- fleet:cut -->没有主线头<!-- /fleet:cut -->';
      if (failure === 'issues')
        w.deps.github.milestoneIssues = async () => {
          throw new Error('分页失败');
        };
      await expect(runChangelogJob(w.deps)).rejects.toThrow('没查成');
      expect(w.opened).toEqual([]);
      expect(w.finished.at(-1)?.outcome).toBe('failed');
    },
  );
  it('读全但期间没有切换发布的合法结果，与读不到区分', async () => {
    const w = world();
    w.deps.history = async () => `2026-10-01T00:00:00Z ${SHA} release\n`;
    await runChangelogJob(w.deps);
    expect(w.opened[0]?.content).toContain('发布历史已读全，这一版期间没有切换发布记录');
    expect(w.opened[0]?.content).not.toContain('没查成');
  });
  it('格子每天06:30、不受总开关影响、补跑一格且会记账', () => {
    expect(changelogSchedule(async () => {})).toMatchObject({
      id: 'changelog',
      everyMinutes: 1440,
      offsetMinutes: 1350,
      catchupMinutes: 1440,
    });
    expect(changelogSchedule(async () => {}).needsMaster).toBeUndefined();
  });
});

describe('法国发布原账', () => {
  it('健康事件不算切版本，回滚算，保留合法空账；坏行/未知事件不静默丢弃', () => {
    expect(
      changelogReleases(
        `2026-10-18T00:00:00Z ${SHA} unhealthy\n2026-10-18T01:00:00Z ${SHA} recovered\n2026-10-18T02:00:00Z ${HEAD} auto-rollback unmerged`,
      ),
    ).toEqual([{ sha: HEAD, date: '2026-10-18' }]);
    expect(changelogReleases('')).toEqual([]);
    for (const line of [
      'nonsense',
      `2026-02-31T00:00:00Z ${SHA} release`,
      `2026-10-18T00:00:00Z ${SHA} unknown`,
      '2026-10-18T00:00:00Z short release',
    ])
      expect(() => changelogReleases(line)).toThrow('认不出');
  });
});
