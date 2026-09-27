import type { Config } from './config.ts';
import type { DemoPublisher } from './demo.ts';
import type { GatewaySeen } from './gateway-seen.ts';
import type { ScryptParams } from './password.ts';
import type {
  ChangeFeed,
  DraftOpener,
  FeishuAuth,
  GitHubEventSink,
  HealthCheck,
  IssuePlanReader,
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
  /** 拉起一张单的工作流（issue 进来之后；起的是 Fusion，见 temporal.ts）。 */
  requirements: RequirementWorkflows;
  /**
   * 读一张 issue 此刻挂在哪个版本、是不是母单子单、开没开着（GitHub 上现读）：接活只派挂在当前版本上的独立单。机器人凭据没读到时是一个读就抛错的
   * （issue-intake.ts 的 issuePlansUnavailable），不拿「挂在当前版本」顶。
   */
  plans: IssuePlanReader;
  changes: ChangeFeed;
  /** null = 飞书登录没配置（只允许在开发环境）。 */
  feishu: FeishuAuth | null;
  github: GitHubEventSink;
  /** 飞书里确认的草稿去开单（开 issue、建任务、拉起工作流）。没接上时用 notWiredDraftOpener：草稿留在待开单。 */
  draftOpener: DraftOpener;
  /** /healthz 逐项探的依赖；空 = 没有外部依赖（内存版）。 */
  health: HealthCheck[];
  /** 飞书网关来没来过：飞书接口的门口验过通行证就记一笔，/healthz 的 feishu_gateway 读它。没给就不记（开发、多数测试）。 */
  gatewaySeen?: GatewaySeen | undefined;
  log: Logger;
  now: () => Date;
  /** 演示版可见范围的发布处；null = 没配（FLEET_DEMO_DIR）。 */
  demo: DemoPublisher | null;
  /**
   * 只有测试传入。不设时新哈希用 password.ts 的 SCRYPT_PARAMS（N=2^15、r=8、p=3）。
   * 改这里之前必须知道：不读环境变量，生产装配（main.ts）不设它；设了也只影响新算的哈希，验旧哈希仍看哈希自己带的参数。
   */
  scryptParams?: ScryptParams;
  /**
   * 还没做的读取器（装配时定）：驾驶舱对应那一块整块显示「待实现」占位（阶段 + 单号），不说成「没查成」。
   * quota = 额度读取（#76）。接上了就删掉这一项。路由探针（#129）已接上：路由在线状态照库里探针的结论显示。
   */
  notWired?: { quota?: NotWiredMark };
}

/** 一块还没做的功能：是什么、排在哪个阶段、哪张单（单开在 fleet-dao 自己这个仓）。 */
export interface NotWiredMark {
  what: string;
  phase: string;
  issue: number;
}
