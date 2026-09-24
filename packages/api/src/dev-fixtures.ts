// 本地开发和测试用的一小份样例数据（假的名字和编号，不对应任何真实账号）。时间都相对 now 算。
import type { MemoryData } from './memory-store.ts';

export const DEV_USER_ID = 'u-founder-a';
export const DEV_RUN_ID = 'run-1';

export function devFixtures(now: Date): Partial<MemoryData> {
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  return {
    users: [
      {
        id: DEV_USER_ID,
        displayName: '创始人甲',
        role: 'founder',
        active: true,
        feishuOpenId: 'ou_dev_founder_a',
        githubLogin: 'founder-a',
        githubId: 1001,
      },
      {
        id: 'u-founder-b',
        displayName: '创始人乙',
        role: 'founder',
        active: true,
        feishuOpenId: 'ou_dev_founder_b',
        githubLogin: 'founder-b',
      },
      { id: 'u-bot-worker', displayName: '干活的机器人', role: 'bot', active: true, githubId: 9001 },
      { id: 'u-bot-engine', displayName: '引擎机器人', role: 'bot', active: true, githubId: 9002 },
    ],
    repos: [
      { id: 'repo-1', owner: 'example', name: 'canary', defaultBranch: 'main', testCommand: 'pnpm check' },
    ],
    channels: [
      { id: 'ch-claude', name: 'Claude 订阅', billing: 'subscription', enabled: true },
      { id: 'ch-mirasim', name: 'Mirasim 云端', billing: 'subscription', enabled: true },
      { id: 'ch-cursor', name: 'Cursor', billing: 'subscription', enabled: true },
    ],
    pools: [
      { id: 'pool-claude-a', channelId: 'ch-claude', maxConcurrency: 5 },
      { id: 'pool-mirasim', channelId: 'ch-mirasim', maxConcurrency: 3 },
      { id: 'pool-cursor', channelId: 'ch-cursor', maxConcurrency: 2 },
    ],
    models: [
      { id: 'opus-5.5', family: 'claude', displayName: 'Opus 5.5' },
      { id: 'gpt-5.6', family: 'gpt', displayName: 'GPT 5.6' },
      { id: 'kimi-k3', family: 'kimi', displayName: 'Kimi k3' },
      { id: 'fable-1', family: 'fable', displayName: 'Fable' },
    ],
    routes: [
      {
        id: 'rt-claude-opus',
        channelId: 'ch-claude',
        poolId: 'pool-claude-a',
        modelId: 'opus-5.5',
        hostId: 'claude-code',
        alive: true,
      },
      {
        id: 'rt-mirasim-gpt',
        channelId: 'ch-mirasim',
        poolId: 'pool-mirasim',
        modelId: 'gpt-5.6',
        hostId: 'codex',
        alive: true,
      },
      {
        id: 'rt-mirasim-kimi',
        channelId: 'ch-mirasim',
        poolId: 'pool-mirasim',
        modelId: 'kimi-k3',
        hostId: 'mirasim',
        alive: true,
      },
      {
        id: 'rt-mirasim-fable',
        channelId: 'ch-mirasim',
        poolId: 'pool-mirasim',
        modelId: 'fable-1',
        hostId: 'mirasim',
        alive: true,
      },
    ],
    stagePolicies: [
      { stage: 'execute', routeIds: ['rt-claude-opus', 'rt-mirasim-kimi'], pinned: false },
      { stage: 'ui', routeIds: ['rt-claude-opus'], pinned: true },
      { stage: 'review', routeIds: ['rt-mirasim-gpt'], pinned: false },
    ],
    bans: [
      { family: 'gpt', stage: 'ui', reason: 'GPT 不碰 UI' },
      { family: 'fable', reason: '不用 Fable' },
    ],
    quotaWindows: [
      {
        poolId: 'pool-claude-a',
        window: '5h',
        utilization: 0.42,
        reading: 'measured',
        readAt: ago(5),
        resetsAt: ago(-120),
      },
      { poolId: 'pool-claude-a', window: '7d', utilization: 0.61, reading: 'measured', readAt: ago(5) },
      {
        poolId: 'pool-cursor',
        window: 'month_usd',
        used: 12.5,
        limit: 20,
        reading: 'estimated',
        readAt: ago(120),
      },
    ],
    tasks: [
      {
        id: 'task-12',
        repoId: 'repo-1',
        issueNumber: 12,
        title: '登录页加验证码',
        rawRequest: '给登录页加手机验证码',
        requestedBy: DEV_USER_ID,
        state: 'running',
        priority: 1,
        specDir: 'specs/12-登录验证码',
        createdAt: ago(90),
      },
      {
        id: 'task-13',
        repoId: 'repo-1',
        issueNumber: 13,
        title: 'README 加一行当前时间',
        rawRequest: '给 README 加一行当前时间',
        requestedBy: 'u-founder-b',
        state: 'done',
        priority: 2,
        createdAt: ago(600),
      },
    ],
    subtasks: [
      {
        id: 'sub-12a',
        taskId: 'task-12',
        index: 0,
        title: '验证码接口',
        touches: ['packages/api/src/auth'],
        dependsOn: [],
        state: 'running',
      },
      {
        id: 'sub-12b',
        taskId: 'task-12',
        index: 1,
        title: '验证码输入框',
        touches: ['packages/web/src/login'],
        dependsOn: ['sub-12a'],
        state: 'waiting_deps',
      },
    ],
    runs: [
      {
        id: DEV_RUN_ID,
        taskId: 'task-12',
        subtaskId: 'sub-12a',
        stage: 'execute',
        routeId: 'rt-claude-opus',
        whyRoute: '写码阶段排第一，额度还剩 58%',
        queuedAt: ago(14),
        startedAt: ago(12),
      },
      {
        id: 'run-0',
        taskId: 'task-12',
        stage: 'plan',
        routeId: 'rt-claude-opus',
        whyRoute: '规划阶段排第一',
        queuedAt: ago(40),
        startedAt: ago(39),
        endedAt: ago(20),
        outcome: 'ok',
        inputTokens: 120_000,
        outputTokens: 8_000,
      },
    ],
    plans: new Map([
      [
        DEV_RUN_ID,
        {
          updatedAt: ago(3),
          steps: [
            { index: 0, title: '读需求和方案', state: 'done' },
            { index: 1, title: '写验证码过期的测试', state: 'in_progress' },
            { index: 2, title: '实现发送和校验接口', state: 'pending' },
          ],
        },
      ],
    ]),
    progress: [
      {
        id: 'p-seed-1',
        runId: DEV_RUN_ID,
        at: ago(10),
        kind: 'say',
        payload: { text: '正在写验证码过期的测试' },
      },
    ],
    agentSessions: [
      {
        runId: DEV_RUN_ID,
        taskId: 'task-12',
        subtaskId: 'sub-12a',
        stage: 'execute',
        repoId: 'repo-1',
        branch: 'fleet/12-a',
        acceptance: ['验证码 5 分钟过期', '同一手机号 60 秒内只能发一次'],
      },
    ],
    jobs: [
      {
        id: 'job-quota',
        name: '额度读取',
        schedule: '每 15 分钟',
        expectEveryMinutes: 15,
        lastRun: { startedAt: ago(10), endedAt: ago(10), outcome: 'ok', found: 0 },
        lastSuccessAt: ago(10),
      },
      {
        id: 'job-reconcile',
        name: '每小时对账',
        schedule: '每小时',
        expectEveryMinutes: 60,
        lastRun: { startedAt: ago(30), endedAt: ago(29), outcome: 'unscanned', why: 'GitHub 接口限流' },
        lastSuccessAt: ago(200),
      },
    ],
    notifications: [
      {
        id: 'n-1',
        level: 'alert',
        title: '任务 12 卡住了',
        body: '写码会话 20 分钟没有进展',
        link: '/tasks/task-12',
        taskId: 'task-12',
        createdAt: ago(8),
        deliveries: [{ channel: 'feishu', messageId: 'om_dev_1', attempts: 1, lastAttemptAt: ago(8) }],
      },
    ],
    settings: [
      { key: 'sessions.maxConcurrent', value: 6, version: 1, updatedAt: ago(1000), updatedBy: DEV_USER_ID },
    ],
    history: [
      {
        repoId: 'repo-1',
        taskId: 'task-13',
        title: 'README 加一行当前时间',
        resultSummary: '在 README 顶部加了一行，由 CI 每次生成',
        mergedAt: ago(500),
      },
    ],
  };
}
