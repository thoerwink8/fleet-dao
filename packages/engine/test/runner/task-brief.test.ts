// task-brief.ts：单子 + 需求文档 → 动手的交代（#632 S2-1）。
// 走通的：正文自己写全需求、单子指着需求文档两种；故意造红的：每一栏缺、涉及面、单子关了、文档不在、读失败（不能当没有）。

import { describe, expect, it } from 'vitest';
import { ManualBriefSchema } from '../../src/runner/brief.ts';
import {
  asModuleRef,
  BriefIncompleteError,
  briefOrThrow,
  buildTaskBrief,
  describeBriefProblems,
  manualBriefOf,
  moduleItems,
  moduleRefsOf,
  readTaskBrief,
  type TaskBriefPorts,
  type TaskIssue,
} from '../../src/runner/task-brief.ts';
import { decideTierFromModules, TIER_HEAVYWEIGHT_FILE_THRESHOLD } from '../../src/runner/tier.ts';

const REPO = { owner: 'acme', name: 'demo' };

const PARTS: Record<string, string> = {
  场景: '创始人要在驾驶舱看到每张单走到哪一步。',
  原话: '「我回来打开驾驶舱，这张单就该在做完的那一栏」（创始人 2026-10-02）',
  已知的模块: '- `packages/web/src/pages/`：驾驶舱页面\n- `packages/api/src/cockpit.ts`：接口',
  要什么: '每张单显示当前在哪一环。',
  怎么算做完: '1. 页面上能看到「验收中」这个状态\n2. `pnpm test:changed` 通过',
};

/** 按 PARTS 拼一份单子正文；over 里给 null 就整节去掉，给字符串就换内容；extra 接在最后。 */
function body(over: Record<string, string | null> = {}, extra = ''): string {
  const out: string[] = ['AI 理解：把状态显示出来。', ''];
  for (const [name, text] of Object.entries(PARTS)) {
    const v = name in over ? over[name] : text;
    if (v === null || v === undefined) continue;
    out.push(`## ${name}`, '', v, '');
  }
  return `${out.join('\n')}${extra}`;
}

function issue(over: Partial<TaskIssue> = {}): TaskIssue {
  return { number: 7, title: '给分档加一条规矩', body: body(), state: 'open', ...over };
}

