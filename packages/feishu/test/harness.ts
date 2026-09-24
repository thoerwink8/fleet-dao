// 测试台：真网关 + 假飞书 + 假后端（真 HTTP），外加几个造数据的函数。
// 造出来的数据都先过一遍 shared 里的约定（parse）：样例本身不合约定，测试当场就红。
import {
  FeishuBoardSnapshotSchema,
  FeishuDraftSchema,
  FeishuOutboxItemSchema,
  TaskDetailResponse,
} from '@fleet-dao/shared';
import type { z } from 'zod';
import { createBackend } from '../src/backend.ts';
import { createGateway, type Gateway, type Timing } from '../src/gateway.ts';
import type { Logger } from '../src/log.ts';
import { A, B, TEAM, TEST_GROUP } from './events.ts';
import { type FakeBackend, startFakeBackend } from './fake-backend.ts';
import { FakeFeishu } from './fake-feishu.ts';

export const TOKEN = 'gateway-pass-for-tests-0123456789abcdef';
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
  opts: { timing?: Partial<Timing>; now?: () => number; askBudgetPerDay?: number } = {},
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
    askBudgetPerDay: opts.askBudgetPerDay ?? 10,
    boardRefreshMs: 60_000,
    timing: { outboxWaitSeconds: 0, ...opts.timing },
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

// —— 造数据 ——

export type Draft = z.output<typeof FeishuDraftSchema>;
export type Snapshot = z.output<typeof FeishuBoardSnapshotSchema>;
export type OutboxItem = z.output<typeof FeishuOutboxItemSchema>;
export type TaskDetail = z.output<typeof TaskDetailResponse>;

export const REPO_WEB = { id: 'repo-web', fullName: 'acme/web' };
export const REPO_API = { id: 'repo-api', fullName: 'acme/api' };

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

export function draft(o: Partial<Draft> = {}): Draft {
  return FeishuDraftSchema.parse({
    id: 'draft-1',
    revision: 1,
    status: 'open',
    rawText: '给登录页加手机验证码',
    understanding: '在登录页加「手机号 + 短信验证码」登录，验证码 5 分钟过期。',
    unsure: false,
    repo: REPO_WEB,
    repoOptions: [REPO_WEB, REPO_API],
    proposedBy: '甲',
    updatedAt: ago(0),
    ...o,
  });
}

export function confirmed(o: Partial<Draft> = {}): Draft {
  return draft({
    status: 'confirmed',
    task: { taskId: 'task-12', repo: 'acme/web', issueNumber: 12 },
    confirmedBy: '甲',
    ...o,
  });
}

export function snapshot(o: Partial<Snapshot> = {}): Snapshot {
  return FeishuBoardSnapshotSchema.parse({
    asOf: ago(0),
    counts: { running: 3, stalled: 1, waitingForYou: 2, mergedToday: 4 },
    stalled: [
      {
        taskId: 'task-9',
        repo: 'acme/api',
        issueNumber: 9,
        title: '账单导出',
        since: ago(3 * 3600_000),
        why: '测试一直红',
      },
    ],
    waiting: [
      {
        kind: 'decision',
        askId: 'ask-1',
        taskId: 'task-7',
        repo: 'acme/web',
        issueNumber: 7,
        title: '发布到正式环境？',
        since: ago(600_000),
      },
      { kind: 'ask', askId: 'ask-2', title: '验证码用哪家短信？', since: ago(0) },
    ],
    active: [
      {
        taskId: 'task-12',
        repo: 'acme/web',
        issueNumber: 12,
        title: '登录验证码',
        state: 'running',
        progress: { done: 1, total: 3 },
        activity: 'Opus 5.5 正在写验证码过期的测试',
      },
    ],
    quota: [
      {
        poolName: 'Claude A 号',
        window: '7d',
        remaining: 0.4,
        resetsAt: new Date(Date.now() + 20 * 3600_000).toISOString(),
        reading: 'measured',
      },
    ],
    ...o,
  });
}

export function outboxItem(o: Partial<OutboxItem> = {}): OutboxItem {
  return FeishuOutboxItemSchema.parse({
    id: 'ask:1',
    revision: 1,
    kind: 'decision',
    to: { type: 'team' },
    title: '发布到正式环境？',
    lines: ['#7 登录验证码做完了，要上线给用户。', '改动：登录页、短信服务。'],
    status: 'open',
    taskId: 'task-7',
    repo: 'acme/web',
    issueNumber: 7,
    askId: 'ask-1',
    options: ['批准', '拒绝'],
    link: '/tasks/task-7',
    createdAt: ago(0),
    ...o,
  });
}

export function taskDetail(o: { state?: TaskDetail['task']['state'] } = {}): TaskDetail {
  return TaskDetailResponse.parse({
    task: {
      id: 'task-12',
      repoId: 'repo-web',
      issueNumber: 12,
      title: '登录验证码',
      rawRequest: '给登录页加手机验证码',
      requestedBy: '甲',
      state: o.state ?? 'running',
      priority: 1,
      createdAt: ago(0),
    },
    repo: { id: 'repo-web', owner: 'acme', name: 'web', defaultBranch: 'main' },
    subtasks: [
      {
        id: 's1',
        index: 1,
        title: '短信服务接口',
        state: 'merged',
        prNumber: 31,
        dependsOn: [],
        touches: [],
      },
      {
        id: 's2',
        index: 2,
        title: '登录页输入框',
        state: 'running',
        dependsOn: ['s1'],
        touches: [],
        activity: {
          runId: 'run-1',
          stage: 'execute',
          routeId: 'route-1',
          modelName: 'Opus 5.5',
          queued: false,
          since: ago(12 * 60_000),
          text: 'Opus 5.5 正在写登录页',
        },
      },
      { id: 's3', index: 3, title: '过期与重发', state: 'waiting_deps', dependsOn: ['s2'], touches: [] },
    ],
    runs: [],
    asks: [],
  });
}
