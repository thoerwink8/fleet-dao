// 要改代码的题：fixer、builder、debugger、standard-editor。夹具是 cases/<场景>/<题>/workspace 下的小 node 包（node:test），
// 判分在临时目录里真跑 `node --test`：先拷进 hidden/ 里藏起来的验收测试，再比文件有没有被改。
// 真题（#1714）在仓快照里做：藏起来的验收拷到快照根上跑，「改之前」是 hidden/base/ 里存的原件（见 grade-util.ts 的 baseFiles）。
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  changedLineCount,
  changesFromBase,
  compareDirs,
  readText,
  runNodeTestFile,
  runNodeTests,
} from '../grade-util.ts';
import type { EvalCase, GradeContext, Verdict } from '../types.ts';

const PREAMBLE =
  '这是能力演练题，不是真任务：不开 PR、不开单、不提交、不推送、不用 git。只在当前目录里干活，做完在最终回答里写一句话说改了什么。\n本目录是一个很小的 node 包，`npm test` 跑全部测试（Node 直接跑 TypeScript，只写可擦除的类型，相对导入带 .ts 后缀）。\n\n';

function workspaceOf(ctx: GradeContext): string {
  return join(ctx.caseDir, 'workspace');
}

/** 隐藏的验收测试拷进 test/ 之后跑全部测试。 */
function runWithHidden(
  ctx: GradeContext,
  hiddenTest: string,
  asName: string,
): { ok: boolean; output: string } {
  cpSync(join(ctx.caseDir, 'hidden', hiddenTest), join(ctx.workDir, 'test', asName));
  return runNodeTests(ctx.workDir);
}

function tail(output: string): string {
  return output.split('\n').slice(-12).join(' | ').slice(-400);
}

/** 夹具里原有的 test/ 文件改了或没了。 */
function touchedOriginalTests(ctx: GradeContext): string[] {
  const d = compareDirs(workspaceOf(ctx), ctx.workDir);
  return [...d.changed, ...d.removed].filter((f) => f.startsWith('test/'));
}

// —— fixer ——

function gradeFixer(srcFile: string) {
  return async (ctx: GradeContext): Promise<Verdict> => {
    const d = compareDirs(workspaceOf(ctx), ctx.workDir);
    const tests = touchedOriginalTests(ctx);
    if (tests.length > 0) return { pass: false, reason: `改了或删了测试文件：${tests.join('、')}` };
    const stray = [...d.changed, ...d.removed, ...d.added].filter((f) => f !== srcFile);
    if (stray.length > 0) return { pass: false, reason: `碰了交代以外的文件：${stray.join('、')}` };
    const r = runWithHidden(ctx, 'extra.test.ts', 'zz-extra.test.ts');
    return r.ok
      ? { pass: true, reason: `点名的测试和藏起来的边界测试全绿，只改了 ${srcFile}` }
      : { pass: false, reason: `测试没转绿：${tail(r.output)}` };
  };
}

// —— builder ——

async function gradeBuilder(ctx: GradeContext): Promise<Verdict> {
  const tests = touchedOriginalTests(ctx);
  if (tests.length > 0) return { pass: false, reason: `改了或删了原有的测试：${tests.join('、')}` };
  const r = runWithHidden(ctx, 'accept.test.ts', 'zz-accept.test.ts');
  return r.ok
    ? { pass: true, reason: '藏起来的验收测试全过，原有测试没动' }
    : { pass: false, reason: `验收测试没过：${tail(r.output)}` };
}

// —— debugger ——

function gradeDebugger(maxChangedLines: number) {
  return async (ctx: GradeContext): Promise<Verdict> => {
    const tests = touchedOriginalTests(ctx);
    if (tests.length > 0) return { pass: false, reason: `改了或删了原有的测试：${tests.join('、')}` };
    const d = compareDirs(workspaceOf(ctx), ctx.workDir);
    const lines = d.changed
      .filter((f) => f.startsWith('src/'))
      .reduce((n, f) => n + changedLineCount(readText(workspaceOf(ctx), f), readText(ctx.workDir, f)), 0);
    const r = runWithHidden(ctx, 'extra.test.ts', 'zz-extra.test.ts');
    if (!r.ok) return { pass: false, reason: `测试没转绿（含藏起来的边界测试）：${tail(r.output)}` };
    if (lines > maxChangedLines) {
      return {
        pass: false,
        reason: `测试绿了，但源码改了 ${lines} 行，超过上限 ${maxChangedLines}（修得不够小）`,
      };
    }
    return { pass: true, reason: `测试全绿，源码改动 ${lines} 行（上限 ${maxChangedLines}）` };
  };
}