describe('buildTaskBrief · 正文自己写全了需求', () => {
  it('齐了 → 交代：原文整份带上、验收逐条、已知的模块每项、将建的文档目录', () => {
    const r = buildTaskBrief({ issue: issue() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.brief;
    expect(b.issueNumber).toBe(7);
    expect(b.title).toBe('给分档加一条规矩');
    expect(b.request).toContain('创始人要在驾驶舱看到每张单走到哪一步。');
    expect(b.request).toContain('每张单显示当前在哪一环。'); // 「要什么」也在，没被挑掉
    expect(b.acceptance).toEqual(['页面上能看到「验收中」这个状态', '`pnpm test:changed` 通过']);
    expect(b.touches).toEqual([
      '`packages/web/src/pages/`：驾驶舱页面',
      '`packages/api/src/cockpit.ts`：接口',
    ]);
    expect(b.specDir).toBeUndefined(); // 正文就是需求：没有文档可对照，也不会再建
  });

  it('引擎写进正文的进度段、HTML 注释不算需求，去掉', () => {
    const progress =
      '<!-- fleet:progress:start as-of=2026-10-02T10:00:00Z -->\n进度：已完成 3/5\n<!-- fleet:progress:end -->\n';
    const r = buildTaskBrief({ issue: issue({ body: body({}, `\n${progress}<!-- 模板提示：别删 -->\n`) }) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.brief.request).not.toContain('已完成 3/5');
    expect(r.brief.request).not.toContain('模板提示');
    expect(r.brief.acceptance).toHaveLength(2);
  });

  it('一个目录（在 packages 里）→ 中档；两个包 → 主力档；各带原因', () => {
    const one = buildTaskBrief({
      issue: issue({ body: body({ 已知的模块: '- `packages/web/src/pages/`' }) }),
    });
    expect(one.ok && one.brief.tier.tier).toBe('medium');
    const two = buildTaskBrief({ issue: issue() });
    expect(two.ok && two.brief.tier.tier).toBe('heavyweight');
    expect(two.ok && two.brief.tier.reason).toContain('碰接口包');
  });
});

describe('buildTaskBrief · 单子指着需求文档', () => {
  it('原文用需求文档全文（issue 上只有概述），目录取指的那个，标主线上已有', () => {
    const summary = '概述：只留原话。\n\n文档：`specs/<本单号>-驾驶舱状态/需求.md`（完整需求和怎么算做完）';
    const r = buildTaskBrief({
      issue: issue({ body: summary }),
      specDoc: { dir: 'specs/7-驾驶舱状态', markdown: body() },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.brief.request).toContain('创始人要在驾驶舱看到每张单走到哪一步。');
    expect(r.brief.request).not.toContain('只留原话');
    expect(r.brief.specDir).toBe('specs/7-驾驶舱状态');
  });

  it('【故意造出的失败】文档里缺栏 → 报需求文档里缺（不是单子正文）', () => {
    const r = buildTaskBrief({
      issue: issue({ body: '文档：`specs/7-x/需求.md`' }),
      specDoc: { dir: 'specs/7-x', markdown: body({ 怎么算做完: null }) },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const done = r.problems.find((p) => p.field === '怎么算做完');
    expect(done?.why).toContain('需求文档里');
  });
});

describe('buildTaskBrief · 【故意造出的失败】缺的一次全报，不拿空冒充齐', () => {
  it('场景、原话、已知的模块、怎么算做完全没有 → 四条一起报', () => {
    const r = buildTaskBrief({
      issue: issue({ body: '随便写了两句，没有任何一栏。' }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => p.field).sort()).toEqual(
      ['原话', '场景', '已知的模块', '怎么算做完'].sort(),
    );
    expect(describeBriefProblems(r.problems)).toContain('【场景】');
  });

  it.each(['场景', '原话', '已知的模块', '怎么算做完'])('只缺「%s」→ 只报它', (name) => {
    const r = buildTaskBrief({ issue: issue({ body: body({ [name]: null }) }) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => p.field)).toEqual([name]);
  });

  it('栏在，但是空的 → 报「是空的」', () => {
    const r = buildTaskBrief({ issue: issue({ body: body({ 原话: '' }) }) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.why).toContain('是空的');
  });

  it('写了「涉及面」 → 报（那是算出来的、不是知道的），不照猜着做', () => {
    const r = buildTaskBrief({ issue: issue({ body: body({}, '\n## 涉及面\n\n- packages/x\n') }) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => p.field)).toEqual(['涉及面']);
  });

  it('正文是空的 / 只有进度段 → 报单子是空的', () => {
    for (const text of ['', '   \n', '<!-- fleet:progress:start -->\n进度\n<!-- fleet:progress:end -->']) {
      const r = buildTaskBrief({ issue: issue({ body: text }) });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.problems[0]).toMatchObject({ field: '单子' });
      expect(r.problems[0]?.why).toContain('是空的');
    }
  });

  it('单子已经关了 → 不派', () => {
    const r = buildTaskBrief({ issue: issue({ state: 'closed' }) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems[0]?.why).toContain('已经关了');
  });
});

describe('moduleItems / asModuleRef / moduleRefsOf', () => {
  it('列表一条一项，续行并进上一项；占位（暂无、无、没有……）不算项', () => {
    expect(moduleItems('- `a/b.ts`：甲\n  续行\n- `c/`：乙')).toEqual(['`a/b.ts`：甲 续行', '`c/`：乙']);
    for (const none of [
      '暂无',
      '无',
      '（暂无）',
      '暂无（建单时没聊到）',
      '没有。',
      '待定',
      '（暂无，建单时没聊到）',
    ]) {
      expect(moduleItems(none)).toEqual([]);
    }
  });

  it('以「无」「没有」开头的正经句子不是占位', () => {
    expect(moduleItems('无人值守的调度器')).toEqual(['无人值守的调度器']);
    expect(moduleItems('没有现成的页面，要新建')).toEqual(['没有现成的页面，要新建']);
  });

  it('没写成列表：一段话一项，空行隔开的是两项', () => {
    expect(moduleItems('`a/b.ts` 和 `c.ts`\n\n另一段')).toEqual(['`a/b.ts` 和 `c.ts`', '另一段']);
  });

  it.each([
    ['packages/api/src/cli.ts', { path: 'packages/api/src/cli.ts', kind: 'file' }],
    ['packages/engine/src/runner/', { path: 'packages/engine/src/runner', kind: 'dir' }],
    ['packages/api', { path: 'packages/api', kind: 'dir' }],
    ['./deploy/france.sh:120-130', { path: 'deploy/france.sh', kind: 'file' }],
    ['packages/web/src/*.tsx', { path: 'packages/web/src', kind: 'dir' }],
    ['package.json', { path: 'package.json', kind: 'file' }],
    ['.gitignore', { path: '.gitignore', kind: 'file' }],
    ['specs/632-三段总调度/', { path: 'specs/632-三段总调度', kind: 'dir' }],
  ] as const)('认得出路径：%s', (raw, want) => {
    expect(asModuleRef(raw)).toEqual(want);
  });

  it.each([
    'decideTier', // 单个词
    'pnpm issue:new', // 带空格
    'FLEET_ENV=production',
    'https://example.com/a/b',
    '/etc/fleet-dao/api.env', // 绝对路径
    '../x/y.ts', // 跳出仓
    '*.ts', // 通配前面没有目录
    'v1.2', // 版本号不是文件名（扩展名以数字开头）
    '',
  ])('【故意造出的失败】不是路径：%j', (raw) => {
    expect(asModuleRef(raw)).toBeUndefined();
  });

  it('一项里一个路径都认不出，整项进 unrecognized（不猜它指哪）', () => {
    const { refs, unrecognized } = moduleRefsOf([
      '`packages/a/x.ts`：甲',
      '驾驶舱的待办页',
      '`decideTier` 这个函数',
    ]);
    expect(refs).toEqual([{ path: 'packages/a/x.ts', kind: 'file' }]);
    expect(unrecognized).toEqual(['驾驶舱的待办页', '`decideTier` 这个函数']);
  });
});

describe('decideTierFromModules · 派活那一刻的分档', () => {
  const file = (path: string) => ({ path, kind: 'file' as const });
  const dir = (path: string) => ({ path, kind: 'dir' as const });

  it('一个文件 → 快档；同一文件写两遍还是一个', () => {
    expect(decideTierFromModules([file('packages/api/src/cli.ts')], []).tier).toBe('fast');
    expect(
      decideTierFromModules([file('packages/api/src/cli.ts'), file('packages/api/src/cli.ts')], []).tier,
    ).toBe('fast');
  });

  it('一个目录、或同一 packages/<包>/ 里几处 → 中档', () => {
    expect(decideTierFromModules([dir('packages/engine/src/runner')], []).tier).toBe('medium');
    expect(
      decideTierFromModules([file('packages/shared/src/a.ts'), dir('packages/shared/src/b')], []).tier,
    ).toBe('medium');
  });

  it('跨包、或不在 packages/<包>/ 下 → 主力档', () => {
    expect(decideTierFromModules([dir('packages/api'), dir('packages/core')], []).tier).toBe('heavyweight');
    expect(decideTierFromModules([dir('deploy')], []).tier).toBe('heavyweight');
    expect(decideTierFromModules([file('docs/ops.md'), file('docs/design.md')], []).tier).toBe('heavyweight');
  });

  it('单个非 packages 的文件 → 快档（一个文件就是一个文件）', () => {
    expect(decideTierFromModules([file('docs/ops.md')], []).tier).toBe('fast');
  });

  it('【故意造出的失败】什么都没写 / 有认不出的一项 → 不猜，主力档，原因写清', () => {
    const none = decideTierFromModules([], []);
    expect(none).toMatchObject({ tier: 'heavyweight', effort: 'high' });
    expect(none.reason).toContain('不猜');
    const unknown = decideTierFromModules([file('packages/api/src/cli.ts')], ['驾驶舱的待办页']);
    expect(unknown.tier).toBe('heavyweight');
    expect(unknown.reason).toContain('驾驶舱的待办页');
    expect(unknown.reason).toContain('反引号');
  });

  it('列了超过 50 处 → 主力档', () => {
    const many = Array.from({ length: TIER_HEAVYWEIGHT_FILE_THRESHOLD + 1 }, (_, i) =>
      file(`packages/shared/src/f${i}.ts`),
    );
    expect(decideTierFromModules(many, []).tier).toBe('heavyweight');
  });

  it('经 buildTaskBrief：「暂无」→ 主力档；写了不是路径的话 → 主力档', () => {
    const none = buildTaskBrief({ issue: issue({ body: body({ 已知的模块: '暂无' }) }) });
    expect(none.ok && none.brief.touches).toEqual([]);
    expect(none.ok && none.brief.tier.tier).toBe('heavyweight');
    const prose = buildTaskBrief({ issue: issue({ body: body({ 已知的模块: '驾驶舱那几个页面' }) }) });
    expect(prose.ok && prose.brief.tier.tier).toBe('heavyweight');
  });
});

describe('readTaskBrief · 现读单子和文档', () => {
  const POINTER_BODY = '概述。\n\n文档：`specs/<本单号>-驾驶舱状态/需求.md`（完整需求和怎么算做完）';

  function ports(over: Partial<TaskBriefPorts> = {}, reads: string[] = []): TaskBriefPorts {
    return {
      async readIssue() {
        return issue();
      },
      async readSpecDoc({ path }) {
        reads.push(path);
        return { content: body() };
      },
      ...over,
    };
  }

  it('正文自己写全了需求 → 不去读文档', async () => {
    const reads: string[] = [];
    const r = await readTaskBrief(ports({}, reads), { repo: REPO, issueNumber: 7 });
    expect(r.ok).toBe(true);
    expect(reads).toEqual([]);
  });

  it('单子指着文档 → 读那一份（占位的 <本单号> 换成真号），原文用文档的', async () => {
    const reads: string[] = [];
    const r = await readTaskBrief(ports({ readIssue: async () => issue({ body: POINTER_BODY }) }, reads), {
      repo: REPO,
      issueNumber: 7,
    });
    expect(reads).toEqual(['specs/7-驾驶舱状态/需求.md']);
    expect(r.ok && r.brief.specDir).toBe('specs/7-驾驶舱状态');
    expect(r.ok && r.brief.request).toContain('创始人要在驾驶舱看到每张单走到哪一步。');
  });

  it('【故意造出的失败】指着的文档主线上没有 → problems（说清路径），不拿概述当需求', async () => {
    const r = await readTaskBrief(
      ports({
        readIssue: async () => issue({ body: POINTER_BODY }),
        readSpecDoc: async () => null,
      }),
      { repo: REPO, issueNumber: 7 },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.field).toBe('需求文档');
    expect(r.problems[0]?.why).toContain('specs/7-驾驶舱状态/需求.md');
  });

  it('【故意造出的失败】指着别的单的文档 → problems', async () => {
    const r = await readTaskBrief(
      ports({ readIssue: async () => issue({ body: '文档：`specs/99-别的单/需求.md`' }) }),
      { repo: REPO, issueNumber: 7 },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems[0]?.why).toContain('#99');
  });

  it('【故意造出的失败】读单子失败 / 读文档失败 → 抛错，不当成「没有」', async () => {
    await expect(
      readTaskBrief(
        ports({
          readIssue: async () => {
            throw new Error('GitHub 502');
          },
        }),
        { repo: REPO, issueNumber: 7 },
      ),
    ).rejects.toThrow('GitHub 502');
    await expect(
      readTaskBrief(
        ports({
          readIssue: async () => issue({ body: POINTER_BODY }),
          readSpecDoc: async () => {
            throw new Error('读文档超时');
          },
        }),
        { repo: REPO, issueNumber: 7 },
      ),
    ).rejects.toThrow('读文档超时');
  });

  it('【故意造出的失败】读回来的是另一张单 → 抛错', async () => {
    await expect(
      readTaskBrief(ports({ readIssue: async () => issue({ number: 8 }) }), { repo: REPO, issueNumber: 7 }),
    ).rejects.toThrow(/读回来的是 #8/);
  });
});

describe('briefOrThrow / manualBriefOf', () => {
  it('【故意造出的失败】交代不全 → BriefIncompleteError（code、逐项原因都在）', () => {
    const r = buildTaskBrief({ issue: issue({ body: body({ 场景: null, 原话: null }) }) });
    expect(() => briefOrThrow(7, r)).toThrow(BriefIncompleteError);
    try {
      briefOrThrow(7, r);
    } catch (e) {
      expect(e).toBeInstanceOf(BriefIncompleteError);
      const err = e as BriefIncompleteError;
      expect(err.code).toBe('BRIEF_INCOMPLETE');
      expect(err.problems.map((p) => p.field).sort()).toEqual(['原话', '场景']);
      expect(err.message).toContain('#7');
    }
  });

  it('加上分支和起点 → 过 ManualBriefSchema；文档在主线上才带 specDir', () => {
    const own = buildTaskBrief({ issue: issue() });
    if (!own.ok) throw new Error('应该齐');
    const m1 = manualBriefOf(own.brief, { branch: 'fleet/7-x', baseSha: 'a'.repeat(40) });
    expect(ManualBriefSchema.parse(m1)).toEqual(m1);
    expect(m1.specDir).toBeUndefined();
    expect(m1.branch).toBe('fleet/7-x');

    const pointed = buildTaskBrief({
      issue: issue({ body: '文档：`specs/7-x/需求.md`' }),
      specDoc: { dir: 'specs/7-x', markdown: body() },
    });
    if (!pointed.ok) throw new Error('应该齐');
    expect(manualBriefOf(pointed.brief, { branch: 'b', baseSha: 'c' }).specDir).toBe('specs/7-x');
  });

  it('【故意造出的失败】分支或起点是空的 → zod 当场红', () => {
    const own = buildTaskBrief({ issue: issue() });
    if (!own.ok) throw new Error('应该齐');
    expect(() => manualBriefOf(own.brief, { branch: '', baseSha: 'a' })).toThrow();
    expect(() => manualBriefOf(own.brief, { branch: 'b', baseSha: '' })).toThrow();
  });
});
