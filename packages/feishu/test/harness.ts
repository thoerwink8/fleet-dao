// 测试台：真网关 + 假飞书 + 假后端（真 HTTP）。
import { FEISHU_MONTHLY_CALL_LIMIT } from '@fleet-dao/shared';
import { createBackend } from '../src/backend.ts';
import { createGateway, type Gateway, type Timing } from '../src/gateway.ts';
import type { Logger } from '../src/log.ts';
import type { WatchLimits } from '../src/watch.ts';
import { A, B, TEAM, TEST_GROUP } from './events.ts';
import { type FakeBackend, startFakeBackend } from './fake-backend.ts';
import { FakeFeishu } from './fake-feishu.ts';

export const TOKEN = 'gateway-pass-for-tests-0123456789abcdef';

/** 没到八成的用量：意图卡回应里带上，网关保持原样。 */
export const QUIET_USAGE = {
  month: '2026-10',
  calls: 0,
  limit: FEISHU_MONTHLY_CALL_LIMIT,
  readable: true,
};

export function quietCards(items: unknown[] = []) {
  return { items, asOf: new Date().toISOString(), usage: QUIET_USAGE };
}
export const PUBLIC_URL = 'https://cockpit.example.test';

export interface LogLine {
  level: string;
  message: string;
  fields?: Record<string, unknown> | undefined;
}

export interface Harness {
  gateway: Gateway;
  feishu: FakeFeishu;
  backend: FakeBackend;
  logs: LogLine[];
  close(): Promise<void>;
}

export function memoryLogger(lines: LogLine[]): Logger {
  const at = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    lines.push({ level, message, fields });
  };
  return { info: at('info'), warn: at('warn'), error: at('error') };
}

export async function harness(
  opts: {
    timing?: Partial<Timing>;
    now?: () => number;
    /** 网关自己看守的时限调小（测报警、心跳时不真等 5 分钟）。 */
    watch?: Partial<WatchLimits>;
  } = {},
): Promise<Harness> {
  const backend = await startFakeBackend();
  const feishu = new FakeFeishu();
  const logs: LogLine[] = [];
  const gateway = createGateway({
    feishu,
    backend: createBackend({ baseUrl: backend.url, gatewayToken: TOKEN }),
    log: memoryLogger(logs),
    ...(opts.now ? { now: opts.now } : {}),
    founders: [
      { openId: A, name: '甲' },
      { openId: B, name: '乙' },
    ],
    teamChatId: TEAM,
    testChatId: TEST_GROUP,
    publicUrl: PUBLIC_URL,
    ackEmoji: 'Get',
    timing: { intentCardsWaitSeconds: 0, ...opts.timing },
    ...(opts.watch ? { watch: opts.watch } : {}),
  });
  return {
    gateway,
    feishu,
    backend,
    logs,
    async close() {
      await gateway.stop(2_000);
      await backend.close();
    },
  };
}

/** 等到条件成立（最多 ms 毫秒）。 */
export async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等了太久，条件还没成立');
    await new Promise((r) => setTimeout(r, 5));
  }
}
