// 陈列页 /_design 的「组件」一节（#3509 片 3）：新做的业务组件（Stack、Grid、Text、Table、Progress、Steps、Descriptions、ProbeCells、
// Timeline、PickList、Anchor、Collapse、Form、ConfirmDialog、Drawer、InfoTip、AuthCard、Chat）和改过的 StatusBadge，
// 每个都摆出常见状态，包括读失败（error）、没有数据（empty）、读到一部分（partial）的样子。
// 这个文件是业务层：一个样式类也不写，只拼组件（lint-design R13–R20 对它是 0）。
import { Clock } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Anchor } from '../components/layout/anchor';
import { AuthCard } from '../components/layout/auth-card';
import { Band } from '../components/layout/band';
import { Breadcrumb } from '../components/layout/breadcrumb';
import { Button } from '../components/layout/button';
import { Chat, Composer } from '../components/layout/chat';
import { Collapse } from '../components/layout/collapse';
import { Descriptions } from '../components/layout/descriptions';
import { Dialog } from '../components/layout/dialog';
import { DisclosureRow } from '../components/layout/disclosure';
import { DragHandle } from '../components/layout/drag-handle';
import { Entry, EntryGrid } from '../components/layout/entry';
import { Form, FormItem } from '../components/layout/form';
import { Grid } from '../components/layout/grid';
import { InfoTip } from '../components/layout/info-tip';
import { RowFrame } from '../components/layout/list';
import { ListFooter } from '../components/layout/list-footer';
import { NativeSelect } from '../components/layout/native-select';
import { Nest } from '../components/layout/nest';
import { PickList } from '../components/layout/pick-list';
import { type ProbeCell, ProbeCells } from '../components/layout/probe-cells';
import { Progress } from '../components/layout/progress';
import { DisclosureIcon, FoldBar, RowButton } from '../components/layout/row-button';
import { ScrollRow } from '../components/layout/scroll-row';
import { Section } from '../components/layout/section';
import { Select } from '../components/layout/select';
import { SidePanel } from '../components/layout/side-panel';
import { Stack } from '../components/layout/stack';
import { StatusBadge } from '../components/layout/status-badge';
import { Steps } from '../components/layout/steps';
import { Switch } from '../components/layout/switch';
import { TabPanel } from '../components/layout/tab-panel';
import { Table, type TableColumn } from '../components/layout/table';
import { Tag } from '../components/layout/tag';
import { Text } from '../components/layout/text';
import { TextArea } from '../components/layout/text-area';
import { TextInput } from '../components/layout/text-input';
import { TextLink } from '../components/layout/text-link';
import { TimeBar } from '../components/layout/time-bar';
import { Timeline } from '../components/layout/timeline';
import { Title } from '../components/layout/title';
import { Toggle } from '../components/layout/toggle';
import { RowItem, WindowBox, WindowList } from '../components/layout/windowed';
import { DOMAINS, STATUS_DICT, type StatusKey } from '../theme/status-dict';
import { ControlsSection } from './design-controls';
import { ConversationSection } from './design-conversation';
import { TranscriptSection } from './design-transcript';

interface DemoRow {
  id: string;
  name: string;
  status: StatusKey;
  cost: number | null;
  note: string;
}

const ROWS: DemoRow[] = [
  {
    id: 't1',
    name: '巡检：每 6 小时扫一遍单子',
    status: 'task:running',
    cost: 82,
    note: '第 3 段，已用 82 秒',
  },
  {
    id: 't2',
    name: '对账：额度和账单',
    status: 'task:failed',
    cost: 12,
    note: '连不上额度接口，已重试 2 次',
  },
  { id: 't3', name: '发布：fleet-dao 主线', status: 'task:stalled', cost: null, note: '20 分钟没动静' },
  { id: 't4', name: '整理：关闭过期单子', status: 'task:done', cost: 340, note: '关了 14 张' },
  { id: 't5', name: '扫描：新提的需求', status: 'task:queued', cost: 0, note: '排在第 2 位' },
];

