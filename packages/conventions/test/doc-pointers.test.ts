import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkDocPointers, DOCS, formatProblem, type PointerKind } from '../src/doc-pointers.ts';
import { fsRepo, type RepoView } from '../src/repo.ts';
import { memRepo } from './helpers.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const DESIGN = [
  '# 设计',
  '',
  '## 一、一句话',
  '',
  '写任务。',
  '- **会话断了接着干**：续上原会话。',
  '',
  '## 二、为什么',
  '',
  '| 现象 | 根因 |',
  '|---|---|',
  '| 没人盯就停 | 要贴标签 |',
  '',
  '## 三、已定',
  '',
  '| # | 事项 |',
  '|---|---|',
  '| 1 | 仓 |',
  '| 2 | 结构 |',
  '',
  '### 仓库结构',
  '',
  '## 八、进度',
  '',
  '- **再主动，做成 `fleet` 命令**：只有 AI 自己知道的事才让它说。',
  '  - 为什么是命令不是 MCP：各家都会跑命令。',
  '',
  '## 十五、驾驶舱',
  '',
  '### 15.1 看板',
  '',
  '1. **随手记任务**：说一句话。',
  '2. **只推三类消息**：别的不推。',
  '',
].join('\n');

const PLAN = [
  '# 计划',
  '',
  '## 一、总思路',
  '',
  '先跑通。',
  '',
  '## 三、分阶段',
  '',
  '### P0 地基（约 6 小时）',
  '',
  '- 仓骨架：pnpm、CI。',
  '- `deploy/france.sh`：一条命令装好。',
  '',
  '**验收**：装两遍。',
  '',
  '### P1 核心闭环',
  '',
  '- 工作流：需求、子任务。',
  '- 错误按「下一步动作」分流、路由熔断。',
  '',
].join('\n');

const OPS = [
  '# 运维',
  '',
  '## 一、两台机器',
  '',
  '装法在 `deploy/france.sh`。',
  '',
  '## 二、备份与恢复',
  '',
  '每晚备份。',
  '',
].join('\n');

const README = [
  '# 仓',
  '',
  '## 常用',
  '',
  '- 跑检查：`pnpm check`。',
  '',
  '## 文档各管什么',
  '',
  '| 文件 | 管什么 |',
  '',
].join('\n');

const SPEC = ['# 演示（#1）', '', '对应计划：plan.md P0「仓骨架」。', ''].join('\n');
/** 结果.md 写在做完之后，指针照严查；要严查的 specs 文档的例子都写在这里（需求.md、方案.md 指到还没有的不报）。 */
const RESULT_DOC = 'specs/1-demo/结果.md';
const RESULT = ['# 结果（#1）', '', '做了：仓骨架。', ''].join('\n');

const BASE: Record<string, string> = {
  'docs/design.md': DESIGN,
  'docs/plan.md': PLAN,
  'docs/ops.md': OPS,
  'README.md': README,
  'specs/1-demo/需求.md': SPEC,
  [RESULT_DOC]: RESULT,
  'deploy/france.sh': '',
  'deploy/hk.sh': '',
  'packages/x/src/a.ts': '',
};

/** 在某份文档末尾加几行，返回查的结果和加的第一行的行号。 */
function withLines(file: string, lines: string[], extra: Record<string, string> = {}) {
  const base = BASE[file] ?? '';
  const first = base.split('\n').length;
  const report = checkDocPointers(memRepo({ ...BASE, ...extra, [file]: `${base}${lines.join('\n')}\n` }));
  return { report, first };
}

describe('文档指针：底子本身都指得到', () => {
  it('夹具的几份文档 0 个问题', () => {
    const report = checkDocPointers(memRepo(BASE));
    expect(report.problems.map(formatProblem)).toEqual([]);
    expect(report.files).toEqual([...DOCS, RESULT_DOC, 'specs/1-demo/需求.md']);
  });
});

