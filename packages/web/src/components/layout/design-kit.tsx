// 陈列页 /_design 专用的「展示令牌」件（#3533）：色板对比度、字号样本、圆角阴影样本、页头样本、按钮样本。
// 陈列页（routes/design.tsx）是业务层，不写样式类、不引 ui/；这些要直接摆令牌的块（探针要带真实类名、样本块要带底色圆角阴影）放在这里。
// 只给陈列页用，别的页不要引。
import { Plus } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { contrastRatio, over, parseColor } from '../../lib/color-ratio';
import { cn } from '../../lib/utils';
import { Kbd as BaseKbd } from '../ui/kbd';
import { Button } from './button';
import { Page } from './page';
import { SaveButton } from './save-button';
import { Stack } from './stack';
import { Table, type TableColumn } from './table';
import { Text } from './text';
import { inkClass, LAYOUT_TONES } from './tone';

// ---------- 整屏外框 ----------

/** 一整屏陈列的外框：页底、圆角、一圈细线；data-gallery 标出当前是亮还是暗（截图脚本找它）。 */
export function DesignPanel({ mode, children }: { mode: string; children: ReactNode }) {
  return (
    <div data-gallery={mode} className="min-w-0 rounded-md bg-page p-4 text-ink ring-1 ring-line">
      {children}
    </div>
  );
}

/** 在一行内容上方画一道细线（放在 flush 区块里、两块内容之间）。 */
export function Ruled({ children }: { children: ReactNode }) {
  return <div className="border-t">{children}</div>;
}

/** 快捷键提示（⌘K）。 */
export function Kbd({ children }: { children: ReactNode }) {
  return <BaseKbd>{children}</BaseKbd>;
}

// ---------- 页头样本 ----------

/** 页头单摆：去掉页的内边距和页头下的空，只看标题行（标题左、操作右、刷新在固定槽位）。 */
export function PageHeadSample() {
  return (
    <Page
      title="页面标题"
      description="一句话说明这页是做什么的。"
      actions={
        <Button variant="primary" size="sm">
          <Plus aria-hidden />
          新建
        </Button>
      }
      refresh={{
        onRefresh: () => {},
        isFetching: false,
        dataUpdatedAt: Date.now() - 30_000,
        staleAfterMs: 120_000,
      }}
      className="p-0 pb-0 sm:p-0 lg:p-0 lg:pb-0 [&_header]:mb-0"
    >
      {null}
    </Page>
  );
}

// ---------- 按钮样本 ----------

/** 五种样子、三档尺寸、置灰（写明原因）。一块区域只摆一个主按钮。 */
export function ButtonSamples() {
  return (
    <Stack gap="md">
      <Stack direction="horizontal" gap="sm" wrap align="center">
        <Button variant="primary">主要</Button>
        <Button variant="secondary">次要</Button>
        <Button variant="outline">描边</Button>
        <Button variant="text">文字</Button>
        <Button variant="danger">危险</Button>
      </Stack>
      <Stack direction="horizontal" gap="sm" wrap align="center">
        <Button size="xs">xs 24</Button>
        <Button size="sm">sm 28</Button>
        <Button>md 32</Button>
        <Button disabledReason="样板：置灰时悬停写原因">置灰</Button>
      </Stack>
    </Stack>
  );
}

/** 忙态（#2009）：转圈不改按钮宽；有图标替掉图标，没图标盖在字上，loadingText 换字。 */
export function LoadingButtonSamples({ icon }: { icon: ReactNode }) {
  return (
    <Stack direction="horizontal" gap="sm" wrap align="center" data-design-loading="">
      <Button variant="secondary" loading>
        次要
      </Button>
      <Button variant="outline" loading>
        描边
      </Button>
      <Button variant="danger" loading>
        叫停
      </Button>
      <Button variant="outline" size="sm" loading>
        {icon}
        暂停
      </Button>
      <Button variant="secondary" loading loadingText="正在提交…">
        发布
      </Button>
      <SaveButton canSave pending />
    </Stack>
  );
}

// ---------- 字号、圆角、阴影样本 ----------

const TYPE = {
  display: 'text-display',
  title: 'text-title',
  heading: 'text-heading',
  body: 'text-body',
  meta: 'text-meta text-muted-foreground',
} as const;

/** 字号一档的样本行。 */
export function TypeSample({ level, children }: { level: keyof typeof TYPE; children: ReactNode }) {
  return <div className={TYPE[level]}>{children}</div>;
}

const SHAPE = {
  sm: 'rounded-sm bg-muted',
  md: 'rounded-md bg-muted',
  lg: 'rounded-lg bg-muted',
  full: 'rounded-full bg-muted',
  card: 'rounded-lg bg-card shadow-card',
  overlay: 'rounded-lg bg-popover shadow-overlay',
  modal: 'rounded-lg bg-popover shadow-modal',
} as const;

/** 圆角、阴影档位的样本块（64 方块，里面写档位名）。 */
export function ShapeSample({ look, children }: { look: keyof typeof SHAPE; children: ReactNode }) {
  return (
    <div className={cn('grid size-16 place-items-center text-meta text-ink', SHAPE[look])}>{children}</div>
  );
}

// ---------- 对比度现算 ----------

