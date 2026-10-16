// GitHub 对账（#654）：用假的 GitHub 跑 auditGitHub。每一条规则一个查得出的例子、一个不该报的例子；
// 读不到、认不出的每一条都故意造出来，断言是「没查成」，不是「没有断裂」。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PlanIssue, PullBody } from '../src/github-api.ts';
import { auditGitHub } from '../src/github-audit.ts';
import { addToOrder } from '../src/plan-view.ts';
import { fakeReader, issue, type Method, milestone, order, V0, V1, type World } from './fake-github.ts';

const NOW = new Date('2026-10-03T00:00:00Z');
const DAY = 24 * 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MOTHER = ['需求', '母单'];

/** 干净的一份：v1 开着（一张母单带两张子单、一张单独的缺陷）、v0 关了、未排期一张杂项；什么都不该报。 */
function cleanWorld(): World {
  return {
    milestones: [
      milestone(8, V1, `目标：做完。\n\n${order(10, 20)}`),
      milestone(9, V0, order(1), { state: 'closed', closedAt: '2026-09-20T16:30:00Z' }),
    ],
    issues: [
      issue(10, { milestone: V1, labels: MOTHER, subIssues: 2, subIssuesDone: 1, createdAt: ago(5 * DAY) }),
      issue(11, { milestone: V1, parent: 10 }),
      issue(12, { milestone: V1, state: 'closed', stateReason: 'completed', parent: 10 }),
      issue(20, { milestone: V1, labels: ['缺陷'] }),
      issue(1, { milestone: V0, state: 'closed', stateReason: 'completed' }),
      issue(30, { labels: ['杂项'] }),
    ],
    subs: { 10: [11, 12] },
  };
}

async function audit(w: World, opts: { fail?: Partial<Record<Method, Error>> } = {}) {
  const { reader, calls } = fakeReader(w, opts);
  const r = await auditGitHub(reader, NOW);
  return { ...r, calls, texts: r.findings.map((f) => f.text) };
}

const editWorld = (edit: (w: World) => void): World => {
  const w = cleanWorld();
  edit(w);
  return w;
};
/** 改世界里的一张单（只改 extra 里的字段）。 */
const patch = (w: World, n: number, extra: Partial<PlanIssue>) => {
  const found = w.issues.find((i) => i.number === n);
  if (!found) throw new Error(`假数据里没有 #${n}`);
  return Object.assign(found, extra);
};

describe('GitHub 对账：干净的一份什么都不报', () => {
  it('没有断裂：findings 空、没有没查成的，说清查了几张单、几个版本', async () => {
    const r = await audit(cleanWorld());
    expect(r.findings).toEqual([]);
    expect(r.notQueried).toEqual([]);
    expect(r.checked).toEqual({ issues: 4, versions: 2 });
  });
});

describe('GitHub 对账：类别标签恰好一个', () => {
  it('没有类别标签：挂在这张单上报', async () => {
    const r = await audit(editWorld((w) => patch(w, 20, { labels: [] })));
    expect(r.findings).toEqual([
      expect.objectContaining({ issue: 20, text: expect.stringContaining('#20 没有类别标签') }),
    ]);
  });

  it('贴了两个：说清是哪两个', async () => {
    const r = await audit(editWorld((w) => patch(w, 20, { labels: ['需求', '缺陷'] })));
    expect(r.texts).toEqual(['#20 贴了 2 个类别标签（需求、缺陷）：只留一个']);
  });

  it('别的标签（本机做、母单）不算类别，不该报', async () => {
    const r = await audit(editWorld((w) => patch(w, 20, { labels: ['缺陷', '本机做'] })));
    expect(r.findings).toEqual([]);
  });
});