// —— standard-editor ——

/** test('…')、it('…')、describe('…') 的标题。 */
function testTitles(source: string): string[] {
  return [...source.matchAll(/\b(?:test|it|describe)(?:\.\w+)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map(
    (m) => m[2] ?? '',
  );
}

/**
 * 标题还在说旧规矩（「最多 3 轮」「超过 3 轮按交接处理」）。说 3 轮已经没了的不算：Sonnet、Opus 新加的
 * 「规矩里不再有 3 轮的旧说法」「旧的 3 轮说法已清干净」被当成残留判错过（#1641）。
 */
function isStaleRoundsTitle(title: string): boolean {
  return (
    title.includes('3 轮') &&
    !/不再|没有|没了|不能|不许|不该|不会|旧|残留|清|去掉|删|改成|改为|→|->|no longer|\bnot\b|\bold\b|stale|legacy|removed/i.test(
      title,
    )
  );
}

/** 改过的测试放回原来的规矩文档上跑：真钉住了 2 轮就该红。 */
function passesOnOriginalRules(ctx: GradeContext): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'agent-eval-revert-'));
  try {
    cpSync(ctx.workDir, dir, { recursive: true });
    cpSync(join(workspaceOf(ctx), 'rules', 'pr-rules.md'), join(dir, 'rules', 'pr-rules.md'));
    return runNodeTests(dir).ok;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 测试那一侧按行为判：在改过的规矩上过、放回原来「3 轮」的规矩上红，标题不再写 3 轮。
// 不数测试里的字面「3 轮」：「旧说法不在了」的反向断言（!includes('…3 轮')、doesNotMatch(/3 轮/)）是更好的钉法，
// 先前数字面把 Sonnet、Opus 这样写的判成「还钉着 3 轮」（#1641）。
async function gradeRuleEdit(ctx: GradeContext): Promise<Verdict> {
  const orig = workspaceOf(ctx);
  const md = readText(ctx.workDir, 'rules/pr-rules.md');
  const test = readText(ctx.workDir, 'test/rules.test.ts');
  const origTest = readText(orig, 'test/rules.test.ts');
  const count = (s: string, sub: string) => s.split(sub).length - 1;
  const origMentions = count(readText(orig, 'rules/pr-rules.md'), '3 轮');
  if (count(md, '3 轮') > 0) return { pass: false, reason: '规矩文档里还有「3 轮」没改' };
  if (count(md, '2 轮') < origMentions)
    return {
      pass: false,
      reason: `规矩文档里「2 轮」只有 ${count(md, '2 轮')} 处，原来有 ${origMentions} 处`,
    };
  if (!md.includes('连续失败不超过 3 次'))
    return { pass: false, reason: '误改了「连续失败不超过 3 次」（那是失败次数，不是 PR 轮数）' };
  const staleTitles = testTitles(test).filter(isStaleRoundsTitle);
  if (staleTitles.length > 0)
    return { pass: false, reason: `测试标题里还写着「3 轮」：${staleTitles.join('、')}` };
  if (!test.includes('2 轮')) return { pass: false, reason: '钉规矩的测试没跟着改成「2 轮」' };
  if (count(test, 'assert.') < count(origTest, 'assert.'))
    return { pass: false, reason: '测试里的断言变少了' };
  if (/\.skip|\.only|todo/.test(test)) return { pass: false, reason: '测试里有 skip、only 或 todo' };
  const r = runNodeTests(ctx.workDir);
  if (!r.ok) {
    const pinned = count(test, '3 轮') > 0 ? '钉规矩的测试里还钉着「3 轮」，' : '';
    return { pass: false, reason: `${pinned}测试没过：${tail(r.output)}` };
  }
  if (passesOnOriginalRules(ctx))
    return { pass: false, reason: '改过的测试放回原来「3 轮」的规矩上也能过：没钉住 2 轮' };
  return { pass: true, reason: '规矩和钉它的测试同时改成 2 轮，失败次数没误改，测试全过、放回旧规矩会红' };
}

// —— 真题（#1714）：仓快照里做 ——

const REPO_PREAMBLE =
  '这是能力演练题，不是真任务：不开 PR、不开单、不提交、不推送、不用 git。当前目录是 fleet-dao 仓在某个历史提交的快照：' +
  '没有 .git，也没装依赖（跑不了 vitest、pnpm）；要验证就自己写个小脚本用 `node` 直接跑（Node 22 直接跑 TypeScript，只认可擦除的类型）。' +
  '只在当前目录里干活，做完在最终回答里写清改了什么。\n\n';

/** 藏起来的验收拷到快照根上，用 node --test 跑；没过时理由写没过的那几条的名字（node --test 的 `not ok N - 名字`）。 */
function runHiddenAtRoot(ctx: GradeContext): { ok: boolean; output: string } {
  cpSync(join(ctx.caseDir, 'hidden', 'accept.test.ts'), join(ctx.workDir, 'zz-accept.test.ts'));
  const r = runNodeTestFile(ctx.workDir, 'zz-accept.test.ts');
  if (r.ok) return r;
  const failed = [...r.output.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { ok: false, output: failed.length > 0 ? `没过的：${failed.join('；')}` : tail(r.output) };
}

/** 快照里的疑难调试：hidden/base 里存的原件只许改 allowed 那一个，改动行数有上限；藏起来的验收要过。 */
function gradeRepoDebugger(allowed: string, maxChangedLines: number) {
  return async (ctx: GradeContext): Promise<Verdict> => {
    const d = changesFromBase(ctx.caseDir, ctx.workDir);
    const stray = [...d.changed.map((c) => c.file), ...d.removed].filter((f) => f !== allowed);
    if (stray.length > 0) return { pass: false, reason: `改了或删了交代以外的文件：${stray.join('、')}` };
    if (d.removed.includes(allowed)) return { pass: false, reason: `把 ${allowed} 删了` };
    const r = runHiddenAtRoot(ctx);
    if (!r.ok) return { pass: false, reason: `藏起来的验收没过：${r.output}` };
    const lines = d.changed.find((c) => c.file === allowed)?.lines ?? 0;
    if (lines > maxChangedLines) {
      return {
        pass: false,
        reason: `验收过了，但 ${allowed} 改了 ${lines} 行，超过上限 ${maxChangedLines}（修得不够小）`,
      };
    }
    return {
      pass: true,
      reason: `藏起来的验收全过，只改了 ${allowed} 的 ${lines} 行（上限 ${maxChangedLines}）`,
    };
  };
}

/** 快照里改标准：藏起来的验收（规矩、钉它的测试、跟着原话走的地方都对上）过，hidden/base 里标着不许动的原件没动。 */
function gradeRepoRuleEdit(untouched: readonly string[]) {
  return async (ctx: GradeContext): Promise<Verdict> => {
    const d = changesFromBase(ctx.caseDir, ctx.workDir);
    const touched = [...d.changed.map((c) => c.file), ...d.removed].filter((f) => untouched.includes(f));
    if (touched.length > 0) return { pass: false, reason: `改了不该动的：${touched.join('、')}` };
    const r = runHiddenAtRoot(ctx);
    return r.ok
      ? { pass: true, reason: '规矩、钉它的测试和跟着原话走的地方同一次改齐，藏起来的验收全过' }
      : { pass: false, reason: `藏起来的验收没过：${r.output}` };
  };
}

/** 一处要改齐的地方：文件、它该满足的条件（读不到文件就是漏了这一处）。 */
interface MustEdit {
  what: string;
  file: string;
  ok: (text: string) => boolean;
}

/** UserPromptSubmit 那一条登记（targets.ts 里花括号里的那一项）。 */
function promptLogSpec(targets: string): string | undefined {
  return [...targets.matchAll(/\{[^{}]*'UserPromptSubmit'[^{}]*\}/g)].map((m) => m[0])[0];
}

/** #823 的 CI 一共红了三回才补齐的几处（第一处是 PR 本来就要做的登记）。 */
export const PROMPT_LOG_EDITS: readonly MustEdit[] = [
  {
    what: 'targets.ts 登记 UserPromptSubmit → prompt-log.mjs（不写 matcher，timeout 30000）',
    file: 'packages/agents-sync/src/targets.ts',
    ok: (t) => {
      const spec = promptLogSpec(t);
      return (
        spec !== undefined &&
        /prompt-log\.mjs/.test(spec) &&
        !/matcher/.test(spec) &&
        /timeout:\s*30000/.test(spec)
      );
    },
  },
  {
    what: '同步工具测试的假仓带上 prompt-log.mjs（helpers.ts 的 HOOK_FILES）',
    file: 'packages/agents-sync/test/helpers.ts',
    ok: (t) => /'prompt-log\.mjs'\s*:/.test(t),
  },
  {
    what: 'cli.test.ts 断言的钩子事件跟上三条',
    file: 'packages/agents-sync/test/cli.test.ts',
    ok: (t) => !t.includes("toEqual(['PreToolUse', 'Stop'])") && t.includes('UserPromptSubmit'),
  },
  {
    what: 'hooks.test.ts 断言的钩子事件跟上三条',
    file: 'packages/agents-sync/test/hooks.test.ts',
    ok: (t) => !t.includes("toEqual(['PreToolUse', 'Stop'])") && t.includes('UserPromptSubmit'),
  },
  {
    what: '装机自测脚本 deploy/test/agents-sync.test.sh 的假仓带上 prompt-log.mjs、断言认三个事件',
    file: 'deploy/test/agents-sync.test.sh',
    ok: (t) => /agents\/hooks\/prompt-log\.mjs/.test(t) && /PreToolUse,Stop,UserPromptSubmit/.test(t),
  },
  {
    what: 'CI 判法登记 agents 的规矩测试读 agents-sync 的 targets.ts（ci-plan.ts 的 TEST_READS）',
    file: 'packages/conventions/src/ci-plan.ts',
    ok: (t) => /\[AGENTS_UNIT\]:\s*\[[^\]]*'agents-sync'[^\]]*\]/.test(t),
  },
  {
    what: 'ci-cache.test.ts 里 agents 的源码闭包跟上 agents-sync',
    file: 'packages/conventions/test/ci-cache.test.ts',
    ok: (t) => /sourceClosure\(GRAPH, \['agents'\]\)\)\.toEqual\(\[[^\]]*'agents-sync'/.test(t),
  },
];

