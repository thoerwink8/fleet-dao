// 设计陈列页（#1848，规范 docs/design/驾驶舱界面.md）：只在 dev:mock 构建里有。
// 每个版式组件、基础件的各种状态，当前亮或暗一屏；最后一张表是对比度现算（读浏览器算好的颜色，不抄表）。
// 改了令牌或组件，先看这一页再看别的页；截图脚本固定截它。
// 这一页和别的业务页一样只拼 components/layout 的件（#3533）：要直接摆令牌的块（色板、字号、圆角阴影样本）在 layout/design-kit.tsx。
import { Inbox, Pause } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/layout/button';
import { Code } from '../components/layout/code';
import { ConfirmDialog } from '../components/layout/confirm-dialog';
import { Descriptions } from '../components/layout/descriptions';
import {
  ButtonSamples,
  ContrastTable,
  DesignPanel,
  Kbd,
  LoadingButtonSamples,
  PageHeadSample,
  Ruled,
  ShapeSample,
  TypeSample,
} from '../components/layout/design-kit';
import { Drawer } from '../components/layout/drawer';
import { EmptyState } from '../components/layout/empty-state';
import { FieldGroup, FieldRow } from '../components/layout/field-row';
import { FilterTabs } from '../components/layout/filter-tabs';
import { Input, Textarea } from '../components/layout/input';
import { KeyValue } from '../components/layout/key-value';
import { List, ListRow } from '../components/layout/list';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { MetaLine } from '../components/layout/meta-line';
import { NativeSelect } from '../components/layout/native-select';
import { Notice } from '../components/layout/notice';
import { Page } from '../components/layout/page';
import { SearchInput } from '../components/layout/search-input';
import { Section, SectionGrid } from '../components/layout/section';
import { Select } from '../components/layout/select';
import { Stack } from '../components/layout/stack';
import { Stat, StatGrid } from '../components/layout/stat';
import { StatusBadge, StatusDot } from '../components/layout/status-badge';
import { Switch } from '../components/layout/switch';
import { Table } from '../components/layout/table';
import { Tag } from '../components/layout/tag';
import { Text } from '../components/layout/text';
import { Title } from '../components/layout/title';
import { Toggle } from '../components/layout/toggle';
import { LAYOUT_TONES, type LayoutTone } from '../components/layout/tone';
import { Toolbar } from '../components/layout/toolbar';
import { useTheme } from '../components/theme-provider';
import { toneLabel } from '../lib/status';
import { ComponentsGallery } from './design-components';

const TONE_WORD: Record<LayoutTone, string> = { ...toneLabel, doubt: '疑似换模型' };

// ---------- 一整屏陈列（当前的亮或暗） ----------

