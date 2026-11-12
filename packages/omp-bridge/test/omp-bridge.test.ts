import { describe, expect, it } from 'vitest';
import {
  assertAntiBanSafety,
  BUILTIN_CHANNELS,
  BUILTIN_MODELS,
  compileAgentPrompt,
  createOmpBridgeHook,
  dehydrateHistoryTurns,
  evaluateTrustFunnel,
  evolvePromptRules,
  runYskCheck,
  SessionCommunicationBus,
  selectBestRoute,
  wilsonLowerBound,
} from '../src/index.ts';

describe('方案 2 四维路由与 reclaude 防封铁律（matrix.ts）', () => {
  const pickChannel = (id: string) => {
    const found = BUILTIN_CHANNELS.find((c) => c.id === id);
    if (!found) throw new Error(`missing channel ${id}`);
    return found;
  };
  const pickModel = (id: string) => {
    const found = BUILTIN_MODELS.find((m) => m.id === id);
    if (!found) throw new Error(`missing model ${id}`);
    return found;
  };
  const reclaude = pickChannel('reclaude');
  const kiro = pickChannel('kiro');
  const commoncode = pickChannel('commoncode');
  const recodex = pickChannel('recodex');
  const devin = pickChannel('devin');

  const opus = pickModel('claude-opus-5-5');
  const kiroSonnet = pickModel('kiro-claude-sonnet');
  const dsPro = pickModel('deepseek-v4-pro');
  const codex = pickModel('gpt-5.3-codex');
  const swe2 = pickModel('devin-swe-2');

  it('reclaude 严格要求官方本体常驻流 + 独立宿主用户隔离，企图走 HTTP 反代或混登立即拦截', () => {
    expect(() =>
      assertAntiBanSafety(
        { ...reclaude, runner: 'pi-api-stream' },
        {
          accountId: 'acc-1',
          channelId: 'reclaude',
          isolatedHostUser: 'france:fleet-agent-carpool',
          enabled: true,
          remainingRatio: 0.8,
        },
      ),
    ).toThrow(/防封拦截.*严禁使用 pi-api-stream 反代/);

    expect(() =>
      assertAntiBanSafety(reclaude, {
        accountId: 'acc-1',
        channelId: 'reclaude',
        enabled: true,
        remainingRatio: 0.8,
      }),
    ).toThrow(/防封拦截.*必须绑定独立的「宿主:系统用户」/);

    expect(() =>
      assertAntiBanSafety(reclaude, {
        accountId: 'acc-1',
        channelId: 'reclaude',
        isolatedHostUser: 'france:fleet-agent-carpool',
        enabled: true,
        remainingRatio: 0.8,
      }),
    ).not.toThrow();
  });

  it('Magpie 5h 拼车窗临近清零且有余量时，优先烧快清零的账号；GPT 硬禁令不接 worker-ui', () => {
    const now = 1_700_000_000_000;
    const picked = selectBestRoute({
      role: 'worker-code',
      nowMs: now,
      candidates: [
        {
          channel: commoncode,
          model: dsPro,
          account: {
            accountId: 'cc-ds-1',
            channelId: 'commoncode',
            enabled: true,
            remainingRatio: 0.9,
          },
          wilsonLowerBound: 0.88,
        },
        {
          channel: reclaude,
          model: opus,
          account: {
            accountId: 'reclaude-carpool-a',
            channelId: 'reclaude',
            isolatedHostUser: 'france:fleet-agent-carpool',
            enabled: true,
            remainingRatio: null,
            windowUsedUsd: 30,
            windowLimitUsd: 80,
            resetsAtMs: now + 45 * 60_000, // 45 分钟后清零，还剩 $50
          },
          wilsonLowerBound: 0.92,
        },
      ],
    });
    expect(picked.account.accountId).toBe('reclaude-carpool-a');
    expect(picked.reason).toContain('官方本体直通');

    // worker-ui 排除 GPT-5.3 Codex，选 Kiro Claude Sonnet
    const uiPicked = selectBestRoute({
      role: 'worker-ui',
      candidates: [
        {
          channel: recodex,
          model: codex,
          account: { accountId: 'rc-1', channelId: 'recodex', enabled: true, remainingRatio: 1 },
          wilsonLowerBound: 0.95,
        },
        {
          channel: kiro,
          model: kiroSonnet,
          account: { accountId: 'kiro-1', channelId: 'kiro', enabled: true, remainingRatio: 0.9 },
          wilsonLowerBound: 0.89,
        },
      ],
    });
    expect(uiPicked.model.id).toBe('kiro-claude-sonnet');
  });

  it('YSK 旁路盯梢与 Scout 斥候自动优选免费的 Devin SWE-2', () => {
    const yskPicked = selectBestRoute({
      role: 'ysk-watcher',
      candidates: [
        {
          channel: kiro,
          model: kiroSonnet,
          account: { accountId: 'kiro-1', channelId: 'kiro', enabled: true, remainingRatio: 0.9 },
        },
        {
          channel: devin,
          model: swe2,
          account: { accountId: 'devin-free', channelId: 'devin', enabled: true, remainingRatio: 1 },
        },
      ],
    });
    expect(yskPicked.model.id).toBe('devin-swe-2');
  });
});

