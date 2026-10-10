// 读和判的题：scout、log-digest、triage、ci-triager、groomer、researcher。回答是文字，判分全用代码（读回答、读夹具、调 check-brief.mjs）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { refsOf, runCheckBrief } from '../grade-util.ts';
import type { EvalCase, GradeContext, Verdict } from '../types.ts';
import { UngradableError } from '../types.ts';

const PREAMBLE =
  '这是能力演练题，不是真任务：不开 PR、不开单、不改任何文件。答案写在最终回答里，按题里要求的格式。\n\n';

/** scout 两道题固定的快照提交（origin/main，2026-10-09）。 */
export const SCOUT_COMMIT = '1c125c51faee829dfdda48f881c8ec89ff115c97';

// —— scout ——

function gradeFileLine(file: string, line: number, tolerance: number) {
  return async (ctx: GradeContext): Promise<Verdict> => {
    const refs = refsOf(ctx.answer).filter((r) => r.file === file || r.file.endsWith(`/${file}`));
    const hit = refs.find((r) => Math.abs(r.line - line) <= tolerance);
    if (hit)
      return {
        pass: true,
        reason: `回了 ${hit.file}:${hit.line}，标准答案 ${file}:${line}（容差 ${tolerance} 行）`,
      };
    const said = refsOf(ctx.answer)
      .map((r) => `${r.file}:${r.line}`)
      .join('、');
    return {
      pass: false,
      reason: `没有对得上的 文件:行。标准答案 ${file}:${line}；回答里的引用：${said || '（没有）'}`,
    };
  };
}

// —— log-digest ——

interface Failure {
  name: string;
  assertion: string;
}

