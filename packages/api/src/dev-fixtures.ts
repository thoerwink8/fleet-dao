// 本地开发和测试用的一小份样例数据（假的名字和编号，不对应任何真实账号）。时间都相对 now 算。
// 编号是 uuid：同一份数据能放进内存版，也能写进 Postgres（test/pg-fixtures.ts），两个 Store 过同一套测试。
import type { MemoryData } from './memory-store.ts';

/** 样例数据里的编号。前缀字母只是为了人眼好认：a 仓、b 需求、c 子任务、d 会话、e 人、f 通知。 */
export const IDS = {
  repo: 'a0000000-0000-4000-8000-000000000001',
  task12: 'b0000000-0000-4000-8000-000000000012',
  task13: 'b0000000-0000-4000-8000-000000000013',
  sub12a: 'c0000000-0000-4000-8000-00000000012a',
  sub12b: 'c0000000-0000-4000-8000-00000000012b',
  run1: 'd0000000-0000-4000-8000-000000000001',
  run0: 'd0000000-0000-4000-8000-000000000000',
  founderA: 'e0000000-0000-4000-8000-00000000000a',
  founderB: 'e0000000-0000-4000-8000-00000000000b',
  botWorker: 'e0000000-0000-4000-8000-000000009001',
  botEngine: 'e0000000-0000-4000-8000-000000009002',
  notification1: 'f0000000-0000-4000-8000-000000000001',
} as const;

export const DEV_USER_ID = IDS.founderA;
export const DEV_RUN_ID = IDS.run1;