const COLUMNS: TableColumn<DemoRow>[] = [
  { key: 'name', title: '任务' },
  { key: 'status', title: '状态', render: (v) => <StatusBadge status={v as StatusKey} variant="dot" /> },
  {
    key: 'cost',
    title: '耗时',
    align: 'right',
    render: (v) => (typeof v === 'number' ? <Text>{v} 秒</Text> : <Text tone="muted">没读到</Text>),
  },
];

const PROBES: ProbeCell[] = [
  ...Array.from({ length: 14 }, (_, i): ProbeCell => ({ result: 'ok', label: `${i + 1} 号 通过` })),
  { result: 'warn', label: '15 号 疑似换模型' },
  { result: 'ok', label: '16 号 通过' },
  { result: 'fail', label: '17 号 不通' },
  { result: 'fail', label: '18 号 不通' },
  { result: 'ok', label: '19 号 通过' },
  ...Array.from({ length: 4 }, (_, i): ProbeCell => ({ result: 'none', label: `${20 + i} 号 没探` })),
];

function Block({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <Stack gap="sm">
      <Stack direction="horizontal" gap="sm" align="baseline">
        <Text strong>{title}</Text>
        {note ? (
          <Text size="meta" tone="muted">
            {note}
          </Text>
        ) : null}
      </Stack>
      {children}
    </Stack>
  );
}

function StatusSection() {
  return (
    <Section
      title="状态 StatusBadge"
      description="状态从字典取（status=“域:键”）：进行中、正常、排队画点加字，警告橙、失败红画底色标签；表格里传 variant=“dot”只画点。"
    >
      <Stack>
        <Block title="五个等级" note="auto：warning、error 画标签">
          <Stack direction="horizontal" gap="xl" wrap align="center">
            <StatusBadge status="task:running" />
            <StatusBadge status="task:done" />
            <StatusBadge status="task:queued" />
            <StatusBadge status="task:stalled" />
            <StatusBadge status="task:failed" />
            <StatusBadge status="unknown" title="认不出的状态，悬停给原值" />
          </Stack>
        </Block>
        <Block title="variant=dot" note="表格状态列、挤的时候">
          <Stack direction="horizontal" gap="xl" wrap align="center">
            <StatusBadge status="task:running" variant="dot" />
            <StatusBadge status="task:done" variant="dot" />
            <StatusBadge status="task:queued" variant="dot" />
            <StatusBadge status="task:stalled" variant="dot" />
            <StatusBadge status="task:failed" variant="dot" />
            <StatusBadge status="unknown" variant="dot" />
          </Stack>
        </Block>
        <Block title="几个域里的词" note="路由、额度、机器、发布">
          <Stack direction="horizontal" gap="xl" wrap align="center">
            <StatusBadge status="route:live" />
            <StatusBadge status="route:degraded" />
            <StatusBadge status="route:fault" />
            <StatusBadge status="quota:quota:near-full" />
            <StatusBadge status="quota:quota:unread" />
            <StatusBadge status="machine:engine:down" />
            <StatusBadge status="machine:refresh:aging" />
            <StatusBadge status="release:ci:pending" />
            <StatusBadge status="release:ci:green" />
          </Stack>
        </Block>
        <Collapse
          title={`字典里的全部状态（${DOMAINS.reduce((n, d) => n + Object.keys(STATUS_DICT[d]).length, 0)} 条）`}
        >
          <Stack>
            {DOMAINS.map((d) => (
              <Stack key={d} gap="sm">
                <Text size="meta" tone="muted">
                  {d}
                </Text>
                <Stack direction="horizontal" gap="lg" wrap>
                  {Object.keys(STATUS_DICT[d]).map((k) => (
                    <StatusBadge key={k} status={`${d}:${k}` as StatusKey} variant="dot" />
                  ))}
                </Stack>
              </Stack>
            ))}
          </Stack>
        </Collapse>
      </Stack>
    </Section>
  );
}

