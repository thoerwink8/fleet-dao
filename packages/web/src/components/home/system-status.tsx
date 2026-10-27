// 工作台「系统状态」（#3509，样稿 Main.dc.html 最后一块）：流水线、中转、引擎进程，一行一个状态。
// 额度在上面的指标里，引擎总开关在顶栏，不重复写；本机会话在「在跑的任务」里，不重复写。
// 有问题持续显示、不伪装成失败：额度紧、有路由不通、引擎按配置关着是橙或灰；引擎开着却探不到在线的工人才是红；没查成不写成正常。
import { useNow } from '../../lib/hooks';
import { type StatusKey, statusEntry } from '../../theme/status-dict';
import { Descriptions, type DescriptionsItem } from '../layout/descriptions';
import { Stack } from '../layout/stack';
import { LevelDot, StatusBadge } from '../layout/status-badge';
import { Text } from '../layout/text';
import { pipelineOf } from './headline';
import type { HomeHealth, HomePipeline } from './types';

const ROUTES_STATUS: Record<HomeHealth['routes']['state'], StatusKey> = {
  ok: 'machine:health:ok',
  degraded: 'machine:health:routes-degraded',
  unknown: 'machine:meter:unread',
};

const ENGINE_STATUS: Record<HomeHealth['engine']['state'], StatusKey> = {
  on: 'machine:engine:on',
  off: 'machine:health:engine-off',
  down: 'machine:health:engine-down',
  unknown: 'machine:health:engine-unknown',
};

/** 系统状态那几行：名字、状态、一句详情。 */
export function systemItems(
  health: HomeHealth,
  pipeline: HomePipeline | undefined,
  now: number,
): DescriptionsItem[] {
  const line = pipelineOf({ pipeline, now });
  return [
    {
      label: '流水线',
      value: (
        <span data-system-row="pipeline" data-level={line.level}>
          <Stack direction="horizontal" gap="sm" align="center">
            <LevelDot level={line.level} />
            <Text>{line.text}</Text>
          </Stack>
        </span>
      ),
    },
    {
      label: '中转',
      value: <StatusBadge status={ROUTES_STATUS[health.routes.state]} />,
      hint: health.routes.detail,
    },
    {
      label: '引擎进程',
      value: <StatusBadge status={ENGINE_STATUS[health.engine.state]} />,
      ...(health.engine.detail ? { hint: health.engine.detail } : {}),
    },
  ];
}

/**
 * 收起时的一行摘要（#3707 批次 3）：流水线一句、中转和引擎各一个状态词，有没有异常一眼看得出。
 * 状态词从字典取（R20：业务层不自己写状态中文），判法和正文那一行一致（`pipelineOf`、`ROUTES_STATUS`、`ENGINE_STATUS`）。
 */
export function systemSummary(health: HomeHealth, pipeline: HomePipeline | undefined, now: number): string {
  const line = pipelineOf({ pipeline, now });
  const routes = statusEntry(ROUTES_STATUS[health.routes.state]).label;
  const engine = statusEntry(ENGINE_STATUS[health.engine.state]).label;
  return `流水线 ${line.text} · 中转 ${routes} · 引擎进程 ${engine}`;
}

export function SystemStatus({
  health,
  pipeline,
}: {
  health: HomeHealth;
  pipeline: HomePipeline | undefined;
}) {
  const now = useNow();
  return <Descriptions columns={1} items={systemItems(health, pipeline, now)} />;
}