describe('文档指针：故意弄断的，逐条报 文件:行', () => {
  const cases: [name: string, file: string, line: string, message: string][] = [
    ['反引号里的路径不在', 'README.md', '- 看 `docs/nope.md`。', 'docs/nope.md 在仓里没有'],
    [
      '反引号里命令带的路径不在',
      'docs/ops.md',
      '- 跑 `bash deploy/gone.sh --check`。',
      'deploy/gone.sh 在仓里没有',
    ],
    [
      '大小写对不上（CI 在 Linux 上）',
      'README.md',
      '- 看 `deploy/France.sh`。',
      'deploy/France.sh 在仓里没有',
    ],
    ['通配一个也对不上', 'docs/ops.md', '单元是 `deploy/*.service`。', 'deploy/*.service 在仓里没有'],
    [
      '路径穿过一个文件：算没有，不算读不到',
      'docs/ops.md',
      '见 `deploy/france.sh/x`。',
      'deploy/france.sh/x 在仓里没有',
    ],
    [
      '链接指的文件不在',
      'README.md',
      '- [旧计划](docs/old.md)',
      '链接 docs/old.md 指的 docs/old.md 在仓里没有',
    ],
    [
      '相对链接按文档所在目录算',
      'docs/ops.md',
      '见 [计划](../docs/plan2.md)。',
      '链接 ../docs/plan2.md 指的 docs/plan2.md 在仓里没有',
    ],
    ['正文里不带反引号的路径不在', 'docs/ops.md', '装法见 deploy/gone.sh。', 'deploy/gone.sh 在仓里没有'],
    ['第 X 节不在', 'docs/design.md', '见第九节。', 'docs/design.md 里没有第九节'],
    ['别的文档的第 X 节不在', 'docs/design.md', '去向见 plan.md 第五节。', 'docs/plan.md 里没有第五节'],
    [
      '第 X 节后面引的话不在那一节',
      'docs/design.md',
      '见第二节「没人管就停」。',
      'docs/design.md 第二节里找不到「没人管就停」',
    ],
    ['第 X 节第 N 条不在', 'docs/design.md', '（第三节第 9 条）', 'docs/design.md 第三节里没有第 9 条'],
    ['X.Y 小节不在', 'docs/design.md', '飞书：见 15.9。', 'docs/design.md 里没有 15.9 这一小节'],
    ['X.Y 第 N 件不在', 'README.md', '见 design 15.1 第 7 件。', 'docs/design.md 15.1里没有第 7 件'],
    [
      '文档名加「标题」，标题不在',
      'docs/design.md',
      '见 README「怎么装」。',
      'README.md 里没有叫「怎么装」的标题',
    ],
    ['「标题」一节不在', 'docs/ops.md', '（「换机恢复」一节）', 'docs/ops.md 里没有叫「换机恢复」的一节'],
    ['plan 的阶段不在', RESULT_DOC, '另见 plan.md P7。', 'plan.md 里没有 P7 这个阶段'],
    ['plan 的条目不在', RESULT_DOC, '另见 plan.md P1「看板」。', 'plan.md 的 P1 里找不到「看板」'],
    // 下面三条是写法本身的问题（空引号、没说哪份、指自己这份里的标题），不是「还没新建」：需求.md 里也照报
    [
      'plan 的条目引号是空的',
      'specs/1-demo/需求.md',
      '另见 plan.md P1「」。',
      'plan.md P1「」引号里是空的，没写是哪一条',
    ],
    [
      '需求文档里光写「第 X 节」、没说哪份',
      'specs/1-demo/需求.md',
      '设计依据：第三节。',
      '「第三节」没说是哪份文档（specs/1-demo/需求.md 自己没有编号的节）：前面写上 design、plan 或 ops',
    ],
    [
      '方案里「「X」一节」指的是它自己的标题，自己没有这一节',
      'specs/1-demo/方案.md',
      '拆分见「先后」一节。',
      'specs/1-demo/方案.md 里没有叫「先后」的一节',
    ],
  ];

  it.each(cases)('%s', (_name, file, line, message) => {
    const { report, first } = withLines(file, [line]);
    expect(report.problems).toEqual([{ file, line: first, message }]);
  });

  it('引的话只认原文：写大意、小标题改了名、指到别的节都报，原文照过', () => {
    const spec = RESULT_DOC;
    const { report, first } = withLines(spec, [
      '见 design 第八节「为什么是命令不是 MCP」。', // 原文
      '见 design 第八节「做成命令不是 MCP」。', // 上下两条拼出来的大意
      '见 design 第三节「仓库目录」。', // 「仓库结构」改名后的样子
      '见 design 第十五节「为什么是命令不是 MCP」。', // 指到别的节
    ]);
    expect(report.problems.map(formatProblem)).toEqual([
      `${spec}:${first + 1}  docs/design.md 第八节里找不到「做成命令不是 MCP」`,
      `${spec}:${first + 2}  docs/design.md 第三节里找不到「仓库目录」`,
      `${spec}:${first + 3}  docs/design.md 第十五节里找不到「为什么是命令不是 MCP」`,
    ]);
  });

  it('#41 审查在真文档上造的三种断法都报：删掉引的那一条、改掉半个标签、意思改反', () => {
    const spec = RESULT_DOC;
    const pointers = [
      '见 design 第八节「为什么是命令不是 MCP」。',
      '见 design 第八节「再主动，做成 fleet 命令」。',
      '见 design 第一节「会话断了接着干」。',
    ];
    expect(withLines(spec, pointers).report.problems).toEqual([]);
    const broken = DESIGN.replace('  - 为什么是命令不是 MCP：各家都会跑命令。\n', '')
      .replace('做成 `fleet` 命令', '做成 `fleet` 配置')
      .replace('会话断了接着干', '会话断了从头干');
    const { report, first } = withLines(spec, pointers, { 'docs/design.md': broken });
    expect(report.problems.map(formatProblem)).toEqual([
      `${spec}:${first}  docs/design.md 第八节里找不到「为什么是命令不是 MCP」`,
      `${spec}:${first + 1}  docs/design.md 第八节里找不到「再主动，做成 fleet 命令」`,
      `${spec}:${first + 2}  docs/design.md 第一节里找不到「会话断了接着干」`,
    ]);
  });

  it('一行里前面写了哪份文档，后面光写的「第 X 节」「X.Y」也按那份查', () => {
    const { report, first } = withLines(RESULT_DOC, ['设计依据：design 第一节、第九节；15.1 第 9 件。']);
    expect(report.problems.map(formatProblem)).toEqual([
      `${RESULT_DOC}:${first}  docs/design.md 里没有第九节`,
      `${RESULT_DOC}:${first}  docs/design.md 15.1里没有第 9 件`,
    ]);
  });

  it('要查的文档读不到、别的文档指过去的那份读不到，都报出来，不当成没问题', () => {
    const files = { ...BASE };
    delete files['docs/ops.md'];
    const report = checkDocPointers(memRepo({ ...files, 'README.md': `${README}- 装机：ops 第一节。\n` }));
    expect(report.problems.map(formatProblem)).toEqual([
      'docs/ops.md:0  读不到这份文档',
      `README.md:${README.split('\n').length}  读不到 docs/ops.md`,
    ]);
  });

  it('specs/ 列不出来：报出来，不当成「specs 下没有文档」', () => {
    const files = { ...BASE };
    delete files['specs/1-demo/需求.md'];
    delete files[RESULT_DOC];
    const report = checkDocPointers(memRepo(files));
    expect(report.problems.map(formatProblem)).toEqual(['specs/:0  列不出这个目录下的文件，里面的文档没查']);
  });
});