function LayoutSection() {
  return (
    <Section title="版式 Stack、Grid、Text" description="页面不写 flex、gap、字号、灰字，选参数。">
      <Stack>
        <Block title="Stack" note="gap：sm 8 · md 12 · lg 16 · xl 24">
          <Stack gap="sm">
            {(['sm', 'md', 'lg', 'xl'] as const).map((g) => (
              <Stack key={g} direction="horizontal" gap={g} align="center">
                <Text size="meta" tone="muted">
                  {g}
                </Text>
                <Tag>一</Tag>
                <Tag>二</Tag>
                <Tag>三</Tag>
              </Stack>
            ))}
          </Stack>
        </Block>
        <Block title="Grid cols=2/3/4">
          <Stack>
            <Grid cols={2}>
              <Tag>1</Tag>
              <Tag>2</Tag>
            </Grid>
            <Grid cols={3}>
              <Tag>1</Tag>
              <Tag>2</Tag>
              <Tag>3</Tag>
            </Grid>
            <Grid cols={4}>
              <Tag>1</Tag>
              <Tag>2</Tag>
              <Tag>3</Tag>
              <Tag>4</Tag>
            </Grid>
          </Stack>
        </Block>
        <Block title="Text" note="size × tone">
          <Stack gap="sm">
            <Text size="heading">heading 16 · 区块标题</Text>
            <Text>body 14 · 正文、列表、按钮</Text>
            <Text size="meta" tone="muted">
              meta 12 · 时间戳、表头、计数
            </Text>
            <Stack direction="horizontal" gap="lg" wrap>
              <Text tone="secondary">secondary 次要</Text>
              <Text tone="muted">muted 灰字说明</Text>
              <Text tone="warning">warning 橙，只给异常</Text>
              <Text tone="danger">danger 红，只给异常</Text>
              <Text strong>strong 500</Text>
              <Text mono>a1b2c3d mono 13</Text>
            </Stack>
            <Text truncate title="很长的一行字会截成省略号，悬停给全文">
              truncate：很长的一行字会截成省略号，悬停给全文。很长的一行字会截成省略号，悬停给全文。很长的一行字会截成省略号，悬停给全文。很长的一行字会截成省略号，悬停给全文。
            </Text>
          </Stack>
        </Block>
      </Stack>
    </Section>
  );
}

function TableSection() {
  const [selected, setSelected] = useState<string | null>('t2');
  return (
    <Section
      title="表格 Table"
      description="表头灰底；悬停整行；选中行蓝底；展开行不套框；读失败整张表换成红条，不画成空表。"
    >
      <Stack gap="xl">
        <Block title="正常 + 展开 + 选中行（点行选中，点箭头展开）">
          <Table
            columns={COLUMNS}
            rows={ROWS}
            rowKey="id"
            selectedKey={selected}
            onRowClick={(r) => setSelected(r.id)}
            expandable={{
              render: (r) => <Text tone="secondary">{r.note}</Text>,
              defaultExpandedKeys: ['t2'],
            }}
          />
        </Block>
        <Block title="partial（一格没读到）" note="t3 的耗时读不到，写灰字「没读到」，不画 0">
          <Table columns={COLUMNS} rows={ROWS.slice(2, 4)} rowKey="id" />
        </Block>
        <Block
          title="分组行 groupRow + 附加行 subRow"
          note="额度页的渠道组头（通栏、fill-1 底）和就地展开的原因表单；返回 null 的行不画"
        >
          <Table
            columns={COLUMNS}
            rows={ROWS.slice(0, 3)}
            rowKey="id"
            groupRow={(r) => (r.id === ROWS[0]?.id ? <Text strong>第一组</Text> : null)}
            subRow={(r) => (r.id === ROWS[1]?.id ? <Text tone="secondary">就地展开的内容</Text> : null)}
          />
        </Block>
        <Block title="empty">
          <Table columns={COLUMNS} rows={[]} rowKey="id" empty={<Text tone="muted">这个仓还没有任务</Text>} />
        </Block>
        <Block title="loading">
          <Table columns={COLUMNS} rows={[]} rowKey="id" load={{ state: 'loading' }} />
        </Block>
        <Block title="error">
          <Table
            columns={COLUMNS}
            rows={[]}
            rowKey="id"
            load={{ state: 'error', what: '任务', reason: '连不上后端（502）', onRetry: () => {} }}
          />
        </Block>
      </Stack>
    </Section>
  );
}

