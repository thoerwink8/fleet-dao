// 三段会话的过程记录的演示数据（#1640）：给任务详情「会话内容」用。真后端这些来自引擎写的 run_transcript，模拟器照形状造：
// - seg-c9-3（t-c9 动手第二轮，已结束）：一整段完整会话，提示词、几轮助手的话、几次工具调用和结果、一条报错、一条被截断的长结果、结论；
// - seg-c9-2（t-c9 动手第一轮，超时收的）：只有提示词、两轮话和一条报错，没有结论（超时被收了，流里没有终帧）；
// - seg-t-12-manual-40（t-12 动手，在跑）：已经有一部分，模拟器每被读一次多放出几条，演示增量刷新；
// - 其余的段（例如 seg-c9-1 对题那一段）故意没有：演示「这一段跑在记录会话内容之前，没有记录」。
import type { TranscriptEntry } from '../types';

type Draft = Omit<TranscriptEntry, 'seq' | 'at'> & { min: number };

const PROMPT =
  '你在 acme/canary 仓里做 #9：README 里「更新时间」那一行改成北京时间（UTC+8）。\n先读 README.md 和生成它的脚本，改脚本，不要手改 README。\n做完提交，提交信息一句话说清改了什么、为什么。';

const FULL: Draft[] = [
  { min: 0, kind: 'prompt', text: PROMPT },
  { min: 0.4, kind: 'assistant', text: '先看 README 里这一行是怎么生成的。' },
  { min: 0.5, kind: 'tool_call', tool: 'Grep', text: '更新时间 @ .' },
  {
    min: 0.6,
    kind: 'tool_result',
    tool: 'Grep',
    ok: true,
    text: 'README.md:3: 更新时间：2026-10-07 04:00 UTC\nscripts/stamp.ts:12: const label = `更新时间：${fmt(now)} UTC`;',
  },
  { min: 0.7, kind: 'tool_call', tool: 'Task', text: '找出还有哪些地方按 UTC 写时间标签' },
  {
    min: 0.8,
    kind: 'assistant',
    text: '我在仓里搜「UTC」，只有 scripts/stamp.ts 和它的测试用到这个标签。',
    meta: { subagent: true, subagentType: 'fleet-scout' },
  },
  {
    min: 0.85,
    kind: 'tool_call',
    tool: 'Grep',
    text: 'UTC @ scripts',
    meta: { subagent: true, subagentType: 'fleet-scout' },
  },
  {
    min: 0.9,
    kind: 'tool_result',
    tool: 'Grep',
    ok: true,
    text: 'scripts/stamp.ts:12\nscripts/stamp.test.ts:8',
    meta: { subagent: true, subagentType: 'fleet-scout' },
  },
  {
    min: 0.95,
    kind: 'tool_result',
    tool: 'Task',
    ok: true,
    text: '只有 scripts/stamp.ts 第 12 行和 stamp.test.ts 第 8 行用到。',
  },
  { min: 1, kind: 'tool_call', tool: 'Read', text: 'scripts/stamp.ts' },
  {
    min: 1.1,
    kind: 'tool_result',
    tool: 'Read',
    ok: true,
    text: `${'import { fmt } from "./time.ts";\n'.repeat(14)}…[已截断]`,
    meta: { truncated: true, originalChars: 2380 },
  },
  {
    min: 2,
    kind: 'assistant',
    text: '生成脚本在 scripts/stamp.ts 第 12 行，时间是按 UTC 格式化的。我把它改成 Asia/Shanghai，再把标签里的 UTC 换成「北京时间」。',
  },
  { min: 2.3, kind: 'tool_call', tool: 'Edit', text: 'scripts/stamp.ts' },
  {
    min: 2.4,
    kind: 'tool_result',
    tool: 'Edit',
    ok: true,
    text: 'The file scripts/stamp.ts has been updated.',
  },
  { min: 3, kind: 'tool_call', tool: 'Bash', text: 'node scripts/stamp.ts && git diff --stat' },
  {
    min: 3.4,
    kind: 'tool_result',
    tool: 'Bash',
    ok: true,
    text: ' README.md        | 2 +-\n scripts/stamp.ts | 4 ++--\n 2 files changed, 3 insertions(+), 3 deletions(-)',
  },
  { min: 4, kind: 'tool_call', tool: 'Bash', text: 'npx vitest run scripts/stamp.test.ts' },
  {
    min: 5,
    kind: 'tool_result',
    tool: 'Bash',
    ok: false,
    text: 'FAIL scripts/stamp.test.ts > 格式\nAssertionError: expected "更新时间：2026-10-07 12:00 北京时间" to be "更新时间：2026-10-07 12:00 UTC+8"',
  },
  { min: 5.2, kind: 'error', text: '测试没过：stamp.test.ts 还在期待旧的标签写法' },
  { min: 5.6, kind: 'assistant', text: '测试里写死了旧标签。改测试的期望值，不改实现。' },
  { min: 5.8, kind: 'tool_call', tool: 'Edit', text: 'scripts/stamp.test.ts' },
  {
    min: 5.9,
    kind: 'tool_result',
    tool: 'Edit',
    ok: true,
    text: 'The file scripts/stamp.test.ts has been updated.',
  },
  {
    min: 6.5,
    kind: 'tool_call',
    tool: 'Bash',
    text: 'npx vitest run scripts/stamp.test.ts && git add -A && git commit -m "README 更新时间改成北京时间：读者在国内，UTC 要自己换算"',
  },
  {
    min: 7.6,
    kind: 'tool_result',
    tool: 'Bash',
    ok: true,
    text: ' ✓ scripts/stamp.test.ts (3 tests)\n[agent/9-readme-tz 4c1d2ab] README 更新时间改成北京时间：读者在国内，UTC 要自己换算',
  },
  {
    min: 8,
    kind: 'result',
    ok: true,
    text: '已提交 4c1d2ab：更新时间改成北京时间（Asia/Shanghai），测试期望同步改了。',
  },
];

