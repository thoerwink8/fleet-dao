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
        runId: 'd12-a1',
        attempt: 1,
        final: true,
        outcome: 'completed',
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
  // 在跑：连着六次工具调用（折叠成一行摘要）+ 一段很长的开场白（预览 200 字）
  'cmd-demo-migration': [
    {
      type: 'session.turn.started',
      ago: 9,
      payload: {
        turnId: 't1',
        text: '把旧驾驶舱的任务页迁到新内核：先盘点旧页面读了哪些表，再逐个对到新内核的事件上，缺的字段列出来；迁的时候不改旧页面一行，两边并行跑，等新页面的数字和旧页面对得上再切；切之前把对不上的清单交给我看，我来定哪些是旧页面算错了、哪些是新内核漏了。另外两件事先说清楚：一是所有对数的口径以新内核的事件为准，旧页面里手工改过的数不算；二是迁移期间任何一边读失败都不许吞掉，页面上要写明读不到的原因和下一次重试的时间，不能显示成零或空。',
      },
    },
    {
      type: 'worker.spawn.requested',
      ago: 8,
      payload: {
        taskId: 'd4a7b3c2-1111-4222-8333-abcdefabcdef',
        task: '盘点旧任务页读的表和字段，对到新内核事件',
        expected: '一张表：旧字段、新事件字段、对不上的原因',
        must_do: '只读，不改旧页面',
        must_not: '不动 packages/web',
        context: '母单 #3770。',
        stop_when: '清单交齐，或发现缺的字段超过一半就停下报',
      },
    },
    {
      type: 'worker.spawned',
      ago: 7,
      payload: {
        runId: 'd14-a1',
        sessionId: 'w-b3c4',
        sessionMode: 'new',
        model: 'claude-sonnet-5-5',
        shadow: true,
        deadline: new Date(Date.now() + 40 * 60_000).toISOString(),
      },
    },
    {
      type: 'worker.progress.reported',
      ago: 6,
      payload: { summary: '读完旧任务页的 14 个接口。', percent: 10 },
    },
    {
      type: 'worker.progress.reported',
      ago: 5,
      payload: { summary: '对出 9 个字段，还剩 5 个没有对应事件。', percent: 35 },
    },
    {
      type: 'worker.progress.reported',
      ago: 4,
      payload: { summary: '其中 3 个可以从交回事件推出来。', percent: 50 },
    },
    {
      type: 'worker.progress.reported',
      ago: 3,
      payload: {
        summary:
          '剩下 2 个字段（重试次数、排队时长）新内核事件里没有，需要在派工事件里补；我先写进清单，不改契约。清单里每一行都带旧字段所在的接口、新内核候选事件和对不上的原因，方便你一眼看出哪些是真缺、哪些只是名字不同。',
        percent: 70,
      },
    },
    {
      type: 'worker.progress.reported',
      ago: 1,
      payload: { summary: '清单写完，正在自查一遍。', percent: 90 },
    },
  ],
  // 做完工人交了结果、等核验：证据很长（40 行），默认只显示前 12 行
  'cmd-demo-test-run': [
    { type: 'session.turn.started', ago: 2, payload: { turnId: 't1', text: '跑一遍全量测试给个结论。' } },
    {
      type: 'worker.result.submitted',
      ago: 1,
      payload: {
        status: 'done',
        summary: '全量测试通过。',
        evidence: Array.from({ length: 40 }, (_, i) => `mod-${String(i + 1).padStart(2, '0')} ok`).join('\n'),
      },
    },
  ],
};

// ---- 工人会话 worker-d12-a1（#3781）：登录页那件活的工人，二十多次工具调用、几句话、一次出错、一份 40 行的长输出 ----
// 会话流里是它经 MCP 报的进度和交结果，过程流 transcript:d12-a1 是 stream-json 每一步落的事件；两条流按写入顺序交错（事件号全库单调）。
export const DEMO_RUN_ID = 'd12-a1';
const DEMO_WORKER_SESSION = `worker-${DEMO_RUN_ID}`;

