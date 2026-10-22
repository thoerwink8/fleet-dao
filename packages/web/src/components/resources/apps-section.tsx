// 资源页「上线项目」一节（#1986；#3509 照 Arco，样稿 canvas/Resources.dc.html）：一个项目一行，表头「项目 · 放在哪、CPU、内存、磁盘」；
// 点开看放在哪、服务单元、口径、名下的目录和库、AI 会话按所属仓的分摊。
// 标签：不归本仓管、定时任务是灰的，没登记是橙的（颜色只给异常）。没登记的行不在行里写源码路径，展开才写怎么登记。
// 每一格怎么写（读成了、没在占用、没读到、不全）在 view.ts 和 cells.tsx；这里只管摆。
import type { HomeResources, HomeRunning } from '../home/types';
import { Descriptions, type DescriptionsItem } from '../layout/descriptions';
import { List, ListRow } from '../layout/list';
import { LoadPartial } from '../layout/load-state';
import { Section } from '../layout/section';
import { Stack } from '../layout/stack';
import { Table, type TableColumn } from '../layout/table';
import { Tag } from '../layout/tag';
import { Text } from '../layout/text';
import { CellText, cellWord, DiskText, diskWord, whyOf } from './cells';
import { type AppRow, appRows, type DiskPart, UNREGISTERED_HINT } from './view';

function PartLine({ part }: { part: DiskPart }) {
  const note =
    part.size.kind === 'unread' ? part.size.why : part.size.kind === 'ok' ? part.size.incomplete : undefined;
  return (
    <ListRow
      title={
        <Text mono={part.kind === 'dir'} title={part.label}>
          {part.label}
        </Text>
      }
      {...(note
        ? {
            meta: (
              <Text size="meta" tone="muted">
                {note}
              </Text>
            ),
          }
        : {})}
      trailing={<DiskText cell={part.size} />}
    />
  );
}

function AppDetail({ row, totalCores }: { row: AppRow; totalCores: number | undefined }) {
  const cpuWhy = whyOf(row.cpu);
  const memWhy = whyOf(row.memory);
  const diskWhy = whyOf(row.disk);
  const items: DescriptionsItem[] = [
    { label: '放在哪', value: row.place, mono: true },
    {
      label: '服务单元',
      value: row.units.length ? row.units.join('、') : '没有（不是进程，只占磁盘）',
      mono: row.units.length > 0,
    },
    ...(row.unregistered
      ? [
          {
            label: '没登记',
            value: `机器上在跑，但登记表里没有它：${UNREGISTERED_HINT}（要么加一项，要么写进「系统自带服务」名单）`,
          },
        ]
      : []),
    {
      label: 'CPU',
      value: `${row.cpu.kind === 'ok' ? `忙 ${row.cpu.text}${totalCores ? `（整机 ${totalCores} 核）` : ''}` : cellWord(row.cpu)}${
        row.cpu.kind !== 'ok' && cpuWhy ? `：${cpuWhy}` : ''
      }`,
    },
    {
      label: '内存',
      value:
        row.memory.kind === 'ok'
          ? (row.memory.title ?? row.memory.text)
          : `${cellWord(row.memory)}${memWhy ? `：${memWhy}` : ''}`,
    },
    {
      label: '磁盘',
      value:
        row.disk.kind === 'ok'
          ? `${row.disk.text}${row.disk.incomplete ? `（${row.disk.incomplete}，数是下限）` : ''}`
          : `${diskWord(row.disk)}${diskWhy ? `：${diskWhy}` : ''}`,
    },
  ];
  return (
    <div data-app-detail={row.id}>
      <Stack>
        <Descriptions columns={1} items={items} />
        {row.diskParts.length ? (
          <Stack gap="sm">
            <Text size="meta" tone="muted">
              名下的目录和库
            </Text>
            <List>
              {row.diskParts.map((p) => (
                <PartLine key={p.key} part={p} />
              ))}
            </List>
          </Stack>
        ) : null}
        {row.children?.length ? (
          <div data-app-children>
            <Stack gap="sm">
              <Text size="meta" tone="muted">
                按所属仓　会话的磁盘算在上面的工作树目录里，不按仓分
              </Text>
              <List>
                {row.children.map((c) => (
                  <ListRow
                    key={c.key}
                    title={<Text title={c.name}>{c.name}</Text>}
                    meta={
                      <Text size="meta" tone="muted">
                        {c.sessions} 个会话{c.emptyScopes ? ` · ${c.emptyScopes} 个没有进程的空分组` : ''}
                      </Text>
                    }
                    trailing={
                      <Stack direction="horizontal" gap="xl" align="center">
                        <Stack direction="horizontal" gap="sm" align="baseline">
                          <Text size="meta" tone="muted">
                            CPU
                          </Text>
                          <CellText cell={c.cpu} />
                        </Stack>
                        <Stack direction="horizontal" gap="sm" align="baseline">
                          <Text size="meta" tone="muted">
                            内存
                          </Text>
                          <CellText cell={c.memory} />
                        </Stack>
                      </Stack>
                    }
                  />
                ))}
              </List>
            </Stack>
          </div>
        ) : null}
      </Stack>
    </div>
  );
}