function ProgressSection() {
  return (
    <Section
      title="进度条 Progress"
      description="蓝条；到 75% 变橙、到 90% 变红（可改）；没有绿色。竖线是「按时间该用到这里」。"
    >
      <Stack>
        <Progress percent={42} />
        <Progress percent={78} />
        <Progress percent={93} />
        <Progress percent={36} mark={60} label="36% · 该用到 60%" />
        <Progress percent={88} mark={50} />
        <Progress percent={{ ok: false, reason: '额度接口超时' }} />
      </Stack>
    </Section>
  );
}

function StepsSection() {
  return (
    <Section title="步骤条 Steps">
      <Stack gap="xl">
        <Steps
          current={2}
          items={[
            { title: '开单', description: '10:00' },
            { title: '验收', description: '10:30' },
            { title: '合并', description: '在走' },
            { title: '上线', description: '没到' },
          ]}
        />
        <Steps
          current={1}
          items={[
            { title: '开单', description: '10:00' },
            { title: '验收', description: 'CI 没过', status: 'error' },
            { title: '合并' },
          ]}
        />
      </Stack>
    </Section>
  );
}

function DescriptionsSection() {
  return (
    <Section
      title="描述列表 Descriptions"
      description="值收 Read：读失败的一项自己写灰字「没读到」，悬停给原因。"
    >
      <Stack gap="xl">
        <Descriptions
          columns={3}
          items={[
            { label: '周期', value: '每 15 分钟' },
            { label: '上次', value: '3 分钟前' },
            { label: '编号', value: 'job-scan-issues', mono: true },
            { label: '内存', value: { ok: true, value: '12.4 GB' }, hint: '共 32 GB' },
            { label: '磁盘', value: { ok: false, reason: '探针超时' } },
            { label: '提交', value: 'a1b2c3d4e', mono: true },
          ]}
        />
        <Descriptions
          columns={1}
          items={[
            { label: '说明', value: '一列版：标签在左，值在右，长了自己折行。' },
            { label: '版本', value: { ok: false, reason: '读不到引擎版本' }, mono: true },
          ]}
        />
      </Stack>
    </Section>
  );
}

function EntrySection() {
  const [open, setOpen] = useState(false);
  return (
    <Section
      title="入口格 Entry"
      description="法国页「更多」那种：链接或按钮，标题加灰字，可带一个标签（只给异常）。"
    >
      <EntryGrid>
        <Entry icon={Clock} title="定时任务" tag="失败 1" tagTone="error" href="/schedules" />
        <Entry icon={Clock} title="资源" meta="每个项目占多少，机器的内存、CPU、磁盘" href="/resources" />
        <Entry icon={Clock} title="发布记录" href="/changelog" />
        <Entry
          icon={Clock}
          title="命令行工具"
          meta={open ? '收起' : '3 个，1 个落后'}
          expanded={open}
          onClick={() => setOpen((o) => !o)}
        />
      </EntryGrid>
    </Section>
  );
}

function ProbeSection() {
  const [sel, setSel] = useState<number | null>(16);
  return (
    <Section title="探测格 ProbeCells" description="通＝灰格，没探＝空心框，警告橙，失败红；点一格选中。">
      <Stack>
        <ProbeCells items={PROBES} selected={sel} onSelect={setSel} />
        <Text size="meta" tone="muted">
          {sel === null ? '没选' : (PROBES[sel]?.label ?? '没选')}
        </Text>
        <ProbeCells items={PROBES.slice(0, 10)} />
        {/* 渠道状态页的变体：补位格（label 为空）、data-cell/data-kind、手机上只做展示的整条（summary） */}
        <ProbeCells
          items={[
            { result: 'none', label: '' },
            { result: 'ok', label: '10:00 通过', id: 1, kind: 'passed' },
            { result: 'warn', label: '10:15 连通但额度耗尽', id: 2, kind: 'quota' },
            { result: 'fail', label: '10:30 不通', id: 3, kind: 'failed' },
          ]}
          summary="近 3 次真探：通过 1、连通但额度耗尽 1、不通 1"
        />
      </Stack>
    </Section>
  );
}