export function devFixtures(now: Date): Partial<MemoryData> {
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  return {
    users: [
      {
        id: IDS.founderA,
        displayName: '创始人甲',
        role: 'founder',
        active: true,
        feishuOpenId: 'ou_dev_founder_a',
        githubLogin: 'founder-a',
        githubId: 1001,
      },
      {
        id: IDS.founderB,
        displayName: '创始人乙',
        role: 'founder',
        active: true,
        feishuOpenId: 'ou_dev_founder_b',
        githubLogin: 'founder-b',
      },
      { id: IDS.botWorker, displayName: '干活的机器人', role: 'bot', active: true, githubId: 9001 },
      { id: IDS.botEngine, displayName: '引擎机器人', role: 'bot', active: true, githubId: 9002 },
    ],
    repos: [
      { id: IDS.repo, owner: 'example', name: 'canary', defaultBranch: 'main', testCommand: 'pnpm check' },
    ],
    channels: [
      { id: 'ch-claude', name: 'Claude 订阅', billing: 'subscription', enabled: true },
      { id: 'ch-cursor', name: 'Cursor', billing: 'subscription', enabled: true },
      { id: 'ch-mirasim', name: 'Mirasim 云端', billing: 'subscription', enabled: true },
    ],
    pools: [
      { id: 'pool-claude-a', channelId: 'ch-claude', maxConcurrency: 5 },
      { id: 'pool-cursor', channelId: 'ch-cursor', maxConcurrency: 2 },
      { id: 'pool-mirasim', channelId: 'ch-mirasim', maxConcurrency: 3 },
    ],
    models: [
      { id: 'fable-5.1', family: 'claude', displayName: 'Fable 5.1' },
      { id: 'gpt-5.6', family: 'gpt', displayName: 'GPT 5.6' },
      { id: 'kimi-k3', family: 'kimi', displayName: 'Kimi k3' },
      { id: 'opus-5.5', family: 'claude', displayName: 'Opus 5.5' },
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
        id: 'rt-mirasim-fable',
        channelId: 'ch-mirasim',
        poolId: 'pool-mirasim',
        modelId: 'fable-5.1',
        hostId: 'mirasim',
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
    ],
    stagePolicies: [
      { stage: 'execute', routeIds: ['rt-claude-opus', 'rt-mirasim-kimi'], pinned: false },
      { stage: 'ui', routeIds: ['rt-claude-opus'], pinned: true },
      { stage: 'review', routeIds: ['rt-mirasim-gpt'], pinned: false },
    ],
    // 两条全局禁令写死在 shared/bans.ts，不在这里；库里只放另外加的（这条是样例）。
    bans: [{ family: 'kimi', stage: 'ui', reason: '（样例）库里另配的禁令：Kimi 暂不进 UI' }],
    quotaWindows: [
      {
        poolId: 'pool-claude-a',
        label: '5h',
        window: '5h',
        utilization: 0.42,
        unit: 'percent',
        reading: 'measured',
        source: 'claude-usage',
        readAt: ago(5),
        resetsAt: ago(-120),
      },
      {
        poolId: 'pool-claude-a',
        label: '7d',
        window: '7d',
        utilization: 0.61,
        unit: 'percent',
        upstreamStatus: 'allowed',
        statusRaw: 'allowed',
        reading: 'measured',
        source: 'claude-usage',
        readAt: ago(5),
      },
      {
        poolId: 'pool-cursor',
        label: 'month_usd',
        window: 'month_usd',
        used: 12.5,
        limit: 20,
        unit: 'usd',
        reading: 'estimated',
        source: 'estimate',
        readAt: ago(120),
      },
    ],
    tasks: [
      {
        id: IDS.task12,
        repoId: IDS.repo,
        issueNumber: 12,
        title: '登录页加验证码',
        rawRequest: '给登录页加手机验证码',
        requestedBy: IDS.founderA,
        state: 'running',
        priority: 1,
        specDir: 'specs/12-登录验证码',
        acceptance: ['验证码 5 分钟过期', '同一手机号 60 秒内只能发一次'],
        createdAt: ago(90),
      },
      {
        id: IDS.task13,
        repoId: IDS.repo,
        issueNumber: 13,
        title: 'README 加一行当前时间',
        rawRequest: '给 README 加一行当前时间',
        requestedBy: IDS.founderB,
        state: 'done',
        priority: 2,
        acceptance: [],
        createdAt: ago(600),
      },
    ],
    subtasks: [
      {
        id: IDS.sub12a,
        taskId: IDS.task12,
        index: 0,
        title: '验证码接口',
        touches: ['packages/api/src/auth'],
        dependsOn: [],
        state: 'running',
      },
      {
        id: IDS.sub12b,
        taskId: IDS.task12,
        index: 1,
        title: '验证码输入框',
        touches: ['packages/web/src/login'],
        dependsOn: [IDS.sub12a],
        state: 'waiting_deps',
      },
    ],
    runs: [
      {
        id: IDS.run0,
        taskId: IDS.task12,
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
      {
        id: IDS.run1,
        taskId: IDS.task12,
        subtaskId: IDS.sub12a,
        stage: 'execute',
        routeId: 'rt-claude-opus',
        whyRoute: '写码阶段排第一，额度还剩 58%',
        branch: 'fleet/12-a',
        queuedAt: ago(14),
        startedAt: ago(12),
      },
    ],
    progress: [
      {
        id: '1',
        runId: IDS.run1,
        at: ago(10),
        kind: 'say',
        payload: { text: '正在写验证码过期的测试' },
      },
      {
        id: '2',
        runId: IDS.run1,
        at: ago(3),
        kind: 'plan',
        payload: {
          steps: [
            { title: '读需求和方案', state: 'done' },
            { title: '写验证码过期的测试', state: 'in_progress' },
            { title: '实现发送和校验接口', state: 'pending' },
          ],
        },
      },
    ],
    jobs: [
      { id: 'job-quota', name: '额度读取', schedule: '每 15 分钟', expectEveryMinutes: 20 },
      { id: 'job-reconcile', name: '每小时对账', schedule: '每小时', expectEveryMinutes: 75 },
    ],
    scheduleRuns: [
      { job: 'job-quota', startedAt: ago(10), endedAt: ago(10), outcome: 'ok', scanned: 3, found: 0 },
      { job: 'job-reconcile', startedAt: ago(200), endedAt: ago(199), outcome: 'ok', scanned: 5, found: 0 },
      {
        job: 'job-reconcile',
        startedAt: ago(30),
        endedAt: ago(29),
        outcome: 'unscanned',
        why: 'GitHub 接口限流，一个仓都没扫到',
      },
    ],
    notifications: [
      {
        id: IDS.notification1,
        level: 'alert',
        title: '任务 12 卡住了',
        body: '写码会话 20 分钟没有进展',
        link: `/tasks/${IDS.task12}`,
        taskId: IDS.task12,
        createdAt: ago(8),
        deliveries: [{ channel: 'feishu', messageId: 'om_dev_1', attempts: 1, lastAttemptAt: ago(8) }],
      },
    ],
    settings: [
      { key: 'sessions.maxConcurrent', value: 6, version: 1, updatedAt: ago(1000), updatedBy: IDS.founderA },
    ],
    specs: [
      {
        taskId: IDS.task13,
        summary: '给 README 加一行当前时间',
        resultSummary: '在 README 顶部加了一行，由 CI 每次生成',
        mergedAt: ago(500),
      },
    ],
  };
}
