// 版本快照（#138）：用假的 GitHub（内存里的里程碑、单子、子单）跑 planSnapshot，不打真接口。
// 读不到、认不出的每一条都故意造出来，断言退出码 2、plan.md 没被写。
import { describe, expect, it } from 'vitest';
import { checkDebtDocs } from '../src/debt.ts';
import { checkDocPointers, formatProblem } from '../src/doc-pointers.ts';
import type { MilestoneDetail, PlanIssue, PlanReader } from '../src/github-api.ts';
import { parseMd } from '../src/markdown.ts';
import {
  escapeText,
  findSnapshot,
  formatAt,
  parseAt,
  parseOrder,
  planSnapshot,
  SNAPSHOT_BEGIN,
  SNAPSHOT_END,
  spliceSnapshot,
} from '../src/plan-snapshot.ts';
import { memRepo } from './helpers.ts';

const V1 = 'v1 Fusion 接活';
const V0 = 'v0 试跑';

function issue(number: number, extra: Partial<PlanIssue> = {}): PlanIssue {
  return {
    number,
    title: `单 ${number}`,
    state: 'open',
    isPr: false,
    createdAt: '2026-09-26T00:00:00Z',
    labels: ['需求'],
    milestone: null,
    stateReason: null,
    subIssues: 0,
    ...extra,
  };
}

function milestone(number: number, title: string, description: string, extra: Partial<MilestoneDetail> = {}) {
  const m: MilestoneDetail = { number, title, state: 'open', description, closedAt: null, ...extra };
  return m;
}

const order = (...ns: number[]) =>
  ['<!-- fleet:order -->', ...ns.map((n, i) => `${i + 1}. #${n}`), '<!-- /fleet:order -->'].join('\n');

interface World {
  milestones: MilestoneDetail[];
  issues: PlanIssue[];
  /** 母单 → 子单号，按 GitHub 上排的先后。 */
  subs: Record<number, number[]>;
}

/** 和真仓差不多的一份：v1 开着（有母单、没排进先后的单），v0 关了，未排期里有母单、没贴标签的母单、空母单。 */
function world(): World {
  const mother = ['需求', '母单'];
  return {
    milestones: [
      milestone(1, 'P1 核心闭环', '验收标准见 docs/plan.md 的 P1 一节', { state: 'closed' }),
      milestone(
        8,
        V1,
        `目标：一张真小单无人插手做到合并。\r\n\r\n先后（程序读下面两行标记之间的列表）：\r\n${order(169, 191, 199).replace(/\n/g, '\r\n')}\r\n`,
      ),
      milestone(9, V0, `${order(10)}\n\n收尾：试跑完就关。`, {
        state: 'closed',
        closedAt: '2026-09-20T16:30:00Z',
      }),
    ],
    issues: [
      issue(169, { milestone: V1 }),
      issue(191, { milestone: V1, labels: mother, subIssues: 2 }),
      issue(129, { milestone: V1 }),
      issue(164, { milestone: V1, state: 'closed', stateReason: 'completed' }),
      issue(199, { milestone: V1, title: '驾驶舱 *帅位* 栏：`等你拍` <b>' }),
      issue(200, { milestone: V1 }),
      issue(48, { milestone: V1 }),
      issue(10, { milestone: V0, state: 'closed', stateReason: 'completed' }),
      issue(43),
      issue(88, { labels: ['缺陷'], subIssues: 1 }),
      issue(90),
      issue(192, { labels: mother, subIssues: 3 }),
      issue(35),
      issue(79, { state: 'closed', stateReason: 'not_planned' }),
      issue(195, { labels: mother }),
    ],
    subs: { 191: [129, 164], 88: [90], 192: [35, 79, 48] },
  };
}

type Method = keyof PlanReader;