describe('文档指针：认得出的写法', () => {
  const good = [
    '见第二节「没人盯就停」，（第三节第 2 条）。', // 章节 + 引的话、第 N 条
    '按 15.1：说一句话；重做（15.1）；见 design 15.1 第 2 件。', // X.Y 的几种写法
    '见 README「文档各管什么」，见 design「随手记任务」，`docs/design.md`「三、已定」。', // 标题、加粗的字
    '另见 plan.md P1「错误按「下一步动作」分流」、plan.md P0 的「仓骨架」一条，plan 的 P1。', // plan 的条目，引号里套引号
    '设计依据：design 第一节、第十五节「随手记任务」；15.1 第 1 件。', // 同一行后面接着写的也算 design 的
    '装法：`deploy/france.sh`、`deploy/*.sh`、packages/x/src/a.ts，[计划](../docs/plan.md)。', // 路径、通配、链接
  ];

  it('都指得到，每一种都认出来了', () => {
    const { report, first } = withLines('docs/design.md', good);
    expect(report.problems.map(formatProblem)).toEqual([]);
    const mine = report.pointers.filter((p) => p.file === 'docs/design.md' && p.line >= first);
    const kinds = new Set<PointerKind>(mine.map((p) => p.kind));
    expect([...kinds].sort()).toEqual(
      ['item', 'link', 'path', 'plan', 'planItem', 'quote', 'section', 'subsection', 'title'].sort(),
    );
    expect(mine.map((p) => p.text)).toEqual(
      expect.arrayContaining([
        'P1「错误按「下一步动作」分流」',
        'docs/design.md「三、已定」',
        'docs/design.md 15.1 第 1 件',
        'deploy/*.sh',
        '../docs/plan.md',
      ]),
    );
  });

  it('ops 自己的「「备份与恢复」一节」按 ops 的标题认', () => {
    const { report, first } = withLines('docs/ops.md', ['（「备份与恢复」一节）']);
    expect(report.problems).toEqual([]);
    expect(report.pointers).toContainEqual({
      kind: 'title',
      file: 'docs/ops.md',
      line: first,
      text: 'docs/ops.md「备份与恢复」一节',
      strict: true,
    });
  });
});