describe('GitHub 对账：母单和子单对得上', () => {
  it('子单都关了、母单还开着：报，说清怎么收', async () => {
    const r = await audit(editWorld((w) => patch(w, 10, { subIssuesDone: 2 })));
    expect(r.findings).toEqual([expect.objectContaining({ issue: 10 })]);
    expect(r.texts[0]).toContain('#10 的 2 张子单都关了，它自己还开着');
    expect(r.texts[0]).toContain('pnpm issue:close 10');
  });

  it('有子单却没贴「母单」标签：报', async () => {
    const r = await audit(editWorld((w) => patch(w, 10, { labels: ['需求'] })));
    expect(r.texts).toEqual(['#10 下面有 2 张子单，却没贴「母单」标签：贴上']);
  });

  it('贴了「母单」却没有子单：超过一天才报（刚开的母单子单还没挂上）', async () => {
    const empty = (createdAt: string) =>
      editWorld((w) => {
        w.issues.push(issue(40, { labels: MOTHER, createdAt }));
      });
    const old = await audit(empty(ago(2 * DAY)));
    expect(old.findings).toEqual([expect.objectContaining({ issue: 40 })]);
    expect(old.texts[0]).toContain('#40 贴了「母单」标签，却一直没有子单');
    const fresh = await audit(empty(ago(3_600_000)));
    expect(fresh.findings).toEqual([]);
  });

  it('【故意造出的失败】接口没给子单数：记成「没查成」，不当成没有断裂，也不猜', async () => {
    const r = await audit(
      editWorld((w) => {
        w.issues.push(issue(40, { labels: MOTHER, createdAt: ago(9 * DAY), subIssues: undefined }));
        // 母单的子单都关了：接口给了子单数时这条会报；没给就核不了，不能悄悄放过
        patch(w, 10, { subIssues: undefined, subIssuesDone: undefined });
      }),
    );
    expect(r.findings).toEqual([]);
    expect(r.notQueried).toEqual(['接口没给 #10、#40 的子单数，母单和子单对不对没核']);
  });

  it('没给子单数的单很多：只列前 10 张，说明一共几张', async () => {
    const r = await audit(
      editWorld((w) => {
        for (let n = 100; n < 112; n += 1) w.issues.push(issue(n, { subIssues: undefined }));
      }),
    );
    expect(r.notQueried).toEqual([
      '接口没给 #100、#101、#102、#103、#104、#105、#106、#107、#108、#109 等 12 张 的子单数，母单和子单对不对没核',
    ]);
  });
});

describe('GitHub 对账：开着的子单，母单已经关了', () => {
  const withOrphans = (w: World) => {
    w.issues.push(
      issue(99, { state: 'closed', stateReason: 'completed' }),
      issue(60, { parent: 99 }),
      issue(61, { parent: 99 }),
      issue(62, { parent: 98 }),
    );
  };

  it('母单已关、母单查不到：各报一条挂在子单上；同一个母单只问一次', async () => {
    const r = await audit(editWorld(withOrphans));
    const orphans = r.findings.filter((f) => f.key.startsWith('orphan:'));
    expect(orphans.map((f) => f.issue)).toEqual([60, 61, 62]);
    expect(orphans[0]?.text).toContain('#60 开着，它的母单 #99 已经关了');
    expect(orphans[2]?.text).toContain('#62 开着，它的母单 #98 在 GitHub 上查不到');
    expect(r.calls.filter((c) => c === 'issue')).toHaveLength(2);
  });

  it('母单开着：不报', async () => {
    const r = await audit(cleanWorld());
    expect(r.findings.filter((f) => f.key.startsWith('orphan:'))).toEqual([]);
  });

  it('【故意造出的失败】读不到母单：没查成，不是没有', async () => {
    const r = await audit(editWorld(withOrphans), { fail: { issue: new Error('GitHub 回了 502') } });
    expect(r.notQueried).toEqual(['读不到母单的状态（GitHub 回了 502），挂在已关母单下面的子单没核']);
    expect(r.findings.filter((f) => f.key.startsWith('orphan:'))).toEqual([]);
  });
});

