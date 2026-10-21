// 设计陈列页（#1848，规范 docs/design/驾驶舱界面.md）：只在 dev:mock 构建里有。
// 每个版式组件、基础件的各种状态，亮色和暗色各一屏；最后一张表是对比度现算（读浏览器算好的颜色，不抄表）。
// 改了令牌或组件，先看这一页再看别的页；截图脚本固定截它。
import { Inbox, Pause, Plus } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Code } from '../components/layout/code';
import { ConfirmDialog } from '../components/layout/confirm-dialog';
import { Descriptions } from '../components/layout/descriptions';
import { Drawer } from '../components/layout/drawer';
import { EmptyState } from '../components/layout/empty-state';
import { FieldGroup, FieldRow } from '../components/layout/field-row';
import { FilterTabs } from '../components/layout/filter-tabs';
import { KeyValue } from '../components/layout/key-value';
import { List, ListRow } from '../components/layout/list';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { MetaLine } from '../components/layout/meta-line';
import { NativeSelect } from '../components/layout/native-select';
import { Notice } from '../components/layout/notice';
import { Page } from '../components/layout/page';
import { SaveButton } from '../components/layout/save-button';
import { SearchInput } from '../components/layout/search-input';
import { Section, SectionGrid } from '../components/layout/section';
import { Stack } from '../components/layout/stack';
import { Stat, StatGrid } from '../components/layout/stat';
import { StatusBadge, StatusDot } from '../components/layout/status-badge';
import { Tag } from '../components/layout/tag';
import { inkClass, LAYOUT_TONES, type LayoutTone } from '../components/layout/tone';
import { Toolbar } from '../components/layout/toolbar';
import { useTheme } from '../components/theme-provider';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Kbd } from '../components/ui/kbd';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Textarea } from '../components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import { contrastRatio, over, parseColor } from '../lib/color-ratio';
import { toneLabel } from '../lib/status';
import { cn } from '../lib/utils';
import { ComponentsGallery } from './design-components';

const TONE_WORD: Record<LayoutTone, string> = { ...toneLabel, doubt: '疑似换模型' };

// ---------- 对比度现算 ----------