/** 假 GitHub：按 world 回；fail 里的那几样一调就抛；reverse 时把没有先后意义的列表倒过来回（子单的顺序不动）。 */
function fakeReader(w: World, opts: { fail?: Partial<Record<Method, Error>>; reverse?: boolean } = {}) {
  const calls: Method[] = [];
  const flip = <T>(xs: T[]) => (opts.reverse ? [...xs].reverse() : xs);
  const hit = (m: Method) => {
    calls.push(m);
    const e = opts.fail?.[m];
    if (e) throw e;
  };
  const find = (n: number) => {
    const found = w.issues.find((i) => i.number === n);
    if (!found) throw new Error(`假数据里没有 #${n}`);
    return found;
  };
  const reader: PlanReader = {
    async milestoneDetails() {
      hit('milestoneDetails');
      return flip(w.milestones);
    },
    async openPlanIssues() {
      hit('openPlanIssues');
      return flip(w.issues.filter((i) => i.state === 'open'));
    },
    async milestonePlanIssues(n) {
      hit('milestonePlanIssues');
      const title = w.milestones.find((m) => m.number === n)?.title;
      return flip(w.issues.filter((i) => i.milestone === title));
    },
    async subIssues(n) {
      hit('subIssues');
      return (w.subs[n] ?? []).map(find);
    },
  };
  return { reader, calls };
}

const HEAD = ['# 计划', '', '> 开头说明，一字不动。', ''];
const TAIL = ['', '## 一、总思路', '', '留作历史。', ''];
const PLAN = [...HEAD, SNAPSHOT_BEGIN, '', '旧快照', '', SNAPSHOT_END, ...TAIL].join('\n');
const NOW = new Date('2026-09-27T01:00:00Z');

async function run(
  argv: string[],
  opts: {
    w?: World;
    fail?: Partial<Record<Method, Error>>;
    reverse?: boolean;
    plan?: string | undefined;
    loggedIn?: boolean;
    writeFails?: boolean;
  } = {},
) {
  const { reader, calls } = fakeReader(opts.w ?? world(), {
    ...(opts.fail ? { fail: opts.fail } : {}),
    ...(opts.reverse ? { reverse: true } : {}),
  });
  const writes: string[] = [];
  const plan = 'plan' in opts ? opts.plan : PLAN;
  const r = await planSnapshot(argv, {
    reader: opts.loggedIn === false ? undefined : reader,
    repo: 'o/r',
    read: () => plan,
    write(text) {
      if (opts.writeFails) throw new Error('磁盘满了');
      writes.push(text);
    },
    now: () => NOW,
  });
  return { ...r, writes, calls };
}

const BLOCK = `## 现在的目标（版本快照：北京时间 2026-09-27 09:00；以 GitHub 上的版本为准）

### v1 Fusion 接活（开着）

[里程碑](https://github.com/o/r/milestone/8)：7 张单，开着 6 张、关了 1 张。

目标：一张真小单无人插手做到合并。

先后（程序读下面两行标记之间的列表）：

1. #169 单 169
2. #191 单 191（母单，子单关了 1/2）
   1. #129 单 129
   2. #164 单 164（已做完）
3. #199 驾驶舱 \\*帅位\\* 栏：\\\`等你拍\\\` \\<b\\>

先后里没排的：

- #48 单 48（母单 #192）
- #200 单 200

## 未排期

没挂版本的开着的单，按单号；母单下面按 GitHub 上排的先后列子单。

- #43 单 43
- #88 单 88（子单关了 0/1，没贴「母单」标签）
  1. #90 单 90
- #192 单 192（母单，子单关了 1/3）
  1. #35 单 35
  2. #79 单 79（不做了）
  3. #48 单 48（挂在「v1 Fusion 接活」）
- #195 单 195（母单，还没有子单）

## 已关的版本

### v0 试跑（已关，2026-09-21）

[里程碑](https://github.com/o/r/milestone/9)：1 张单，开着 0 张、关了 1 张。

先后：

1. #10 单 10（已做完）

收尾：试跑完就关。`;

