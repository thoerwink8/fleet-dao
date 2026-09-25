// 配置：缺了或不合规就拒绝启动，并一次列出全部问题（缺凭据时大声失败，不许静默跑成哑巴）。
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

const GOOD = {
  FEISHU_APP_ID: 'cli_placeholder',
  FEISHU_APP_SECRET: 'secret-placeholder',
  FLEET_FEISHU_GATEWAY_TOKEN: 'x'.repeat(40),
  FLEET_BACKEND_URL: 'http://backend.example.test:8787',
  FLEET_PUBLIC_URL: 'https://cockpit.example.test',
  FEISHU_TEAM_CHAT_ID: 'oc_team',
  FEISHU_FOUNDERS: 'ou_founder_a:甲, ou_founder_b:乙',
};

function problems(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
}

describe('配置', () => {
  it('齐全：读出来，默认值合理', () => {
    const c = loadConfig(GOOD);
    expect(c).toMatchObject({
      backendUrl: 'http://backend.example.test:8787',
      publicUrl: 'https://cockpit.example.test',
      teamChatId: 'oc_team',
      testChatId: null,
      ackEmoji: 'Get',
      askBudgetPerDay: 10,
      boardRefreshMs: 30_000,
    });
    expect(c.founders).toEqual([
      { openId: 'ou_founder_a', name: '甲' },
      { openId: 'ou_founder_b', name: '乙' },
    ]);
  });

  it('什么都没配：一次列出全部缺的，不是一个一个报', () => {
    const p = problems({});
    for (const name of [
      'FEISHU_APP_ID',
      'FEISHU_APP_SECRET',
      'FLEET_FEISHU_GATEWAY_TOKEN',
      'FLEET_BACKEND_URL',
      'FLEET_PUBLIC_URL',
      'FEISHU_TEAM_CHAT_ID',
      'FEISHU_FOUNDERS',
    ]) {
      expect(p).toContain(`缺 ${name}`);
    }
  });

  it('写错了的都拦下：通行证太短、地址带路径、群编号和 open_id 格式不对、重复、数字越界', () => {
    const p = problems({
      ...GOOD,
      FEISHU_APP_ID: 'app123',
      FLEET_FEISHU_GATEWAY_TOKEN: 'short',
      FLEET_BACKEND_URL: 'http://backend.example.test:8787/api',
      FLEET_PUBLIC_URL: 'not a url',
      FEISHU_TEAM_CHAT_ID: 'team',
      FEISHU_TEST_CHAT_ID: 'test',
      FEISHU_FOUNDERS: 'founder-a, ou_b, ou_b',
      FEISHU_ASK_BUDGET_PER_DAY: '0',
      FEISHU_BOARD_REFRESH_SECONDS: 'soon',
      FEISHU_ACK_EMOJI: '收到',
    });
    expect(p).toEqual([
      'FEISHU_APP_ID 应以 cli_ 开头（飞书开发者后台「凭证与基础信息」里的 App ID）',
      'FLEET_FEISHU_GATEWAY_TOKEN 太短：至少 32 个字符',
      'FLEET_BACKEND_URL 只写到域名（和端口），不带路径',
      'FLEET_PUBLIC_URL 不是合法地址：「not a url」',
      'FEISHU_TEAM_CHAT_ID 应以 oc_ 开头（群的 chat_id）',
      'FEISHU_TEST_CHAT_ID 应以 oc_ 开头',
      'FEISHU_FOUNDERS 里「founder-a」不是 open_id（应以 ou_ 开头）',
      'FEISHU_FOUNDERS 里 ou_b 写了两次',
      'FEISHU_ACK_EMOJI 不像飞书的 emoji_type：「收到」',
      'FEISHU_ASK_BUDGET_PER_DAY 要是 1–200 之间的整数，现在是「0」',
      'FEISHU_BOARD_REFRESH_SECONDS 要是 5–3600 之间的整数，现在是「soon」',
    ]);
  });

  it('测试群不能是团队群', () => {
    expect(problems({ ...GOOD, FEISHU_TEST_CHAT_ID: 'oc_team' })).toEqual([
      'FEISHU_TEST_CHAT_ID 不能和团队群是同一个',
    ]);
  });

  it('创始人名字可省：卡片上显示 open_id 末 4 位', () => {
    expect(loadConfig({ ...GOOD, FEISHU_FOUNDERS: 'ou_founder_a' }).founders).toEqual([
      { openId: 'ou_founder_a', name: '创始人…er_a' },
    ]);
  });
});