describe('模型专属提示词编译器与自进化闭环（prompt-compiler.ts）', () => {
  const dsPro = BUILTIN_MODELS.find((m) => m.id === 'deepseek-v4-pro') ?? BUILTIN_MODELS[0];
  if (!dsPro) throw new Error('missing model');

  it('同类翻车满 3 次自动提炼出模型专属反模式护栏，并编译进三明治 Prompt（含 Scout 预切片与黑板）', () => {
    const evolved = evolvePromptRules(
      [
        {
          id: '1',
          modelId: 'deepseek-v4-pro',
          role: 'worker-code',
          category: 'out-of-scope',
          summary: '顺手改了 header.tsx 导航文案',
          at: '2026-11-12T00:00:00Z',
        },
        {
          id: '2',
          modelId: 'deepseek-v4-pro',
          role: 'worker-code',
          category: 'out-of-scope',
          summary: '顺手改了 footer.tsx 链接',
          at: '2026-11-12T00:10:00Z',
        },
        {
          id: '3',
          modelId: 'deepseek-v4-pro',
          role: 'worker-code',
          category: 'out-of-scope',
          summary: '顺手格式化了 package.json',
          at: '2026-11-12T00:20:00Z',
        },
      ],
      [],
      3,
    );
    expect(evolved).toHaveLength(1);
    expect(evolved[0]?.category).toBe('out-of-scope');

    const prompt = compileAgentPrompt({
      role: 'worker-code',
      model: dsPro,
      taskTitle: '新增结算页初稿',
      mustDo: ['新建 checkout.tsx'],
      mustNotDo: ['不改现有导航栏'],
      writeScope: ['packages/harness-web/src/pages/checkout.tsx'],
      checkCommand: 'npx vitest run packages/harness-web',
      evolvedRules: evolved,
      blackboardFacts: ['Order.totalCents 已统一为 bigint'],
      preSlicedContext: [
        {
          file: 'packages/harness-web/src/main.tsx',
          startLine: 10,
          endLine: 25,
          reason: '路由入口挂载点',
          content: 'const router = createBrowserRouter([...]);',
        },
      ],
    });

    expect(prompt).toContain('【DeepSeek (V4 Pro / V3 / R1) 编码主力调优】');
    expect(prompt).toContain('历史翻车自进化护栏');
    expect(prompt).toContain('Order.totalCents 已统一为 bigint');
    expect(prompt).toContain('Scout 预定位代码切片');
  });
});

