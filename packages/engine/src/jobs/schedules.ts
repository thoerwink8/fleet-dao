// 引擎的 Temporal 定时任务（design 第四节：替代旧系统的 systemd 定时器）。引擎每次启动都按这里的声明对一遍：
// 编号固定，没有就建，有了就按声明更新（保留人手动暂停的状态），重启、重复部署都不会多出第二个。
import {
  type Client,
  ScheduleAlreadyRunning,
  type ScheduleOptionsStartWorkflowAction,
  ScheduleOverlapPolicy,
  type ScheduleSpec,
  type ScheduleUpdateOptions,
} from '@temporalio/client';
import type { Workflow } from '@temporalio/common';
import {
  type CanaryInput,
  type GitHubReconcileInput,
  type HourlyReconcileInput,
  type RouteProbeInput,
  WORKFLOW_TYPES,
} from '../contract.ts';
import {
  CANARY_EVERY_HOURS,
  CANARY_JOB,
  CANARY_OFFSET_MINUTES,
  CANARY_RUN_TIMEOUT_MINUTES,
} from './canary.ts';
import { GITHUB_RECONCILE_EVERY_MINUTES, GITHUB_RECONCILE_JOB } from './github-reconcile.ts';
import {
  HOURLY_RECONCILE_EVERY_MINUTES,
  HOURLY_RECONCILE_JOB,
  HOURLY_RECONCILE_OFFSET_MINUTES,
} from './hourly-reconcile.ts';
import { ROUTE_PROBE_EVERY_MINUTES, ROUTE_PROBE_JOB, ROUTE_PROBE_OFFSET_MINUTES } from './route-probe.ts';

export const GITHUB_RECONCILE_SCHEDULE_ID = GITHUB_RECONCILE_JOB.id;
export const ROUTE_PROBE_SCHEDULE_ID = ROUTE_PROBE_JOB.id;
export const HOURLY_RECONCILE_SCHEDULE_ID = HOURLY_RECONCILE_JOB.id;
export const CANARY_SCHEDULE_ID = CANARY_JOB.id;

interface EngineSchedule {
  scheduleId: string;
  spec: ScheduleSpec;
  action: ScheduleOptionsStartWorkflowAction<Workflow>;
  policies: NonNullable<ScheduleUpdateOptions['policies']>;
}

