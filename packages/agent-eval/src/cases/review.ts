// 评审类的题：review-screen（清单初筛）、reviewer（找逻辑错）。夹具是一份 change.diff，回答按 `change.diff:行 — 问题` 报，
// 判分按行号窗口比：窗口是从 diff 里用正则现找的，不写死行号。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gradeCitations, type Planted } from '../grade-util.ts';
import type { EvalCase, GradeContext, Verdict } from '../types.ts';

const PREAMBLE =
  '这是能力演练题，不是真任务：不开 PR、不评论、不改任何文件，也没有 git 仓，改动就是当前目录里的 `change.diff` 这一个文件。\n\n';

const FORMAT =
  '回答格式：每个问题一行，`change.diff:<行号> — <一句话>`。行号是 `change.diff` 这个文件自己的行号（从 1 数）。' +
  '只报你认为有问题的，没问题的不要列。\n';

function diffOf(ctx: GradeContext): string {
  return readFileSync(join(ctx.caseDir, 'workspace', 'change.diff'), 'utf8');
}

// —— review-screen ——

const QUEUE_PLANTED: Planted[] = [
  { kind: '碰标准路径 agents/', anchor: /^diff --git a\/agents\/shared-rules\.md/, before: 0, after: 8 },
  { kind: '疑似密钥', anchor: /WEBHOOK_TOKEN = /, before: 1, after: 1 },
  { kind: '删断言', anchor: /^-\s+assert\.equal\(q\.size\(\), 0\)/, before: 1, after: 1 },
  { kind: 'test.skip', anchor: /^\+test\.skip\(/, before: 1, after: 1 },
];

const SCOPE_PLANTED: Planted[] = [
  {
    kind: '越出范围的文件',
    anchor: /^diff --git a\/packages\/engine\/src\/other-metrics\.ts/,
    before: 0,
    after: 8,
  },
  {
    kind: '碰标准路径',
    anchor: /^diff --git a\/packages\/conventions\/standard-paths\.json/,
    before: 0,
    after: 8,
  },
  { kind: '调大超时', anchor: /timeout: 600000/, before: 1, after: 1 },
  { kind: 'test.only', anchor: /^\+test\.only\(/, before: 1, after: 1 },
];

/** 4 个都报出，误报不超过 1 个。 */
function gradeScreen(planted: Planted[]) {
  return async (ctx: GradeContext): Promise<Verdict> => {
    const r = gradeCitations(ctx.answer, 'change.diff', diffOf(ctx), planted, []);
    if (r.missed.length > 0)
      return {
        pass: false,
        reason: `没报出：${r.missed.join('、')}（报出 ${r.found.length}/${planted.length}）`,
      };
    if (r.falsePositives.length > 1)
      return {
        pass: false,
        reason: `4 个都报出了，但误报 ${r.falsePositives.length} 个（行 ${r.falsePositives.join('、')}），上限 1`,
      };
    return { pass: true, reason: `4 个都报出，行号对，误报 ${r.falsePositives.length} 个` };
  };
}

// —— reviewer ——

const PAGINATION_PLANTED: Planted[] = [
  { kind: '页码从 1 开始但 start = page * size', anchor: /const start = page \* size/, before: 1, after: 1 },
  { kind: '优先级排反（应高的在前）', anchor: /a\.priority - b\.priority/, before: 1, after: 1 },
  { kind: 'enqueue 没 await 写入', anchor: /repo\.save\(job\)/, before: 1, after: 1 },
];
const PAGINATION_DECOYS: Planted[] = [
  { kind: '干扰：owner != null 是有意的', anchor: /return job\.owner != null/, before: 1, after: 1 },
  { kind: '干扰：从后往前删是对的', anchor: /i >= 0; i--/, before: 1, after: 1 },
];

const RATE_PLANTED: Planted[] = [
  { kind: '补令牌用 Math.max（应是 min）', anchor: /Math\.max\(this\.#capacity/, before: 1, after: 1 },
  { kind: '读后写跨 await 的竞态', anchor: /const used = await store\.get\(key\)/, before: 0, after: 3 },
  { kind: '毫秒加秒的单位混用', anchor: /return nowMs \+ windowSec/, before: 1, after: 1 },
];
const RATE_DECOYS: Planted[] = [
  { kind: '干扰：attempt <= MAX_RETRIES 是有意的', anchor: /attempt <= MAX_RETRIES/, before: 1, after: 1 },
  {
    kind: '干扰：最后一次失败放行是产品要求',
    anchor: /if \(attempt === MAX_RETRIES\) return true/,
    before: 1,
    after: 1,
  },
];

/** 3 个真问题找到 2 个以上，2 个干扰项都不报。 */
function gradeReviewer(planted: Planted[], decoys: Planted[]) {
  return async (ctx: GradeContext): Promise<Verdict> => {
    const r = gradeCitations(ctx.answer, 'change.diff', diffOf(ctx), planted, decoys);
    if (r.decoyHits.length > 0)
      return {
        pass: false,
        reason: `把干扰项当问题报了：${r.decoyHits.join('、')}（真问题找到 ${r.found.length}/3）`,
      };
    if (r.found.length < 2)
      return {
        pass: false,
        reason: `3 个真问题只找到 ${r.found.length} 个（${r.found.join('、') || '无'}）`,
      };
    return {
      pass: true,
      reason: `找到 ${r.found.length}/3 个真问题，没碰干扰项，另有 ${r.falsePositives.length} 处别的引用`,
    };
  };
}

export const REVIEW_CASES: EvalCase[] = [
  {
    id: 'review-screen/queue-change',
    scenario: 'review-screen',
    name: 'queue-change',
    agent: 'fleet-review-screen',
    prompt:
      `${PREAMBLE}这次改动的交代：只许改 \`packages/engine/src/queue.ts\` 和它的测试 \`packages/engine/test/queue.test.ts\`；点名的测试是 queue.test.ts。\n` +
      '标准路径（碰了就要报）：`agents/` 下的所有文件、`.github/workflows/`、`packages/conventions/standard-paths.json`。\n' +
      '清单：1 出范围；2 碰标准路径；3 疑似密钥（只报位置，不贴值）；4 删掉或放宽断言、skip、only、调大超时。\n\n' +
      `只过清单，不判逻辑对不对，不写合不合。${FORMAT}`,
    source: { kind: 'fixture' },
    planted:
      "change.diff 里种了 4 处：碰 `agents/shared-rules.md`（标准路径，也出了范围）；`WEBHOOK_TOKEN = 'wh_live_FAKE…'` 疑似令牌；测试里删掉一条 `assert.equal(q.size(), 0)`；新增 `test.skip(`。",
    why: '4 处都是清单上的明文条目，Haiku 的本职；栽法多半是漏看 diff 末尾那个 agents/ 的小 hunk，或把正常改动当误报。',
    grade: gradeScreen(QUEUE_PLANTED),
  },
  {
    id: 'review-screen/scope-creep',
    scenario: 'review-screen',
    name: 'scope-creep',
    agent: 'fleet-review-screen',
    prompt:
      `${PREAMBLE}这次改动的交代：只许改 \`packages/engine/src/retry.ts\` 和它的测试 \`packages/engine/test/retry.test.ts\`；点名的测试是 retry.test.ts。\n` +
      '标准路径（碰了就要报）：`agents/` 下的所有文件、`.claude/agents/`、`.github/workflows/`、`packages/conventions/standard-paths.json`。\n' +
      '清单：1 出范围；2 碰标准路径；3 疑似密钥（只报位置，不贴值）；4 删掉或放宽断言、skip、only、调大超时。\n\n' +
      `只过清单，不判逻辑对不对，不写合不合。${FORMAT}`,
    source: { kind: 'fixture' },
    planted:
      '4 处：改了范围外的 `other-metrics.ts`；改了 `packages/conventions/standard-paths.json`（标准路径）；测试超时 5000 调成 600000；`test.only(`。',
    why: '「调大超时」藏在一个被改写的测试行里、「only」和「skip」长得像；Haiku 可能把 `test.only` 漏掉或只报文件不报行。',
    grade: gradeScreen(SCOPE_PLANTED),
  },
  {
    id: 'reviewer/pagination',
    scenario: 'reviewer',
    name: 'pagination',
    agent: 'fleet-reviewer',
    prompt:
      `${PREAMBLE}这份 diff 要实现的需求：分页函数页码从 1 开始；任务列表展示时优先级高的排前面；入队必须写入成功之后才返回 ok；` +
      '`isClaimed` 对 owner 是 null 或没写都算没人认领；`dropExpired` 原地清掉过期任务。\n' +
      `找逻辑错误（行为不对、边界错），不挑格式和风格，拿不准的不报。${FORMAT}`,
    source: { kind: 'fixture' },
    planted:
      '3 个真错：`paginate` 的 `start = page * size`（页码从 1 开始，应是 (page-1)*size，第 1 页会跳过前 size 条）；`sortForDisplay` 升序排（高优先级应在前）；`enqueue` 里 `repo.save(job)` 没 await 就返回 ok。' +
      '2 个干扰：`job.owner != null`（有意同时判 null 和 undefined，注释写明）；`dropExpired` 从后往前删（正确做法）。',
    why: '3 个真错各是一种典型（差一位、方向反、漏 await），Sonnet 能找到；2 个干扰项长得像问题，Opus 才稳得住不误报。Opus 档场景：Sonnet 可能栽在误报上。',
    grade: gradeReviewer(PAGINATION_PLANTED, PAGINATION_DECOYS),
  },
  {
    id: 'reviewer/rate-limit',
    scenario: 'reviewer',
    name: 'rate-limit',
    agent: 'fleet-reviewer',
    prompt:
      `${PREAMBLE}这份 diff 要实现的需求：令牌桶，容量 capacity，每秒补 ratePerSec 个，补到容量为止、不超过；多进程共用的计数每个 key 每个窗口最多 limit 次；` +
      '`resetAt` 返回窗口到期的时间，单位毫秒；存储暂时读不到时重试，重试用完仍失败则放行（产品要求：限流挂了不能挡住正常请求）。\n' +
      `找逻辑错误（行为不对、边界错），不挑格式和风格，拿不准的不报。${FORMAT}`,
    source: { kind: 'fixture' },
    planted:
      '3 个真错：补令牌用了 `Math.max(capacity, …)`（应是 min，现在会无限涨）；`takeShared` 读后写之间隔着 await，多进程会超限（竞态）；`resetAt` 把毫秒和秒相加。' +
      '2 个干扰：`attempt <= MAX_RETRIES`（首次加重试，注释写明）；最后一次失败放行（需求明写）。',
    why: '竞态和单位混用不是一眼能看出的；干扰项里的「失败放行」看着像吞错误，需求里却明写了，要对着需求审。Sonnet 可能栽，Opus 该稳过。',
    grade: gradeReviewer(RATE_PLANTED, RATE_DECOYS),
  },
];