/** 文字色 × 底色。底色都是页面上真有的几种；文字色是规范里要求 ≥4.5:1 的那些。 */
const TEXT_TOKENS: { cls: string; name: string; on?: string }[] = [
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

/** 在 host 里放一个探针，读它算好的颜色。 */
function measure(host: HTMLElement) {
  const probe = (cls: string) => {
    const el = document.createElement('span');
    el.className = cls;
    host.appendChild(el);
    return el;
  };
  const made: Element[] = [];
  const p = (cls: string) => {
    const el = probe(cls);
    made.push(el);
    return el;
  };
  const rows: { name: string; cells: (number | undefined)[] }[] = [];
  for (const t of TEXT_TOKENS) {
    const fgEl = p(t.cls);
    const fg = resolved(fgEl, 'color');
    rows.push({
      name: t.name,
      cells: BG_TOKENS.map((b) => {
        const bgc = resolved(p(b.cls), 'backgroundColor');
        if (!fg || !bgc) return undefined;
        return contrastRatio(fg, bgc.a < 1 ? over(bgc, { r: 255, g: 255, b: 255, a: 1 }) : bgc);
      }),
    });
  }
  const pairs = PAIRS.map((pr) => {
    const fg = resolved(p(pr.fg), 'color');
    const bg = resolved(p(pr.bg), 'backgroundColor');
    return { name: pr.name, ratio: fg && bg ? contrastRatio(fg, bg) : undefined };
  });
  for (const el of made) el.remove();
  return { rows, pairs };
}

function Ratio({ v }: { v: number | undefined }) {
  if (v === undefined) return <span className="text-muted-foreground">算不出</span>;
  const ok = v >= 4.5;
  return (
    <span className={cn('num', ok ? 'text-foreground' : 'text-ink-fail font-semibold')}>
      {v.toFixed(2)}
      {ok ? '' : ' 不达标'}
    </span>
  );
}

function ContrastTable() {
  const ref = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<ReturnType<typeof measure>>();
  useLayoutEffect(() => {
    if (ref.current) setData(measure(ref.current));
  }, []);
  return (
    <div ref={ref}>
      {data ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>文字色</TableHead>
              {BG_TOKENS.map((b) => (
                <TableHead key={b.name}>{b.name}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((r) => (
              <TableRow key={r.name}>
                <TableCell>{r.name}</TableCell>
                {r.cells.map((c, i) => (
                  <TableCell key={BG_TOKENS[i]?.name}>
                    <Ratio v={c} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {data.pairs.map((r) => (
              <TableRow key={r.name}>
                <TableCell colSpan={3}>{r.name}</TableCell>
                <TableCell colSpan={3}>
                  <Ratio v={r.ratio} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Skeleton className="h-24 w-full" />
      )}
    </div>
  );
}

// ---------- 一整屏陈列（当前的亮或暗） ----------

/** 确认框忙态的样板（#2009）：点确定后等 2.5 秒，按选的结果成功关上或失败留着写原因。 */
function ConfirmBusyDemo() {
  const [open, setOpen] = useState<null | 'ok' | 'fail'>(null);
  return (
    <div className="flex flex-wrap items-center gap-2" data-design-confirm>
      <Button variant="outline" size="sm" onClick={() => setOpen('ok')}>
        确认框：会成功
      </Button>
      <Button variant="outline" size="sm" onClick={() => setOpen('fail')}>
        确认框：会失败
      </Button>
      <AlertDialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>发布到法国？</AlertDialogTitle>
            <AlertDialogDescription>
              样板：点「确认发布」等 2.5 秒。等的时候转圈、Esc
              和「先不」都关不掉；成功关上，失败留在原处写原因。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不</AlertDialogCancel>
            <AlertDialogAction
              onConfirm={async () => {
                await new Promise((r) => setTimeout(r, 2500));
                if (open === 'fail') throw new Error('主线头已经不是 2005b290a 了，刷新后再发');
              }}
            >
              确认发布
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** 「组件」一节里确认框、抽屉的触发键（业务层摆不了按钮，由这里传进去）：确认框成功 / 失败 / 危险，抽屉三档宽。 */
function OverlayDemos() {
  const [drawer, setDrawer] = useState<null | 'sm' | 'md' | 'lg'>(null);
  const [danger, setDanger] = useState(false);
  return (
    <Stack gap="md">
      <Stack direction="horizontal" gap="sm" wrap>
        <ConfirmDialog
          trigger={
            <Button variant="outline" size="sm">
              确认框：会成功
            </Button>
          }
          title="发布到法国？"
          description="样板：点「确定」等 2.5 秒，成功关上。"
          onConfirm={() => new Promise<void>((r) => setTimeout(r, 2500))}
        />
        <ConfirmDialog
          trigger={
            <Button variant="outline" size="sm">
              确认框：会失败
            </Button>
          }
          title="发布到法国？"
          description="样板：点「确定」等 2.5 秒，失败留在原处写原因。"
          onConfirm={async () => {
            await new Promise((r) => setTimeout(r, 2500));
            throw new Error('主线头已经不是 2005b290a 了，刷新后再发');
          }}
        />
        <Button variant="danger" size="sm" onClick={() => setDanger(true)}>
          危险确认框
        </Button>
        <ConfirmDialog
          open={danger}
          onOpenChange={setDanger}
          danger
          title="叫停这个任务？"
          description="叫停后不能接着做，要重新开单。"
          confirmText="叫停"
          onConfirm={() => {}}
        />
      </Stack>
      <Stack direction="horizontal" gap="sm" wrap>
        {(['sm', 'md', 'lg'] as const).map((w) => (
          <Button key={w} variant="outline" size="sm" onClick={() => setDrawer(w)}>
            抽屉 {w}
          </Button>
        ))}
        <Drawer
          open={drawer !== null}
          onOpenChange={(o) => !o && setDrawer(null)}
          title="任务详情"
          description="从右边滑进来，按 Esc 或点遮罩关闭。"
          width={drawer ?? 'md'}
          footer={
            <Button variant="secondary" size="sm" onClick={() => setDrawer(null)}>
              关闭
            </Button>
          }
        >
          <Descriptions
            columns={1}
            items={[
              { label: '编号', value: 't-12', mono: true },
              { label: '状态', value: <StatusBadge status="task:running" /> },
              { label: '耗时', value: { ok: false, reason: '还没结束' } },
            ]}
          />
        </Drawer>
      </Stack>
    </Stack>
  );
}

function Gallery({ mode }: { mode: 'light' | 'dark' }) {
  const [tab, setTab] = useState('all');
  const [level, setLevel] = useState('alert');
  const [q, setQ] = useState('');
  return (
    <div className="space-y-6">
      <h2 className="text-title">{mode === 'light' ? '亮色' : '暗色'}</h2>

      <Section title="页头" description="标题左、操作右，刷新在固定槽位；说明手机上收成 ⓘ。">
        <Page
          title="页面标题"
          description="一句话说明这页是做什么的。"
          actions={
            <Button size="sm">
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
      </Section>

      <SectionGrid cols={2}>
        <Section
          title="区块"
          description="默认：边框、底、一根下边线。"
          actions={
            <Button size="sm" variant="outline">
              操作
            </Button>
          }
        >
          <p className="text-body">正文 14px，行高 20px。次要文字用 muted-foreground。</p>
        </Section>
        <Section title="出问题的区块" tone="fail" description="左边一道状态色竖线。">
          <p className="text-body">失败、停滞这类区块用 tone。</p>
        </Section>
        <Section variant="plain" title="无边框区块" description="设置页那种，只有标题和内容。">
          <p className="text-body">plain 不画边框和底。</p>
        </Section>
        <Section title="放列表" flush>
          <List>
            <ListRow
              title="第一行"
              meta={<MetaLine items={['仓 #12', '开单 1 小时前']} />}
              trailing={<StatusBadge tone="run" label="在跑" />}
            />
            <ListRow title="选中的一行" selected trailing={<StatusBadge tone="done" label="完成" />} />
            <ListRow title="出问题的一行" rail="fail" trailing={<StatusBadge tone="fail" label="失败" />} />
            <ListRow
              leading={<StatusDot tone="stall" />}
              title="可展开的一行"
              expandable
              defaultOpen
              details={<p className="text-body text-muted-foreground">展开后的明细，底色 muted。</p>}
            />
          </List>
        </Section>
      </SectionGrid>

      <Section title="状态标签 StatusBadge">
        <div className="space-y-3">
          {(['soft', 'outline', 'dot'] as const).map((v) => (
            <div key={v} className="flex flex-wrap items-center gap-2">
              <span className="w-14 text-meta text-muted-foreground">{v}</span>
              {LAYOUT_TONES.map((t) => (
                <StatusBadge key={t} tone={t} label={TONE_WORD[t]} variant={v} />
              ))}
            </div>
          ))}
        </div>
      </Section>

      <Section title="小标签 Tag、等宽 Code、点分行 MetaLine">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Tag>中性</Tag>
            <Tag tone="brand">品牌</Tag>
            {LAYOUT_TONES.map((t) => (
              <Tag key={t} tone={t}>
                {TONE_WORD[t]}
              </Tag>
            ))}
            <Tag mono>a1b2c3d</Tag>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Code>claude-sonnet-5-5</Code>
            <Code>t-12</Code>
          </div>
          <MetaLine items={['fleet-dao#1848', '开单 1 小时前', 'PR #1860', null]} />
        </div>
      </Section>

      <SectionGrid cols={2}>
        <Section title="键值（rows）">
          <KeyValue
            items={[
              { label: '周期', value: '每 15 分钟' },
              { label: '编号', value: 'job-scan-issues', mono: true },
              { label: '上次结果', value: '失败', tone: 'fail', hint: '连不上后端' },
            ]}
          />
        </Section>
        <Section title="键值（grid）">
          <KeyValue
            layout="grid"
            cols={2}
            items={[
              { label: '在跑', value: '3' },
              { label: '排队', value: '12', tone: 'stall' },
              { label: '完成', value: '40', tone: 'done' },
              { label: '失败', value: '1', tone: 'fail' },
            ]}
          />
        </Section>
      </SectionGrid>

      <Section title="指标 Stat">
        <StatGrid cols={4}>
          <Stat label="在跑" value="3" unit="个" />
          <Stat label="排队" value="12" unit="个" tone="stall" />
          <Stat label="失败" value="1" unit="个" tone="fail" />
          <Stat label="完成" value="40" unit="个" tone="done" />
        </StatGrid>
      </Section>

      <SectionGrid cols={2}>
        <Section title="空状态" flush>
          <EmptyState
            icon={Inbox}
            title="没有待处理的提醒"
            hint="有要你拍的事会出现在这里。"
            action={
              <Button size="sm" variant="outline">
                去看全部
              </Button>
            }
          />
          <div className="border-t">
            <EmptyState size="inline" icon={Inbox} title="这个仓还没有任务" />
          </div>
        </Section>
        <Section title="横幅 Notice 和读取状态">
          <div className="space-y-2">
            <Notice tone="fail" title="没读成">
              连不上后端。
            </Notice>
            <Notice tone="stall">引擎已经 20 分钟没动了。</Notice>
            <Notice tone="info">下次读取在 1 分钟后。</Notice>
            <Notice tone="done">已保存。</Notice>
            <LoadError what="额度" error={new Error('连不上后端')} />
            <LoadingRows rows={2} />
          </div>
        </Section>
      </SectionGrid>

      <Section title="工具条：筛选、搜索、下拉">
        <Toolbar
          className="mb-0"
          start={
            <FilterTabs
              aria-label="按状态"
              value={tab}
              onChange={setTab}
              items={[
                { id: 'all', label: '全部', count: 24 },
                { id: 'run', label: '在跑', count: 3 },
                { id: 'fail', label: '失败', count: null },
              ]}
            />
          }
          end={
            <>
              <SearchInput value={q} onChange={setQ} placeholder="搜任务" />
              <NativeSelect aria-label="仓">
                <option>全部仓</option>
                <option>fleet-dao</option>
              </NativeSelect>
            </>
          }
        />
        <div className="mt-3">
          <FilterTabs
            mode="toggle"
            aria-label="按级别"
            value={level}
            onChange={setLevel}
            items={[
              { id: 'decision', label: '要你拍', tone: 'human', count: 2 },
              { id: 'alert', label: '卡住报警', tone: 'stall', count: 5 },
              { id: 'daily', label: '日报', tone: 'wait', count: 0 },
            ]}
          />
        </div>
      </Section>

      <Section title="字段组 FieldGroup、FieldRow">
        <FieldGroup>
          <FieldRow label="名字" htmlFor={`name-${mode}`} hint="显示在列表里。">
            <Input id={`name-${mode}`} defaultValue="fleet-dao" className="max-w-search" />
          </FieldRow>
          <FieldRow label="说明" htmlFor={`note-${mode}`} error="说明不能为空。">
            <Textarea id={`note-${mode}`} aria-invalid defaultValue="" className="max-w-search" />
          </FieldRow>
          <FieldRow label="开关">
            <Switch aria-label="开关" defaultChecked />
          </FieldRow>
        </FieldGroup>
      </Section>

      <SectionGrid cols={2}>
        <Section title="基础件：按钮和标签">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button>主要</Button>
              <Button variant="outline">描边</Button>
              <Button variant="secondary">次要</Button>
              <Button variant="ghost">幽灵</Button>
              <Button variant="destructive">危险</Button>
              <Button variant="link">链接</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="xs">xs 24</Button>
              <Button size="sm">sm 32</Button>
              <Button>默认 32</Button>
              <Button size="lg">lg 40</Button>
              <Button disabled>禁用</Button>
            </div>
            {/* 忙态（#2009）：转圈不改按钮宽；有图标替掉图标，没图标盖在字上，loadingText 换字 */}
            <div className="flex flex-wrap items-center gap-2" data-design-loading>
              <Button loading>主要</Button>
              <Button variant="outline" loading>
                描边
              </Button>
              <Button variant="destructive" loading>
                叫停
              </Button>
              <Button variant="outline" size="sm" loading>
                <Pause />
                暂停
              </Button>
              <Button loading loadingText="正在提交…">
                发布
              </Button>
              <SaveButton canSave pending />
            </div>
            <ConfirmBusyDemo />
            <div className="flex flex-wrap items-center gap-2">
              <Badge>默认</Badge>
              <Badge variant="secondary">次要</Badge>
              <Badge variant="destructive">危险</Badge>
              <Badge variant="outline">描边</Badge>
              <Kbd>⌘K</Kbd>
            </div>
          </div>
        </Section>
        <Section title="基础件：输入">
          <div className="space-y-3">
            <Input placeholder="输入框 32 高" />
            <Input aria-invalid defaultValue="校验失败" />
            <Select defaultValue="a">
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="a">选项 A</SelectItem>
                <SelectItem value="b">选项 B</SelectItem>
              </SelectContent>
            </Select>
            <ToggleGroup type="single" defaultValue="a" variant="outline">
              <ToggleGroupItem value="a">甲</ToggleGroupItem>
              <ToggleGroupItem value="b">乙</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </Section>
      </SectionGrid>

      <Section title="字号、圆角、阴影档位">
        <div className="space-y-3">
          <div className="space-y-1">
            <div className="text-display">display 28 · 1,234</div>
            <div className="text-title">title 20 页面标题</div>
            <div className="text-heading">heading 16 区块标题</div>
            <div className="text-body">body 14 正文、列表、按钮</div>
            <div className="text-meta text-muted-foreground">meta 12 时间戳、表头、计数</div>
          </div>
          <div className="flex flex-wrap items-center gap-4 pt-2">
            <div className="grid size-16 place-items-center rounded-sm bg-muted text-meta">sm 4</div>
            <div className="grid size-16 place-items-center rounded-md bg-muted text-meta">md 6</div>
            <div className="grid size-16 place-items-center rounded-lg bg-muted text-meta">lg 10</div>
            <div className="grid size-16 place-items-center rounded-full bg-muted text-meta">full</div>
            <div className="grid size-16 place-items-center rounded-lg bg-card text-meta shadow-card">
              card
            </div>
            <div className="grid size-16 place-items-center rounded-lg bg-popover text-meta shadow-overlay">
              overlay
            </div>
            <div className="grid size-16 place-items-center rounded-lg bg-popover text-meta shadow-modal">
              modal
            </div>
          </div>
        </div>
      </Section>

      <Section title="表格" flush>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名字</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">耗时</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>扫描单子</TableCell>
              <TableCell>
                <StatusBadge tone="done" label="完成" />
              </TableCell>
              <TableCell className="num text-right">1 分 20 秒</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>对账</TableCell>
              <TableCell>
                <StatusBadge tone="fail" label="失败" />
              </TableCell>
              <TableCell className="num text-right">12 秒</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Section>

      <ComponentsGallery
        overlays={<OverlayDemos />}
        input={({ id, placeholder, defaultValue, invalid }) => (
          <Input
            {...(id ? { id } : {})}
            {...(placeholder ? { placeholder } : {})}
            {...(defaultValue ? { defaultValue } : {})}
            {...(invalid ? { 'aria-invalid': true } : {})}
          />
        )}
      />

      <Section
        title="对比度（浏览器现算）"
        description="文字色对各种底色，WCAG 要求正文至少 4.5。红字是不达标。"
      >
        <ContrastTable />
      </Section>
    </div>
  );
}

export default function DesignGallery() {
  // 主题只有一套，亮暗跟随系统（#3509）：陈列页只画当前这一种，看另一种就切系统的深浅色。
  const { resolvedMode } = useTheme();
  return (
    <Page
      title="设计陈列"
      description="每个组件的各种状态。亮暗跟随系统，切系统深浅色看另一种。只在 dev:mock 里有。"
    >
      <div data-gallery={resolvedMode} className="min-w-0 rounded-md bg-page p-4 text-ink ring-1 ring-line">
        <Gallery mode={resolvedMode} />
      </div>
    </Page>
  );
}