async function gradePromptLog(ctx: GradeContext): Promise<Verdict> {
  const missed: string[] = [];
  for (const e of PROMPT_LOG_EDITS) {
    const p = join(ctx.workDir, e.file);
    if (!existsSync(p) || !e.ok(readText(ctx.workDir, e.file))) missed.push(e.what);
  }
  const d = changesFromBase(ctx.caseDir, ctx.workDir);
  const touched = [...d.changed.map((c) => c.file), ...d.removed];
  if (touched.length > 0) {
    return { pass: false, reason: `改了已经写好的钩子或规矩测试：${touched.join('、')}` };
  }
  return missed.length === 0
    ? { pass: true, reason: `${PROMPT_LOG_EDITS.length} 处都改齐了，钩子和规矩测试没动` }
    : {
        pass: false,
        reason: `漏了 ${missed.length}/${PROMPT_LOG_EDITS.length} 处（推上去 CI 会红）：${missed.join('；')}`,
      };
}

export const REAL_CODE_TASK_CASES: EvalCase[] = [
  {
    id: 'debugger/e2e-output-omitted',
    scenario: 'debugger',
    name: 'e2e-output-omitted',
    agent: 'fleet-debugger',
    prompt:
      `${REPO_PREAMBLE}任务：#1200（PR 的 e2e 只点改动页：ci-plan 的 e2e 从开关变成 spec 清单，空清单跳过）刚合进主线，` +
      '接着 #1204 这个 PR 的 CI 汇总 job `check` 就红了，日志里只有这一条 ✗：\n' +
      '```\n✓ changes：success\n✓ lint：success\n✗ changes 给 e2e job 的开关（outputs.e2e）和 plan 里的 e2e 不是同一份\n' +
      '✓ test：success\n✓ web：skipped\n✓ e2e：skipped\n✓ deploy：skipped\n```\n' +
      '#1204 没碰驾驶舱页面，plan 里 e2e 是空清单，e2e job 也照计划跳过了；#1200 自己的 CI 是绿的。没碰页面的 PR 都会这样红。\n' +
      '找到根因，修在必经的那一步：只改 `packages/conventions/src/ci-plan.ts`，不改 `.github/workflows/ci.yml`；' +
      '不许删掉或放宽这条「开关和 plan 是同一份」的核对——plan 要跑 e2e 而开关没给，照样要判红。改动尽量小。最终回答里写清根因。',
    source: { kind: 'repo', commit: 'b19d4dbb657bdb01da69fae3e670e162a99f8f49' },
    planted:
      'GitHub 不把值为空串的 job 输出放进 needs.<job>.outputs：空清单时 e2eOutput 是空串，汇总 job 读到的 outputs.e2e 整个没有（undefined），' +
      "`!==` 和空串一比就判红。#1207 的修法：`(n.changes?.outputs?.e2e ?? '') !== e2eOutput(plan.e2e)`，一行。" +
      '藏起来的 accept.test.ts 照 GitHub 的样子造 needs：空清单不给这一项要过；plan 要跑（all 或有清单）而这一项缺了要红；对不上要红。',
    why:
      '真事：#1200 的作者（引擎会话）写了严格的 `!==`，它自己的 PR 改了页面、清单不空，CI 是绿的，合进去后第一个没碰页面的 PR（#1204）就被挡住，' +
      '指挥官（Opus 5.5）在 #1207 修。症状在 ci-plan.ts，根因在 GitHub 怎么交 job 输出，只读代码找不到；' +
      '顺着症状删掉核对、或让空清单输出个占位值（ci.yml 的 e2e job 靠空串跳过，会跟着坏）都过不了验收。',
    grade: gradeRepoDebugger('packages/conventions/src/ci-plan.ts', 6),
  },
  {
    id: 'debugger/pr-fields-heading',
    scenario: 'debugger',
    name: 'pr-fields-heading',
    agent: 'fleet-debugger',
    prompt:
      `${REPO_PREAMBLE}任务：PR 必填栏检查（\`packages/conventions/src/pr-fields.ts\`，CI 的 pr-fields）已经第二回把填得好好的 PR 判红了（#60、#65）。` +
      '两回的正文都是把几栏写在最前面、后面分小标题写说明，缩写成这样（`specs/12-登录验证码/` 在 PR 里是有的）：\n' +
      '```\n对应计划：P1「工作流」\nspecs：specs/12-登录验证码/\n\n## 改了什么\n- `specs/99-别的/需求.md`：顺带提一句\n```\n' +
      '检查报：`「specs」写的 specs/99-别的/需求.md：顺带提一句 在这个 PR 里没有：先把需求.md 放进去，或者改成已有的目录。`\n' +
      '另一回 specs 栏写的是 `**specs**：`specs/12-登录验证码/需求.md`：照 #12 抄。`，报的是 `「specs」写的 specs/12-登录验证码/需求.md：照 在这个 PR 里没有…`。\n' +
      '找到根因，修在必经的那一步：只改 `packages/conventions/src/pr-fields.ts`；写错的 specs 目录照样要报出来，不许放宽存在性检查。' +
      '改动尽量小。最终回答里写清根因。',
    source: { kind: 'repo', commit: '349517af37c998e70d698bd1540b6eb925d9fc15' },
    planted:
      '两个根因叠在一起：①prColumns 认栏「到下一栏为止」，正文里的小标题（## …）不截断上一栏，后面各节里提到的 specs 路径被收进 specs 栏去查；' +
      '②checkSpecs 取路径的正则不排除全角冒号「：」，`需求.md`：照 被当成路径的一部分。#66 两处一起修：加小标题截断、正则排除「：:。」。' +
      '藏起来的 accept.test.ts 核对两种写法都过、小标题之后的栏照样认得出、写错的目录照样报。',
    why:
      '真事：这条检查两回（#60、#65）把对的 PR 判红，指挥官（Opus 5.5）在 #66 才两处一起修掉。两个报错长得像同一个毛病，' +
      '只修看得见的那一处（只改正则、或只截断小标题）另一种写法照样红；要读懂「一栏到哪为止」才找得到第一个根因。',
    grade: gradeRepoDebugger('packages/conventions/src/pr-fields.ts', 14),
  },
  {
    id: 'standard-editor/fable-ban-permanent',
    scenario: 'standard-editor',
    name: 'fable-ban-permanent',
    agent: 'fleet-standard-editor',
    prompt:
      `${REPO_PREAMBLE}（改标准演练：这里不走 PR，也不用管人闸。）创始人 2026-10-03 拍「目前阶段我不希望用 fable」，并同意「把撤回理由改成永久的」。` +
      '现在的 Fable 禁令带着撤回条件「出比 5.1 更高的版本之前」，这个条件按字面已经触发了（仓里已经拿 Fable 5.2 当测试用例）；不碰 Fable 是模型族的约束，和出到几版无关。\n' +
      '任务：把 Fable 禁令改成永久的、不再挂版本号——禁令本身（`packages/shared/src/bans.ts` 的 no-fable）、通用段里那句、钉住禁令文案的测试，同一次改齐；' +
      '照仓里的规矩，改规矩时把冲突的旧说法一起改掉。GPT 那条不动；测试不能删断言、不能 skip。推上去 CI 要一次绿。',
    source: { kind: 'repo', commit: '294c0338ba30ef326500cc5628e8c5e83dc0960f' },
    planted:
      '要改 4 处：bans.ts 的 reason、AGENTS.md 通用段那句、packages/db/test/candidates.test.ts 钉文案的两行，' +
      '还有 packages/web/src/build/demo-renames.ts——它拿禁令理由的原话当正则下标，换成演示版的样例说法，demo-renames.test.ts 核对每条理由都换掉了。' +
      '扫描名单 scan.ts 不许动（删掉禁用词能让演示版扫描「过」）。藏起来的 accept.test.ts 照 demo-renames.test.ts 的判法核对。',
    why:
      '真事：#669 的作者（Opus 5.5）改了 bans.ts、AGENTS.md 和 candidates.test.ts，漏了 demo-renames.ts，CI 的 web 和 test rest 两条红了才补。' +
      'demo-renames.ts 不在任何人说的范围里，只有照「冲突的旧说法一起改」去全仓找原话，才找得到它。',
    grade: gradeRepoRuleEdit(['packages/web/src/build/scan.ts']),
  },
  {
    id: 'standard-editor/prompt-log-hook',
    scenario: 'standard-editor',
    name: 'prompt-log-hook',
    agent: 'fleet-standard-editor',
    prompt:
      `${REPO_PREAMBLE}（改标准演练：这里不走 PR，也不用管人闸。）#823：创始人 2026-10-04 问「丢失我的回复，查到原因和解决了没有」。` +
      '定下加一个 UserPromptSubmit 钩子，创始人每条消息一到就由钩子原样落盘。钩子脚本 `agents/hooks/prompt-log.mjs` 和钉它的规矩测试 ' +
      '`agents/test/rules/prompt-log.rules.test.ts` 已经写好，就在快照里，不用改。\n' +
      '任务：把这个钩子登记进同步工具（`packages/agents-sync/src/targets.ts`），让 agents:sync 把它装到各台机器；' +
      '跟着钩子清单走的地方同一次改齐。推上去 CI 要一次绿：CI 跑各包的 vitest、`deploy/test/` 下的脚本测试，还有 conventions 包里核对 CI 判法的测试。',
    source: { kind: 'repo', commit: '9d3702c4af4a59f0fe1629a94cc892caf40e8b76' },
    planted:
      `要改 ${PROMPT_LOG_EDITS.length} 处（见 code-tasks.ts 的 PROMPT_LOG_EDITS）：targets.ts 的登记；同步工具测试的假仓（helpers.ts）和两处钩子事件断言；` +
      '装机自测脚本 deploy/test/agents-sync.test.sh 的假仓和断言；CI 判法里 agents 读 agents-sync 的登记（ci-plan.ts 的 TEST_READS）和跟着它的 ci-cache.test.ts。' +
      '已经写好的 prompt-log.mjs、prompt-log.rules.test.ts 不许动。',
    why:
      '真事：#823 的作者（Sonnet 5.5）第一版只改了 targets.ts，CI 红了三回才补齐：同步工具测试的夹具没有这个脚本、断言只认两个事件；' +
      '装机自测脚本的假仓同样；新规矩测试读了 agents-sync 的 targets.ts，CI 判法要登记包外读取（TEST_READS），ci-cache 的期望跟着变。' +
      '后两处要先弄懂 CI 怎么按改动挑测试才想得到。',
    grade: gradePromptLog,
  },
];