function gradeLogDigest(failures: readonly Failure[], retried: readonly string[]) {
  return async (ctx: GradeContext): Promise<Verdict> => {
    const log = readFileSync(join(ctx.caseDir, 'workspace', 'ci-output.txt'), 'utf8');
    for (const f of failures) {
      if (!log.includes(f.name) || !log.includes(f.assertion)) {
        throw new UngradableError(`标准答案不在夹具日志里：${f.name} / ${f.assertion}`);
      }
    }
    const missing = failures.filter((f) => !ctx.answer.includes(f.name) || !ctx.answer.includes(f.assertion));
    if (missing.length > 0) {
      return {
        pass: false,
        reason: `漏了 ${missing.length} 条失败的用例名或断言行：${missing.map((f) => f.name).join('、')}`,
      };
    }
    // 编造：回答里每一行以 AssertionError 起头的内容必须在原文里找得到。
    const invented = ctx.answer
      .split('\n')
      .map((l) =>
        /AssertionError.*$/
          .exec(l)?.[0]
          ?.replace(/[`'"]+$/, '')
          .trim(),
      )
      .filter((s): s is string => Boolean(s) && !log.includes(s as string));
    if (invented.length > 0) return { pass: false, reason: `证据行不在原文里：${invented[0]}` };
    // 重试后过了的不算失败：提到它的行必须同时说明它过了。
    for (const name of retried) {
      const bad = ctx.answer
        .split('\n')
        .find((l) => l.includes(name) && !/重试|retry|passed|通过|flaky|偶发|过了/i.test(l));
      if (bad)
        return { pass: false, reason: `把重试后通过的「${name}」当成了失败：${bad.trim().slice(0, 80)}` };
    }
    return { pass: true, reason: `${failures.length} 条失败的用例名和断言行都在，且都在原文里` };
  };
}

// —— triage ——

/** 回答里每份任务书一行 `brief-N.md: PASS|FAIL`，逐份和 check-brief.mjs 比。 */
function gradeTriage() {
  return async (ctx: GradeContext): Promise<Verdict> => {
    const wrong: string[] = [];
    for (let n = 1; n <= 5; n++) {
      const file = join(ctx.caseDir, 'workspace', 'briefs', `brief-${n}.md`);
      const expected = runCheckBrief(file).pass ? 'PASS' : 'FAIL';
      const line = ctx.answer
        .split('\n')
        .find((l) => new RegExp(`brief-${n}\\.md`).test(l) && /\b(PASS|FAIL)\b/.test(l));
      const got = line ? /\b(PASS|FAIL)\b/.exec(line)?.[1] : undefined;
      if (got !== expected) wrong.push(`brief-${n}（该 ${expected}，回的 ${got ?? '没回'}）`);
    }
    return wrong.length === 0
      ? { pass: true, reason: '5 份的过不过都和 check-brief.mjs 一致' }
      : { pass: false, reason: `和 check-brief.mjs 不一致：${wrong.join('；')}` };
  };
}

const TRIAGE_RULES =
  '规矩（只按这些判，不自己加）：\n' +
  '1. 四节齐，标题固定：`## 场景`、`## 原话`、`## 已知的模块`、`## 怎么算做完`。\n' +
  '2. 「已知的模块」每行都是用反引号括起来的路径；路径不超过 50 个。\n' +
  '3. 路径不跨模块：`packages/<包名>` 算一个模块，别的路径取第一段目录算模块；整张单只能在一个模块里。\n' +
  '4. 路径不能碰 `agents/`。\n' +
  '5. 正文任何地方不能提到 `.github/workflows/`。\n' +
  '6. 「怎么算做完」一节里不能出现「grep」「CI 绿」「截图」这三个词（别的节里出现不算）。\n';

// —— ci-triager ——

function gradeCulprit(culprit: string, others: readonly string[], rootCause: RegExp) {
  return async (ctx: GradeContext): Promise<Verdict> => {
    const first = ctx.answer.split('\n').find((l) => l.includes('罪魁'));
    if (!first) return { pass: false, reason: '没有以「罪魁:」开头的一行' };
    if (!first.includes(culprit)) {
      const wrongOne = others.find((s) => first.includes(s));
      return {
        pass: false,
        reason: `罪魁指错了：${wrongOne ?? first.trim().slice(0, 60)}；标准答案 ${culprit}`,
      };
    }
    if (others.some((s) => first.includes(s)))
      return { pass: false, reason: '罪魁一行里列了不止一个提交，没有下结论' };
    const cause = ctx.answer.split('\n').find((l) => /根因/.test(l));
    if (!cause || !rootCause.test(cause)) {
      return {
        pass: false,
        reason: `罪魁对了（${culprit}），但根因一行没说到点上（要提到 ${String(rootCause)}）`,
      };
    }
    return { pass: true, reason: `罪魁 ${culprit} 对，根因说到了` };
  };
}

// —— groomer ——

function gradeGroomer(expected: Record<number, string>) {
  return async (ctx: GradeContext): Promise<Verdict> => {
    const wrong: string[] = [];
    for (const [num, want] of Object.entries(expected)) {
      const line = ctx.answer
        .split('\n')
        .find((l) => new RegExp(`#${num}\\b`).test(l) && /(做完|没做完|过期)/.test(l));
      // 「没做完」里含「做完」：先判没做完。
      const got = line ? (/没做完/.test(line) ? '没做完' : /过期/.test(line) ? '过期' : '做完') : undefined;
      if (got !== want) wrong.push(`#${num}（该「${want}」，回的「${got ?? '没回'}」）`);
    }
    return wrong.length === 0
      ? { pass: true, reason: `${Object.keys(expected).length} 张单的结论都判对` }
      : { pass: false, reason: `判错：${wrong.join('；')}` };
  };
}

// —— researcher ——

// 「--agents 高于项目 .claude/agents/」认三种说法：直说（高于、优先于、赢过…）、排序（… > --agents > 项目 .claude/agents/ > …）、
// 编号（--agents 是 2、项目是 3）。直说那种，--agents 和动词之间不能先提到项目，免得「--agents 输给项目」「被项目覆盖」也算对。
// 先前只认直说里的「高于、优先于」，Opus、Haiku 写「赢」「> 排序」答对了也被判错（#1641）。
const AGENTS_ABOVE_SAID =
  /--agents`?(?:(?!项目|project|\.claude\/agents)[^。\n]){0,40}?(?:高于|优先于|先于|赢|胜过|胜出|压过|overrides?|takes? precedence|higher|wins|beats)/i;
const AGENTS_RANK_2 = /--agents[^。\n]{0,40}?(?:[(（]\s*2\s*[)）]|是\s*2|第\s*2|②)/;
const PROJECT_RANK_3 =
  /(?:(?<!~\/)\.claude\/agents\/?`?|项目)[^。\n]{0,20}?(?:[(（]\s*3\s*[)）]|是\s*3|第\s*3|③)/;
const OTHER_PLACE = /托管|managed|用户|user|插件|plugin|~\//i;

/** 同一行按 > 切开：只写 --agents 的那一格排在只写项目 .claude/agents/ 的那一格前面。 */
function agentsOrderedAbove(a: string): boolean {
  const isAgents = (p: string) =>
    p.includes('--agents') && !/项目|project|\.claude\/agents/i.test(p) && !OTHER_PLACE.test(p);
  const isProject = (p: string) =>
    /(?<!~\/)\.claude\/agents|项目|project/i.test(p) && !p.includes('--agents') && !OTHER_PLACE.test(p);
  return a.split('\n').some((line) => {
    const parts = line.split(/[>＞]/);
    const ia = parts.findIndex(isAgents);
    const ip = parts.findIndex(isProject);
    return ia >= 0 && ip >= 0 && ia < ip;
  });
}

async function gradeAgentsPriority(ctx: GradeContext): Promise<Verdict> {
  const a = ctx.answer;
  const second = /第\s*2|第二|\bsecond\b|\b2nd\b|priority\s*2|\b2\s*[.)、]/i.test(a);
  const above =
    AGENTS_ABOVE_SAID.test(a) || agentsOrderedAbove(a) || (AGENTS_RANK_2.test(a) && PROJECT_RANK_3.test(a));
  const link = /https?:\/\/(?:code\.claude\.com|docs\.claude\.com|docs\.anthropic\.com)\/\S+/.test(a);
  const dated = /20\d\d[-/年.]\s*\d{1,2}/.test(a);
  const problems: string[] = [];
  if (!second) problems.push('没说「第 2」');
  if (!above) problems.push('没说 --agents 高于项目 .claude/agents/');
  if (!link) problems.push('没有官方文档链接');
  if (!dated) problems.push('没写查的日期');
  return problems.length === 0
    ? { pass: true, reason: '答出排第 2、高于项目级定义，带官方链接和日期' }
    : { pass: false, reason: problems.join('；') };
}

export const READING_CASES: EvalCase[] = [
  {
    id: 'scout/route-probe-entry',
    scenario: 'scout',
    name: 'route-probe-entry',
    agent: 'fleet-scout',
    prompt:
      `${PREAMBLE}当前目录是 fleet-dao 仓在某个固定提交的快照。问题：引擎里「定时路由探针跑一轮」的入口函数是哪个？` +
      '回答格式：一行「函数名 — 文件:行」，文件路径从仓根算起，行号是函数声明所在行。',
    source: { kind: 'repo', commit: SCOUT_COMMIT },
    planted: `\`runRouteProbeJob\`，\`packages/engine/src/jobs/route-probe.ts:717\`（快照 ${SCOUT_COMMIT.slice(0, 8)}）。同一文件里的 \`planScheduledProbe\`、\`probeOrgNow\`、\`conclude\` 是干扰项。`,
    why: '文件里有好几个名字带 probe 的函数，只有 runRouteProbeJob 的注释写着「跑一轮」；Sonnet 稳过，Haiku 可能指到 planScheduledProbe 或常量。',
    grade: gradeFileLine('packages/engine/src/jobs/route-probe.ts', 717, 3),
  },
  {
    id: 'scout/hourly-reconcile-entry',
    scenario: 'scout',
    name: 'hourly-reconcile-entry',
    agent: 'fleet-scout',
    prompt:
      `${PREAMBLE}当前目录是 fleet-dao 仓在某个固定提交的快照。问题：引擎里「每小时对账」跑一轮的入口函数是哪个？` +
      '回答格式：一行「函数名 — 文件:行」，文件路径从仓根算起，行号是函数声明所在行。',
    source: { kind: 'repo', commit: SCOUT_COMMIT },
    planted:
      '`runHourlyReconcileJob`，`packages/engine/src/jobs/hourly-reconcile.ts:184`。同文件的 `combineParts` 是干扰项。',
    why: '「对账」在仓里有 reconcile-common、github-reconcile、hourly-reconcile 好几处，要认准「每小时」那个文件的入口；Haiku 可能指到别的 reconcile。',
    grade: gradeFileLine('packages/engine/src/jobs/hourly-reconcile.ts', 184, 3),
  },
  {
    id: 'log-digest/three-failures',
    scenario: 'log-digest',
    name: 'three-failures',
    agent: 'fleet-log-digest',
    prompt:
      `${PREAMBLE}当前目录里的 \`ci-output.txt\` 是一次红灯的 CI 日志。把红的那几条缩成证据行：每个失败的用例，` +
      '摘出它的完整用例名（`文件 > 组 > 名字` 那一串里的最后两段即可）和原文里那行 `AssertionError…`。不写原因、不写怎么修。',
    source: { kind: 'fixture' },
    planted:
      "3 个失败用例：`skips orgs on cooldown`（expected [ 'org-b' ] to deeply equal []）、`clamps negative remaining to zero`（expected -3 to be +0）、" +
      "`rejects reversed range`（expected function to throw an error, but it didn't）。日志里还有 stderr 噪声和 15 条通过的用例。",
    why: '日志里通过和失败混着、有 stderr 噪声；Haiku 的本职场景，Sonnet、Opus 也该过。栽的话多半是漏一条或改写了原文行。',
    grade: gradeLogDigest(
      [
        {
          name: 'skips orgs on cooldown',
          assertion: "AssertionError: expected [ 'org-b' ] to deeply equal []",
        },
        { name: 'clamps negative remaining to zero', assertion: 'AssertionError: expected -3 to be +0' },
        {
          name: 'rejects reversed range',
          assertion: "AssertionError: expected function to throw an error, but it didn't",
        },
      ],
      [],
    ),
  },
  {
    id: 'log-digest/retry-noise',
    scenario: 'log-digest',
    name: 'retry-noise',
    agent: 'fleet-log-digest',
    prompt:
      `${PREAMBLE}当前目录里的 \`ci-output.txt\` 是一次红灯的 CI 日志（跑测试时带了 --retry=1）。把真正红的那几条缩成证据行：` +
      '每个最终失败的用例，摘出它的完整用例名（`组 > 名字`）和原文里那行 `AssertionError…`。不写原因、不写怎么修。',
    source: { kind: 'fixture' },
    planted:
      '2 个最终失败：`evicts the least recently used entry`、`writes the header row first`。干扰：`answers within 50ms` 重试后通过了，还有一行和本任务无关的 lint 警告。',
    why: '重试后通过的不算红，lint 警告不是失败；Haiku 可能把重试过的列进来。',
    grade: gradeLogDigest(
      [
        { name: 'evicts the least recently used entry', assertion: "AssertionError: expected 'b' to be 'a'" },
        {
          name: 'writes the header row first',
          assertion: "AssertionError: expected 'id,name\\r\\n1,x' to be 'id,name\\n1,x'",
        },
      ],
      ['answers within 50ms'],
    ),
  },
  {
    id: 'triage/briefs-a',
    scenario: 'triage',
    name: 'briefs-a',
    agent: 'fleet-triage',
    prompt:
      `${PREAMBLE}\`briefs/\` 下有 5 份任务书草稿（brief-1.md 到 brief-5.md）。按下面的规矩逐份判，` +
      '这里没有 check-brief.mjs，你自己读文件判。不下「该不该做」的结论。\n\n' +
      `${TRIAGE_RULES}\n` +
      '回答格式：每份一行，`brief-N.md: PASS` 或 `brief-N.md: FAIL — 哪条规矩`。',
    source: { kind: 'fixture' },
    planted:
      '1 过；2 缺「原话」节（FAIL）；3 过（三个路径都在 packages/shared，源码和测试算同一个模块）；4 验收条写了「CI 绿」（FAIL）；5 过（「grep」只出现在场景和原话里，验收条里没有）。标准答案由 check-brief.mjs 现算。',
    why: '3 和 5 是陷阱：同包里的源码和测试不算跨模块，「grep」出现在别的节不算数；Sonnet 稳过，Haiku 可能误判成 FAIL。',
    grade: gradeTriage(),
  },
  {
    id: 'triage/briefs-b',
    scenario: 'triage',
    name: 'briefs-b',
    agent: 'fleet-triage',
    prompt:
      `${PREAMBLE}\`briefs/\` 下有 5 份任务书草稿（brief-1.md 到 brief-5.md）。按下面的规矩逐份判，` +
      '这里没有 check-brief.mjs，你自己读文件判。不下「该不该做」的结论。\n\n' +
      `${TRIAGE_RULES}\n` +
      '回答格式：每份一行，`brief-N.md: PASS` 或 `brief-N.md: FAIL — 哪条规矩`。',
    source: { kind: 'fixture' },
    planted:
      '1 跨模块（api 和 web，FAIL）；2 碰 agents/（FAIL）；3 过（路径都在 docs/）；4 场景里提到 .github/workflows/（FAIL）；5 验收条写了「截图」（FAIL）。标准答案由 check-brief.mjs 现算。',
    why: '违规点藏在不同的节里（场景里的 workflows、验收条里的截图），要逐条对；Haiku 可能漏看场景里的那处。',
    grade: gradeTriage(),
  },
  {
    id: 'ci-triager/renamed-method',
    scenario: 'ci-triager',
    name: 'renamed-method',
    agent: 'fleet-ci-triager',
    prompt:
      `${PREAMBLE}当前目录里有一次红灯的 CI 日志 \`ci-output.txt\`、提交清单 \`commits.md\`，和两个提交的 diff（另一个提交只改了文档，没附 diff）。` +
      '问：哪个提交弄红的、根因是什么。\n回答格式（两行就够，后面可以补证据）：\n罪魁: <7 位提交号>\n根因: <一句话>',
    source: { kind: 'fixture' },
    planted:
      '罪魁 e4f5a6b：把 `Pool.acquire` 改名 `lease`，只改了 pool 和 pool 的测试，没改 `runner.ts` 里的调用。干扰：9c8d7e6 只整理了 runner.ts 的缩进（堆栈指在 runner.ts 上），a1b2c3d 只改文档。',
    why: '堆栈指向 runner.ts，最后一个提交也碰了 runner.ts，直觉会怪它；要看出 TypeError 的 `acquire is not a function` 对应的是更早一个提交的改名。Sonnet 稳过，Haiku 可能怪最后一个提交。',
    grade: gradeCulprit('e4f5a6b', ['9c8d7e6', 'a1b2c3d'], /acquire|lease|改名|重命名|rename/i),
  },
  {
    id: 'ci-triager/retries-default',
    scenario: 'ci-triager',
    name: 'retries-default',
    agent: 'fleet-ci-triager',
    prompt:
      `${PREAMBLE}当前目录里有一次红灯的 CI 日志 \`ci-output.txt\`、提交清单 \`commits.md\`，和两个提交的 diff（第三个提交只改了文档，没附 diff）。` +
      '问：哪个提交弄红的、根因是什么。\n回答格式（两行就够，后面可以补证据）：\n罪魁: <7 位提交号>\n根因: <一句话>',
    source: { kind: 'fixture' },
    planted:
      '罪魁 8e9f0a1：commit 标题「默认值整理」，实际把 `retries` 默认值从 3 改成 2，测试断言 3 次重试加首次共 4 次。干扰：3b4c5d6 只改了失败那条测试的描述和变量名（碰了失败的测试文件），c2d3e4f 只改文档。',
    why: '标题写「整理」、数字改动藏在格式整理里（30000 → 30_000 同一个 hunk）；失败的测试文件被另一个提交碰过，容易被误怪。',
    grade: gradeCulprit('8e9f0a1', ['3b4c5d6', 'c2d3e4f'], /retries|重试/i),
  },
  {
    id: 'groomer/four-issues-a',
    scenario: 'groomer',
    name: 'four-issues-a',
    agent: 'fleet-groomer',
    prompt:
      `${PREAMBLE}当前目录里 \`issues.md\` 是 4 张待审的单，\`main-facts.md\` 是主线事实（只有那里写的，别的你不知道，不要猜）。` +
      '每张单判一个结论：\n- 做完：怎么算做完的每一条主线事实都证明做到了；\n- 没做完：有一条没做到或没证据；\n- 过期：它要改的对象已经不存在或被取代。\n' +
      '回答格式：每张一行 `#号: 做完|没做完|过期 — 一句理由`。',
    source: { kind: 'fixture' },
    planted:
      '#101 做完；#102 没做完（第 3 条筛选状态写进地址栏没做，主线事实明说没有）；#103 过期（`legacyExport` 已被 #185 删掉）；#104 没做完（没有任何 PR）。',
    why: '#102 是「做了一半」的陷阱，要逐条对验收条；#103 要认出对象已经不在了。Sonnet 稳过，Haiku 可能把 #102 判成做完。',
    grade: gradeGroomer({ 101: '做完', 102: '没做完', 103: '过期', 104: '没做完' }),
  },
  {
    id: 'groomer/four-issues-b',
    scenario: 'groomer',
    name: 'four-issues-b',
    agent: 'fleet-groomer',
    prompt:
      `${PREAMBLE}当前目录里 \`issues.md\` 是 4 张待审的单，\`main-facts.md\` 是主线事实（只有那里写的，别的你不知道，不要猜）。` +
      '每张单判一个结论：\n- 做完：怎么算做完的每一条主线事实都证明做到了；\n- 没做完：有一条没做到或没证据；\n- 过期：它要改的对象已经不存在或被取代。\n' +
      '回答格式：每张一行 `#号: 做完|没做完|过期 — 一句理由`。',
    source: { kind: 'fixture' },
    planted:
      '#201 过期（Fusion 已被决定 0003 替代、代码已删）；#202 做完（#150 覆盖 `*.pem` 并有测试）；#203 没做完（#170 是草稿、CI 红、没合并）；#204 做完（#160 和 #161 都合了）。',
    why: '#203 有 PR 但没合并，容易误判成做完；#201 要联系决定记录认出被取代；#204 两条要求分在两个 PR。',
    grade: gradeGroomer({ 201: '过期', 202: '做完', 203: '没做完', 204: '做完' }),
  },
  {
    id: 'researcher/agents-priority',
    scenario: 'researcher',
    name: 'agents-priority',
    agent: 'fleet-researcher',
    prompt:
      `${PREAMBLE}（这一题不用写 _tmp 文件，答案直接写在最终回答里。）\n` +
      '问题：Claude Code 里，同名的子代理定义同时出现在几处时谁优先？命令行 `--agents` 传的定义，在这个优先级里排第几，' +
      '和项目 `.claude/agents/` 里的同名定义比谁赢？查官方文档回答，带官方文档链接、你查文档的日期（YYYY-MM-DD）和原文关键句。',
    source: { kind: 'fixture' },
    planted:
      '官方文档（子代理一页）：托管设置第 1、`--agents` 第 2、项目 `.claude/agents/` 第 3、用户 `~/.claude/agents/` 第 4、插件第 5。所以 `--agents` 排第 2，高于项目级。',
    why: '有标准答案、要查文档且带来源；Sonnet 稳过，Haiku 可能凭印象答成「项目级优先」或不带链接。官方页面改版后标准答案要重核（见 specs/1641 调研第一节第 7 条）。',
    grade: gradeAgentsPriority,
  },
];