const EXPECTED = [...HEAD, SNAPSHOT_BEGIN, '', BLOCK, '', SNAPSHOT_END, ...TAIL].join('\n');

describe('版本快照：从 GitHub 生成 plan.md 标记之间的几节', () => {
  it('版本、先后、母单和子单、未排期、已关的版本都写出来；标记外面一字不动', async () => {
    const r = await run(['--at', '2026-09-27T09:00+08:00']);
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([EXPECTED]);
    expect(r.lines).toEqual([
      '写好了 docs/plan.md 的版本快照（北京时间 2026-09-27 09:00 的快照；开着的版本：「v1 Fusion 接活」；未排期 6 张；已关的版本 1 个）：git diff 看一眼，照常开 PR。',
      '提醒：「v1 Fusion 接活」里 #48、#200 开着却没排进先后（快照里列在「先后里没排的」）。',
    ]);
  });

  it('输出确定：同一份数据跑两遍、接口回的顺序打乱，写出来一字不差', async () => {
    const a = await run(['--at', '2026-09-27T09:00+08:00']);
    const b = await run(['--at', '2026-09-27T09:00+08:00'], { reverse: true });
    expect(b.writes).toEqual(a.writes);
    expect(a.writes).toEqual([EXPECTED]);
  });

  it('再跑一遍、什么都没变：不写，说一样', async () => {
    const r = await run(['--at', '2026-09-27T09:00+08:00'], { plan: EXPECTED });
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([]);
    expect(r.lines[0]).toContain('docs/plan.md 的版本快照和原来一样');
  });

  it('文件里唯一的时间是快照时间：不写 --at 取现在，写了照 --at（换算成北京时间）', async () => {
    const now = await run([]);
    expect(now.writes[0]).toContain('## 现在的目标（版本快照：北京时间 2026-09-27 09:00；');
    const utc = await run(['--at', '2026-09-26T16:05:30Z']);
    expect(utc.writes[0]).toContain('版本快照：北京时间 2026-09-27 00:05；');
    const onlyTime = (await run(['--at', '2026-09-28T09:00+08:00'])).writes[0]?.replace(
      '09-28 09:00',
      '09-27 09:00',
    );
    expect(onlyTime).toBe(EXPECTED);
  });

  it('pnpm 传过来的 -- 认得；plan.md 是 CRLF 的也认得，写回统一成 LF', async () => {
    const r = await run(['--', '--at', '2026-09-27T09:00+08:00'], { plan: PLAN.replace(/\n/g, '\r\n') });
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([EXPECTED]);
  });

  it('没有开着的版本：写明上一个已关，照样生成', async () => {
    const w = world();
    w.milestones = w.milestones.filter((m) => m.title !== V1);
    w.issues = w.issues.filter((i) => i.milestone !== V1);
    w.subs = { 88: [90], 192: [35, 79] };
    const r = await run(['--at', '2026-09-27T09:00+08:00'], { w });
    expect(r.code).toBe(0);
    expect(r.writes[0]).toContain('现在没有开着的版本（上一个是「v0 试跑」，已关）。');
  });

  it('里程碑说明里的标题行前面加 \\，免得打乱 plan.md 的分节、被认成阶段', async () => {
    const w = world();
    const v1 = w.milestones.find((m) => m.title === V1);
    if (v1) v1.description = `### P7 不是阶段\n\n${order(169, 191, 199)}\n\n## 也不是一节`;
    const r = await run(['--at', '2026-09-27T09:00+08:00'], { w });
    const text = r.writes[0] ?? '';
    expect(text).toContain('\n\\### P7 不是阶段\n');
    expect(text).toContain('\n\\## 也不是一节\n');
    expect(parseMd('docs/plan.md', text).headings.map((h) => h.text)).not.toContain('P7 不是阶段');
  });
});

