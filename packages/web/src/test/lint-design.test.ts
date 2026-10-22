// 设计规范检查（#1847，并入了 #182 / #1446 的 lint-arbitrary）。扫描脚本在 packages/web/scripts/lint-design.ts，
// 规则表在 docs/design/驾驶舱界面.md 第八节。本测试盯三块：
//   1) 每条规则 R0–R12：一条故意造红的写法要报出来，一条合规写法要放过；
//   2) 计数；
//   3) 整个 packages/web/src 严格模式一条违规都不许有（没有旧账清单，#1855）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  ALLOWLIST,
  check,
  countHits,
  formatHit,
  type Hit,
  LAYER_RULES,
  lex,
  RULE_IDS,
  type RuleId,
  scanSource,
  utilityOf,
} from '../../scripts/lint-design.ts';

const PAGE = 'src/routes/sample.tsx';

/** 只看严格规则 R0–R12 的命中（页面夹具常顺带踩到 R13–R20，那些在下面单独测）。 */
function strictScan(source: string, file = PAGE): Hit[] {
  return scanSource(source, file).filter((h) => !LAYER_RULES.includes(h.rule));
}
function rulesOf(source: string, file = PAGE): RuleId[] {
  return strictScan(source, file).map((h) => h.rule);
}
function classesOf(source: string, file = PAGE): string[] {
  return strictScan(source, file).map((h) => h.cls);
}

