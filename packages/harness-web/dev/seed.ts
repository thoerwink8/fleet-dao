// 灌几条样例事件：三个会话，覆盖每种事件类型（含异常：叫停、被杀、核验不过）。时间往回摊开，列表和时间线好看。
import { events } from '@fleet-dao/harness-store';
import { eq } from 'drizzle-orm';
import type { Stack } from './stack.ts';

interface Step {
  type: string;
  /** 距离“现在”多少分钟前。 */
  ago: number;
  payload: Record<string, unknown>;
}

const SESSIONS: Record<string, Step[]> = {
  'cmd-demo-login-fix': [
    {
      type: 'session.turn.started',
      ago: 42,
      payload: { turnId: 't1', text: '指挥官接到需求：登录页在手机上按钮被挤没。' },
    },
    {
      type: 'worker.spawn.requested',
      ago: 40,
      payload: {
        taskId: 'a3f9c2d1-7b5e-4c0a-9e21-5d8f40b6a111',
        task: '修登录页窄屏下按钮被挤出屏幕的问题',
        expected: '390 宽下登录按钮完整可见，1440 宽版式不变，加一条窄屏回归测试',
        must_do: '先复现再改；改完跑登录页相关测试和界面检查',
        must_not: '不动其它页面，不改接口',
        context: '登录页在 packages/web/src/routes/login.tsx，窄屏下表单用了固定宽度。',
        stop_when: '回归测试和界面检查都绿，或者发现问题不在登录页就停下回报',
      },
    },
    {
      type: 'worker.spawned',
      ago: 39,
      payload: {
        runId: 'd12-a1',
        sessionId: 'w-8c21',
        sessionMode: 'new',
        model: 'claude-sonnet-5-5',
        shadow: true,
        deadline: new Date(Date.now() + 25 * 60_000).toISOString(),
      },
    },
    {
      type: 'worker.progress.reported',
      ago: 33,
      payload: { summary: '已复现：390 宽下表单溢出 38px，定位到固定宽度的容器。', percent: 25 },
    },
    {
      type: 'worker.progress.reported',
      ago: 26,
      payload: { summary: '改成自适应宽度，补了窄屏回归测试，正在跑界面检查。', percent: 70 },
    },
    {
      type: 'worker.result.submitted',
      ago: 19,
      payload: {
        status: 'done',
        summary: '登录页窄屏修好，回归测试和界面检查通过。',
        evidence:
          'npx vitest run packages/web/src/routes/login.test.tsx\n 1 file, 4 tests passed\nlint-design: 0 violations',
      },
    },
    {
      type: 'worker.settled',
      ago: 18,
      payload: {
        runId: 'd12-a1',
        sessionId: 'w-8c21',
        exitCode: 0,
        signal: null,
        killed: null,
        lastStep: 'submit_result',
        firstProgressMs: 4200,
        wallMs: 1260000,
        stragglers: 0,
        leftovers: null,
        stderrTail: '',
      },
    },
    {
      type: 'handback.recorded',
      ago: 17,
      payload: {
        jobKey: 'd12',
        taskId: 'a3f9c2d1-7b5e-4c0a-9e21-5d8f40b6a111',
        attempt: 1,
        final: true,
        outcome: 'delivered',
        verdict: 'pass',
        reasons: ['改动只在登录页', '测试和界面检查输出齐全'],
      },
    },
    {
      type: 'session.turn.settled',
      ago: 16,
      payload: { turnId: 't1', summary: '工人交回并核验通过，等待你验收。' },
    },
  ],
  'cmd-demo-flaky-ci': [
    { type: 'session.turn.started', ago: 12, payload: { turnId: 't1', text: '排查昨晚两次 CI 偶发红。' } },
    {
      type: 'worker.spawn.requested',
      ago: 11,
      payload: {
        taskId: 'b71e08aa-3c44-49d2-8a10-e2c77d9f0222',
        task: '找出偶发红的测试并判断是测试问题还是代码问题',
        expected: '给出出红的用例名、复现办法和根因，不要靠重跑',
        must_do: '看最近 20 次运行的日志，本机循环跑复现',
        must_not: '不调大超时，不跳过测试',
        context: '两次都红在 scheduler 相关用例。',
        stop_when: '找到根因或者连续 30 轮本机复现不出',
      },
    },
    {
      type: 'worker.spawned',
      ago: 10,
      payload: {
        runId: 'd13-a1',
        sessionId: 'w-91ab',
        sessionMode: 'new',
        model: 'claude-sonnet-5-5',
        shadow: true,
        deadline: new Date(Date.now() + 20 * 60_000).toISOString(),
      },
    },
    {
      type: 'worker.progress.reported',
      ago: 7,
      payload: {
        summary: '本机循环 30 轮没有复现，日志里看到两次都发生在 CI 机器负载高的时段。',
        percent: 60,
      },
    },
    {
      type: 'worker.stop.requested',
      ago: 5,
      payload: {
        taskId: 'b71e08aa-3c44-49d2-8a10-e2c77d9f0222',
        reason: '条件已满足（连续 30 轮复现不出），先停，改派去查 CI 机器负载。',
      },
    },
    {
      type: 'worker.settled',
      ago: 4,
      payload: {
        runId: 'd13-a1',
        sessionId: 'w-91ab',
        exitCode: 143,
        signal: 'SIGTERM',
        killed: 'stop-requested',
        lastStep: 'report_progress',
        firstProgressMs: 5100,
        wallMs: 372000,
        stragglers: 1,
        leftovers: null,
        stderrTail: 'terminated by supervisor: stop requested\nflushing 2 pending writes\n',
      },
    },
    {
      type: 'handback.recorded',
      ago: 3,
      payload: {
        jobKey: 'd13',
        taskId: 'b71e08aa-3c44-49d2-8a10-e2c77d9f0222',
        attempt: 1,
        final: true,
        outcome: 'dead',
        verdict: 'unknown',
        reasons: ['工人被叫停，没有交结果', '做到哪一步不知道，不盲目重派'],
      },
    },
  ],
  'cmd-demo-docs-sweep': [
    { type: 'session.turn.started', ago: 95, payload: { turnId: 't1', text: '把过期的文档链接扫一遍。' } },
    {
      type: 'worker.spawn.requested',
      ago: 94,
      payload: {
        taskId: 'c0de1234-aaaa-4bbb-8ccc-0123456789ab',
        task: '扫描 docs 下失效的相对链接并修正',
        expected: '列出失效链接清单，能自动修的修掉',
        must_do: '修完跑文档链接检查',
        must_not: '不改正文措辞',
        context: '最近挪过两个目录。',
        stop_when: '链接检查全绿',
      },
    },
    {
      type: 'worker.result.submitted',
      ago: 80,
      payload: {
        status: 'blocked',
        summary: '有 3 处链接指向已删除的决定文档，需要你定替代去处。',
        evidence:
          'docs/a.md:12 -> docs/old/0042.md\ndocs/b.md:7 -> docs/old/0042.md\ndocs/c.md:30 -> docs/old/0051.md',
      },
    },
    {
      type: 'handback.recorded',
      ago: 79,
      payload: {
        jobKey: 'd09',
        taskId: 'c0de1234-aaaa-4bbb-8ccc-0123456789ab',
        attempt: 2,
        final: false,
        outcome: 'blocked',
        verdict: 'rejected',
        reasons: ['3 处链接未修', '缺少链接检查的输出'],
      },
    },
  ],
};

/** 灌样例；已经有同名会话的跳过（持久化目录里重复启动不重复灌）。 */
export async function seed(stack: Stack): Promise<string[]> {
  const made: string[] = [];
  for (const [sessionId, steps] of Object.entries(SESSIONS)) {
    const existing = await stack.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.streamId, `session:${sessionId}`))
      .limit(1);
    if (existing.length > 0) continue;
    for (const s of steps) {
      const id = await stack.emit(sessionId, s.type, s.payload);
      await stack.db
        .update(events)
        .set({ createdAt: new Date(Date.now() - s.ago * 60_000) })
        .where(eq(events.id, id));
    }
    made.push(sessionId);
  }
  return made;
}
