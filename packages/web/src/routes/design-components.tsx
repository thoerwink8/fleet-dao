// 陈列页 /_design 的「组件」一节（#3509 片 3）：新做的业务组件（Stack、Grid、Text、Table、Progress、Steps、Descriptions、ProbeCells、
// Timeline、PickList、Anchor、Collapse、Form、ConfirmDialog、Drawer、InfoTip、AuthCard、Chat）和改过的 StatusBadge，
// 每个都摆出常见状态，包括读失败（error）、没有数据（empty）、读到一部分（partial）的样子。
// 这个文件是业务层：一个样式类也不写，只拼组件（lint-design R13–R20 对它是 0）。
import { type ReactNode, useState } from 'react';
import { Anchor } from '../components/layout/anchor';
import { AuthCard } from '../components/layout/auth-card';
import { Chat, Composer } from '../components/layout/chat';
import { Collapse } from '../components/layout/collapse';
import { Descriptions } from '../components/layout/descriptions';
import { Form, FormItem } from '../components/layout/form';
import { Grid } from '../components/layout/grid';
import { InfoTip } from '../components/layout/info-tip';
import { NativeSelect } from '../components/layout/native-select';
import { PickList } from '../components/layout/pick-list';
import { type ProbeCell, ProbeCells } from '../components/layout/probe-cells';
import { Progress } from '../components/layout/progress';
import { Section } from '../components/layout/section';
import { Stack } from '../components/layout/stack';
import { StatusBadge } from '../components/layout/status-badge';
import { Steps } from '../components/layout/steps';
import { Table, type TableColumn } from '../components/layout/table';
import { Tag } from '../components/layout/tag';
import { Text } from '../components/layout/text';
import { Timeline } from '../components/layout/timeline';
import { DOMAINS, STATUS_DICT, type StatusKey } from '../theme/status-dict';

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

/** 「组件」一节。overlays 是确认框、抽屉的触发键，input 是输入框：它们只有基础件有，业务层摆不了，由陈列页自己传进来。 */
export function ComponentsGallery({ overlays, input }: { overlays: ReactNode; input: DemoInput }) {
  return (
    <Stack gap="xl">
      <Text size="heading" strong>
        组件（片 3 新件）
      </Text>
      <StatusSection />
      <LayoutSection />
      <TableSection />
      <ProgressSection />
      <StepsSection />
      <DescriptionsSection />
      <ProbeSection />
      <TimelineSection />
      <PickSection />
      <MiscSection overlays={overlays} input={input} />
    </Stack>
  );
}