const TIMED_OUT: Draft[] = [
  { min: 0, kind: 'prompt', text: PROMPT },
  { min: 1, kind: 'assistant', text: '先看 README 和生成脚本。' },
  { min: 1.2, kind: 'tool_call', tool: 'shell', text: 'ls -R | head -50' },
  {
    min: 1.5,
    kind: 'tool_result',
    tool: 'shell',
    ok: true,
    text: 'README.md\nscripts\nscripts/stamp.ts\nscripts/stamp.test.ts',
  },
  { min: 29, kind: 'error', text: '上游一直没有回话，30 分钟到了，被收掉' },
];

/** 在跑的那一段的全部过程；模拟器按被读的次数一点点放出来。 */
const RUNNING: Draft[] = [
  {
    min: -39,
    kind: 'prompt',
    text: '你在 acme/canary 仓里做 #12：把 canary 的探活间隔从 60 秒改成 30 秒，配置在 config/canary.json。\n改完跑 pnpm test canary，提交。',
  },
  { min: -38, kind: 'assistant', text: '先找探活间隔写在哪。' },
  { min: -38, kind: 'tool_call', tool: 'Grep', text: 'intervalSeconds @ config' },
  {
    min: -37,
    kind: 'tool_result',
    tool: 'Grep',
    ok: true,
    text: 'config/canary.json:4:  "intervalSeconds": 60,',
  },
  { min: -36, kind: 'tool_call', tool: 'Edit', text: 'config/canary.json' },
  {
    min: -36,
    kind: 'tool_result',
    tool: 'Edit',
    ok: true,
    text: 'The file config/canary.json has been updated.',
  },
  { min: -35, kind: 'assistant', text: '配置改好了，跑 canary 的测试。' },
  { min: -34, kind: 'tool_call', tool: 'Bash', text: 'pnpm test canary' },
  {
    min: -32,
    kind: 'tool_result',
    tool: 'Bash',
    ok: true,
    text: ' ✓ canary/probe.test.ts (6 tests)\n ✓ canary/config.test.ts (2 tests)',
  },
  { min: -31, kind: 'assistant', text: '测试都过了，提交。' },
  {
    min: -30,
    kind: 'tool_call',
    tool: 'Bash',
    text: 'git add -A && git commit -m "canary 探活间隔改成 30 秒：60 秒发现故障太慢"',
  },
];

function materialize(drafts: readonly Draft[], at: (min: number) => string): TranscriptEntry[] {
  return drafts.map(({ min, ...entry }, seq) => ({ seq, at: at(min), ...entry }));
}

export interface MockTranscripts {
  /** 段 id → 条目（按 seq）。没在表里的段 = 没有记录。 */
  readonly byRun: ReadonlyMap<string, TranscriptEntry[]>;
  /** 这些段是「在跑」的：读一次多放几条（演示增量刷新）。 */
  readonly live: ReadonlySet<string>;
}

/** at(min)：距「现在」多少分钟的 ISO 时间（seed.ts 的 at）。 */
export function transcriptSeed(at: (min: number) => string): MockTranscripts {
  const base = (startMin: number) => (min: number) => at(startMin + min);
  return {
    byRun: new Map([
      ['seg-c9-3', materialize(FULL, base(-142))],
      ['seg-c9-2', materialize(TIMED_OUT, base(-174))],
      ['seg-t-12-manual-40', materialize(RUNNING, (min) => at(min))],
    ]),
    live: new Set(['seg-t-12-manual-40']),
  };
}

/** 在跑的段一开始放出多少条，和每被读一次多放几条。 */
export const LIVE_FIRST_REVEAL = 4;
export const LIVE_REVEAL_STEP = 2;