describe('每条规则：造红的报、合规的放', () => {
  test('R0 任意值：text-[13px]、2xl:max-w-[380px] 报', () => {
    expect(classesOf(`<div className="text-[13px] 2xl:max-w-[380px] grid-cols-[240px_1fr]" />`)).toEqual([
      'text-[13px]',
      '2xl:max-w-[380px]',
      'grid-cols-[240px_1fr]',
    ]);
  });
  test('R0 放行：引 CSS 变量的、data-[…] 变体', () => {
    expect(
      rulesOf(`<div className="shadow-[0_1px_0_var(--border)] data-[spacing=0]:rounded-none" />`),
    ).toEqual([]);
  });

  test('R1 颜色：默认色板、white、black、语义色上的透明度都报', () => {
    expect(rulesOf(`cn('bg-red-500 text-white bg-black/50 bg-st-fail/10 border-st-fail/[0.4]')`)).toEqual([
      'R1',
      'R1',
      'R1',
      'R1',
      'R1',
    ]);
  });
  test('R1 放行：语义色、状态淡底和描边令牌、ui/ 里的聚焦圈', () => {
    expect(
      rulesOf(`cn('bg-st-fail-soft border-st-fail-line text-ink-fail bg-scrim text-muted-foreground')`),
    ).toEqual([]);
    expect(rulesOf(`cn('focus-visible:ring-ring/50')`, 'src/components/ui/button.tsx')).toEqual([]);
    // 同一个聚焦圈写在页面里不放行
    expect(rulesOf(`cn('focus-visible:ring-ring/50')`)).toEqual(['R1']);
  });

  test('R2 字号：Tailwind 默认字号、#182 旧名、画布外的 text-canvas 报', () => {
    expect(rulesOf(`"text-xs text-sm text-caption text-stat-num text-2xl text-canvas"`)).toEqual([
      'R2',
      'R2',
      'R2',
      'R2',
      'R2',
      'R2',
    ]);
  });
  test('R2 放行：六档字号；text-canvas 在画布目录里', () => {
    expect(
      rulesOf(`"text-meta text-body text-heading text-title text-display text-left text-ink-run"`),
    ).toEqual([]);
    expect(rulesOf(`"text-canvas"`, 'src/components/home/board/nodes.tsx')).toEqual([]);
  });

  test('R3 字重：font-bold、font-light 报', () => {
    expect(rulesOf(`"font-bold md:font-light"`)).toEqual(['R3', 'R3']);
  });
  test('R3 放行：normal、medium、semibold、字体族', () => {
    expect(rulesOf(`"font-normal font-medium font-semibold font-mono"`)).toEqual([]);
  });

  test('R4 间距：p-3.5、gap-7、-mt-9 报', () => {
    expect(classesOf(`"p-3.5 gap-7 -mt-9 lg:pt-7"`)).toEqual(['p-3.5', 'gap-7', '-mt-9', 'lg:pt-7']);
  });
  test('R4 放行：档位里的、auto、专用名', () => {
    expect(rulesOf(`"p-0 px-4 py-2.5 gap-1.5 space-y-6 -mx-px m-auto pl-timeline-label"`)).toEqual([]);
  });

  test('R5 圆角：rounded、rounded-xl、rounded-2xl、rounded-2 报', () => {
    expect(classesOf(`"rounded rounded-xl rounded-t-2xl rounded-2"`)).toEqual([
      'rounded',
      'rounded-xl',
      'rounded-t-2xl',
      'rounded-2',
    ]);
  });
  test('R5 放行：sm、md、lg、full、none 和方向变体', () => {
    expect(rulesOf(`"rounded-sm rounded-md rounded-lg rounded-full rounded-none rounded-t-lg"`)).toEqual([]);
  });

  test('R6 阴影：shadow-sm、shadow-lg、旧名 shadow-card-edge 报', () => {
    expect(rulesOf(`"shadow-sm shadow-lg shadow-card-edge shadow"`)).toEqual(['R6', 'R6', 'R6', 'R6']);
  });
  test('R6 放行：xs、card、overlay、modal 和三个特效', () => {
    expect(
      rulesOf(`"shadow-xs shadow-card shadow-overlay shadow-modal shadow-row-selected shadow-none"`),
    ).toEqual([]);
  });

  test('R7 行高字距：leading-4、tracking-tight 报', () => {
    expect(rulesOf(`"leading-4 tracking-tight"`)).toEqual(['R7', 'R7']);
  });
  test('R7 放行：leading-none、tight、snug、normal、relaxed', () => {
    expect(rulesOf(`"leading-none leading-tight leading-snug leading-normal leading-relaxed"`)).toEqual([]);
  });

  test('R8 手写版式：页面里 border + bg-card、border-dashed + text-center 报', () => {
    expect(classesOf(`<section className="rounded-lg border bg-card" />`)).toEqual(['border + bg-card']);
    expect(classesOf(`<p className="border-dashed text-center" />`)).toEqual(['border-dashed + text-center']);
  });
  test('R8 放行：layout/、ui/ 里写；页面里只有其一', () => {
    expect(rulesOf(`"rounded-lg border bg-card"`, 'src/components/layout/section.tsx')).toEqual([]);
    expect(rulesOf(`"rounded-lg border bg-card"`, 'src/components/ui/card.tsx')).toEqual([]);
    expect(rulesOf(`"border bg-muted"`)).toEqual([]);
  });

  test('R9 原生控件：页面里 <select>、带图标的 <input> 报', () => {
    const src = [
      `import { Search } from 'lucide-react';`,
      '<select value={x}>',
      '<label>',
      '  <Search aria-hidden />',
      '  <input type="search" />',
      '</label>',
    ].join('\n');
    expect(strictScan(src, PAGE).map((h) => [h.rule, h.line])).toEqual([
      ['R9', 2],
      ['R9', 5],
    ]);
  });
  test('R9 放行：ui/ 里的 select；没有图标的 input；字符串里的 <select', () => {
    expect(rulesOf('<select value={x}>', 'src/components/ui/native-select.tsx')).toEqual([]);
    expect(rulesOf(`<input type="checkbox" />`)).toEqual([]);
    expect(rulesOf(`const s = '<select>';`)).toEqual([]);
  });

  test('R10 组件令牌：页面里 h-control、p-section、gap-stack、任意值里的 var(--spacing-row) 报', () => {
    expect(
      classesOf(
        `<div className="h-control p-section gap-stack md:gap-section-gap min-h-[var(--spacing-row)]" />`,
      ),
    ).toEqual(['h-control', 'p-section', 'gap-stack', 'md:gap-section-gap', 'min-h-[var(--spacing-row)]']);
    expect(rulesOf(`"h-row"`, 'src/components/home/board/card.tsx')).toEqual(['R10']);
  });
  test('R10 放行：layout/、ui/ 里写；flex-row、grid-flow-row 这类撞了名字的不算', () => {
    expect(rulesOf(`"h-control p-section gap-stack min-h-row"`, 'src/components/layout/section.tsx')).toEqual(
      [],
    );
    expect(rulesOf(`"h-control size-row"`, 'src/components/ui/button.tsx')).toEqual([]);
    expect(rulesOf(`"flex-row grid-flow-row h-8 gap-3"`)).toEqual([]);
  });

  test('R11 状态字不许裸文字：<Tag>关着</Tag>、<span>在跑</span> 报（故意造红）', () => {
    expect(rulesOf(`<Tag>关着</Tag>`)).toEqual(['R11']);
    expect(rulesOf(`<span className="text-meta">\n  在跑\n</span>`)).toEqual(['R11']);
    expect(rulesOf(`<b>开着</b><i>已关</i>`)).toEqual(['R11', 'R11']);
    const [hit] = strictScan(`\n<Tag>关着</Tag>`, PAGE);
    expect(hit?.line).toBe(2);
    expect(formatHit(hit as Hit)).toContain('StatusBadge');
  });
  test('R11 放行：经 StatusBadge 的 label、带别的字的句子、字符串里的词', () => {
    expect(rulesOf(`<StatusBadge tone="stop" label="关着" />`)).toEqual([]);
    expect(rulesOf(`<p>总开关关着只是不派活</p>`)).toEqual([]);
    expect(rulesOf(`<span>在跑 3 个</span>`)).toEqual([]);
    expect(rulesOf(`<span>已关 <b>3</b> 条路由</span>`)).toEqual([]);
    expect(rulesOf(`const word = '在跑';`)).toEqual([]);
  });

  // R12（#2009）：会发写请求的按钮要有忙态
  test('R12 写请求按钮没忙态：onClick 直接、经函数名、经 useCallback 调 mutate 都报（故意造红）', () => {
    const direct = `export function A() {
  const save = useSave();
  return <Button onClick={() => save.mutate({ on: true })}>保存</Button>;
}`;
    expect(rulesOf(direct)).toEqual(['R12']);
    expect(strictScan(direct, PAGE)[0]?.line).toBe(3);
    expect(formatHit(strictScan(direct, PAGE)[0] as Hit)).toContain('loading-ok');

    // 确认框老写法：preventDefault 后调本文件里的 confirm()，confirm 里 mutate
    const viaName = `export function B() {
  const update = useUpdate();
  const confirm = () => {
    update.mutate({ on: false }, { onSuccess: () => {} });
  };
  return (
    <AlertDialogAction
      onClick={(e) => {
        e.preventDefault();
        confirm();
      }}
    >
      关闭
    </AlertDialogAction>
  );
}`;
    expect(rulesOf(viaName)).toEqual(['R12']);

    const viaCallback = `export function C() {
  const { mutateAsync } = useTaskAction();
  const send = useCallback(async () => { await mutateAsync({ id: 1 }); }, [mutateAsync]);
  return <AlertDialogAction onClick={() => void send()}>叫停</AlertDialogAction>;
}`;
    expect(rulesOf(viaCallback)).toEqual(['R12']);

    const form = `export function D() {
  const save = useSave();
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(1); }}>
      <Button type="submit">保存</Button>
      <SaveButton canSave />
    </form>
  );
}`;
    expect(rulesOf(form)).toEqual(['R12', 'R12']);
  });

  test('R12 放行：loading、onConfirm、disabled 带 pending、SaveButton pending、不发请求的按钮', () => {
    expect(
      rulesOf(`export function A() {
  const save = useSave();
  return (
    <>
      <Button loading={save.isPending} onClick={() => save.mutate(1)}>保存</Button>
      <Button disabled={save.isPending} onClick={() => save.mutate(2)}>保存</Button>
      <Button aria-disabled={pending} onClick={() => save.mutate(3)}>保存</Button>
      <AlertDialogAction onConfirm={() => save.mutateAsync(4)}>确认</AlertDialogAction>
      <Button onClick={() => setOpen(true)}>打开</Button>
      <form onSubmit={() => save.mutate(5)}>
        <SaveButton canSave pending={save.isPending} />
        <Button type="button" onClick={() => setOpen(false)}>取消</Button>
      </form>
    </>
  );
}`),
    ).toEqual([]);
  });

  test('R12 例外：开标签里或上一行写 loading-ok: <理由> 放行；只写 loading-ok: 没理由不放行', () => {
    expect(
      rulesOf(`export function A() {
  const save = useSave();
  return (
    <>
      {/* loading-ok: 只是本地开关，写请求在别处 */}
      <Button onClick={() => save.mutate(1)}>一</Button>
      <Button
        // loading-ok: 忙态由外面的播放器接管
        onClick={() => save.mutate(2)}
      >
        二
      </Button>
    </>
  );
}`),
    ).toEqual([]);
    expect(
      rulesOf(`export function A() {
  const save = useSave();
  return (
    <>
      {/* loading-ok: */}
      <Button onClick={() => save.mutate(1)}>一</Button>
    </>
  );
}`),
    ).toEqual(['R12']);
  });

  test('R12 解析不了的文件报出来，不当没事放过', () => {
    const [hit] = strictScan(`const x = save.mutate(1); <Button onClick={`, PAGE);
    expect(hit?.rule).toBe('R12');
    expect(hit?.cls).toBe('解析不了');
  });
});

