// 假后端内部的数据结构：相当于真后端的数据库表。只在 mock/ 里用——页面只看 FleetApi 返回的契约形状。
import type {
  Ban,
  Channel,
  Model,
  Pool,
  QuotaWindow,
  Repo,
  Route,
  SessionRun,
  StagePolicy,
  Step,
  Subtask,
  Task,
} from '@fleet-dao/shared';
import type { AuditEntry, Me, Notification, Setting } from '../types';

export interface MSubtask {
  subtask: Subtask;
  /** 当前会话用 fleet plan 汇报的步骤清单。 */
  steps: Step[];
  runs: SessionRun[];
  paused: boolean;
  planUpdatedAt?: string;
  lastSay?: { text: string; at: string };
}

export interface MAsk {
  id: string;
  taskId: string;
  runId?: string;
  question: string;
  options: string[];
  askedAt: string;
  answer?: string;
  answeredBy?: string;
  answeredAt?: string;
}

export interface MTask {
  task: Task;
  /** 需求级会话：分诊、写需求文档、写方案。 */
  runs: SessionRun[];
  subtasks: MSubtask[];
  paused: boolean;
  asks: MAsk[];
}

/** 时间线的一条（对应真后端的 progress_events + state_changes + 人的操作）。text 已按后端的说法拼好。 */
export interface MLog {
  id: string;
  taskId: string;
  at: string;
  source: 'session' | 'engine' | 'person';
  kind: string;
  runId?: string;
  subtaskId?: string;
  text: string;
  detail?: unknown;
}

export interface MJob {
  id: string;
  name: string;
  schedule: string;
  expectEveryMinutes: number;
  lastRun?: {
    startedAt: string;
    endedAt?: string;
    outcome?: 'ok' | 'unscanned' | 'failed';
    found?: number;
    why?: string;
  };
  lastSuccessAt?: string;
  /** 模拟器用：下次到点的时间。 */
  nextRunAt: string;
  /** 模拟器用：这个任务一直查不成（用来演示「没查成」）。 */
  keepsFailing?: 'unscanned' | 'failed';
}

/** 方案写完时拆出来的子任务（模拟器用）。 */
export interface PlanTemplate {
  title: string;
  touches: string[];
  stage: 'execute' | 'ui';
  steps: string[];
}

export interface MockState {
  me: Me;
  repos: Repo[];
  channels: Channel[];
  pools: Pool[];
  models: Model[];
  routes: Route[];
  stages: StagePolicy[];
  bans: Ban[];
  quota: QuotaWindow[];
  tasks: MTask[];
  logs: MLog[];
  jobs: MJob[];
  notifications: Notification[];
  audit: AuditEntry[];
  settings: Setting[];
  plans: Record<string, PlanTemplate[]>;
  nextPr: number;
  seq: number;
}
