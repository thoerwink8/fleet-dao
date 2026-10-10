// 评审类的题：review-screen（清单初筛）、reviewer（找逻辑错）。夹具是一份 change.diff，回答按 `change.diff:行 — 问题` 报，
// 判分按行号窗口比：窗口是从 diff 里用正则现找的，不写死行号。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gradeCitations, type Planted, refsOf } from '../grade-util.ts';
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

// —— reviewer 真题（#1714）：仓快照是那次 PR 合进去的那一刻，change.diff 是那次 PR 的改动；标准答案是后来返工 PR 改掉的地方 ——
// 按快照里的文件行号报、按 change.diff 的行号报都认。行号窗口写死（快照和 diff 都是固定的），test/cases.test.ts 核对窗口里真是那几行。

/** 一处的行号窗口：文件从仓根算（change.diff 就写 change.diff），from、to 都含。 */
export interface Spot {
  file: string;
  from: number;
  to: number;
}

/** 后来返工 PR 改掉的一处问题。required：当时真栽在这里、必须找到的；不是 required 的找到也不算误报。 */
export interface RealIssue {
  kind: string;
  required: boolean;
  spots: readonly Spot[];
}

const sameFile = (cited: string, spot: string) =>
  cited === spot || spot.endsWith(`/${cited}`) || cited.endsWith(`/${spot}`);

/**
 * 回答里每一行带 `文件:行` 的算报了一处问题：落进某个问题的窗口就算找到了它，一个窗口都不落的算误报。
 * 必须找到的都找到、误报不超过 maxFalse 才过。
 */
export function gradeRealReview(issues: readonly RealIssue[], maxFalse: number) {
  return async (ctx: GradeContext): Promise<Verdict> => {
    const lines = ctx.answer
      .split('\n')
      .map((text) => refsOf(text))
      .filter((refs) => refs.length > 0);
    const hit = (refs: ReturnType<typeof refsOf>, issue: RealIssue) =>
      refs.some((r) =>
        issue.spots.some((s) => sameFile(r.file, s.file) && r.line >= s.from && r.line <= s.to),
      );
    const found = issues.filter((i) => lines.some((refs) => hit(refs, i)));
    const falses = lines.filter((refs) => !issues.some((i) => hit(refs, i)));
    const missed = issues.filter((i) => i.required && !found.includes(i)).map((i) => i.kind);
    const extra = found.filter((i) => !i.required).map((i) => i.kind);
    const tally = `必须找到的 ${issues.filter((i) => i.required && found.includes(i)).length}/${issues.filter((i) => i.required).length}${extra.length > 0 ? `，另找到 ${extra.join('、')}` : ''}，误报 ${falses.length} 条`;
    if (missed.length > 0) return { pass: false, reason: `没找到：${missed.join('、')}（${tally}）` };
    if (falses.length > maxFalse) {
      const sample = falses
        .slice(0, 3)
        .map((refs) => `${refs[0]?.file}:${refs[0]?.line}`)
        .join('、');
      return { pass: false, reason: `误报 ${falses.length} 条，上限 ${maxFalse}（如 ${sample}；${tally}）` };
    }
    return { pass: true, reason: tally };
  };
}

const REAL_PREAMBLE =
  '这是能力演练题，不是真任务：不开 PR、不评论、不改任何文件。当前目录是 fleet-dao 仓在某个 PR 合进去那一刻的快照（没有 .git），' +
  '那个 PR 的改动另存在当前目录的 `change.diff`。\n\n';

const REAL_FORMAT =
  '回答格式：每个问题一行，`<文件>:<行号> — <一句话>`。文件写从仓根算起的路径、行号是快照里这个文件的行号；也可以写 `change.diff:<行号>`（change.diff 自己的行号，从 1 数）。' +
  '一个问题只写一行，只报你认为有问题的，没问题的不要列。\n';

const VI = 'packages/engine/src/verifier-invoke.ts';
const TV = 'packages/engine/src/real/task-verify.ts';

/** #1690 合进去那一刻（Opus 5.5 写的冷验收两家都验）。 */
const TWO_FAMILY_COMMIT = '2297849a75860e7f84f9e2a232a9a5c7b5a0b683';
export const TWO_FAMILY_ISSUES: readonly RealIssue[] = [
  {
    kind: '两家都验挑到一家就起会话：凑不齐第二家时这一家白跑，重来又整个再跑',
    required: true,
    spots: [
      { file: VI, from: 779, to: 785 },
      { file: VI, from: 800, to: 809 },
      { file: 'change.diff', from: 396, to: 402 },
      { file: 'change.diff', from: 417, to: 426 },
    ],
  },
  {
    kind: '别家在等（等额度、等空位）被当成派不出，改成两家都验、混进作者族互验',
    required: true,
    spots: [
      { file: VI, from: 213, to: 228 },
      { file: VI, from: 601, to: 604 },
      { file: VI, from: 769, to: 778 },
      { file: TV, from: 421, to: 423 },
      { file: TV, from: 480, to: 487 },
      { file: 'change.diff', from: 228, to: 230 },
      { file: 'change.diff', from: 386, to: 395 },
    ],
  },
  {
    kind: '切号登记在挑模型的那一下，两家先挑后跑时登记的是错的那一家',
    required: false,
    spots: [{ file: TV, from: 424, to: 436 }],
  },
];