function TimelineSection() {
  return (
    <Section title="时间线 Timeline">
      <Timeline
        items={[
          { title: '已合并', time: '10:42', description: '#3504 驾驶舱令牌', status: 'success' },
          { title: '验收中', time: '10:30', description: 'CI 在跑', status: 'processing' },
          { title: '卡在评审', time: '10:12', description: '等了 20 分钟', status: 'warning' },
          { title: '第一次没过', time: '10:05', description: '类型检查红', status: 'error' },
          { title: '开单', time: '09:58' },
        ]}
      />
    </Section>
  );
}

function PickSection() {
  const [v, setV] = useState('a');
  const items = [
    { key: 'a', title: 'anthropic · sonnet', meta: '近 24 次 · 3 分钟前', status: 'route:live' },
    { key: 'b', title: 'relay-hk · opus', meta: '近 24 次 · 12 分钟前', status: 'route:fault' },
    { key: 'c', title: 'openai · gpt', meta: '没探过', status: 'route:unprobed' },
    { key: 'd', title: 'relay-sg · haiku', meta: '近 24 次 · 刚刚', status: 'route:degraded' },
  ] as const;
  return (
    <Grid preset="split">
      <Section title="渠道（PickList）" flush>
        <PickList aria-label="渠道" items={items} value={v} onChange={setV} />
      </Section>
      <Section title={items.find((i) => i.key === v)?.title} description="Grid preset=split：左列表右详情">
        <Descriptions
          columns={2}
          items={[
            { label: '近 24 次', value: '23 通 / 1 失败' },
            { label: '延迟', value: { ok: false, reason: '探测没带延迟' } },
          ]}
        />
      </Section>
    </Grid>
  );
}

/** 陈列页传进来的输入框（输入框只有基础件有，业务层摆不了）。 */
export type DemoInput = (opts: {
  id?: string;
  placeholder?: string;
  defaultValue?: string;
  invalid?: boolean;
}) => ReactNode;

function MiscSection({ overlays, input }: { overlays: ReactNode; input: DemoInput }) {
  const [msgs, setMsgs] = useState<{ role: 'me' | 'other' | 'tool'; meta: string; body: string }[]>([
    { role: 'me', meta: '你 10:00', body: '把 /tasks 的状态列改成点加字' },
    { role: 'tool', meta: '工具 10:01', body: 'gh issue create --title "任务页状态列"\n#3521 created' },
    { role: 'other', meta: '指挥官 10:01', body: '开好了，单号 #3521。派给法国引擎去做，做完我来验收。' },
  ]);
  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');
  return (
    <Stack gap="xl">
      <Section
        title="折叠 Collapse + 悬停说明 InfoTip"
        description="低频的东西收在这里；展开是高度加淡入 200。"
      >
        <Stack>
          <Stack direction="horizontal" gap="sm" align="center">
            <Text>三段 / 全程</Text>
            <InfoTip content="三段＝只做分诊、方案、实现；全程＝连验收和合并一起做。" />
          </Stack>
          <Collapse title="高级设置">
            <Text tone="secondary">这里放不常用的选项。默认收着，点标题展开。</Text>
          </Collapse>
          <Collapse title="已展开的一个" defaultOpen>
            <Text tone="secondary">defaultOpen：一开始就开着。</Text>
          </Collapse>
        </Stack>
      </Section>

      <Section
        title="表单 Form / FormItem"
        description="左标签右控件（窄屏标签在上）；必填红星；help 灰字；error 红字。"
      >
        <Stack gap="xl">
          <Form>
            <FormItem label="仓名" required htmlFor="demo-repo" help="显示在顶栏的仓切换里">
              {input({ id: 'demo-repo', defaultValue: 'fleet-dao' })}
            </FormItem>
            <FormItem label="环境" htmlFor="demo-env">
              <NativeSelect id="demo-env">
                <option>本机</option>
                <option>香港</option>
              </NativeSelect>
            </FormItem>
            <FormItem label="口令" required error="口令不对，再试一次" htmlFor="demo-pass">
              {input({ id: 'demo-pass', placeholder: '输入口令', invalid: true })}
            </FormItem>
          </Form>
          <Form>
            <FormItem label="竖排的标签" layout="vertical" help="layout=vertical：标签永远在上">
              {input({ placeholder: '随便写点' })}
            </FormItem>
          </Form>
          <Form>
            <FormItem
              label="原因"
              required
              layout="vertical"
              htmlFor="demo-reason"
              help="TextArea：多行输入，最少三行"
            >
              <TextArea id="demo-reason" value={reason} onChange={setReason} placeholder="写一句为什么改" />
            </FormItem>
          </Form>
        </Stack>
      </Section>

      <Section title="对话 Chat / Composer">
        <Stack>
          <Chat messages={msgs} />
          <Composer
            value={draft}
            onChange={setDraft}
            placeholder="说点什么"
            onSend={() => {
              setMsgs((m) => [...m, { role: 'me', meta: '你 刚刚', body: draft }]);
              setDraft('');
            }}
          />
        </Stack>
      </Section>

      <Section
        title="确认框 ConfirmDialog、抽屉 Drawer"
        description="确认框：忙态不可关，失败留在原处写原因。抽屉三档宽 sm / md / lg。"
      >
        {overlays}
      </Section>

      <Section title="页内导航 Anchor" description="设置页左边那一列；窄屏排成一行。">
        <Anchor
          items={[
            { id: 'a-general', label: '通用' },
            { id: 'a-notify', label: '通知' },
            { id: 'a-engine', label: '引擎' },
          ]}
        />
      </Section>

      <Section title="登录卡片 AuthCard（陈列时不撑满整屏）" flush>
        <AuthCard title="登录驾驶舱" description="用口令进来" footer="v1.0.0 · 香港门面" embedded>
          <Form>
            <FormItem label="口令" layout="vertical">
              {input({ placeholder: '输入口令' })}
            </FormItem>
          </Form>
        </AuthCard>
      </Section>
    </Stack>
  );
}

