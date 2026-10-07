import type { AlertWorkPort, DeployLagInput } from '@fleet-dao/store';
import type { CarpoolReconcilePort } from './carpool-reconcile-view.ts';
import type { Config } from './config.ts';
import type { DemoPublisher } from './demo.ts';
import type { FranceReleasePort } from './france-release.ts';
import type { GatewaySeen } from './gateway-seen.ts';
import type { IntentStore } from './intent-store.ts';
import type { OrgSwitchPort } from './org-switch-view.ts';
import type { ScryptParams } from './password.ts';
import type {
  ChangeFeed,
  FeishuAuth,
  GitHubEventSink,
  HealthCheck,
  Logger,
  Store,
  WorkflowControl,
} from './ports.ts';
import type { ReleaseCardPort } from './release-card.ts';
import type { ReleaseRequestPort } from './release-request.ts';
import type { ReleaseSource } from './release-version.ts';
import type { RoutingEffortsPort } from './routing-efforts.ts';
import type { RoutingLayersPort } from './routing-layers.ts';
import type { RoutingOrderPort } from './routing-order.ts';
import type { TaskRoutePinsPort } from './task-route-pins.ts';

/** 后端的全部外部依赖。生产由 main.ts 装配，测试各自换成假的。 */
export interface Deps {
  config: Config;
  store: Store;
  workflows: WorkflowControl;
  changes: ChangeFeed;
  /** null = 飞书登录没配置（只允许在开发环境）。 */
  feishu: FeishuAuth | null;
  github: GitHubEventSink;
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
   * 会话用户切号的现状（#194，org-switch-view.ts）：驾驶舱额度页顶上「挂着独享；拼车预计几点恢复」读它。没给（开发、内存版没有
   * 那张表）的额度页照样回，另写一句 unavailable，不拿空冒充「没事」。
   */
  orgSwitch?: OrgSwitchPort | undefined;
  /**
   * 拼车额度对账（#194 方案 4.7，carpool-reconcile-view.ts）：额度页写「这一窗本机记到花了 $X，接口说用了 $Y」。没给（开发、内存版
   * 没有会话和额度读数那几张表）的额度页照样回，另写一句 unavailable，不拿「对得上」冒充。
   */
  carpoolReconcile?: CarpoolReconcilePort | undefined;
  /**
   * 路由两层里每条路由的思考档位（#470，routing-efforts.ts）：驾驶舱「思考档位」页读、改。没给（开发、内存版没有那张表）的
   * 读接口写 unavailable、改接口回 503，不拿空列表冒充「都没配」。
   */
  routingEfforts?: RoutingEffortsPort | undefined;
  /**
   * 路由两层的先后和开关（母单 #1089，routing-order.ts）：驾驶舱「路由」页改用途下的模型先后、模型下的渠道先后、渠道开关。没给（开发、内存版
   * 没有那两张表）的改接口回 503，不当改成了。
   */
  routingOrder?: RoutingOrderPort | undefined;
  /**
   * 按单指定模型（驾驶舱改版 2026-10-07，task-route-pins.ts）：单子页读、改每段用哪个模型，引擎选路现读同一张表。没给（开发、
   * 内存版没有那张表）的任务详情写 unavailable、改接口回 503，不拿空列表冒充「没指定」。
   */
  taskRoutePins?: TaskRoutePinsPort | undefined;
  /**
   * 环境页（#820 片 1）的版本那一项：读这台的发布目录（current 链接 + 状态文件）现算。只在正式环境装配
   * （main.ts 的 production；法国是）；别的环境不给，环境页写「没查成 + 原因」，不拿「还没发布过」顶。
   */
  deployLag?: (() => DeployLagInput) | undefined;
  /**
   * /changelog 页「发布 v<N>」定版本号要的两样（release-version.ts）：仓里开着的里程碑（GitHub 现读）、仓根 CHANGELOG.md。
   * 没给（开发、内存版）接口照样回，写明「没接上、版本号核不了」，不拿「上一版 +1」顶。
   */
  release?: ReleaseSource | undefined;
  /**
   * /france 页发版一键（#618，france-release.ts）：读 release-train 状态文件 + 起 pnpm release:onekey preflight。
   * 只在正式环境装配（main.ts 的 liveFranceReleasePort）；没给时接口照样回 unreadable，页面画「没查成 + 原因」。
   */
  franceRelease?: FranceReleasePort | undefined;
  /**
   * /france 页「发版」卡（#1231，release-card.ts）：读 GitHub 上主线头、CI、PR，和法国在用的提交（发布目录）。
   * 只在正式环境装配（main.ts 的 liveReleaseCardPort）；没给时接口照样回，四行都写「没接上 + 原因」，不拿「已是最新」顶。
   */
  releaseCard?: ReleaseCardPort | undefined;
  /**
   * /france 页「发布到法国」按钮（#1232，release-request.ts）：往请求目录写请求文件，法国上 root 的单元接活。只在正式环境装配；
   * 没给时按钮置灰写没接上、POST 回 503，不当成发了。
   */
  releaseRequest?: ReleaseRequestPort | undefined;
  /**
   * 进程要停了（main.ts 收到 SIGTERM）：只有生产装配会给。意图卡的长轮询（intent-routes.ts）拿它跟请求自己的
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
