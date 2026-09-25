import type { Config } from './config.ts';
import type { DemoPublisher } from './demo.ts';
import type {
  ChangeFeed,
  DraftOpener,
  FeishuAuth,
  GitHubEventSink,
  HealthCheck,
  Logger,
  RequirementWorkflows,
  Store,
  WorkflowControl,
} from './ports.ts';

/** 后端的全部外部依赖。生产由 main.ts 装配，测试各自换成假的。 */
export interface Deps {
  config: Config;
  store: Store;
  workflows: WorkflowControl;
  /** 拉起需求工作流（issue 进来之后）。 */
  requirements: RequirementWorkflows;
  changes: ChangeFeed;
  /** null = 飞书登录没配置（只允许在开发环境）。 */
  feishu: FeishuAuth | null;
  github: GitHubEventSink;
  /** 飞书里确认的草稿去开单（开 issue、建任务、拉起工作流）。没接上时用 notWiredDraftOpener：草稿留在待开单。 */
  draftOpener: DraftOpener;
  /** /healthz 逐项探的依赖；空 = 没有外部依赖（内存版）。 */
  health: HealthCheck[];
  log: Logger;
  now: () => Date;
  /** 演示版可见范围的发布处；null = 没配（FLEET_DEMO_DIR）。 */
  demo: DemoPublisher | null;
}