/** 任务页过程用的件（#3533）：展开行、色带、缩进、时间条、侧面板。 */
function ProcessPartsSection() {
  const [open, setOpen] = useState<Record<string, boolean>>({ r2: true });
  const [panelOpen, setPanelOpen] = useState(false);
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  return (
    <Section
      title="过程的件 Disclosure、Band、Nest、TimeBar、SidePanel"
      description="展开行由页面管开合（有失败的自动展开，人点过就听人的）；色带夹在列表里写引擎做的事、为什么返工；时间条一段一个按钮；侧面板是右边盖上来的抽屉。"
    >
      <Stack gap="md">
        <Block title="TimeBar" note="失败红、在跑蓝、其余灰">
          <TimeBar
            label="每一笔各占多久"
            onPick={() => {}}
            items={[
              { id: 'a', weight: 4, state: 'fail', label: '动手第 1 次，用时 30 分钟' },
              { id: 'b', weight: 1, label: '验收第 1 次，用时 3 分钟' },
              { id: 'c', weight: 3, state: 'run', label: '动手第 2 次，用时 12 分钟' },
            ]}
          />
        </Block>
        <Block title="DisclosureRow、Band" note="回合头：结局放右边；返工回合下面一条淡红色带">
          <Stack gap="sm">
            <DisclosureRow
              open={!!open.r1}
              onToggle={() => toggle('r1')}
              header={
                <Stack direction="horizontal" gap="sm" align="baseline">
                  <Text strong>第 1 回合</Text>
                  <Text size="meta" tone="muted">
                    10:02–10:40 · 38 分钟 · 1 笔
                  </Text>
                </Stack>
              }
              trailing={<StatusBadge status="task:round:timeout" />}
            />
            <DisclosureRow
              open={!!open.r2}
              onToggle={() => toggle('r2')}
              header={<Text strong>第 2 回合</Text>}
              trailing={<StatusBadge status="task:round:open" />}
              actions={
                <Button variant="text" size="xs">
                  看会话
                </Button>
              }
            />
            <Band tone="danger">
              <Text size="meta" tone="danger" strong>
                为什么返工
              </Text>{' '}
              <Text size="meta" tone="secondary">
                上一回合超时——30 分钟没交活
              </Text>
            </Band>
            <Band>引擎 自测 → 推分支 → 开 PR → 等 CI</Band>
          </Stack>
        </Block>
        <Block title="Nest" note="子代理说的话、它的调用缩进一级">
          <Nest>
            <Text size="meta" tone="muted">
              子代理：我先看一下 README 里这一行怎么生成的。
            </Text>
          </Nest>
        </Block>
        <Block title="SidePanel" note="右边盖上来的抽屉，手机从底下整屏">
          <Button size="sm" onClick={() => setPanelOpen(true)}>
            打开侧面板
          </Button>
          <SidePanel
            open={panelOpen}
            onOpenChange={setPanelOpen}
            title="过程"
            header={
              <Stack direction="horizontal" gap="sm" align="center" justify="between">
                <Text size="heading" strong>
                  过程
                </Text>
                <Button size="sm" variant="text" onClick={() => setPanelOpen(false)}>
                  关闭
                </Button>
              </Stack>
            }
          >
            <Band>面板里的内容</Band>
          </SidePanel>
        </Block>
      </Stack>
    </Section>
  );
}