// R13–R20（#3509）：业务层 = routes + components，组件层 = components/layout、ui、shell。
const LAYOUT = 'src/components/layout/section.tsx';
const SHELL = 'src/components/shell/sidebar.tsx';
const BIZ = 'src/components/task-card.tsx';
/** 只留 R13–R20 的命中（造红夹具常顺带踩到 R0–R12，不在这里断言）。 */
function ratchetOf(source: string, file = PAGE): RuleId[] {
  return scanSource(source, file)
    .map((h) => h.rule)
    .filter((r) => LAYER_RULES.includes(r));
}

describe('R13–R20 业务层规则：造红的报、合规的放', () => {
  test('R13 业务层写样式类：颜色、字号、字重、边框、底色、圆角、阴影、边距、gap、过渡都报，并提示用哪个组件', () => {
    const src = `<div className="text-muted-foreground text-meta font-medium border bg-fill-2 rounded-md shadow-pop p-4 gap-2 mt-3 transition-colors hover:bg-fill-3" />`;
    expect(ratchetOf(src)).toEqual(Array(12).fill('R13'));
    expect(ratchetOf(src, BIZ)).toEqual(Array(12).fill('R13'));
    const [first] = scanSource(`<p className="text-muted-foreground" />`, PAGE).filter(
      (h) => h.rule === 'R13',
    );
    expect(first?.fix).toContain('<Text tone');
    expect(first?.cls).toBe('text-muted-foreground');
  });
  test('R13 放行：位置类、显隐、num；组件层（layout、ui、shell）随便写', () => {
    expect(
      ratchetOf(
        `<div className="min-w-0 flex-1 shrink-0 col-span-2 row-span-1 sr-only hidden md:block num text-left text-center truncate flex items-center w-55 h-10" />`,
      ),
    ).toEqual([]);
    for (const f of [LAYOUT, 'src/components/ui/button.tsx', SHELL]) {
      expect(ratchetOf(`<div className="text-ink-3 border rounded-md bg-card p-4 gap-2" />`, f)).toEqual([]);
    }
  });
  test('R13 单个英文单词不当类名（border 单独一个词的普通文字）', () => {
    expect(ratchetOf(`const label = 'border';`)).toEqual([]);
    expect(ratchetOf(`const label = 'rounded border';`)).toEqual(['R13', 'R13']);
  });

  test('R14 业务层 import components/ui、radix-ui、motion 报（相对路径按文件位置解析）', () => {
    expect(ratchetOf(`import { Button } from '../components/ui/button';`)).toEqual(['R14']);
    expect(ratchetOf(`import { Button } from './ui/button';`, BIZ)).toEqual(['R14']);
    expect(ratchetOf(`import { Dialog } from 'radix-ui';`)).toEqual(['R14']);
    expect(ratchetOf(`import { Dialog } from '@radix-ui/react-dialog';`)).toEqual(['R14']);
    expect(ratchetOf(`import { motion } from 'motion/react';`, BIZ)).toEqual(['R14']);
    expect(
      scanSource(`\nimport { Button } from '../components/ui/button';`, PAGE).find((h) => h.rule === 'R14')
        ?.line,
    ).toBe(2);
  });
  test('R14 放行：从 layout 引；组件层自己引 ui、motion；包名只是长得像', () => {
    expect(ratchetOf(`import { Button } from '../components/layout/button';`)).toEqual([]);
    expect(ratchetOf(`import { Button } from './ui/button';`, LAYOUT)).toEqual([]);
    expect(ratchetOf(`import { Button } from '../ui/button';`, SHELL)).toEqual([]);
    expect(ratchetOf(`import { motion } from 'motion/react';`, LAYOUT)).toEqual([]);
    expect(ratchetOf(`import x from 'motionless';`)).toEqual([]);
  });

  test('R15 业务层 style={{…}} 报；组件层放行', () => {
    expect(ratchetOf(`<div style={{ width: pct }} />`)).toEqual(['R15']);
    expect(ratchetOf(`<div style={{ width: pct }} />`, LAYOUT)).toEqual([]);
    expect(ratchetOf(`<div style={styles} />`)).toEqual([]);
  });

  test('R16 时长缓动不在档位：duration-500、ease-linear、motion 里写死的数都报，连组件层一起查', () => {
    expect(ratchetOf(`"duration-500 ease-linear md:duration-700 ease-in"`, LAYOUT)).toEqual([
      'R16',
      'R16',
      'R16',
      'R16',
    ]);
    // 业务层写这些类，R13 也报
    expect(ratchetOf(`"duration-500 ease-linear"`).sort()).toEqual(['R13', 'R13', 'R16', 'R16']);
    expect(ratchetOf(`"duration-500"`, 'src/components/ui/sheet.tsx')).toEqual(['R16']);
    expect(ratchetOf(`"duration-150"`, LAYOUT)).toEqual(['R16']);
    expect(
      ratchetOf(
        `import { motion } from 'motion/react';\nconst t = { duration: 0.5, ease: 'linear' };`,
        LAYOUT,
      ),
    ).toEqual(['R16', 'R16']);
    expect(ratchetOf(`<motion.div transition={{ duration: 0.4 }} />`, LAYOUT)).toEqual(['R16']);
  });
  test('R16 放行：档位里的、arco 缓动；和动效无关的 duration 字段', () => {
    expect(
      ratchetOf(`"duration-100 duration-200 duration-300 ease-arco ease-out ease-in-out"`, LAYOUT),
    ).toEqual([]);
    expect(
      ratchetOf(
        `import { motion } from 'motion/react';\nconst t = { duration: 0.2, ease: [0.34, 0.69, 0.1, 1] };`,
        LAYOUT,
      ),
    ).toEqual([]);
    expect(ratchetOf(`const row = { duration: 3600 };`)).toEqual([]);
  });

  test('R17 业务层原生 button、table、h1–h4、dl、progress、hr 报；组件层放行；th、h5、自定义组件不算', () => {
    const src = `<><button /><table /><h1 /><h2>x</h2><h3 /><h4 /><dl /><progress /><hr /></>`;
    expect(ratchetOf(src)).toEqual(Array(9).fill('R17'));
    expect(ratchetOf(src, LAYOUT)).toEqual([]);
    expect(ratchetOf(`<><Button /><Table /><th /><h5 /><header /><hgroup /></>`)).toEqual([]);
    expect(ratchetOf(`const s = '<button>';`)).toEqual([]);
  });

  test('R18 Section/Card 套 Section/Card 报；展开区里再套带底色或描边的框报', () => {
    expect(ratchetOf(`const A = () => <Section><Card>x</Card></Section>;`)).toEqual(['R18']);
    expect(ratchetOf(`const A = () => <Card><div><Section>x</Section></div></Card>;`)).toEqual(['R18']);
    expect(
      ratchetOf(
        `const A = () => <Collapse><div className="rounded-md border bg-fill-1">x</div></Collapse>;`,
      ).filter((r) => r === 'R18'),
    ).toEqual(['R18']);
    expect(
      ratchetOf(
        `const A = () => <Table expandedRowRender={() => <div className="bg-fill-2">x</div>} />;`,
      ).filter((r) => r === 'R18'),
    ).toEqual(['R18']);
  });
  test('R18 放行：并排的两个容器；展开区里没有框；组件层', () => {
    expect(ratchetOf(`const A = () => <><Section>a</Section><Card>b</Card></>;`)).toEqual([]);
    expect(ratchetOf(`const A = () => <Collapse><Descriptions /></Collapse>;`)).toEqual([]);
    expect(ratchetOf(`const A = () => <Section><Card>x</Card></Section>;`, LAYOUT)).toEqual([]);
  });

  test("R19 对 query 的 data 写 ?? 0、|| 0、?? []、|| '正常' 报", () => {
    const src = `export function A() {
  const { data } = useTasks();
  const q = useQuota();
  const { data: rows } = useRows();
  const a = data?.count ?? 0;
  const b = data?.items || 0;
  const c = rows ?? [];
  const d = q.data?.state || '正常';
  const e = q.data.list ?? [];
  return null;
}`;
    expect(ratchetOf(src)).toEqual(['R19', 'R19', 'R19', 'R19', 'R19']);
    expect(scanSource(src, PAGE).find((h) => h.rule === 'R19')?.line).toBe(5);
  });
  test('R19 放行：不是 query 的数据、非默认值、组件层', () => {
    const src = `export function A() {
  const { data } = useTasks();
  const local = props.count ?? 0;
  const label = data?.name ?? '未命名';
  const n = data?.count ?? null;
  const [list] = useState([]);
  const x = list ?? [];
  return null;
}`;
    expect(ratchetOf(src)).toEqual([]);
    expect(ratchetOf(`function A() { const { data } = useTasks(); return data ?? 0; }`, LAYOUT)).toEqual([]);
  });

  test('R20 StatusBadge 写 tone=、label= 报；状态中文映射表报', () => {
    expect(
      ratchetOf(`const A = () => <StatusBadge tone="ok" label="在跑" />;`).filter((r) => r === 'R20'),
    ).toEqual(['R20', 'R20']);
    expect(ratchetOf(`const M = { running: '在干活', failed: '出错了', other: 'x' };`)).toEqual(['R20']);
    expect(ratchetOf(`const M: Record<string, string> = { 'ok': '正常', 'error': '异常' };`)).toEqual([
      'R20',
    ]);
  });
  test('R20 主按钮：.map( 里的报；同一块区域第二个报', () => {
    expect(ratchetOf(`const A = () => rows.map((r) => <Button variant="primary">{r}</Button>);`)).toEqual([
      'R20',
    ]);
    expect(
      ratchetOf(
        `const A = () => <><Button variant="primary">a</Button><Button variant="primary">b</Button></>;`,
      ),
    ).toEqual(['R20']);
    // 同一个 Form / Section 里两个
    expect(
      ratchetOf(
        `const A = () => <Section><Button variant="primary">a</Button><Stack><Button variant="primary">b</Button></Stack></Section>;`,
      ),
    ).toEqual(['R20']);
  });
  test('R20 放行：列表里只给第一行（下标 === 0）或被选中那一行（=== selected…）画主按钮，整块恰好一个', () => {
    expect(
      ratchetOf(
        `const A = () => rows.map((r, i) => <Button variant={i === 0 ? 'primary' : 'secondary'}>{r}</Button>);`,
      ),
    ).toEqual([]);
    expect(
      ratchetOf(
        `const A = ({ lead }) => opts.map((o, i) => <Button variant={lead && i === 0 && o.recommended ? 'primary' : 'secondary'}>{o.label}</Button>);`,
      ),
    ).toEqual([]);
    expect(
      ratchetOf(
        `const A = () => <Section>{rows.map((r) => <Button variant={r.id === selectedId ? 'primary' : 'secondary'}>{r.n}</Button>)}</Section>;`,
      ),
    ).toEqual([]);
  });
  test('R20 列表里的条件主按钮没把列表钉在一行上仍报；钉了一行但同一块里还有别的主按钮也报（故意造红）', () => {
    // 条件可能放出多行
    expect(
      ratchetOf(
        `const A = () => rows.map((r) => <Button variant={r.ok ? 'primary' : 'secondary'}>{r.n}</Button>);`,
      ),
    ).toEqual(['R20']);
    expect(
      ratchetOf(
        `const A = () => rows.map((r, i) => <Button variant={i === 0 || r.ok ? 'primary' : 'secondary'}>{r.n}</Button>);`,
      ),
    ).toEqual(['R20']);
    // 第一行一个，块里另有写死的主按钮：两个
    expect(
      ratchetOf(
        `const A = () => <Section><Button variant="primary">全部</Button>{rows.map((r, i) => <Button variant={i === 0 ? 'primary' : 'secondary'}>{r.n}</Button>)}</Section>;`,
      ),
    ).toEqual(['R20']);
  });
  test('R20 按条件选主按钮也判：variant={条件 ? "primary" : …} 同一块里和别的主按钮凑成两个也报（故意造红）', () => {
    expect(
      ratchetOf(
        `const A = () => <Form><Button variant="primary">a</Button><Button variant={ok ? 'primary' : 'secondary'}>b</Button></Form>;`,
      ),
    ).toEqual(['R20']);
    expect(
      ratchetOf(
        `const A = () => <Form><Button variant={ok && 'primary'}>a</Button><Button variant={ok ? 'primary' : 'outline'}>b</Button></Form>;`,
      ),
    ).toEqual(['R20']);
  });
  test('R20 放行：不同块里各一个主按钮（Form 里一个、外面一个）；条件主按钮单独一个；条件里没有 primary', () => {
    expect(
      ratchetOf(
        `const A = () => <AuthCard><Form><Button variant="primary">登录</Button></Form><Button variant={only ? 'primary' : 'outline'}>飞书</Button></AuthCard>;`,
      ),
    ).toEqual([]);
    expect(
      ratchetOf(
        `const A = () => <><Section><Button variant="primary">a</Button></Section><Section><Button variant="primary">b</Button></Section></>;`,
      ),
    ).toEqual([]);
    expect(
      ratchetOf(
        `const A = () => <><Button variant={ok ? 'secondary' : 'outline'}>a</Button><Button variant="primary">b</Button></>;`,
      ),
    ).toEqual([]);
  });
  test('R20 放行：status= 取字典、一个主按钮、次按钮在 .map( 里、只有一个状态键的对象、组件层', () => {
    expect(ratchetOf(`const A = () => <StatusBadge status="task:running" />;`)).toEqual([]);
    expect(
      ratchetOf(
        `const A = () => <><Button variant="primary">a</Button>{rows.map((r) => <Button variant="default">{r}</Button>)}</>;`,
      ),
    ).toEqual([]);
    expect(ratchetOf(`const M = { running: '在干活', title: '标题' };`)).toEqual([]);
    expect(ratchetOf(`const A = () => <StatusBadge tone="ok" label="在跑" />;`, LAYOUT)).toEqual([]);
  });
});