describe('Devin SWE-2 YSK 旁路盯梢 + 省 Token 折叠 + 黑板通信 + 四道验收漏斗', () => {
  it('YSK 精准抓出「顺手改了范围外已上线文件」和「删 expect 断言凑绿」，并触发实时 steer', async () => {
    const bus = new SessionCommunicationBus();
    const alerts: string[] = [];
    const hook = createOmpBridgeHook({
      sessionId: 'worker-1',
      waveId: 'wave-a',
      taskGoal: '新增个人设置初稿页',
      allowedScope: ['packages/harness-web/src/pages/profile.tsx'],
      mustNotDo: ['严禁改动线上导航栏'],
      bus,
      onYskAlert: (a) => alerts.push(`${a.badge}: ${a.message}`),
    });

    const res = await hook.onToolExecutionEnd({
      toolName: 'edit',
      exitCode: 0,
      output: `${'✓ test line\n'.repeat(120)}Tests  48 passed (48)\nDone in 1.2s`,
      changedFiles: [
        {
          path: 'packages/harness-web/src/pages/profile.tsx',
          addedLines: 40,
          removedLines: 0,
          diffPreview: '+ export function Profile() {}',
        },
        {
          path: 'packages/harness-web/src/components/shell.tsx',
          addedLines: 3,
          removedLines: 3,
          diffPreview: '- 驾驶舱\n+ 个人中心',
        },
      ],
    });

    expect(res.yskAlert?.triggered).toBe(true);
    expect(res.yskAlert?.badge).toBe('✦ Heads up · 主 agent');
    expect(res.yskAlert?.message).toContain('packages/harness-web/src/components/shell.tsx');
    expect(res.pendingSteers).toHaveLength(1);
    expect(res.savedTokensEstimate).toBeGreaterThan(200);

    // 删断言检测
    const delCheck = await runYskCheck({
      taskGoal: '修单测',
      allowedScope: ['packages/api/test/a.test.ts'],
      mustNotDo: [],
      changedFiles: [
        {
          path: 'packages/api/test/a.test.ts',
          addedLines: 1,
          removedLines: 5,
          diffPreview: '- expect(res.status).toBe(200);\n- expect(res.body.ok).toBe(true);\n+ // ok',
        },
      ],
    });
    expect(delCheck.triggered).toBe(true);
    expect(delCheck.kind).toBe('deleted-assertion');
  });

  it('同波次 Worker 发布黑板事实自动广播给伙伴；历史工具长输出超过 3 轮自动脱水', () => {
    const bus = new SessionCommunicationBus();
    bus.joinWave('w1', 'worker-a');
    bus.joinWave('w1', 'worker-b');

    const pub = bus.publishFact({
      id: 'f1',
      waveId: 'w1',
      authorSessionId: 'worker-a',
      authorModel: 'kiro-claude-sonnet',
      touchedFiles: ['packages/shared/src/ports.ts'],
      fact: 'SessionSummary 新增了 modelBadge 字段',
      createdAt: '2026-11-12T01:00:00Z',
    });
    expect(pub.notifiedSessions).toEqual(['worker-b']);
    expect(bus.drainSteer('worker-b')[0]?.text).toContain('SessionSummary 新增了 modelBadge 字段');

    const dehydrated = dehydrateHistoryTurns(
      [
        {
          turnIndex: 1,
          role: 'toolResult',
          toolName: 'read',
          targetFile: 'packages/db/src/schema.ts',
          content: 'x'.repeat(2400),
        },
        {
          turnIndex: 5,
          role: 'toolResult',
          toolName: 'read',
          targetFile: 'packages/db/src/index.ts',
          content: 'y'.repeat(1200),
        },
      ],
      6,
      3,
    );
    expect(dehydrated.savedTokens).toBeGreaterThan(500);
    expect(dehydrated.messages[0]?.content).toContain('历史已读脱水快照');
    expect(dehydrated.messages[1]?.content).toHaveLength(1200);
  });

  it('四道可信漏斗：同族验收被拒、第 2 次失败自动升强一档模型、达标格自动波次合流', () => {
    expect(wilsonLowerBound(24, 24)).toBeGreaterThan(0.85);
    expect(wilsonLowerBound(48, 50)).toBeGreaterThan(0.86);
    expect(wilsonLowerBound(98, 100)).toBeGreaterThan(0.9);

    // 第 2 次机械闸不过 → 自动升强一档模型（escalate-stronger-model）
    const esc = evaluateTrustFunnel({
      attempt: 2,
      ysk: {
        triggered: false,
        badge: '✦ Heads up · 主 agent',
        severity: 'warning',
        kind: 'clean',
        message: '',
        watcherModel: 'devin/swe-2',
      },
      mechanical: {
        writeScopeClean: true,
        outOfScopeFiles: [],
        biomeExitCode: 0,
        tscExitCode: 1,
        testExitCode: 0,
        passedTestsCount: 10,
        baselineTestsCount: 10,
      },
      coldVerify: {
        verifierModelId: 'gpt-5.3-codex',
        verifierFamily: 'gpt',
        workerFamily: 'deepseek',
        verdict: 'pass',
        blockingReasons: [],
      },
      track: {
        cellKey: 'worker-code::deepseek-v4-pro',
        maturedCount: 60,
        successCount: 59,
        recentRetractions: 0,
        gatePolicy: 'by-record',
        gateOpenedByHuman: true,
      },
    });
    expect(esc.overallVerdict).toBe('escalate-stronger-model');

    // 四道闸全过且 Wilson >= 90% → 自动波次合流（不需要每个子任务开 GitHub PR）
    const pass = evaluateTrustFunnel({
      attempt: 1,
      ysk: {
        triggered: false,
        badge: '✦ Heads up · 主 agent',
        severity: 'warning',
        kind: 'clean',
        message: '',
        watcherModel: 'devin/swe-2',
      },
      mechanical: {
        writeScopeClean: true,
        outOfScopeFiles: [],
        biomeExitCode: 0,
        tscExitCode: 0,
        testExitCode: 0,
        passedTestsCount: 42,
        baselineTestsCount: 40,
        uiScreenshots: {
          desktop1440Path: '_tmp/1440.png',
          mobile390Path: '_tmp/390.png',
          consoleErrors: 0,
          horizontalOverflowPx: 0,
        },
      },
      coldVerify: {
        verifierModelId: 'gpt-5.3-codex',
        verifierFamily: 'gpt',
        workerFamily: 'claude',
        verdict: 'pass',
        blockingReasons: [],
      },
      track: {
        cellKey: 'worker-ui::kiro-claude-sonnet',
        maturedCount: 100,
        successCount: 98,
        recentRetractions: 0,
        gatePolicy: 'by-record',
        gateOpenedByHuman: true,
      },
    });
    expect(pass.overallVerdict).toBe('auto-merge-wave');
  });
});
