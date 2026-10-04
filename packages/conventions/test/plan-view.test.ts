// 现在的计划（#654，pnpm plan）：用假的 GitHub（内存里的里程碑、单子、子单）跑 planCommand，不打真接口。
// 读不到、认不出的每一条都故意造出来，断言退出码 2、什么都没打印成计划。
import { describe, expect, it } from 'vitest';
import { formatAt, PlanProblem, parseOrder, planCommand, readPlan } from '../src/plan-view.ts';
import { fakeReader, issue, type Method, milestone, order, V0, V1, type World } from './fake-github.ts';

/** 和真仓差不多的一份：v1 开着（有母单、没排进先后的单），v0 关了，未排期里有母单、没贴标签的母单、空母单。 */
function world(): World {
  const mother = ['需求', '母单'];
  return {
    milestones: [
      milestone(1, 'P1 核心闭环', '验收标准见旧计划的 P1 一节', { state: 'closed' }),
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

const NOW = new Date('2026-09-27T01:00:00Z');

async function run(
  argv: string[],
  opts: {
    w?: World;
    fail?: Partial<Record<Method, Error>>;
    reverse?: boolean;
    loggedIn?: boolean;
    now?: Date;
  } = {},
) {
  const { reader, calls } = fakeReader(opts.w ?? world(), {
    ...(opts.fail ? { fail: opts.fail } : {}),
    ...(opts.reverse ? { reverse: true } : {}),
  });
  const r = await planCommand(argv, {
    reader: opts.loggedIn === false ? undefined : reader,
    repo: 'o/r',
    now: () => opts.now ?? NOW,
  });
  return { ...r, calls };
}

const BLOCK = `## 现在的目标（GitHub 现读：北京时间 2026-09-27 09:00）

### v1 Fusion 接活（开着）

里程碑 https://github.com/o/r/milestone/8 ：7 张单，开着 6 张、关了 1 张。

目标：一张真小单无人插手做到合并。

先后（程序读下面两行标记之间的列表）：

1. #169 单 169
2. #191 单 191（母单，子单关了 1/2）
   1. #129 单 129
   2. #164 单 164（已做完）
3. #199 驾驶舱 *帅位* 栏：\`等你拍\` <b>

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

里程碑 https://github.com/o/r/milestone/9 ：1 张单，开着 0 张、关了 1 张。

先后：

1. #10 单 10（已做完）

收尾：试跑完就关。`;

describe('现在的计划：从 GitHub 现读、打印出来', () => {
  it('版本、先后、母单和子单、未排期、已关的版本都打印出来；标题里的符号照原样，不加转义', async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      BLOCK,
      '',
      '提醒：「v1 Fusion 接活」里 #48、#200 开着却没排进先后（列在「先后里没排的」）。',
    ]);
  });

  it('输出确定：同一份数据跑两遍、接口回的顺序打乱，一字不差', async () => {
    const a = await run([]);
    const b = await run([], { reverse: true });
    expect(b.lines).toEqual(a.lines);
  });

  it('时间只在第一行：现在是几点就写几点（换算成北京时间）', async () => {
    const r = await run([], { now: new Date('2026-09-26T16:05:30Z') });
    expect(r.lines[0]?.split('\n')[0]).toBe('## 现在的目标（GitHub 现读：北京时间 2026-09-27 00:05）');
    expect(r.lines[0]?.split('\n').slice(1)).toEqual(BLOCK.split('\n').slice(1));
  });

  it('pnpm 传过来的 -- 认得', async () => {
    const r = await run(['--']);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe(BLOCK);
  });

  it('没有开着的版本：写明上一个已关，照样打印', async () => {
    const w = world();
    w.milestones = w.milestones.filter((m) => m.title !== V1);
    w.issues = w.issues.filter((i) => i.milestone !== V1);
    w.subs = { 88: [90], 192: [35, 79] };
    const r = await run([], { w });
    expect(r.code).toBe(0);
    expect(r.lines[0]).toContain('现在没有开着的版本（上一个是「v0 试跑」，已关）。');
  });
});