type Beat =
  | { to: 'session'; type: string; payload: Record<string, unknown> }
  | { to: 'transcript'; type: string; payload: Record<string, unknown> };

function demoWorkerBeats(): Beat[] {
  const out: Beat[] = [];
  let n = 0;
  const say = (text: string) =>
    out.push({
      to: 'transcript',
      type: 'transcript.assistant',
      payload: { runId: DEMO_RUN_ID, text, truncated: false, chars: text.length },
    });
  const tool = (
    name: string,
    input: Record<string, unknown>,
    summary: string,
    result: string,
    isError = false,
  ) => {
    const toolUseId = `toolu_demo_${String(++n).padStart(2, '0')}`;
    out.push({
      to: 'transcript',
      type: 'transcript.tool_use',
      payload: {
        runId: DEMO_RUN_ID,
        toolUseId,
        name,
        summary,
        input: JSON.stringify(input),
        inputTruncated: false,
      },
    });
    out.push({
      to: 'transcript',
      type: 'transcript.tool_result',
      payload: {
        runId: DEMO_RUN_ID,
        toolUseId,
        isError,
        text: result,
        truncated: false,
        chars: result.length,
      },
    });
  };
  const progress = (summary: string, percent: number) =>
    out.push({ to: 'session', type: 'worker.progress.reported', payload: { summary, percent } });
  const login = 'packages/web/src/routes/login.tsx';
  const longTest = Array.from(
    { length: 40 },
    (_, i) => ` ✓ packages/web/src/routes/case-${String(i + 1).padStart(2, '0')}.test.tsx (${i + 3} tests)`,
  ).join('\n');

  say('先看登录页的组件和现有测试，再决定怎么改。');
  tool(
    'Read',
    { file_path: login },
    login,
    'export function Login() {\n  return <form style={{ width: 420 }} />;\n}',
  );
  tool(
    'Read',
    { file_path: 'packages/web/src/routes/login.test.tsx' },
    'packages/web/src/routes/login.test.tsx',
    'describe("login", () => { /* 4 个用例 */ });',
  );
  tool(
    'Grep',
    { pattern: 'width: 420', path: 'packages/web/src' },
    'width: 420  packages/web/src',
    `${login}:3:  return <form style={{ width: 420 }} />;`,
  );
  say('找到了：表单写死了 420px，窄屏放不下。先跑一遍现有测试确认基线。');
  tool(
    'Bash',
    { command: 'npx vitest run packages/web/src/routes' },
    'npx vitest run packages/web/src/routes',
    longTest,
  );
  progress('已复现：390 宽下表单溢出 38px，定位到固定宽度的容器。', 25);
  say('改成自适应宽度，再补一条窄屏回归测试。');
  tool(
    'Edit',
    { file_path: login, old_string: 'width: 420', new_string: 'maxWidth: 420, width: "100%"' },
    login,
    'The file has been updated.',
  );
  tool(
    'Edit',
    { file_path: login, old_string: 'width: 400', new_string: 'width: "100%"' },
    login,
    'Error: old_string not found in file',
    true,
  );
  tool(
    'Edit',
    { file_path: login, old_string: '<form style', new_string: '<form data-testid="login-form" style' },
    login,
    'The file has been updated.',
  );
  tool(
    'Read',
    { file_path: login },
    login,
    'export function Login() {\n  return <form data-testid="login-form" style={{ maxWidth: 420, width: "100%" }} />;\n}',
  );
  tool(
    'Bash',
    { command: 'npx vitest run packages/web/src/routes/login.test.tsx' },
    'npx vitest run packages/web/src/routes/login.test.tsx',
    ' 1 file, 4 tests passed',
  );
  say('基线没坏。现在查一下别的页面有没有同样的写死宽度。');
  tool(
    'Grep',
    { pattern: 'width: [0-9]{3}', path: 'packages/web/src/routes' },
    'width: [0-9]{3}  packages/web/src/routes',
    'packages/web/src/routes/signup.tsx:12:  width: 380',
  );
  say('注册页同样写死了，但不在这件活的范围里，只记一笔不动它。');
  tool(
    'Bash',
    { command: 'npx playwright test login-narrow --project=390' },
    'npx playwright test login-narrow --project=390',
    'Running 1 test using 1 worker\n  1 passed (2.1s)',
  );
  tool('Bash', { command: 'pnpm lint:design' }, 'pnpm lint:design', 'lint-design: 0 violations');
  tool('Bash', { command: 'pnpm typecheck' }, 'pnpm typecheck', 'tsc -b: ok');
  tool(
    'Bash',
    { command: 'pnpm exec biome check packages/web/src/routes' },
    'pnpm exec biome check packages/web/src/routes',
    'Checked 14 files. No fixes applied.',
  );
  progress('改成自适应宽度，补了窄屏回归测试，界面检查通过，正在做最后一轮核对。', 70);
  say('逐个再看一遍改动的文件，确认没有多余改动。');
  tool(
    'Bash',
    { command: 'git diff --stat' },
    'git diff --stat',
    ' packages/web/src/routes/login.tsx | 2 +-\n packages/web/src/routes/login.test.tsx | 18 ++++++\n 2 files changed',
  );
  tool(
    'Bash',
    { command: 'git status --short' },
    'git status --short',
    ' M packages/web/src/routes/login.test.tsx\n M packages/web/src/routes/login.tsx',
  );
  tool(
    'Read',
    { file_path: 'packages/web/src/routes/login.test.tsx' },
    'packages/web/src/routes/login.test.tsx',
    'test("390 宽下登录按钮完整可见", async () => { /* … */ });',
  );
  tool('Read', { file_path: 'docs/design/驾驶舱界面.md' }, 'docs/design/驾驶舱界面.md', '# 驾驶舱界面\n……');
  say('改动只在登录页和它的测试，交结果。');
  out.push({
    to: 'session',
    type: 'worker.result.submitted',
    payload: {
      status: 'done',
      summary: '登录页窄屏修好，回归测试和界面检查通过。',
      evidence:
        'npx vitest run packages/web/src/routes/login.test.tsx\n 1 file, 4 tests passed\nlint-design: 0 violations',
    },
  });
  out.push({
    to: 'transcript',
    type: 'transcript.result',
    payload: {
      runId: DEMO_RUN_ID,
      subtype: 'success',
      isError: false,
      text: '登录页窄屏修好，回归测试和界面检查通过。',
      truncated: false,
      chars: 20,
      durationMs: 1260000,
      numTurns: 31,
    },
  });
  return out;
}

async function seedWorkerRun(stack: Stack): Promise<boolean> {
  const existing = await stack.db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.streamId, `session:${DEMO_WORKER_SESSION}`))
    .limit(1);
  if (existing.length > 0) return false;
  const beats = demoWorkerBeats();
  // 二十分钟的运行，按顺序均匀摊开
  const span = 21 * 60_000;
  const start = Date.now() - 38 * 60_000;
  let i = 0;
  for (const b of beats) {
    const id =
      b.to === 'session'
        ? await stack.emit(DEMO_WORKER_SESSION, b.type, b.payload)
        : await stack.emitStream(`transcript:${DEMO_RUN_ID}`, b.type, b.payload);
    await stack.db
      .update(events)
      .set({ createdAt: new Date(start + (span * i++) / beats.length) })
      .where(eq(events.id, id));
  }
  return true;
}

/** 灌样例；已经有同名会话的跳过（持久化目录里重复启动不重复灌）。 */
export async function seed(stack: Stack): Promise<string[]> {
  const made: string[] = [];
  // 工人会话先灌：事件号小，列表里排在其它样例之后，不挤掉原有样例的位置
  if (await seedWorkerRun(stack)) made.push(DEMO_WORKER_SESSION);
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