describe('R13–R20 也是严格模式：没有基线，一条都不放', () => {
  const hitsOf = (src: string, file: string) =>
    scanSource(src, file).filter((h) => LAYER_RULES.includes(h.rule));

  test('任何文件（老文件、新文件一样）有一处 R13–R20 就报，不分基线（故意造红）', () => {
    for (const file of ['src/routes/old.tsx', 'src/routes/brand-new.tsx']) {
      const errors = check(hitsOf(`<p className="text-ink-3 p-4" />`, file));
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain(file);
      expect(errors[0]).toContain('R13');
    }
  });
  test('合规的写法放行：check 返回空', () => {
    expect(check(hitsOf(`<Text tone="secondary">x</Text>`, 'src/routes/old.tsx'))).toEqual([]);
  });
  test('R0–R12 和 R13–R20 一起报，都不进任何清单', () => {
    const errors = check(scanSource(`<p className="text-sm p-4" />`, 'src/routes/old.tsx'));
    expect(errors.some((e) => e.includes('R2'))).toBe(true);
    expect(errors.some((e) => e.includes('R13'))).toBe(true);
  });
  test('基线文件和棘轮入口已经删了：脚本不再导出基线函数', async () => {
    const mod = (await import('../../scripts/lint-design.ts')) as Record<string, unknown>;
    for (const gone of [
      'loadBaseline',
      'parseBaseline',
      'compareToBaseline',
      'ratchetCounts',
      'BASELINE_PATH',
    ]) {
      expect(mod[gone], gone).toBeUndefined();
    }
  });
});

