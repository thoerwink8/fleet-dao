import type { AlertWorkPort } from './alert-work.ts';
import type { Config } from './config.ts';
import type { DemoPublisher } from './demo.ts';
import type { GatewaySeen } from './gateway-seen.ts';
import type { IntentStore } from './intent-store.ts';
import type { ScryptParams } from './password.ts';
import type {
  ChangeFeed,
  DraftOpener,
  FeishuAuth,
  GitHubEventSink,
  HealthCheck,
  Logger,
  Store,
  WorkflowControl,
} from './ports.ts';
import type { ReleaseSource } from './release-version.ts';
import type { RoutingEffortsPort } from './routing-efforts.ts';
import type { RoutingLayersPort } from './routing-layers.ts';

/** 后端的全部外部依赖。生产由 main.ts 装配，测试各自换成假的。 */
export interface Deps {
  config: Config;
  store: Store;
  workflows: WorkflowControl;
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
  /**
   * 飞书群聊理成的意图（#553 第 4 条，intent-store.ts）：网关收原话、取意图卡都经它。没给的话网关的意图接口一律 503
   * 「没接上」（原话没存，网关标「没记成」、之后补漏），不回 200 冒充存下了。
   */
  intents?: IntentStore | undefined;
  /**
   * 提醒谁在处理、修到哪（design 15.3，alert-work.ts）：驾驶舱提醒列表现算用。没给（开发、内存版）的提醒列表照样出，
   * 另写一句「谁在处理没接上」，不拿「没人在修」顶。
   */
  alertWork?: AlertWorkPort | undefined;
  /**
   * 路由两层每一层现在活着吗（#574，routing-layers.ts）：驾驶舱「路由」页现算用。没给（开发、内存版没有那两张表）的接口照样回，
   * 另写一句 unavailable，不拿空列表冒充「都没配」。
   */
  routingLayers?: RoutingLayersPort | undefined;
  /**
   * 路由两层里每条路由的思考档位（#470，routing-efforts.ts）：驾驶舱「思考档位」页读、改。没给（开发、内存版没有那张表）的
   * 读接口写 unavailable、改接口回 503，不拿空列表冒充「都没配」。
   */
  routingEfforts?: RoutingEffortsPort | undefined;
  /**
   * /changelog 页「发布 v<N>」定版本号要的两样（release-version.ts）：仓里开着的里程碑（GitHub 现读）、仓根 CHANGELOG.md。
   * 没给（开发、内存版）接口照样回，写明「没接上、版本号核不了」，不拿「上一版 +1」顶。
   */
  release?: ReleaseSource | undefined;
  /**
   * 进程要停了（main.ts 收到 SIGTERM）：只有生产装配会给。飞书 outbox 的长轮询（feishu-routes.ts）拿它跟请求自己的
   * signal 合并着等，停机时马上醒、不再查库（#364：库关到一半时还查会报错，被当成「未处理的错误」500）。
   */
  shutdownSignal?: AbortSignal | undefined;
  log: Logger;
  now: () => Date;
  /** 演示版可见范围的发布处；null = 没配（FLEET_DEMO_DIR）。 */
  demo: DemoPublisher | null;
  /**
   * 只有测试传入。不设时新哈希用 password.ts 的 SCRYPT_PARAMS（N=2^15、r=8、p=3）。
   * 改这里之前必须知道：不读环境变量，生产装配（main.ts）不设它；设了也只影响新算的哈希，验旧哈希仍看哈希自己带的参数。
   */
  scryptParams?: ScryptParams;
}