function columns(): TableColumn<AppRow>[] {
  return [
    {
      key: 'name',
      title: '项目 · 放在哪',
      render: (_, row) => (
        <div data-app={row.id}>
          <Stack direction="horizontal" gap="sm" align="center">
            <Text strong>{row.name}</Text>
            {row.external ? <Tag>不归本仓管</Tag> : null}
            {row.scheduled ? <Tag>定时任务</Tag> : null}
            {row.unregistered ? <Tag tone="warning">没登记</Tag> : null}
          </Stack>
          <span data-unregistered-hint={row.unregistered ? '' : undefined}>
            <Text
              as="div"
              size="meta"
              tone="muted"
              truncate
              title={row.unregistered ? `${row.place}；${UNREGISTERED_HINT}` : row.place}
              mono={row.place.startsWith('/')}
            >
              {row.unregistered ? '展开看怎么登记' : row.place}
            </Text>
          </span>
        </div>
      ),
    },
    { key: 'cpu', title: 'CPU', align: 'right', render: (_, row) => <CellText cell={row.cpu} /> },
    { key: 'memory', title: '内存', align: 'right', render: (_, row) => <CellText cell={row.memory} /> },
    { key: 'disk', title: '磁盘', align: 'right', render: (_, row) => <DiskText cell={row.disk} /> },
  ];
}

export function AppsSection({
  resources,
  running,
  remote,
}: {
  resources: HomeResources | undefined;
  running: readonly HomeRunning[];
  remote: boolean;
}) {
  const result = appRows(resources, running, { remote });
  const totalCores = resources?.cpu.state === 'ok' ? resources.cpu.cores : undefined;
  if (result.kind === 'unread') {
    return (
      <Section title="上线项目" data-resources-apps>
        <span data-resources-apps-missing>
          <Text tone="muted">没读到：{result.why}</Text>
        </span>
      </Section>
    );
  }
  return (
    <Stack>
      {result.scanWhy ? (
        <span data-resources-apps-scan>
          <LoadPartial>没登记的服务、定时任务没扫成，可能还有没列出来的：{result.scanWhy}</LoadPartial>
        </span>
      ) : null}
      <Section
        flush
        title="上线项目"
        data-resources-apps
        actions={
          <Text size="meta" tone="muted">
            此刻的 CPU、内存，名下目录和库的磁盘
          </Text>
        }
      >
        <Table
          caption="上线项目"
          columns={columns()}
          rows={result.rows}
          rowKey="id"
          expandable={{ render: (row) => <AppDetail row={row} totalCores={totalCores} /> }}
        />
      </Section>
    </Stack>
  );
}