describe('词法和报错', () => {
  test('注释里的类名不算；模板串的静态段和插值里的字符串都算', () => {
    const src = [
      '// 原来是 text-xs',
      '/* rounded-xl */',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 样例本身就是一段带插值的源码
      'const a = `px-4 text-sm ${on ? "font-bold" : ""} rounded`;',
    ].join('\n');
    expect(classesOf(src)).toEqual(['text-sm', 'font-bold', 'rounded']);
  });
  test('JSX 正文里的撇号不当字符串开头', () => {
    const src = [`<p>it's fine</p>`, `<div className="text-xs" />`].join('\n');
    expect(strictScan(src, PAGE).map((h) => [h.cls, h.line])).toEqual([['text-xs', 2]]);
  });
  test('正则字面量里的引号不打乱字符串', () => {
    const src = `const re = /['"]/g; const c = "rounded-xl";`;
    expect(classesOf(src)).toEqual(['rounded-xl']);
    expect(lex(src).segments.map((s) => s.text)).toEqual(['rounded-xl']);
  });
  test('去变体：md:hover:、data-[state=open]:、!、负号', () => {
    expect(utilityOf('md:hover:bg-accent')).toBe('bg-accent');
    expect(utilityOf('data-[state=open]:text-xs')).toBe('text-xs');
    expect(utilityOf('!p-3.5')).toBe('p-3.5');
    expect(utilityOf('-mt-9')).toBe('mt-9');
  });
  test('报错写清文件、行、类名、换成什么、规范第几节', () => {
    const [hit] = strictScan('\n<div className="text-xs" />', PAGE);
    expect(hit).toBeDefined();
    const msg = formatHit(hit as Hit);
    expect(msg).toContain('src/routes/sample.tsx:2');
    expect(msg).toContain('text-xs');
    expect(msg).toContain('text-meta');
    expect(msg).toContain('docs/design/驾驶舱界面.md 第 6.2 节');
  });
  test('白名单每一项都写了理由', () => {
    expect(ALLOWLIST.length).toBeGreaterThan(0);
    for (const a of ALLOWLIST) {
      expect(RULE_IDS).toContain(a.rule);
      expect(a.reason.trim().length).toBeGreaterThan(10);
    }
  });
});

describe('计数', () => {
  test('按文件、按规则', () => {
    const hits = strictScan('"text-xs text-sm rounded-xl"', PAGE);
    expect(countHits(hits)).toEqual({ [PAGE]: { R2: 2, R5: 1 } });
  });
});

describe('令牌名不撞车', () => {
  test('app.css 里没有 --color-canvas：它会让 text-canvas 被当成文字颜色，字号类不生成（#1850）', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../app.css'), 'utf8');
    expect(css).not.toMatch(/--color-canvas\s*:/);
    expect(css).toMatch(/--text-canvas\s*:/);
  });
});

describe('整个 packages/web/src', () => {
  test('R0–R12 严格一条都没有；R13–R20 不超基线（lint-design.baseline.json）', () => {
    expect(check()).toEqual([]);
  });
});