describe('GitHub 对账：版本里程碑说明里的先后', () => {
  it('先后标记缺了：报（不挂在哪张单上），说清是哪个版本', async () => {
    const r = await audit(
      editWorld((w) => {
        const v1 = w.milestones.find((m) => m.title === V1);
        if (v1) v1.description = '目标：只写了目标，忘了先后';
      }),
    );
    expect(r.findings).toEqual([expect.objectContaining({ issue: undefined })]);
    expect(r.texts[0]).toContain('里程碑「v1 Fusion 接活」：说明里没有先后标记');
    expect(r.notQueried).toEqual([]);
  });

  it('开着的单没排进先后：不报（拉单、发版车把没排进先后的排后面照样拉，#2683 删了这条）', async () => {
    const r = await audit(
      editWorld((w) => {
        w.issues.push(issue(70, { milestone: V1 }));
      }),
    );
    expect(r.findings).toEqual([]);
    expect(r.notQueried).toEqual([]);
  });

  it('pnpm issue:new 开单那一刻写进先后的（addToOrder 写的样子，排末尾和 --order-after 各一张）：判已排进，不报（#807）', async () => {
    const r = await audit(
      editWorld((w) => {
        w.issues.push(issue(70, { milestone: V1 }), issue(71, { milestone: V1, labels: ['缺陷'] }));
        const v1 = w.milestones.find((m) => m.title === V1);
        if (!v1) throw new Error('假数据里没有 v1');
        const appended = addToOrder(v1.description, 70);
        const inserted = appended.ok ? addToOrder(appended.description, 71, 10) : appended;
        if (!inserted.ok) throw new Error(inserted.problem);
        expect(inserted.order).toEqual([10, 71, 20, 70]);
        v1.description = inserted.description;
      }),
    );
    expect(r.findings).toEqual([]);
    expect(r.notQueried).toEqual([]);
  });

  it('先后里的单挪出了这个版本、还开着（#2683）：不整个报错，别的几条照核；给了 writer 就从先后里清掉', async () => {
    // #30 开着、挂在未排期：从前 readPlan 报「不是这个版本里的单」整个失败，清理也跟着不跑
    const moved = () =>
      editWorld((w) => {
        const v1 = w.milestones.find((m) => m.title === V1);
        if (v1) v1.description = `目标：做完。\n\n${order(10, 30, 20)}`;
      });
    const r = await audit(moved());
    expect(r.findings).toEqual([]);
    expect(r.notQueried).toEqual([]);
    expect(r.checked.versions).toBe(2);

    const w = moved();
    const { reader } = fakeReader(w);
    const writer = {
      async setMilestoneDescription(n: number, description: string) {
        const m = w.milestones.find((x) => x.number === n);
        if (!m) throw new Error(`假数据里没有里程碑 ${n}`);
        m.description = description;
        return { ...m };
      },
    };
    const cleaned = await auditGitHub(reader, NOW, writer);
    expect(cleaned.pruned).toEqual([{ milestone: V1, removed: [30] }]);
    expect(w.milestones[0]?.description).toBe(`目标：做完。\n\n${order(10, 20)}`);
  });
});

const pull = (number: number, body: string, extra: Partial<PullBody> = {}): PullBody => ({
  number,
  title: `PR ${number}`,
  body,
  headRef: `feat/${number}`,
  state: 'closed',
  mergedAt: '2026-10-02T00:00:00Z',
  ...extra,
});
/** PR 正文：「需求」栏下面写这几行。 */
const column = (first: string, ...more: string[]) => [`**需求**：${first}`, ...more, ''].join('\n');
const REFS_30 = column('Refs #30');