describe('文档指针：需求.md、方案.md 写在动手之前，指到还没有的不报', () => {
  // 方案本来就要写「新建哪个文件、ops 哪一段加什么」：#160 的方案.md 指着要新建的 packages/api/src/handover.ts、
  // 写成「docs/ops.md「让 AI 接活」那段」，引擎直写进主线后，别人的 PR 全被这两行挡红。
  // 下面每一行在 结果.md、design 里都各报几条（最后两条测试），在需求.md、方案.md 里一条不报、但都认出来了。
  const planned = [
    '新建 `packages/x/src/handover.ts`，用法写进 [新文档](../../docs/handover.md)。', // 文件、链接
    '`docs/ops.md`「交给 fleet」那段后加用法，README「交接」里补一句。', // 标题
    '设计依据：design 第二十一节、design 15.9；design 第三节第 9 条，design 第二节「还没写的话」。', // 节、小节、条、引的话
    '对应计划：plan.md P7；plan.md P1「还没有的一条」。', // plan 的阶段、条目
  ];
  const ALL_KINDS: PointerKind[] = [
    'item',
    'link',
    'path',
    'plan',
    'planItem',
    'quote',
    'section',
    'subsection',
    'title',
  ];

  it.each(['specs/1-demo/需求.md', 'specs/1-demo/方案.md'])(
    '%s：不报，每一类都认出来了、标成不严查',
    (file) => {
      const { report, first } = withLines(file, planned);
      expect(report.problems.map(formatProblem)).toEqual([]);
      const mine = report.pointers.filter((p) => p.file === file && p.line >= first);
      expect([...new Set(mine.map((p) => p.kind))].sort()).toEqual(ALL_KINDS);
      expect(mine.filter((p) => p.strict)).toEqual([]);
    },
  );

  it('同样几行写在 结果.md 里：逐条照报（结果写在做完之后，指的东西该在了）', () => {
    const { report, first } = withLines(RESULT_DOC, planned);
    expect(report.problems.map(formatProblem)).toEqual(
      [
        [0, 'packages/x/src/handover.ts 在仓里没有'],
        [0, '链接 ../../docs/handover.md 指的 docs/handover.md 在仓里没有'],
        [1, 'docs/ops.md 里没有叫「交给 fleet」的标题'],
        [1, 'README.md 里没有叫「交接」的标题'],
        [2, 'docs/design.md 里没有第二十一节'],
        [2, 'docs/design.md 里没有 15.9 这一小节'],
        [2, 'docs/design.md 第三节里没有第 9 条'],
        [2, 'docs/design.md 第二节里找不到「还没写的话」'],
        [3, 'plan.md 里没有 P7 这个阶段'],
        [3, 'plan.md 的 P1 里找不到「还没有的一条」'],
      ].map(([k, m]) => `${RESULT_DOC}:${first + Number(k)}  ${m}`),
    );
  });

  it('同样几行写在 docs/design.md 里：逐条照报', () => {
    const file = 'docs/design.md';
    const { report, first } = withLines(file, planned);
    expect(report.problems.map(formatProblem)).toEqual(
      [
        [0, 'packages/x/src/handover.ts 在仓里没有'],
        [0, '链接 ../../docs/handover.md 指的 ../docs/handover.md 在仓里没有'],
        [1, 'docs/ops.md 里没有叫「交给 fleet」的标题'],
        [1, 'README.md 里没有叫「交接」的标题'],
        [2, 'docs/design.md 里没有第二十一节'],
        [2, 'docs/design.md 里没有 15.9 这一小节'],
        [2, 'docs/design.md 第三节里没有第 9 条'],
        [2, 'docs/design.md 第二节里找不到「还没写的话」'],
        [3, 'plan.md 里没有 P7 这个阶段'],
        [3, 'plan.md 的 P1 里找不到「还没有的一条」'],
      ].map(([k, m]) => `${file}:${first + Number(k)}  ${m}`),
    );
  });

  it('「每一类查了几个」只数指不到会报的：某一类只写在需求.md、方案.md 里就是 0，不当成查过了', () => {
    // 底子里 plan 的阶段、条目只写在 需求.md 里
    const base = checkDocPointers(memRepo(BASE));
    expect(base.pointers.filter((p) => p.kind === 'planItem')).toEqual([
      { kind: 'planItem', file: 'specs/1-demo/需求.md', line: 3, text: 'P0「仓骨架」', strict: false },
    ]);
    expect([base.checked.plan, base.checked.planItem]).toEqual([0, 0]);
    // 同一句写进 结果.md：查了、会报，算上
    const { report } = withLines(RESULT_DOC, ['对应计划：plan.md P0「仓骨架」。']);
    expect([report.checked.plan, report.checked.planItem]).toEqual([1, 1]);
  });
});

