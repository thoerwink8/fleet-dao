// 单子打标挂版本（#448）的真装配里，唯一带分支逻辑、值得单测的一块：闲置清理天数怎么从环境变量读（其余都是薄接线，
// 跟 close-sweep 的 closeSweepJob 一样不单测，靠 github-reconcile.test.ts 的集成测试兜底）。天数是配置（需求原文），
// 不设用默认、设了要是正整数，不是就报错——不能拿认不出的值悄悄当默认用（#448「怎么算做完」没直接点这条，但和
// realPortsConfigFromEnv 的数字型配置同一条底线：读不出来的不许装没事）。
import { DEFAULT_IDLE_POLICY } from '@fleet-dao/conventions';
import { describe, expect, it } from 'vitest';
import { issueGroomDigestKey, issueGroomIdlePolicyFromEnv } from '../../src/real/issue-groom.ts';

describe('issueGroomIdlePolicyFromEnv：闲置清理的天数（#448，天数是配置）', () => {
  it('不设环境变量：用 conventions 的默认值（过时 30 天、再 14 天关）', () => {
    expect(issueGroomIdlePolicyFromEnv({})).toEqual(DEFAULT_IDLE_POLICY);
  });

  it('设了合法的正整数：照设的用', () => {
    expect(
      issueGroomIdlePolicyFromEnv({
        FLEET_ISSUE_GROOM_STALE_DAYS: '45',
        FLEET_ISSUE_GROOM_CLOSE_DAYS: '7',
      }),
    ).toEqual({ staleAfterDays: 45, closeAfterDays: 7 });
  });

  it('只设了一项：另一项仍用默认值', () => {
    expect(issueGroomIdlePolicyFromEnv({ FLEET_ISSUE_GROOM_STALE_DAYS: '60' })).toEqual({
      staleAfterDays: 60,
      closeAfterDays: DEFAULT_IDLE_POLICY.closeAfterDays,
    });
  });

  it('故意造失败：设了不是正整数的值（非数字）要报错，不能悄悄当默认用', () => {
    expect(() => issueGroomIdlePolicyFromEnv({ FLEET_ISSUE_GROOM_STALE_DAYS: '一个月' })).toThrow(
      'FLEET_ISSUE_GROOM_STALE_DAYS 要是正整数',
    );
  });

  it('故意造失败：设了 0 或负数要报错', () => {
    expect(() => issueGroomIdlePolicyFromEnv({ FLEET_ISSUE_GROOM_CLOSE_DAYS: '0' })).toThrow(
      'FLEET_ISSUE_GROOM_CLOSE_DAYS 要是正整数',
    );
    expect(() => issueGroomIdlePolicyFromEnv({ FLEET_ISSUE_GROOM_CLOSE_DAYS: '-3' })).toThrow(
      'FLEET_ISSUE_GROOM_CLOSE_DAYS 要是正整数',
    );
  });

  it('故意造失败：设了小数要报错（天数不是连续量）', () => {
    expect(() => issueGroomIdlePolicyFromEnv({ FLEET_ISSUE_GROOM_STALE_DAYS: '30.5' })).toThrow(
      'FLEET_ISSUE_GROOM_STALE_DAYS 要是正整数',
    );
  });
});

describe('issueGroomDigestKey：这一轮的日报键', () => {
  it('一个仓一条，原地更新用', () => {
    expect(issueGroomDigestKey({ owner: 'thoerwink8', name: 'fleet-dao' })).toBe(
      'issue-groom:thoerwink8/fleet-dao',
    );
  });
});
