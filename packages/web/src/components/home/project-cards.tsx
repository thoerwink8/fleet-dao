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

/**
 * 收起时的一行摘要（#3707 批次 3）：几个仓、其中几个卡住了。没给这一块、还没有项目都照实写。
 * 判法用 `projectProblem`（卡住，或还有要拍的），和「有问题排前面」同一份。
 */
export function projectsSummary(projects: readonly HomeProject[] | undefined): string {
  if (projects === undefined) return '项目这一块没给';
  if (projects.length === 0) return '还没有项目';
  const stuck = projects.filter(projectProblem).length;
  return stuck > 0 ? `${projects.length} 个仓 · ${stuck} 个有问题` : `${projects.length} 个仓 · 都正常`;
}

/** 收起区块的开关状态（#3707 批次 3）；不给就不收，老样子。 */
export interface CollapsibleProps {
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
}

/** 每个仓一行。没给这一块（老后端）写明没给，不画成「还没有项目」。 */
export function ProjectCards({
  projects,
  collapsible,
  open,
  onToggle,
}: { projects: readonly HomeProject[] | undefined } & CollapsibleProps) {
  const folding = {
    ...(collapsible
      ? { collapsible, open: open === true, 'data-fold-block': 'projects', ...(onToggle ? { onToggle } : {}) }
      : {}),
  };
  const summary = <>{projectsSummary(projects)}</>;
  if (projects === undefined) {
    return (
      <Section title="项目" data-project-cards="missing" summary={summary} {...folding}>
        <Text tone="muted">项目这一块没给</Text>
      </Section>
    );
  }
  if (projects.length === 0) {
    return (
      <Section title="项目" data-project-cards="empty" summary={summary} {...folding}>
        <EmptyState size="inline" title="还没有项目" />
      </Section>
    );
  }
  return (
    <Section flush title="项目" data-project-cards summary={summary} {...folding}>
      <Table caption="项目" columns={COLUMNS} rows={sortProjects(projects)} rowKey="id" />
    </Section>
  );
}