describe('文档指针：故意不查的', () => {
  const ignored: [name: string, file: string, lines: string[]][] = [
    ['围栏代码块里的示例', 'docs/design.md', ['```', 'edge/  以后才有', '见第九节 `docs/nope.md`', '```']],
    ['HTML 注释里的占位', 'README.md', ['<!-- 见第九节，`docs/nope.md`，plan.md P9 -->']],
    ['别的仓的路径', 'docs/ops.md', ['按 windsurf-dao 仓 `docs/decisions/x.md` 的「先观测」。']],
    [
      '版本号、小数不当小节号',
      'docs/design.md',
      ['用 Opus 5.5（先用订阅）、Node 22.23、内存先按 1.2–1.6G 估。'],
    ],
    ['没有小节编号的文档里，括号里的小数也不当', 'docs/ops.md', ['最高是 16（16.6）。']],
    [
      '别的仓 README 的「…」两节',
      'README.md',
      ['见那个仓 README 的「解开一个文件」和「法国整机没了怎么恢复」两节。'],
    ],
    [
      '机器上的路径、家目录、标签名、占位',
      'docs/ops.md',
      ['`/etc/fleet-dao/x.env`、`~/.fleet-dao/k.txt`、`model/`、`kind/bug`、`specs/<号>-<短名>/`、`hk.env`'],
    ],
    ['外面的链接', 'README.md', ['[里程碑](https://github.com/o/r/milestones)、[这一段](#常用)']],
    ['路径后面紧跟中文，截不准的不查', 'docs/ops.md', ['放 specs/99-不存在/ 下面']],
    [
      '不是指针的「节」和「P」',
      'docs/design.md',
      ['见 docs/plan.md 的 PX 一节；前面各节；验证环节；第一个里程碑。'],
    ],
  ];

  it.each(ignored)('%s', (_name, file, lines) => {
    const { report, first } = withLines(file, lines);
    expect(report.problems.map(formatProblem)).toEqual([]);
    const mine = report.pointers.filter((p) => p.file === file && p.line >= first);
    // 「不是指针」那条里的 docs/plan.md 本身是个真路径，照查；别的一条都不该认
    expect(mine.filter((p) => p.text !== 'docs/plan.md')).toEqual([]);
  });
});