/** 引擎要有的定时任务。 */
export function engineSchedules(taskQueue: string): EngineSchedule[] {
  const input: GitHubReconcileInput = { schemaVersion: 1 };
  const probeInput: RouteProbeInput = { schemaVersion: 1 };
  const hourlyInput: HourlyReconcileInput = { schemaVersion: 1 };
  const canaryInput: CanaryInput = { schemaVersion: 1 };
  return [
    {
      scheduleId: GITHUB_RECONCILE_SCHEDULE_ID,
      spec: { intervals: [{ every: `${GITHUB_RECONCILE_EVERY_MINUTES} minutes` }] },
      action: {
        type: 'startWorkflow',
        workflowType: WORKFLOW_TYPES.githubReconcile,
        // Temporal 会在后面拼上这一轮的时刻，每轮一个编号
        workflowId: GITHUB_RECONCILE_SCHEDULE_ID,
        taskQueue,
        args: [input],
        // 一轮最多 10 分钟（活动的限时）；卡死的不拖到下一轮
        workflowRunTimeout: '15 minutes',
      },
      policies: {
        // 上一轮还没完就跳过这一轮，不叠着跑
        overlap: ScheduleOverlapPolicy.SKIP,
        // Temporal 停了一阵再起来：只补最近一轮，不把错过的全补一遍（每轮本来就往回看 2 小时）
        catchupWindow: `${GITHUB_RECONCILE_EVERY_MINUTES} minutes`,
        // 一轮失败不停掉定时：下一轮照样来，失败记在 schedule_runs 里由看门狗报
        pauseOnFailure: false,
      },
    },
    {
      // 路由探针（#129）：频率按渠道成本定（design 第九节「路由探针」）；和对账错开几分钟，不在整点挤着起会话
      scheduleId: ROUTE_PROBE_SCHEDULE_ID,
      spec: {
        intervals: [
          { every: `${ROUTE_PROBE_EVERY_MINUTES} minutes`, offset: `${ROUTE_PROBE_OFFSET_MINUTES} minutes` },
        ],
      },
      action: {
        type: 'startWorkflow',
        workflowType: WORKFLOW_TYPES.routeProbe,
        workflowId: ROUTE_PROBE_SCHEDULE_ID,
        taskQueue,
        args: [probeInput],
        // 一轮最多 10 分钟（活动的限时）；卡死的不拖到下一轮
        workflowRunTimeout: '15 minutes',
      },
      policies: {
        // 上一轮还没完就跳过这一轮：两轮叠着跑会同时起两个探针会话、后写的盖掉先写的
        overlap: ScheduleOverlapPolicy.SKIP,
        // Temporal 停了一阵再起来：只补最近一轮（结论只看最新的，补旧的只是白花额度）
        catchupWindow: `${ROUTE_PROBE_EVERY_MINUTES} minutes`,
        pauseOnFailure: false,
      },
    },
    {
      // 每小时对账（工作树残留、提醒按条件撤和再推）：和对账补漏、路由探针错开
      scheduleId: HOURLY_RECONCILE_SCHEDULE_ID,
      spec: {
        intervals: [
          {
            every: `${HOURLY_RECONCILE_EVERY_MINUTES} minutes`,
            offset: `${HOURLY_RECONCILE_OFFSET_MINUTES} minutes`,
          },
        ],
      },
      action: {
        type: 'startWorkflow',
        workflowType: WORKFLOW_TYPES.hourlyReconcile,
        workflowId: HOURLY_RECONCILE_SCHEDULE_ID,
        taskQueue,
        args: [hourlyInput],
        // 一轮最多 10 分钟（活动的限时）；卡死的不拖到下一轮
        workflowRunTimeout: '15 minutes',
      },
      policies: {
        // 上一轮还没完就跳过：两轮叠着删同一棵树、写同一条再提醒没意义
        overlap: ScheduleOverlapPolicy.SKIP,
        // Temporal 停了一阵再起来：只补最近一轮（每轮都是看当时的目录和库，补旧的没意义）
        catchupWindow: `${HOURLY_RECONCILE_EVERY_MINUTES} minutes`,
        pauseOnFailure: false,
      },
    },
    {
      // 全流程巡检（#223）：每 6 小时开一张巡检单，一路看到有结论（一轮最长 5 小时）；和别的定时任务错开
      scheduleId: CANARY_SCHEDULE_ID,
      spec: {
        intervals: [{ every: `${CANARY_EVERY_HOURS} hours`, offset: `${CANARY_OFFSET_MINUTES} minutes` }],
      },
      action: {
        type: 'startWorkflow',
        workflowType: WORKFLOW_TYPES.canary,
        workflowId: CANARY_SCHEDULE_ID,
        taskQueue,
        args: [canaryInput],
        // 一轮自己到 5 小时就判断在当时那一步；再多给半小时（开单、没查成的几回），卡死的不拖到下一轮
        workflowRunTimeout: `${CANARY_RUN_TIMEOUT_MINUTES} minutes`,
      },
      policies: {
        // 上一轮还没完就跳过：两轮叠着跑，巡检仓里会同时有两张巡检单抢同一个文件
        overlap: ScheduleOverlapPolicy.SKIP,
        // Temporal 停了一阵再起来：错过的那一轮一小时内补上，再久就等下一轮
        catchupWindow: '1 hour',
        pauseOnFailure: false,
      },
    },
  ];
}

export type EnsureOutcome = 'created' | 'updated';

/** 建或更新引擎的定时任务，返回每个编号是新建的还是更新的。连不上 Temporal、没权限等原样抛出（引擎起不来要看得见）。 */
export async function ensureEngineSchedules(
  client: Pick<Client, 'schedule'>,
  taskQueue: string,
): Promise<Record<string, EnsureOutcome>> {
  const out: Record<string, EnsureOutcome> = {};
  for (const s of engineSchedules(taskQueue)) {
    try {
      await client.schedule.create({
        scheduleId: s.scheduleId,
        spec: s.spec,
        action: s.action,
        policies: s.policies,
      });
      out[s.scheduleId] = 'created';
    } catch (err) {
      if (!(err instanceof ScheduleAlreadyRunning)) throw err;
      // 已经有了：按声明改间隔、要起的工作流、策略；暂停没暂停、备注照旧（人手动暂停的不给恢复）
      await client.schedule.getHandle(s.scheduleId).update((prev) => ({
        ...prev,
        spec: s.spec,
        action: s.action,
        policies: s.policies,
      }));
      out[s.scheduleId] = 'updated';
    }
  }
  return out;
}