/** 任务详情页用的件（#3533）：面包屑、文字链接、页签面板。 */
function TaskPageParts() {
  return (
    <Section
      title="面包屑 Breadcrumb、文字链接 TextLink、页签面板 TabPanel"
      description="面包屑最后一项是当前页（不是链接）；文字链接站内走路由、external 开新窗口；页签面板配 FilterTabs 的 idPrefix。"
    >
      <Stack gap="md">
        <Block title="Breadcrumb">
          <Breadcrumb
            items={[{ label: '驾驶舱', href: '/' }, { label: '任务', href: '/tasks' }, { label: '#3491' }]}
          />
        </Block>
        <Block title="TextLink" note="站内 / 外部 / 等宽">
          <Stack direction="horizontal" gap="md" align="baseline">
            <TextLink href="/tasks">站内链接</TextLink>
            <TextLink href="https://example.com" external>
              外部链接
            </TextLink>
            <TextLink href="/tasks/t-c9" mono>
              #3491
            </TextLink>
          </Stack>
        </Block>
        <Block title="ListFooter" note="任务列表底栏：到底了 / 加载更多">
          <ListFooter>
            <Text size="meta" tone="muted">
              已经到底，共 12 张
            </Text>
          </ListFooter>
        </Block>
        <Block title="TabPanel">
          <TabPanel idPrefix="demo" id="latest">
            <Text size="meta" tone="muted">
              选中页签对应的内容
            </Text>
          </TabPanel>
        </Block>
      </Stack>
    </Section>
  );
}

