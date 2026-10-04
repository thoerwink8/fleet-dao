// 飞书那一块的样例数据：Store 契约（test/store-contract-feishu.ts）和 api 的几份测试共用。
import { devFixtures, IDS } from '../dev-fixtures.ts';
import type { MemoryData } from '../memory-store.ts';

export const T0 = new Date('2026-09-25T08:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const FEISHU_IDS = {
  repo2: 'a0000000-0000-4000-8000-000000000002',
  task2of12: 'b0000000-0000-4000-8000-000000000212',
  askOpen: '10000000-0000-4000-8000-000000000001',
  askAnswered: '10000000-0000-4000-8000-000000000002',
  askOld: '10000000-0000-4000-8000-000000000003',
  decision: 'f0000000-0000-4000-8000-000000000002',
  oldAlert: 'f0000000-0000-4000-8000-000000000003',
  draft1: '20000000-0000-4000-8000-000000000001',
  draft2: '20000000-0000-4000-8000-000000000002',
} as const;

const ago = (ms: number) => new Date(T0.getTime() - ms).toISOString();

/** 样例数据再加：第二个仓（也有 12 号）、三条追问（没答的、刚答的、很久以前答的）、要人拍的通知、很久以前处理掉的报警。 */
export function feishuData(): Partial<MemoryData> {
  const data = devFixtures(T0);
  data.repos = [
    ...(data.repos ?? []),
    {
      id: FEISHU_IDS.repo2,
      owner: 'example',
      name: 'another',
      defaultBranch: 'main',
      testCommand: 'pnpm test',
    },
  ];
  data.tasks = [
    ...(data.tasks ?? []),
    {
      id: FEISHU_IDS.task2of12,
      repoId: FEISHU_IDS.repo2,
      issueNumber: 12,
      title: '另一个仓的 12 号',
      rawRequest: '另一个仓的活',
      requestedBy: IDS.founderB,
      state: 'queued',
      priority: 3,
      acceptance: [],
      createdAt: ago(30 * MIN),
    },
  ];
  data.asks = [
    {
      id: FEISHU_IDS.askOpen,
      taskId: IDS.task12,
      runId: IDS.run1,
      question: '验证码几位？\n4 位还是 6 位',
      options: ['4 位', '6 位'],
      askedAt: ago(5 * MIN),
    },
    {
      id: FEISHU_IDS.askAnswered,
      taskId: IDS.task12,
      question: '用哪家短信？',
      options: [],
      askedAt: ago(60 * MIN),
      answer: '阿里云',
      answeredBy: IDS.founderB,
      answeredAt: ago(50 * MIN),
    },
    {
      id: FEISHU_IDS.askOld,
      taskId: IDS.task12,
      question: '很久以前的问题',
      options: [],
      askedAt: ago(40 * DAY),
      answer: '早答了',
      answeredBy: IDS.founderA,
      answeredAt: ago(39 * DAY),
    },
  ];
  data.notifications = [
    ...(data.notifications ?? []),
    {
      id: FEISHU_IDS.decision,
      level: 'decision',
      title: '要批：发版',
      body: '第一行\n第二行',
      taskId: IDS.task12,
      createdAt: ago(3 * MIN),
      deliveries: [],
    },
    {
      id: FEISHU_IDS.oldAlert,
      level: 'alert',
      title: '旧报警',
      body: '',
      createdAt: ago(40 * DAY),
      resolvedAt: ago(39 * DAY),
      resolvedBy: IDS.founderA,
      deliveries: [],
    },
  ];
  return data;
}