describe('GitHub 对账：合并了的 PR 提到它、它却还开着（#995 拍 1 的 B）', () => {
  const withPulls = (...pulls: PullBody[]) =>
    editWorld((w) => {
      w.pulls = pulls;
    });
  const merged = (r: { findings: { key: string }[] }) =>
    r.findings.filter((f) => f.key.startsWith('merged-open:'));

  it('合并了的 PR 在「需求」栏 Refs 它、它还开着：报，挂在这张单上，说清是哪张 PR 和怎么收', async () => {
    const r = await audit(withPulls(pull(500, REFS_30)));
    expect(r.findings).toEqual([expect.objectContaining({ issue: 30, key: 'merged-open:30:500' })]);
    expect(r.texts[0]).toContain('#30 开着，但 PR #500「PR 500」');
    expect(r.texts[0]).toContain('pnpm issue:close 30');
    expect(r.texts[0]).toContain('分片、关不了它');
  });

  it('有好几张合并的 PR 提到它：只报最近合并的那一张', async () => {
    const r = await audit(
      withPulls(
        pull(500, REFS_30, { mergedAt: '2026-10-01T00:00:00Z' }),
        pull(501, REFS_30, { mergedAt: '2026-10-02T00:00:00Z' }),
      ),
    );
    expect(merged(r).map((f) => f.key)).toEqual(['merged-open:30:501']);
  });

  it('不该报：那一行写明「分片、关不了它」', async () => {
    const r = await audit(withPulls(pull(500, column('Refs #30（分片，关不了它）'))));
    expect(merged(r)).toEqual([]);
  });

  it('不该报：还有开着的 PR 的「需求」栏挂着它（活还在做）', async () => {
    const r = await audit(
      withPulls(pull(500, REFS_30), pull(501, REFS_30, { state: 'open', mergedAt: null })),
    );
    expect(merged(r)).toEqual([]);
  });

  it('不该报：引擎任务流程的 PR（它的单引擎自己关）', async () => {
    const r = await audit(withPulls(pull(500, REFS_30, { headRef: 'fleet/30-t0123abcd' })));
    expect(merged(r)).toEqual([]);
  });

  it('不该报：只是关了没合并的 PR；Closes（合并时 GitHub 自己关，开着是有人重开）', async () => {
    const r = await audit(withPulls(pull(500, REFS_30, { mergedAt: null }), pull(501, column('Closes #30'))));
    expect(merged(r)).toEqual([]);
  });

  it('不该报：母单、「本机做」标签的单、下面还有开着子单的单', async () => {
    const r = await audit(
      editWorld((w) => {
        patch(w, 30, { labels: ['杂项', '本机做'] });
        patch(w, 20, { labels: ['缺陷', '母单'] });
        w.pulls = [pull(500, column('Refs #30', 'Refs #20', 'Refs #10'))];
      }),
    );
    expect(merged(r)).toEqual([]);
  });

  it('不该报：这张单已经关了', async () => {
    const r = await audit(
      editWorld((w) => {
        patch(w, 30, { state: 'closed', stateReason: 'completed' });
        w.pulls = [pull(500, REFS_30)];
      }),
    );
    expect(merged(r)).toEqual([]);
  });

  it('【故意造出的失败】读不到 PR：没查成，不当成没有断裂；别的几条照查', async () => {
    const r = await audit(withPulls(pull(500, REFS_30)), {
      fail: { recentPulls: new Error('GitHub 回了 502') },
    });
    expect(r.notQueried).toEqual(['读不到最近的 PR（GitHub 回了 502），合并了却还开着的单没核']);
    expect(merged(r)).toEqual([]);
  });
});

describe('GitHub 对账：读不到一律是「没查成」，不当成没有断裂', () => {
  it('开着的单读不到：单子本身的几条、版本先后都没核', async () => {
    const r = await audit(cleanWorld(), {
      fail: { openIssues: new Error('读开着的 issue，GitHub 回了 502') },
    });
    expect(r.findings).toEqual([]);
    expect(r.notQueried).toEqual([
      '读不到开着的单（读开着的 issue，GitHub 回了 502），单子本身的几条没核',
      '读不到版本和先后（读开着的 issue，GitHub 回了 502），里程碑说明里的先后没核',
    ]);
    expect(r.checked).toEqual({ issues: 0, versions: 0 });
  });

  it('里程碑读不到：单子本身的几条照查', async () => {
    const w = editWorld((x) => patch(x, 20, { labels: [] }));
    const r = await audit(w, { fail: { milestones: new Error('读里程碑，GitHub 回了 500') } });
    expect(r.notQueried).toEqual(['读不到版本和先后（读里程碑，GitHub 回了 500），里程碑说明里的先后没核']);
    expect(r.findings).toEqual([expect.objectContaining({ issue: 20 })]);
  });

  it.each(['milestoneIssues', 'subIssues'] as const)(
    '%s 连不上 GitHub：是没查成，不是先后有问题',
    async (method) => {
      const r = await audit(cleanWorld(), { fail: { [method]: new Error('连不上 GitHub（fetch failed）') } });
      expect(r.findings).toEqual([]);
      expect(r.notQueried).toEqual([
        '读不到版本和先后（连不上 GitHub（fetch failed）），里程碑说明里的先后没核',
      ]);
    },
  );
});