describe('现在的计划：读不到、认不出一律退出码 2，不打印空计划', () => {
  const refused = (r: Awaited<ReturnType<typeof run>>, message: string) => {
    expect(r.code).toBe(2);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^没读成：/);
    expect(r.lines[0]).toContain(message);
    expect(r.lines[0]).not.toContain('## 现在的目标');
  };

  it('没登录 GitHub', async () => {
    const r = await run([], { loggedIn: false });
    refused(r, '没登录 GitHub');
    expect(r.calls).toEqual([]);
  });

  it.each([
    ['milestones', '读里程碑，GitHub 回了 500'],
    ['openIssues', '读开着的 issue，GitHub 回了 502'],
    ['milestoneIssues', '连不上 GitHub（fetch failed）'],
    ['subIssues', '读 #191 的子单，GitHub 回了 404'],
  ] as const)('GitHub 读不到（%s）', async (method, message) => {
    refused(await run([], { fail: { [method]: new Error(message) } }), message);
  });

  it('先后标记缺了', async () => {
    const w = world();
    const v1 = w.milestones.find((m) => m.title === V1);
    if (v1) v1.description = '目标：只写了目标，忘了先后';
    refused(await run([], { w }), '里程碑「v1 Fusion 接活」：说明里没有先后标记');
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
    refused(await run([], { w }), message);
    expect(parseOrder(description)).toEqual({ ok: false, problem: expect.stringContaining(message) });
  });

  it('关了的版本先后认不出，一样不打印', async () => {
    const w = world();
    const v0 = w.milestones.find((m) => m.title === V0);
    if (v0) v0.description = '试跑';
    refused(await run([], { w }), '里程碑「v0 试跑」：说明里没有先后标记');
  });

  it('先后里的单不在这个版本里（没挂这个里程碑，或者是 PR）', async () => {
    const w = world();
    const v1 = w.milestones.find((m) => m.title === V1);
    if (v1) v1.description = order(169, 191, 199, 43);
    refused(await run([], { w }), '里程碑「v1 Fusion 接活」的先后里有 #43，可它不是这个版本里的单');
  });

  it('先后里排了子单（它的母单也在这个版本里）', async () => {
    const w = world();
    const v1 = w.milestones.find((m) => m.title === V1);
    if (v1) v1.description = order(169, 191, 129, 199);
    refused(await run([], { w }), '先后里有 #129，可它是 #191 的子单：先后里只排母单和单独的单');
  });

  it('一个版本也没有：不打印空计划', async () => {
    const w = world();
    w.milestones = w.milestones.filter((m) => m.title.startsWith('P'));
    w.issues = w.issues.filter((i) => i.milestone === null);
    refused(await run([], { w }), 'GitHub 上一个版本（v<N> 开头的里程碑）也没有，不打印空计划');
  });

  it('两个里程碑是同一个版本号', async () => {
    const w = world();
    w.milestones.push(milestone(10, 'v1 另一个', order(43)));
    refused(await run([], { w }), '「v1 Fusion 接活」和「v1 另一个」都是 v1');
  });

  it('开着的单挂在不是版本的里程碑上：计划里没地方放', async () => {
    const w = world();
    w.issues.push(issue(56, { milestone: 'P1 核心闭环' }));
    refused(await run([], { w }), '开着的单挂在不是版本的里程碑上，计划里没地方放：#56（「P1 核心闭环」）');
  });

  it('子单关系对不上：同一张单在两张母单下面', async () => {
    const w = world();
    w.subs[195] = [35];
    refused(await run([], { w }), '#35 既在 #192 下面、又在 #195 下面');
  });

  it('子单绕成了圈', async () => {
    const w = world();
    const i90 = w.issues.find((i) => i.number === 90);
    if (i90) i90.subIssues = 1;
    w.subs[90] = [88];
    refused(await run([], { w }), '子单绕成了圈');
  });

  it.each([
    [['--at', '2026-09-27T09:00+08:00'], "Unknown option '--at'"],
    [['--force'], "Unknown option '--force'"],
    [['v3'], '参数不对'],
  ])('参数不对（pnpm plan 不带参数）：%j', async (argv, message) => {
    const r = await run(argv);
    refused(r, message);
    expect(r.lines[0]).toContain('用法：pnpm plan');
    expect(r.calls).toEqual([]);
  });
});

describe('现在的计划：内容有问题和读不到 GitHub 是两种错（对账靠它分开）', () => {
  it('先后标记缺了：抛 PlanProblem', async () => {
    const w = world();
    const v1 = w.milestones.find((m) => m.title === V1);
    if (v1) v1.description = '没有先后';
    await expect(readPlan(fakeReader(w).reader)).rejects.toBeInstanceOf(PlanProblem);
  });

  it('GitHub 读不到：抛的是原来的错，不是 PlanProblem', async () => {
    const err = new Error('读里程碑，GitHub 回了 500');
    const caught = await readPlan(fakeReader(world(), { fail: { milestones: err } }).reader).catch(
      (e: unknown) => e,
    );
    expect(caught).toBe(err);
    expect(caught).not.toBeInstanceOf(PlanProblem);
  });
});

describe('现在的计划：小零件', () => {
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

  it('时间写成北京时间', () => {
    expect(formatAt(new Date('2026-09-26T23:59:00Z'))).toBe('北京时间 2026-09-27 07:59');
  });
});