describe('文档指针：读不到的明确报「没查成」，不当成「没有」（需求.md、方案.md 里也照报）', () => {
  // 列目录回 undefined 有两种：不是目录（路径穿过了一个文件，算没有）、是目录却读不到（在不在没查成）。
  // 读不到当成「没有」，需求.md、方案.md 里「没有」又不报，读不到就被悄悄吞了（#162 合并后补审）。
  function broken(file: string, lines: string[], breakRepo: (repo: RepoView) => RepoView) {
    const base = BASE[file] ?? '';
    const first = base.split('\n').length;
    const repo = memRepo({ ...BASE, [file]: `${base}${lines.join('\n')}\n` });
    return { report: checkDocPointers(breakRepo(repo)), first };
  }
  /** dir 是目录，却列不出来。 */
  const unlistable =
    (dir: string) =>
    (repo: RepoView): RepoView => ({ ...repo, list: (rel) => (rel === dir ? undefined : repo.list(rel)) });

  it.each(['specs/1-demo/需求.md', 'specs/1-demo/方案.md', RESULT_DOC, 'docs/design.md'])(
    '%s：路径、链接经过的目录列不出来',
    (file) => {
      const link = `${'../'.repeat(file.split('/').length - 1)}packages/x/README.md`;
      const { report, first } = broken(
        file,
        ['新建 `packages/x/src/new.ts`。', `见 [说明](${link})。`],
        unlistable('packages/x'),
      );
      expect(report.problems.map(formatProblem)).toEqual([
        `${file}:${first}  packages/x/src/new.ts 在不在没查成：读不到 packages/x/`,
        `${file}:${first + 1}  链接 ${link} 指的 packages/x/README.md 在不在没查成：读不到 packages/x/`,
      ]);
    },
  );

  it('指的是目录、却连它是不是目录都看不出（stat 失灵）', () => {
    const statBroken = (repo: RepoView): RepoView => ({
      ...repo,
      isDir: (rel) => rel !== 'deploy' && repo.isDir(rel),
      exists: (rel) => rel !== 'deploy' && repo.exists(rel),
    });
    const { report, first } = broken('specs/1-demo/需求.md', ['装法放 `deploy/` 下。'], statBroken);
    expect(report.problems.map(formatProblem)).toEqual([
      `specs/1-demo/需求.md:${first}  deploy/ 在不在没查成：读不到 deploy/`,
    ]);
  });

  it('仓根列不出来：报出来，不当成「没有路径指针」', () => {
    const { report } = broken('docs/ops.md', ['装法在 `deploy/nope.sh`。'], unlistable(''));
    expect(report.problems.map(formatProblem)).toEqual(['.:0  列不出仓根下的文件：路径、链接指针都没法查']);
  });
});

describe('全仓的文档（main 上现有的，加上本 PR 改的）', () => {
  const report = checkDocPointers(fsRepo(ROOT));

  it('查了 design、plan、ops、README 和 specs 下的文档', () => {
    expect(report.files).toEqual(expect.arrayContaining([...DOCS]));
    expect(report.files.some((f) => f.startsWith('specs/'))).toBe(true);
  });

  // 每一类先断言「认出了至少一个」：规则认不出了，和「全都指得到」看起来一样是绿的，得分开。
  // 某一类指针在文档里真的删光了，就把它从这里去掉。
  it('每一类指针都认出了至少一个', () => {
    const empty = Object.entries(report.checked).filter(([, n]) => n === 0);
    expect(empty).toEqual([]);
  });

  it('都指得到', () => {
    expect(report.problems.map(formatProblem)).toEqual([]);
  });
});