/** 路由页用的小件（#3533）：开关、筛选钮、下拉、输入框、对话框、行按钮、折叠条、定高窗口行、拖动柄、横滑行、标题。 */
function RoutingPartsSection() {
  const [on, setOn] = useState(true);
  const [pressed, setPressed] = useState(false);
  const [pick, setPick] = useState('high');
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [fold, setFold] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [picked, setPicked] = useState('b');
  return (
    <Section
      title="路由页的小件 Switch、Toggle、Select、RowButton、窗口行"
      description="列表行里的开关、筛选钮、档位下拉、整块可点的行、定高窗口行、拖动柄。"
    >
      <Stack gap="lg">
        <Block title="Switch" note="size=sm 给列表行；置灰时悬停写原因">
          <Stack direction="horizontal" gap="md" align="center">
            <Switch checked={on} onCheckedChange={setOn} aria-label="演示开关" />
            <Switch checked={on} onCheckedChange={setOn} size="sm" aria-label="演示小开关" />
            <Switch
              checked={false}
              onCheckedChange={() => {}}
              disabled
              title="去那台上操作"
              aria-label="置灰"
            />
          </Stack>
        </Block>
        <Block title="Toggle" note="按下是品牌浅底">
          <Stack direction="horizontal" gap="sm" align="center">
            <Toggle pressed={pressed} onPressedChange={setPressed}>
              只看已开启
            </Toggle>
            <Toggle pressed onPressedChange={() => {}}>
              显示全部
            </Toggle>
          </Stack>
        </Block>
        <Block title="Select / TextInput / Title">
          <Stack direction="horizontal" gap="md" align="center" wrap>
            <Select
              value={pick}
              onValueChange={setPick}
              aria-label="演示档位"
              options={[
                { value: 'default', label: '默认', title: '没配，用默认档 high' },
                { value: 'high', label: 'high', numeric: true },
                { value: 'xhigh', label: 'xhigh', numeric: true },
              ]}
            />
            <TextInput
              value={text}
              onChange={setText}
              placeholder="例如 claude-sonnet-x"
              aria-label="演示输入"
            />
          </Stack>
          <Title level={1}>动手</Title>
          <Title level={3}>渠道里有、目录里还没有的模型</Title>
        </Block>
        <Block title="RowButton、FoldBar、DisclosureIcon" note="点名字看详情；折叠条整行可点">
          <Stack gap="sm">
            <RowFrame>
              <RowButton onClick={() => setOpen((v) => !v)} expanded={open}>
                <DisclosureIcon open={open} />
                <Text strong>Opus 5.5</Text>
              </RowButton>
            </RowFrame>
            <RowFrame>
              <RowButton onClick={() => {}} dim>
                <Text strong>关着的模型</Text>
              </RowButton>
            </RowFrame>
            <FoldBar open={fold} onToggle={() => setFold((v) => !v)} controls="demo-fold">
              配不了 3 条
            </FoldBar>
            <FoldBar open size="group" onToggle={() => {}} controls="demo-group">
              Claude 3 条，已配 1
            </FoldBar>
          </Stack>
        </Block>
        <Block
          title="WindowBox / WindowList / RowItem（定高窗口行）"
          note="选中行换底；行高给定，只画看得见的几行"
        >
          <WindowBox height={96}>
            <WindowList ariaLabel="演示窗口">
              {['a', 'b', 'c'].map((id) => (
                <RowItem key={id} selected={picked === id} height={48}>
                  <RowFrame className="h-full">
                    <RowButton onClick={() => setPicked(id)} pressed={picked === id}>
                      <Text strong>模型 {id}</Text>
                    </RowButton>
                    <DragHandle
                      label={`拖动 ${id}`}
                      title="拖到新位置"
                      draggable
                      disabled={false}
                      busy={false}
                      onDragStart={() => {}}
                      onDragEnd={() => {}}
                      onKeyDown={() => {}}
                    />
                  </RowFrame>
                </RowItem>
              ))}
            </WindowList>
          </WindowBox>
        </Block>
        <Block title="ScrollRow / Dialog" note="筛选行放不下横滑；对话框放自己的内容">
          <ScrollRow>
            <Toggle pressed={false} onPressedChange={() => {}}>
              只看已开启
            </Toggle>
            <Toggle pressed onPressedChange={() => {}}>
              新发现
            </Toggle>
            <Button variant="text" size="sm" onClick={() => {}}>
              清除筛选
            </Button>
          </ScrollRow>
          <Button onClick={() => setDialog(true)}>打开对话框</Button>
          <Dialog
            open={dialog}
            onOpenChange={setDialog}
            title="往动手里加模型"
            description="只列没排进来的。"
          >
            <Text tone="muted">这里放选择器。</Text>
          </Dialog>
        </Block>
      </Stack>
    </Section>
  );
}

/** 「组件」一节。overlays 是确认框、抽屉的触发键，input 是输入框：它们只有基础件有，业务层摆不了，由陈列页自己传进来。 */
export function ComponentsGallery({ overlays, input }: { overlays: ReactNode; input: DemoInput }) {
  return (
    <Stack gap="xl">
      <Text size="heading" strong>
        组件（片 3 新件）
      </Text>
      <StatusSection />
      <ControlsSection />
      <ConversationSection />
      <LayoutSection />
      <TableSection />
      <ProgressSection />
      <StepsSection />
      <DescriptionsSection />
      <ProbeSection />
      <EntrySection />
      <TimelineSection />
      <PickSection />
      <ProcessPartsSection />
      <TaskPageParts />
      <TranscriptSection />
      <RoutingPartsSection />
      <MiscSection overlays={overlays} input={input} />
    </Stack>
  );
}