export const CODE_TASK_CASES: EvalCase[] = [
  {
    id: 'fixer/format-bytes',
    scenario: 'fixer',
    name: 'format-bytes',
    agent: 'fleet-fixer',
    prompt:
      `${PREAMBLE}任务：\`test/bytes.test.ts\` 里有一条测试是红的。只许改 \`src/bytes.ts\`，不改测试、不碰别的文件。` +
      '改到 `npm test` 全绿为止。',
    source: { kind: 'fixture' },
    planted:
      '`formatBytes` 在 1048575 字节这类「四舍五入后正好进到 1024」的边界上返回 `1024.0 KB`，应换成 `1.0 MB`（GB 同理）。' +
      '藏起来的 extra.test.ts 还核对 GB 边界和不该进位的 1023.9 KB。',
    why:
      '症状一眼就看到（一条红测试），但修法要想清「先四舍五入再判是否进位」，只改比较阈值会让 1023.95 KB 之类误进位；' +
      'Sonnet 稳过，Haiku 可能只补一个特例或进位判断写错。',
    grade: gradeFixer('src/bytes.ts'),
  },
  {
    id: 'fixer/slugify',
    scenario: 'fixer',
    name: 'slugify',
    agent: 'fleet-fixer',
    prompt:
      `${PREAMBLE}任务：\`test/slug.test.ts\` 里有几条测试是红的。只许改 \`src/slug.ts\`，不改测试、不碰别的文件。` +
      '改到 `npm test` 全绿为止。',
    source: { kind: 'fixture' },
    planted:
      '`slugify` 三处错：连续非字母数字没合成一个 `-`、头尾只去掉一个 `-`、没去重音（Café → cafe 要先 NFKD 再去组合符号）。',
    why: '三处缺陷叠在一个函数里，红测试只暴露部分；重音那条要知道 NFKD；漏一处藏起来的 extra.test.ts 就红。',
    grade: gradeFixer('src/slug.ts'),
  },
  {
    id: 'builder/parse-duration',
    scenario: 'builder',
    name: 'parse-duration',
    agent: 'fleet-builder',
    prompt:
      `${PREAMBLE}任务：在 \`src/duration.ts\` 里加 \`parseDuration(text: string): number\`，和已有的 \`formatDuration\` 反过来：\n` +
      '- 单位：`d`、`h`、`m`、`s`、`ms`，写法是整数加单位，可以多个连着写，如 `1h30m`、`90s`、`500ms`；顺序随意；单位之间可以有空白，首尾空白忽略。\n' +
      '- 返回毫秒（整数）。`ms` 是毫秒，不是 `m` 加 `s`。\n' +
      '- 空串、全是空白、没有单位、认不出的单位、负数、小数、同一个单位出现两次，都抛 `RangeError`，消息是 `bad duration: <原文>`。\n' +
      '- `parseDuration(formatDuration(n)) === n` 对所有非负整数成立。\n' +
      '先在 `test/` 下自己写好测试（新文件），再实现；`npm test` 全绿。不改已有的测试文件。',
    source: { kind: 'fixture' },
    planted:
      '规格里藏了几处易错点：`ms` 与 `m`+`s` 的歧义、同单位重复、小数和负数、单位间空白、与 formatDuration 互逆。' +
      '藏起来的 accept.test.ts 逐条核对。',
    why:
      '规格全写在题面里，Sonnet 按条实现稳过；Haiku 容易把 `ms` 吃成 `m`、漏掉重复单位或小数的拒绝。' +
      '这道是 Sonnet 档场景，Opus 不该比 Sonnet 更好。',
    grade: gradeBuilder,
  },
  {
    id: 'builder/ttl-cache',
    scenario: 'builder',
    name: 'ttl-cache',
    agent: 'fleet-builder',
    prompt:
      `${PREAMBLE}任务：新建 \`src/ttl-cache.ts\`，导出 \`class TtlCache<K, V>\`（不要用参数属性这类不可擦除的写法）：\n` +
      '- `new TtlCache({ max, ttlMs, now? })`：`now` 是返回毫秒的函数，默认 `Date.now`，测试里用它注入假时钟。`max`、`ttlMs` 不是正整数抛 `RangeError`。\n' +
      '- `set(key, value)`：写入并记下过期时刻 = 当前 + ttlMs；已有的 key 被覆盖，并重新计时。超过 `max` 条时淘汰最久没被用过的那条。\n' +
      '- `get(key)`：没有或已过期返回 `undefined`；命中算「用过」（变成最近用过的），但不续期。\n' +
      '- 「已过期」指当前时刻 ≥ 过期时刻。过期的条目不算在 `size` 里，也不该挤掉没过期的条目。\n' +
      '- `has(key)`、`delete(key)`（返回有没有删到）、只读属性 `size`。\n' +
      '先在 `test/` 下自己写好测试（新文件），再实现；`npm test` 全绿。不改已有的测试文件。',
    source: { kind: 'fixture' },
    planted:
      'LRU 加 TTL 的交界：get 刷新最近用过但不续期、覆盖 set 续期、过期点是「≥」、过期条目不占位置也不算 size。藏起来的 accept.test.ts 逐条核对。',
    why: '多条规则互相咬合，Sonnet 一般能全对；Haiku 常漏「过期条目不占位置」或「get 不续期」。',
    grade: gradeBuilder,
  },
  {
    id: 'debugger/week-start-tz',
    scenario: 'debugger',
    name: 'week-start-tz',
    agent: 'fleet-debugger',
    prompt:
      `${PREAMBLE}任务：\`test/week.test.ts\` 里「东京」那条红了，别的绿。找到根因，修在必经的那一步。\n` +
      '前两次有人试过：给东京的用例特判一下时区（会让洛杉矶之类别的时区继续错），没成。不要再打补丁式地修。\n' +
      '修完 `npm test` 全绿；改动尽量小；不改已有的测试文件。最终回答里写清根因。',
    source: { kind: 'fixture' },
    planted:
      '`weekdayOf` 用 `at.getUTCDay()`：日期按目标时区算，周几却按 UTC 算，两个坐标系混用。注释「周几和时区无关」是错的。正确做法是从时区里的日历日期算周几。',
    why:
      '症状只在时区日期和 UTC 日期不是同一天时出现，东京一条红测试容易引向「特判东京」；' +
      '根因要看出两套坐标混用。藏起来的洛杉矶、檀香山、跨年用例专门拦打补丁的修法。Sonnet 可能栽，Opus 该稳过。',
    grade: gradeDebugger(14),
  },
  {
    id: 'debugger/merge-config',
    scenario: 'debugger',
    name: 'merge-config',
    agent: 'fleet-debugger',
    prompt:
      `${PREAMBLE}任务：\`test/load.test.ts\` 里「上一次的覆盖不会留到下一次」红了。找到根因，修在必经的那一步。\n` +
      '前两次有人试过：每次 `loadConfig` 前把 `DEFAULTS` 重置一份（症状消了，但 `mergeConfig` 本身还在改它收到的对象，别处一调用又会中招），没成。不要再给同一个方案打补丁。\n' +
      '修完 `npm test` 全绿；改动尽量小；不改已有的测试文件。最终回答里写清根因。',
    source: { kind: 'fixture' },
    planted:
      '`mergeConfig` 对嵌套对象用 `Object.assign(current, …)`，`current` 就是 base 里的那个嵌套对象：合并时改了 base（即 DEFAULTS），且结果和 base 共用嵌套对象。' +
      '正确修法是递归返回新对象。',
    why:
      '症状在 `loadConfig`，根因在另一个文件的 `mergeConfig`；顺着症状改 `loadConfig`（克隆 DEFAULTS）能让可见测试转绿，' +
      '但藏起来的 extra.test.ts 直接测 `mergeConfig` 不改 base、不共用嵌套对象，打补丁的修法会红。Sonnet 可能栽，Opus 该稳过。',
    grade: gradeDebugger(10),
  },
  {
    id: 'standard-editor/pr-rounds',
    scenario: 'standard-editor',
    name: 'pr-rounds',
    agent: 'fleet-standard-editor',
    prompt:
      `${PREAMBLE}（这里没有 agents/ 和 decisions，规矩文档是 \`rules/pr-rules.md\`，钉它的测试是 \`test/rules.test.ts\`。）\n` +
      '任务：把「一个 PR 最多 3 轮」改成「最多 2 轮」。规矩文档里所有讲 PR 轮数的地方、和钉它的测试要在同一次里改齐，' +
      '新旧说法打架的地方一起改掉；不相干的数字不要动；测试不能删断言、不能 skip。改完 `npm test` 全绿。',
    source: { kind: 'fixture' },
    planted:
      '「3 轮」在文档里出现两处（一处在「谁负责」，一处在「交接」），测试里钉了两处；另有一处「连续失败不超过 3 次」是失败次数，不能改。',
    why: '要查全（两处文档加两处测试），还要认出 3 次不是 3 轮；Sonnet 常漏掉「交接」里那处，Opus 档该稳过。',
    grade: gradeRuleEdit,
  },
];