/** 确认框忙态的样板（#2009）：点确定后等 2.5 秒，按选的结果成功关上或失败留着写原因。 */
function ConfirmBusyDemo() {
  const [open, setOpen] = useState<null | 'ok' | 'fail'>(null);
  return (
    <Stack direction="horizontal" gap="sm" wrap align="center" data-design-confirm="">
      <Button size="sm" onClick={() => setOpen('ok')}>
        确认框：会成功
      </Button>
      <Button size="sm" onClick={() => setOpen('fail')}>
        确认框：会失败
      </Button>
      <ConfirmDialog
        open={open !== null}
        onOpenChange={(o) => !o && setOpen(null)}
        title="发布到法国？"
        description="样板：点「确认发布」等 2.5 秒。等的时候转圈、Esc 和「先不」都关不掉；成功关上，失败留在原处写原因。"
        confirmText="确认发布"
        onConfirm={async () => {
          await new Promise((r) => setTimeout(r, 2500));
          if (open === 'fail') throw new Error('主线头已经不是 2005b290a 了，刷新后再发');
        }}
      />
    </Stack>
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
          trigger={<Button size="sm">确认框：会成功</Button>}
          title="发布到法国？"
          description="样板：点「确定」等 2.5 秒，成功关上。"
          onConfirm={() => new Promise<void>((r) => setTimeout(r, 2500))}
        />
        <ConfirmDialog
          trigger={<Button size="sm">确认框：会失败</Button>}
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
          <Button key={w} size="sm" onClick={() => setDrawer(w)}>
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
            <Button size="sm" onClick={() => setDrawer(null)}>
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
  const [pick, setPick] = useState('a');
  const [pressed, setPressed] = useState<'a' | 'b'>('a');
  return (
    <Stack gap="xl">
      <Title level={2} look={1}>
        {mode === 'light' ? '亮色' : '暗色'}
      </Title>

      <Section title="页头" description="标题左、操作右，刷新在固定槽位；说明手机上收成 ⓘ。">
        <PageHeadSample />
      </Section>

      <SectionGrid cols={2}>
        <Section
          title="区块"
          description="默认：边框、底、一根下边线。"
          actions={<Button size="sm">操作</Button>}
        >
          <Text as="p">正文 14px，行高 20px。次要文字用 muted-foreground。</Text>
        </Section>
        <Section title="出问题的区块" tone="fail" description="左边一道状态色竖线。">
          <Text as="p">失败、停滞这类区块用 tone。</Text>
        </Section>
        <Section variant="plain" title="无边框区块" description="设置页那种，只有标题和内容。">
          <Text as="p">plain 不画边框和底。</Text>
        </Section>
        <Section title="放列表" flush>
          <List>
            <ListRow
              title="第一行"
              meta={<MetaLine items={['仓 #12', '开单 1 小时前']} />}
              trailing={<StatusBadge status="tone:run" />}
            />
            <ListRow title="选中的一行" selected trailing={<StatusBadge status="tone:done" />} />
            <ListRow title="出问题的一行" rail="fail" trailing={<StatusBadge status="tone:fail" />} />
            <ListRow
              leading={<StatusDot tone="stall" />}
              title="可展开的一行"
              expandable
              defaultOpen
              details={
                <Text as="p" tone="muted">
                  展开后的明细，底色 muted。
                </Text>
              }
            />
          </List>
        </Section>
      </SectionGrid>

      <Section title="状态标签 StatusBadge">
        <Stack gap="md">
          {(['auto', 'dot'] as const).map((v) => (
            <Stack key={v} direction="horizontal" gap="sm" wrap align="center">
              <Text size="meta" tone="muted">
                {v}
              </Text>
              {LAYOUT_TONES.map((t) => (
                <StatusBadge key={t} status={`tone:${t}`} variant={v} />
              ))}
            </Stack>
          ))}
        </Stack>
      </Section>

      <Section title="小标签 Tag、等宽 Code、点分行 MetaLine">
        <Stack gap="md">
          <Stack direction="horizontal" gap="sm" wrap align="center">
            <Tag>中性</Tag>
            <Tag tone="brand">品牌</Tag>
            {LAYOUT_TONES.map((t) => (
              <Tag key={t} tone={t}>
                {TONE_WORD[t]}
              </Tag>
            ))}
            <Tag mono>a1b2c3d</Tag>
          </Stack>
          <Stack direction="horizontal" gap="sm" wrap align="center">
            <Code>claude-sonnet-5-5</Code>
            <Code>t-12</Code>
          </Stack>
          <MetaLine items={['fleet-dao#1848', '开单 1 小时前', 'PR #1860', null]} />
        </Stack>
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
            action={<Button size="sm">去看全部</Button>}
          />
          <Ruled>
            <EmptyState size="inline" icon={Inbox} title="这个仓还没有任务" />
          </Ruled>
        </Section>
        <Section title="横幅 Notice 和读取状态">
          <Stack gap="sm">
            <Notice tone="fail" title="没读成">
              连不上后端。
            </Notice>
            <Notice tone="stall">引擎已经 20 分钟没动了。</Notice>
            <Notice tone="info">下次读取在 1 分钟后。</Notice>
            <Notice tone="done">已保存。</Notice>
            <LoadError what="额度" error={new Error('连不上后端')} />
            <LoadingRows rows={2} />
          </Stack>
        </Section>
      </SectionGrid>

      <Section title="工具条：筛选、搜索、下拉">
        <Stack gap="md">
          <Toolbar
            flush
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
        </Stack>
      </Section>

      <Section title="字段组 FieldGroup、FieldRow">
        <FieldGroup>
          <FieldRow label="名字" htmlFor={`name-${mode}`} hint="显示在列表里。">
            <Input id={`name-${mode}`} defaultValue="fleet-dao" width="search" />
          </FieldRow>
          <FieldRow label="说明" htmlFor={`note-${mode}`} error="说明不能为空。">
            <Textarea id={`note-${mode}`} aria-invalid defaultValue="" width="search" />
          </FieldRow>
          <FieldRow label="开关">
            <Switch aria-label="开关" defaultChecked />
          </FieldRow>
        </FieldGroup>
      </Section>

      <SectionGrid cols={2}>
        <Section title="基础件：按钮和标签">
          <Stack gap="md">
            <ButtonSamples />
            {/* 忙态（#2009）：转圈不改按钮宽；有图标替掉图标，没图标盖在字上，loadingText 换字 */}
            <LoadingButtonSamples icon={<Pause />} />
            <ConfirmBusyDemo />
            <Stack direction="horizontal" gap="sm" wrap align="center">
              <Tag tone="default">默认</Tag>
              <Tag tone="warning">橙</Tag>
              <Tag tone="error">红</Tag>
              <Kbd>⌘K</Kbd>
            </Stack>
          </Stack>
        </Section>
        <Section title="基础件：输入">
          <Stack gap="md">
            <Input placeholder="输入框 32 高" />
            <Input aria-invalid defaultValue="校验失败" />
            <Select
              aria-label="选项"
              width="full"
              value={pick}
              onValueChange={setPick}
              options={[
                { value: 'a', label: '选项 A' },
                { value: 'b', label: '选项 B' },
              ]}
            />
            <Stack direction="horizontal" gap="sm">
              <Toggle pressed={pressed === 'a'} onPressedChange={() => setPressed('a')}>
                甲
              </Toggle>
              <Toggle pressed={pressed === 'b'} onPressedChange={() => setPressed('b')}>
                乙
              </Toggle>
            </Stack>
          </Stack>
        </Section>
      </SectionGrid>

      <Section title="字号、圆角、阴影档位">
        <Stack gap="md">
          <Stack gap="sm">
            <TypeSample level="display">display 28 · 1,234</TypeSample>
            <TypeSample level="title">title 20 页面标题</TypeSample>
            <TypeSample level="heading">heading 16 区块标题</TypeSample>
            <TypeSample level="body">body 14 正文、列表、按钮</TypeSample>
            <TypeSample level="meta">meta 12 时间戳、表头、计数</TypeSample>
          </Stack>
          <Stack direction="horizontal" gap="lg" wrap align="center">
            <ShapeSample look="sm">sm 4</ShapeSample>
            <ShapeSample look="md">md 6</ShapeSample>
            <ShapeSample look="lg">lg 10</ShapeSample>
            <ShapeSample look="full">full</ShapeSample>
            <ShapeSample look="card">card</ShapeSample>
            <ShapeSample look="overlay">overlay</ShapeSample>
            <ShapeSample look="modal">modal</ShapeSample>
          </Stack>
        </Stack>
      </Section>

      <Section title="表格" flush>
        <Table
          rowKey="name"
          columns={[
            { key: 'name', title: '名字' },
            { key: 'status', title: '状态', render: (_v, r) => <StatusBadge status={r.status} /> },
            { key: 'took', title: '耗时', align: 'right' },
          ]}
          rows={[
            { name: '扫描单子', status: 'task:segment:done' as const, took: '1 分 20 秒' },
            { name: '对账', status: 'task:segment:failed' as const, took: '12 秒' },
          ]}
        />
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
    </Stack>
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
      <DesignPanel mode={resolvedMode}>
        <Gallery mode={resolvedMode} />
      </DesignPanel>
    </Page>
  );
}
