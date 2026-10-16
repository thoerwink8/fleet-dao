// 对账红了有人接（#2683）：红了开或更新同一张「GitHub 对账没过」单，绿了关掉；读不到开着的单不开。
import { describe, expect, it } from 'vitest';
import { ALARM_TITLE, type AlarmInput, followAlarm } from '../src/audit-alarm.ts';
import type { GitHubAlarmWriter } from '../src/github-api.ts';
import { issue } from './fake-github.ts';

const AT = new Date('2026-10-19T01:41:00Z');

function writer(fail?: Error) {
  const calls: string[] = [];
  const gh: GitHubAlarmWriter = {
    async createIssue(title, _body, labels) {
      if (fail) throw fail;
      calls.push(`create ${title} [${labels.join(',')}]`);
      return 900;
    },
    async updateIssueBody(n) {
      calls.push(`update #${n}`);
    },
    async setIssueMilestone(n, m) {
      calls.push(`milestone #${n} → ${m}`);
    },
    async closeIssueCompleted(n) {
      calls.push(`close #${n}`);
    },
  };
  return { gh, calls };
}

const input = (over: Partial<AlarmInput> = {}): AlarmInput => ({
  red: true,
  lines: ['#20 没有类别标签'],
  open: [issue(20)],
  milestone: 11,
  runUrl: 'https://github.com/o/r/actions/runs/1',
  at: AT,
  ...over,
});

describe('对账红了开同一张单', () => {
  it('红了、还没有那张单：开一张（贴缺陷和本机做），挂当前版本', async () => {
    const { gh, calls } = writer();
    expect(await followAlarm(gh, input())).toEqual({ action: 'opened', issue: 900 });
    expect(calls).toEqual([`create ${ALARM_TITLE} [缺陷,本机做]`, 'milestone #900 → 11']);
  });

  it('红了、那张单已经开着：只更新它，不开第二张；没挂版本的补挂', async () => {
    const { gh, calls } = writer();
    const open = [issue(20), issue(777, { title: ALARM_TITLE, labels: ['缺陷', '本机做'] })];
    expect(await followAlarm(gh, input({ open }))).toEqual({ action: 'updated', issue: 777 });
    expect(calls).toEqual(['update #777', 'milestone #777 → 11']);

    const again = writer();
    const hung = [issue(777, { title: ALARM_TITLE, milestone: 'v4 10-12～10-18' })];
    await followAlarm(again.gh, input({ open: hung }));
    expect(again.calls).toEqual(['update #777']);
  });

  it('绿了：那张单开着就关掉；没有就什么也不做', async () => {
    const { gh, calls } = writer();
    const open = [issue(777, { title: ALARM_TITLE, body: '原来的正文' })];
    expect(await followAlarm(gh, input({ red: false, open }))).toEqual({ action: 'closed', issue: 777 });
    expect(calls).toEqual(['close #777']);

    const none = writer();
    expect(await followAlarm(none.gh, input({ red: false }))).toEqual({ action: 'none' });
    expect(none.calls).toEqual([]);
  });

  it('【故意造出的失败】读不到开着的单：不开（免得开出重复的），回 failed；开单报错也回 failed', async () => {
    const { gh, calls } = writer();
    const r = await followAlarm(gh, input({ open: undefined }));
    expect(r.action).toBe('failed');
    expect(calls).toEqual([]);

    const broken = writer(new Error('GitHub 回了 502'));
    const f = await followAlarm(broken.gh, input());
    expect(f).toEqual({ action: 'failed', why: expect.stringContaining('GitHub 回了 502') });
  });
});