describe('GitHub 对账：先后里已关的号直接清掉（#2393）', () => {
  /** v1 先后里排了 10、13、20：13 是关了的单独的单（子单不能写进先后，所以不用 12）。 */
  const closed13 = () => issue(13, { milestone: V1, state: 'closed', stateReason: 'completed' });
  const closedInOrder = (): World => {
    const w = cleanWorld();
    w.milestones[0] = milestone(8, V1, `目标：做完。\n\n${order(10, 13, 20)}\n\n收尾。`);
    w.issues.push(closed13());
    return w;
  };
  const withWriter = (w: World, fail?: Error) => {
    const { reader } = fakeReader(w);
    const writes: { milestone: number; description: string }[] = [];
    const writer = {
      async setMilestoneDescription(n: number, description: string) {
        if (fail) throw fail;
        writes.push({ milestone: n, description });
        const m = w.milestones.find((x) => x.number === n);
        if (!m) throw new Error(`假数据里没有里程碑 ${n}`);
        m.description = description;
        return { ...m };
      },
    };
    return { reader, writer, writes };
  };

  it('对账跑一次后说明里不再有已关号，标记外的话不动；再跑一次什么都不改', async () => {
    const w = closedInOrder();
    const { reader, writer, writes } = withWriter(w);
    const r = await auditGitHub(reader, NOW, writer);
    expect(r.pruned).toEqual([{ milestone: V1, removed: [13] }]);
    expect(r.notQueried).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(w.milestones[0]?.description).toBe(`目标：做完。\n\n${order(10, 20)}\n\n收尾。`);
    const again = await auditGitHub(reader, NOW, writer);
    expect(again.pruned).toEqual([]);
    expect(writes).toHaveLength(1);
  });

  it('干净的一份：一次也不写', async () => {
    const { reader, writer, writes } = withWriter(cleanWorld());
    const r = await auditGitHub(reader, NOW, writer);
    expect(r.pruned).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('没给 writer：只读，不改说明', async () => {
    const w = closedInOrder();
    const { reader } = withWriter(w);
    const r = await auditGitHub(reader, NOW);
    expect(r.pruned).toEqual([]);
    expect(w.milestones[0]?.description).toContain('2. #13');
  });

  it('【故意造出的失败】读不到开着的单：不清（不拿读不到当成全关了），已记没查成', async () => {
    const w = closedInOrder();
    const { writer, writes } = withWriter(w);
    const { reader: broken } = fakeReader(w, { fail: { openIssues: new Error('连不上 GitHub') } });
    const r = await auditGitHub(broken, NOW, writer);
    expect(writes).toEqual([]);
    expect(r.notQueried).toContainEqual(expect.stringContaining('读不到版本和先后'));
  });

  it('【故意造出的失败】改说明失败：记没查成、带原因，不当成清好了', async () => {
    const { reader, writer } = withWriter(closedInOrder(), new Error('在里程碑 8 上改说明，GitHub 回了 403'));
    const r = await auditGitHub(reader, NOW, writer);
    expect(r.pruned).toEqual([]);
    expect(r.notQueried).toEqual([
      '没改成里程碑「v1 Fusion 接活」先后里已关的号（在里程碑 8 上改说明，GitHub 回了 403），#13 还在里面',
    ]);
  });

  it('【故意造出的失败】接口说改好了、回来的先后却对不上：不拿 200 当改好了', async () => {
    const w = closedInOrder();
    const { reader } = withWriter(w);
    const stale = {
      async setMilestoneDescription(n: number) {
        const m = w.milestones.find((x) => x.number === n);
        if (!m) throw new Error('没有');
        return { ...m };
      },
    };
    const r = await auditGitHub(reader, NOW, stale);
    expect(r.pruned).toEqual([]);
    expect(r.notQueried[0]).toContain('改完回来的说明里先后和要写的对不上');
  });

  it('先后里的全是已关的：清光会留空先后，不动，出一条 finding', async () => {
    const w = cleanWorld();
    w.milestones[0] = milestone(8, V1, order(13));
    w.issues.push(closed13());
    const { reader, writer, writes } = withWriter(w);
    const r = await auditGitHub(reader, NOW, writer);
    expect(writes).toEqual([]);
    expect(r.findings.map((f) => f.text)).toContainEqual(expect.stringContaining('清光会留下空先后'));
  });
});

describe('GitHub 对账：定时任务只报告、不挡 PR，也不进必过检查（#87）', () => {
  const read = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');

  it('github-audit.yml 只在定时和手动时跑，不在 PR、主线推送上跑；pnpm check 里不跑对账', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['github:audit']).toBe('node packages/conventions/src/bin/github-audit.ts');
    expect(pkg.scripts.check).not.toContain('github-audit');
    const yml = read('.github/workflows/github-audit.yml');
    expect(yml).not.toMatch(/^ {2}pull_request(?:_target)?:/m);
    expect(yml).not.toMatch(/^ {2}push:/m);
    expect(yml).toMatch(/^ {2}schedule:/m);
    expect(yml).toMatch(/^ {2}workflow_dispatch:/m);
    expect(yml).toMatch(/run: node packages\/conventions\/src\/bin\/github-audit\.ts --comment\s*$/m);
  });
});