describe('版本快照：读不到、认不出一律不写、退出码 2', () => {
  const at = ['--at', '2026-09-27T09:00+08:00'];
  const refused = (r: Awaited<ReturnType<typeof run>>, message: string) => {
    expect(r.code).toBe(2);
    expect(r.writes).toEqual([]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain(message);
    expect(r.lines[0]).toMatch(/docs\/plan\.md 没动。$/);
  };

  it('没登录 GitHub', async () => {
    const r = await run(at, { loggedIn: false });
    refused(r, '没登录 GitHub');
    expect(r.calls).toEqual([]);
  });

  it.each([
    ['milestoneDetails', '读里程碑，GitHub 回了 500'],
    ['openPlanIssues', '读开着的 issue，GitHub 回了 502'],
    ['milestonePlanIssues', '连不上 GitHub（fetch failed）'],
    ['subIssues', '读 #191 的子单，GitHub 回了 404'],
  ] as const)('GitHub 读不到（%s）', async (method, message) => {
    refused(await run(at, { fail: { [method]: new Error(message) } }), message);
  });

  it('先后标记缺了', async () => {
    const w = world();
    const v1 = w.milestones.find((m) => m.title === V1);
    if (v1) v1.description = '目标：只写了目标，忘了先后';
    refused(await run(at, { w }), '里程碑「v1 Fusion 接活」：说明里没有先后标记');
  });

  it.each([
    ['只有开头', '<!-- fleet:order -->\n1. #169', '先后标记要恰好一对，现在开头的有 1 个、结尾的有 0 个'],
    ['有两对', `${order(169)}\n${order(191)}`, '先后标记要恰好一对，现在开头的有 2 个、结尾的有 2 个'],
    ['结尾在前', '<!-- /fleet:order -->\n1. #169\n<!-- fleet:order -->', '先后的结尾标记写在了开头标记前面'],
    ['之间是空的', '<!-- fleet:order -->\n\n<!-- /fleet:order -->', '先后标记之间一张单也没有'],
    [
      '一行多写了字',
      '<!-- fleet:order -->\n1. #169 定稿\n<!-- /fleet:order -->',
      '先后第 1 行「1. #169 定稿」认不出：一行只写一张，写成「1. #单号」',
    ],
    [
      '序号跳了',
      '<!-- fleet:order -->\n1. #169\n3. #191\n<!-- /fleet:order -->',
      '先后第 2 行的序号写成了 3',
    ],
    ['同一张写两遍', '<!-- fleet:order -->\n1. #169\n2. #169\n<!-- /fleet:order -->', '先后里 #169 写了两遍'],
  ])('先后认不出：%s', async (_name, description, message) => {
    const w = world();
    const v1 = w.milestones.find((m) => m.title === V1);
    if (v1) v1.description = description;
    refused(await run(at, { w }), message);
    expect(parseOrder(description)).toEqual({ ok: false, problem: expect.stringContaining(message) });
  });

  it('关了的版本先后认不出，一样不生成', async () => {
    const w = world();
    const v0 = w.milestones.find((m) => m.title === V0);
    if (v0) v0.description = '试跑';
    refused(await run(at, { w }), '里程碑「v0 试跑」：说明里没有先后标记');
  });

  it('先后里的单不在这个版本里（没挂这个里程碑，或者是 PR）', async () => {
    const w = world();
    const v1 = w.milestones.find((m) => m.title === V1);
    if (v1) v1.description = order(169, 191, 199, 43);
    refused(await run(at, { w }), '里程碑「v1 Fusion 接活」的先后里有 #43，可它不是这个版本里的单');
  });

  it('先后里排了子单（它的母单也在这个版本里）', async () => {
    const w = world();
    const v1 = w.milestones.find((m) => m.title === V1);
    if (v1) v1.description = order(169, 191, 129, 199);
    refused(await run(at, { w }), '先后里有 #129，可它是 #191 的子单：先后里只排母单和单独的单');
  });

  it('一个版本也没有：不生成空快照', async () => {
    const w = world();
    w.milestones = w.milestones.filter((m) => m.title.startsWith('P'));
    w.issues = w.issues.filter((i) => i.milestone === null);
    refused(await run(at, { w }), 'GitHub 上一个版本（v<N> 开头的里程碑）也没有，不生成空快照');
  });

  it('两个里程碑是同一个版本号', async () => {
    const w = world();
    w.milestones.push(milestone(10, 'v1 另一个', order(43)));
    refused(await run(at, { w }), '「v1 Fusion 接活」和「v1 另一个」都是 v1');
  });

  it('开着的单挂在不是版本的里程碑上：快照里没地方放', async () => {
    const w = world();
    w.issues.push(issue(56, { milestone: 'P1 核心闭环' }));
    refused(await run(at, { w }), '开着的单挂在不是版本的里程碑上，快照里没地方放：#56（「P1 核心闭环」）');
  });

  it('子单关系对不上：同一张单在两张母单下面', async () => {
    const w = world();
    w.subs[195] = [35];
    refused(await run(at, { w }), '#35 既在 #192 下面、又在 #195 下面');
  });

  it('子单绕成了圈', async () => {
    const w = world();
    const i90 = w.issues.find((i) => i.number === 90);
    if (i90) i90.subIssues = 1;
    w.subs[90] = [88];
    refused(await run(at, { w }), '子单绕成了圈');
  });

  it('plan.md 读不到', async () => {
    const r = await run(at, { plan: undefined });
    refused(r, '读不到 docs/plan.md');
    expect(r.calls).toEqual([]);
  });

  it.each([
    ['没有标记', '# 计划\n\n旧的\n', 'docs/plan.md 里没有快照标记'],
    ['只有开始', `${SNAPSHOT_BEGIN}\n旧的\n`, '现在开始的有 1 行、结束的有 0 行'],
    [
      '两个开始',
      `${SNAPSHOT_BEGIN}\n${SNAPSHOT_BEGIN}\n${SNAPSHOT_END}\n`,
      '现在开始的有 2 行、结束的有 1 行',
    ],
    ['结束在前', `${SNAPSHOT_END}\n旧的\n${SNAPSHOT_BEGIN}\n`, '快照的结束标记写在了开始标记前面'],
  ])('plan.md 的快照标记认不出（%s）：先查标记，不出网', async (_name, plan, message) => {
    const r = await run(at, { plan });
    refused(r, message);
    expect(r.calls).toEqual([]);
  });

  it('里程碑说明里混进了快照标记：生成出来不成对，不写', async () => {
    const w = world();
    const v1 = w.milestones.find((m) => m.title === V1);
    if (v1) v1.description = `${order(169, 191, 199)}\n${SNAPSHOT_END}`;
    refused(await run(at, { w }), '生成的快照里混进了快照标记');
  });

  it.each([
    [['--at', '明天'], '--at 的「明天」认不出'],
    [['--at', '2026-09-27T09:00'], '--at 的「2026-09-27T09:00」认不出'],
    [['--at', '2026-09-27'], '--at 的「2026-09-27」认不出'],
    [['--force'], "Unknown option '--force'"],
    [['docs/plan.md'], '参数不对'],
  ])('参数不对：%j', async (argv, message) => {
    const r = await run(argv);
    refused(r, message);
    expect(r.calls).toEqual([]);
  });

  it('写不进 plan.md：退出码 2，说清可能只写了一半', async () => {
    const r = await run(at, { writeFails: true });
    expect(r.code).toBe(2);
    expect(r.lines).toEqual(['没写成：docs/plan.md（磁盘满了）。它可能只写了一半，先 git diff 看一眼。']);
  });
});

describe('版本快照：小零件', () => {
  it('先后：前后的说明原样留着（CRLF 统一成 LF），标记里的空行不算', () => {
    expect(
      parseOrder('目标\r\n<!-- fleet:order -->\r\n1. #5\r\n\r\n2. #3\r\n<!--/fleet:order-->\r\n尾巴'),
    ).toEqual({
      ok: true,
      order: [5, 3],
      before: '目标',
      after: '尾巴',
    });
  });

  it('标题照抄：压成一行，起 Markdown 作用的字符前加 \\', () => {
    expect(escapeText('  a\n*b* `c` [d](e) <!-- f --> \\ ')).toBe(
      'a \\*b\\* \\`c\\` \\[d\\](e) \\<!-- f --\\> \\\\',
    );
  });

  it('时间：--at 要带时区；写成北京时间', () => {
    expect(parseAt('2026-09-27T09:00+08:00')?.toISOString()).toBe('2026-09-27T01:00:00.000Z');
    expect(parseAt('2026-09-27T01:00:00.5Z')?.toISOString()).toBe('2026-09-27T01:00:00.500Z');
    expect(parseAt('2026-09-27 09:00+08:00')).toBeUndefined();
    expect(parseAt('2026-19-27T09:00Z')).toBeUndefined();
    expect(formatAt(new Date('2026-09-26T23:59:00Z'))).toBe('北京时间 2026-09-27 07:59');
  });

  it('换快照：只换两行标记之间；换完标记不成对就抛', () => {
    const text = `头\n${SNAPSHOT_BEGIN}\n旧\n${SNAPSHOT_END}\n尾`;
    expect(spliceSnapshot(text, '新')).toBe(`头\n${SNAPSHOT_BEGIN}\n\n新\n\n${SNAPSHOT_END}\n尾`);
    expect(() => spliceSnapshot(text, `新\n${SNAPSHOT_BEGIN}`)).toThrow('生成的快照里混进了快照标记');
    expect(findSnapshot('头\n尾')).toContain('没有快照标记');
  });
});

describe('生成的快照段：文档指针、欠账检查不查（照抄 GitHub 的标题，要改去 GitHub 改）', () => {
  // 快照段里：指不到的路径、「以后再做」没带单号；标记外面：同样两句
  const inside = ['- #139 按模块拆 `docs/nowhere/`', '- 这件以后再做'];
  const doc = (lines: string[]) => ['# 计划', '', ...lines, ''].join('\n');
  const repoWith = (plan: string) =>
    memRepo({
      'docs/plan.md': plan,
      'docs/design.md': '# 设计\n',
      'docs/ops.md': '# 运维\n',
      'README.md': '# 读我\n',
      'AGENTS.md': '# 约定\n',
      'specs/': '',
    });
  const pointerProblems = (plan: string) =>
    checkDocPointers(repoWith(plan), ['docs/plan.md']).problems.map(formatProblem);
  const debtLines = (plan: string) =>
    checkDebtDocs(repoWith(plan)).lines.filter((l) => l.startsWith('docs/plan.md'));

  it('标记成对：快照段里的不报', () => {
    const plan = doc([SNAPSHOT_BEGIN, ...inside, SNAPSHOT_END]);
    expect(pointerProblems(plan)).toEqual([]);
    expect(debtLines(plan)).toEqual([]);
  });

  it('同样的两句写在标记外面：照报', () => {
    const plan = doc([SNAPSHOT_BEGIN, SNAPSHOT_END, ...inside]);
    expect(pointerProblems(plan)).toEqual(['docs/plan.md:5  docs/nowhere/ 在仓里没有']);
    expect(debtLines(plan)).toHaveLength(1);
    expect(debtLines(plan)[0]).toMatch(/^docs\/plan\.md:6 /);
  });

  it('标记不成对：认不出快照段，整份照查', () => {
    const plan = doc([SNAPSHOT_BEGIN, ...inside]);
    expect(pointerProblems(plan)).toEqual(['docs/plan.md:4  docs/nowhere/ 在仓里没有']);
    expect(debtLines(plan)).toHaveLength(1);
  });
});