/** 文字色 × 底色。底色都是页面上真有的几种；文字色是规范里要求 ≥4.5:1 的那些。 */
const TEXT_TOKENS: { cls: string; name: string }[] = [
  { cls: 'text-foreground', name: 'foreground' },
  { cls: 'text-muted-foreground', name: 'muted-foreground' },
  ...LAYOUT_TONES.map((t) => ({ cls: inkClass[t], name: `ink-${t}` })),
];
const BG_TOKENS: { cls: string; name: string }[] = [
  { cls: 'bg-background', name: 'background' },
  { cls: 'bg-card', name: 'card' },
  { cls: 'bg-popover', name: 'popover' },
  { cls: 'bg-muted', name: 'muted' },
  { cls: 'bg-panel', name: 'panel' },
];
const PAIRS: { fg: string; bg: string; name: string }[] = [
  { fg: 'text-brand-foreground', bg: 'bg-brand', name: 'brand-foreground / brand' },
  { fg: 'text-destructive-foreground', bg: 'bg-destructive', name: 'destructive-foreground / destructive' },
];

let swatch: CanvasRenderingContext2D | null | undefined;

/** 浏览器把 color-mix 算成 oklab() 这类写法时，借一块 1×1 画布换成 sRGB。 */
function viaCanvas(css: string) {
  if (swatch === undefined) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    swatch = c.getContext('2d', { willReadFrequently: true });
  }
  if (!swatch) return undefined;
  swatch.clearRect(0, 0, 1, 1);
  swatch.fillStyle = '#000';
  swatch.fillStyle = css;
  swatch.fillRect(0, 0, 1, 1);
  const px = swatch.getImageData(0, 0, 1, 1).data;
  const a = (px[3] ?? 0) / 255;
  if (a === 0) return undefined;
  return { r: px[0] ?? 0, g: px[1] ?? 0, b: px[2] ?? 0, a };
}

function resolved(el: Element, prop: 'color' | 'backgroundColor') {
  const css = getComputedStyle(el)[prop];
  return parseColor(css) ?? viaCanvas(css);
}

type Measured = {
  rows: Record<string, string | number | undefined>[];
  pairs: { name: string; ratio: number | undefined }[];
};

/** 在 host 里放探针，读它算好的颜色。 */
function measure(host: HTMLElement): Measured {
  const made: Element[] = [];
  const p = (cls: string) => {
    const el = document.createElement('span');
    el.className = cls;
    host.appendChild(el);
    made.push(el);
    return el;
  };
  const rows: Measured['rows'] = [];
  for (const t of TEXT_TOKENS) {
    const fg = resolved(p(t.cls), 'color');
    const row: Measured['rows'][number] = { name: t.name };
    for (const b of BG_TOKENS) {
      const bgc = resolved(p(b.cls), 'backgroundColor');
      row[b.name] =
        fg && bgc
          ? contrastRatio(fg, bgc.a < 1 ? over(bgc, { r: 255, g: 255, b: 255, a: 1 }) : bgc)
          : undefined;
    }
    rows.push(row);
  }
  const pairs = PAIRS.map((pr) => {
    const fg = resolved(p(pr.fg), 'color');
    const bg = resolved(p(pr.bg), 'backgroundColor');
    return { name: pr.name, ratio: fg && bg ? contrastRatio(fg, bg) : undefined };
  });
  for (const el of made) el.remove();
  return { rows, pairs };
}

/** 一个比值：算不出写「算不出」，不到 4.5 标红「不达标」（不拿空冒充通过）。 */
function Ratio({ v }: { v: number | undefined }) {
  if (v === undefined) return <Text tone="muted">算不出</Text>;
  const ok = v >= 4.5;
  return (
    <span className={cn('num', ok ? 'text-foreground' : 'font-semibold text-ink-fail')}>
      {v.toFixed(2)}
      {ok ? '' : ' 不达标'}
    </span>
  );
}

const RATIO_COLUMNS: readonly TableColumn<Measured['rows'][number]>[] = [
  { key: 'name', title: '文字色' },
  ...BG_TOKENS.map(
    (b): TableColumn<Measured['rows'][number]> => ({
      key: b.name,
      title: b.name,
      render: (v) => <Ratio v={typeof v === 'number' ? v : undefined} />,
    }),
  ),
];
const PAIR_COLUMNS: readonly TableColumn<Measured['pairs'][number]>[] = [
  { key: 'name', title: '配对' },
  { key: 'ratio', title: '对比度', render: (v) => <Ratio v={typeof v === 'number' ? v : undefined} /> },
];

/** 文字色对各种底色的对比度，现算（读浏览器算好的颜色，不抄表）。 */
export function ContrastTable() {
  const ref = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<Measured>();
  useLayoutEffect(() => {
    if (ref.current) setData(measure(ref.current));
  }, []);
  return (
    <div ref={ref}>
      <Stack gap="md">
        <Table
          columns={RATIO_COLUMNS}
          rows={data?.rows ?? []}
          rowKey="name"
          caption="文字色对底色的对比度"
          {...(data ? {} : { load: { state: 'loading' as const } })}
        />
        {data ? <Table columns={PAIR_COLUMNS} rows={data.pairs} rowKey="name" caption="配对对比度" /> : null}
      </Stack>
    </div>
  );
}
