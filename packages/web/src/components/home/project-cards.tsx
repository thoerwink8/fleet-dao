// 工作台「项目」（#2759，#3509 起是一张表）：一个仓一行。本周上线几版、在跑几张、卡住几张、当前里程碑。
// 有问题的排前面；卡住的数标橙（颜色只给异常），本周上线、里程碑读不到写「没记」，不拿 0 顶。

import { EmptyState } from '../layout/empty-state';
import { Section } from '../layout/section';
import { Table, type TableColumn } from '../layout/table';
import { Tag } from '../layout/tag';
import { Text } from '../layout/text';
import { milestoneText, projectProblem, shippedText, sortProjects } from './projects';
import type { HomeProject } from './types';

const COLUMNS: TableColumn<HomeProject>[] = [
  {
    key: 'repo',
    title: '仓',
    render: (_, p) => (
      <span data-project={p.repo} data-problem={projectProblem(p) ? 'yes' : 'no'}>
        <Text strong>{p.repo}</Text>
      </span>
    ),
  },
  {
    key: 'shippedThisWeek',
    title: '本周上线',
    align: 'right',
    render: (_, p) => shippedText(p.shippedThisWeek),
  },
  { key: 'running', title: '在跑', align: 'right', render: (_, p) => `${p.running} 张` },
  {
    key: 'stuck',
    title: '卡住',
    align: 'right',
    render: (_, p) => (p.stuck > 0 ? <Tag tone="warning">{p.stuck} 张</Tag> : `${p.stuck} 张`),
  },
  { key: 'milestone', title: '里程碑', render: (_, p) => milestoneText(p.milestone) },
];

/** 每个仓一行。没给这一块（老后端）写明没给，不画成「还没有项目」。 */
export function ProjectCards({ projects }: { projects: readonly HomeProject[] | undefined }) {
  if (projects === undefined) {
    return (
      <Section title="项目" data-project-cards="missing">
        <Text tone="muted">项目这一块没给</Text>
      </Section>
    );
  }
  if (projects.length === 0) {
    return (
      <Section title="项目" data-project-cards="empty">
        <EmptyState size="inline" title="还没有项目" />
      </Section>
    );
  }
  return (
    <Section flush title="项目" data-project-cards>
      <Table caption="项目" columns={COLUMNS} rows={sortProjects(projects)} rowKey="id" />
    </Section>
  );
}