/** #1663 合进去那一刻（Sonnet 5.5 写的 agent-eval 判分）。 */
const GRADING_COMMIT = 'fd65e2ba38c9a1786e063e13714bdb964f2fcc1e';
const GU = 'packages/agent-eval/src/grade-util.ts';
const CT = 'packages/agent-eval/src/cases/code-tasks.ts';
export const GRADING_ISSUES: readonly RealIssue[] = [
  {
    kind: '比文件、数改动行不管换行符：Windows 上整份写回成 CRLF 就算每行都改了',
    required: true,
    spots: [
      { file: GU, from: 63, to: 65 },
      { file: GU, from: 74, to: 81 },
      { file: 'change.diff', from: 309, to: 311 },
      { file: 'change.diff', from: 320, to: 327 },
    ],
  },
  {
    kind: '测试里数字面「3 轮」：「旧说法不在了」的反向断言被判成还钉着 3 轮',
    required: true,
    spots: [
      { file: CT, from: 101, to: 101 },
      { file: 'change.diff', from: 107, to: 107 },
    ],
  },
  {
    kind: '测试没按行为核：放回旧规矩也能过的测试（没钉住 2 轮）照样判过',
    required: false,
    spots: [
      { file: CT, from: 102, to: 109 },
      { file: 'change.diff', from: 108, to: 115 },
    ],
  },
  {
    kind: '临时目录没转成真路径：Windows 的 8.3 短名让会话拒绝改文件',
    required: false,
    spots: [
      { file: 'packages/agent-eval/src/workspace.ts', from: 18, to: 20 },
      { file: 'change.diff', from: 438, to: 440 },
    ],
  },
];

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
  {
    id: 'reviewer/two-family-verify',
    scenario: 'reviewer',
    name: 'two-family-verify',
    agent: 'fleet-reviewer',
    prompt:
      `${REAL_PREAMBLE}这个 PR 是 #1690，要落实决定 0076 第 4 条（\`docs/decisions/0076-route-strictly-by-order.md\`，#1681）：冷验收挑不出别家时自己兜——` +
      '作者族认不出（如 Cursor Auto），或别家一家都派不出，就从两个不同的族各挑一个模型各验一遍，两家都过才算过；连两个不同的族都凑不齐，才停下等人。' +
      '冷验收的要义是换一家来验，写代码的族不能自己验自己。\n' +
      `主要改在 \`${VI}\`（requireTwoFamilies、第 4、5 步）；调它的是 \`${TV}\` 的 createColdVerify（chooseModelForFamily、waitReason 决定过一会儿重来）。\n` +
      `找逻辑错误（行为不对、会白跑、会绕过规矩），不挑格式和风格，拿不准的不报。${REAL_FORMAT}`,
    source: { kind: 'repo', commit: TWO_FAMILY_COMMIT },
    planted:
      '标准答案是 #1697 返工改掉的两处（必须找到）：①第 5 步挑到一家就起会话（verifier-invoke.ts:779 一带），凑不齐第二家时回「没讨论成」，' +
      'waitReason 让它过一会儿重来，这一家白跑、重来又整个再跑；②选路说某族「在等」时 chooseModelForFamily 和「派不出」一样回 undefined（task-verify.ts:423），' +
      '第 4 步挑不出就落到第 5 步（verifier-invoke.ts:778），把作者族拉进来两家都验，等于作者族互验。' +
      '另一处找到也算对：切号登记放在挑模型的那一下（task-verify.ts:424–436），两家先挑后跑时登记的是错的那一家。误报不超过 2 条。',
    why:
      '当时 Opus 5.5 写了这个 PR、CI 全绿、合了，合进去以后才发现这两处（#1697 返工）：两处都要把选路的「等」、waitReason 的重来、第 5 步的循环串起来看，' +
      '光看 diff 本身看不出来，Sonnet、Haiku 多半只挑得出 diff 里的局部写法。',
    grade: gradeRealReview(TWO_FAMILY_ISSUES, 2),
  },
  {
    id: 'reviewer/agent-eval-grading',
    scenario: 'reviewer',
    name: 'agent-eval-grading',
    agent: 'fleet-reviewer',
    prompt:
      `${REAL_PREAMBLE}这个 PR 是 #1663，新加子代理能力探查工具 \`packages/agent-eval\`：起无头会话做题，再用代码判过没过；判错了，分档的数据就是错的。` +
      '题面、夹具和藏起来的验收在 `packages/agent-eval/cases/` 下。被测会话在 Windows 本机和 Linux 上都会跑，改文件的手段五花八门（Edit 工具、Python、PowerShell、sed）。\n' +
      `审 \`${GU}\`、\`${CT}\`、\`packages/agent-eval/src/workspace.ts\` 里的判分：找会把对的产出判成没过、或把错的产出判成过的地方。` +
      `不挑格式和风格，拿不准的不报。${REAL_FORMAT}`,
    source: { kind: 'repo', commit: GRADING_COMMIT },
    planted:
      '标准答案是 #1698 返工改掉的两处（必须找到）：①compareDirs、changedLineCount 不管换行符（grade-util.ts:64、77），' +
      'Windows 上用 Python 文本模式写回整份成 CRLF，Sonnet 只改 6 行被数成 49 行判「修得不够小」；②standard-editor 题数测试里字面「3 轮」（code-tasks.ts:101），' +
      '「旧说法不在了」的反向断言被判成还钉着 3 轮。另两处找到也算对：测试不按行为核（放回旧规矩也过照样判过，#1698）；临时目录没转真路径（Windows 8.3 短名，#1687）。误报不超过 2 条。',
    why:
      '当时 Sonnet 5.5 写了这个 PR、单测全绿、合了；三档真跑之后才发现判错了 Sonnet 和 Opus 的对答案（#1698、#1687 返工）。' +
      '要想到「会话在 Windows 上会把换行符整份换掉」「更好的测试会写反向断言」这类真实产出才看得出，光核代码自洽看不出。',
    grade: gradeRealReview(GRADING_ISSUES, 2),
  },
];
