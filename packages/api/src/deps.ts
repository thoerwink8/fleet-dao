import type { AcceptanceDutyRow } from '@fleet-dao/db';
import type { AppRole, InstallationListedRepo } from '@fleet-dao/github';
import type { Repo } from '@fleet-dao/shared';
import type { AlertWorkPort, DeployLagInput } from '@fleet-dao/store';
import type { AlertRepairPort } from './alert-repair.ts';
import type { CarpoolReconcilePort } from './carpool-reconcile-view.ts';
import type { CiPolicyBridge } from './ci-policy-bridge.ts';
import type { CliToolsPort } from './cli-versions.ts';
import type { Config } from './config.ts';
import type { DecisionCapabilities } from './decision-actions.ts';
import type { DecisionCommenter } from './decision-handoff.ts';
import type { CockpitAlerts } from './feishu-alerts.ts';
import type { PreflightReaders } from './france-preflight.ts';
import type { FranceReleasePort } from './france-release.ts';
import type { HostResourceSampler } from './host-resources.ts';
import type { LocalClaimsPort } from './local-claims.ts';
import type { LocalHoldPort } from './local-hold.ts';
import type { ManualTracksPort } from './manual-tracks.ts';
import type { ModelRosterPort } from './model-roster.ts';
import type { NodeDispatchFn } from './node-dispatch.ts';
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
import type { ProbeHistoryPort } from './probe-history.ts';
import type { ReleaseCardPort } from './release-card.ts';
import type { ReleaseRequestPort } from './release-request.ts';
import type { RequestChatPort } from './request-chat-pg.ts';
import type { RequestsPort } from './request-store-pg.ts';
import type { RoutingEffortsPort } from './routing-efforts.ts';
import type { RoutingLayersPort } from './routing-layers.ts';
import type { RoutingOrderPort } from './routing-order.ts';
import type { RunTranscriptPort } from './run-transcript.ts';
import type { TaskRoutePinsPort } from './task-route-pins.ts';

/** 驾驶舱点「重做」时交给引擎的那一口（真装配在 temporal.ts，用 Temporal 起下一代）。 */
export interface TaskRedoPort {
  redo(input: {
    taskId: string;
    issueNumber: number;
    title: string;
    repo: Repo;
  }): Promise<{ ok: true; workflowId: string; generation: number } | { ok: false; why: string }>;
}

/** 两个机器人已经装上的仓：安装令牌读 GET /installation/repositories。 */
export interface InstallationReposPort {
  list(role: AppRole): Promise<InstallationListedRepo[]>;
}

/** 后端的全部外部依赖。生产由 main.ts 装配，测试各自换成假的。 */
export interface Deps {
  config: Config;
  store: Store;
  workflows: WorkflowControl;
  /**
   * 两个机器人已经装上的仓（安装令牌读 /installation/repositories）。
   * 没给（开发、测试没有机器人凭据）时导入列表回 200 写明「这台没接上 GitHub」，不拿空列表冒充「没有仓」。
   */
  installationRepos?: InstallationReposPort | undefined;
  /**
   * 被撤或挂起的任务重做（shared/task-redo.ts）：同一张单另起一代。没给（开发环境没有 Temporal）时重做回 503，不假装起了。
   */
  taskRedo?: TaskRedoPort | undefined;
  changes: ChangeFeed;
  /** null = 飞书登录没配置（只允许在开发环境）。 */
  feishu: FeishuAuth | null;
  github: GitHubEventSink;
  /** 只在真实 DB + 既有 engine App 装配，缺少时不能公开样例模式。 */
  ciPolicyBridge?: CiPolicyBridge | undefined;
  acceptanceDuties?:
    | ((identity: { repo: string; issueNumber: number }) => Promise<AcceptanceDutyRow[]>)
    | undefined;
  /** /healthz 逐项探的依赖；空 = 没有外部依赖（内存版）。 */
  health: HealthCheck[];
  /** 驾驶舱提醒（#795）。生产的两套装配都给。 */
  alerts?: CockpitAlerts | undefined;
  /**
   * 提醒谁在处理、修到哪（design 15.3，alert-work.ts）：驾驶舱提醒列表现算用。没给（开发、内存版）的提醒列表照样出，
   * 另写一句「谁在处理没接上」，不拿「没人在修」顶。
   */
  alertWork?: AlertWorkPort | undefined;
  /**
   * 看门狗提醒的受控修复（#3033，alert-repair.ts）：任务现读（idle-running 的列表动作和核验）、开修复单。
   * 没给（开发、内存版）的对应动作不出现，提醒的 repair.problems 写没接上，不假装能修。
   */
  alertRepair?: AlertRepairPort | undefined;
  /**
   * 路由两层每一层现在活着吗（#574，routing-layers.ts）：驾驶舱「路由」页现算用。没给（开发、内存版没有那两张表）的接口照样回，
   * 另写一句 unavailable，不拿空列表冒充「都没配」。
   */
  routingLayers?: RoutingLayersPort | undefined;
  /**
   * 动手战绩（manual-tracks.ts）：路由页那张表，和选路读的 modelTierTracks 同一份。没给（开发、内存版）的路由页不画这张表，
   * 不拿空表冒充「都没战绩」。
   */
  manualTracks?: ManualTracksPort | undefined;
  /**
   * 探针真历史（#1139，probe-history.ts）：渠道状态页的近 60 次格子。没给（开发、内存版没有这张表）时接口写没查成，
   * 不拿空列表冒充「还没有探测」。不看引擎开没开。
   */
  probeHistory?: ProbeHistoryPort | undefined;
  /**
   * 渠道模型名册和目录的差（#1302，model-roster.ts）。没给（开发、内存版）的路由页照样回两层，
   * 另写一句 modelRosterUnavailable，不拿「都对得上」顶。
   */
  modelRoster?: ModelRosterPort | undefined;
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
   * 按单指定模型（task-route-pins.ts）：单子页读、改每段用哪个模型，引擎选路现读同一张表。没给（开发、
   * 内存版没有那张表）的任务详情写 unavailable、改接口回 503，不拿空列表冒充「没指定」。
   */
  taskRoutePins?: TaskRoutePinsPort | undefined;
  /**
   * 本机领单（决定 0096，local-claims.ts）：本机会话经 POST /api/nodes/claims 领单、续租、结束，写 tasks 那一行。没给（开发、内存版）回 503。
   */
  localClaims?: LocalClaimsPort | undefined;
  /**
   * 本机交单给法国引擎（#3739，node-dispatch.ts）：POST /api/nodes/dispatch 复用看门狗修复的 repairDispatcher，
   * 和 fleet-api dispatch-issue 不带 --force 同一套准入。没给（开发、内存版）回 503。
   */
  nodeDispatch?: NodeDispatchFn | undefined;
  /**
   * 任务详情每一段的「会话内容」（#1640，run-transcript.ts）：读引擎按条记下的 run_transcript。没给（开发、内存版没有那张表）的
   * 接口回 503 写明原因，不拿空列表冒充「没有记录」。
   */
  runTranscript?: RunTranscriptPort | undefined;
  /**
   * 提需求（#2049，request-store-pg.ts）：需求、消息、每人的置顶和读到哪。没给（开发、内存版没有这三张表）的列表写 unavailable、
   * 别的接口回 503，不拿空列表冒充「没有需求」。
   */
  requests?: RequestsPort | undefined;
  /**
   * 提需求的指挥官会话（#2061，request-chat-pg.ts）：排一轮、停下、换模型、让别家挑错。没给（开发、内存版）时人话照存、指挥官不接，
   * 那几个按钮的接口回 503 写明没接上，不当成排上了。
   */
  requestChat?: RequestChatPort | undefined;
  /**
   * 「要你拍」拍完交给指挥官（#1915，decision-handoff.ts）：往进度单 #1055、任务单留言，走引擎机器人的 GitHub 客户端。
   * 没给（开发环境、机器人凭据没读到）的答案照样存下，回包里 handoff 写没接上，不当成记上了。
   */
  decisionCommenter?: DecisionCommenter | undefined;
  /**
   * 诊断型 / diff 外验收条的单被「继续」「重做」时交回本机（#3602）：往单上留言并贴「本机做」，走引擎机器人的 GitHub。
   * 没给（开发环境、机器人凭据没读到）就只拒绝，原因里写明没贴标签。
   */
  localHold?: LocalHoldPort | undefined;
  /**
   * 「要你拍」选完要本机做的事（decision-actions.ts）：重查 GitHub App、重查飞书推送。
   * 没给（开发、内存版）这两样回「没接上」，卡留着；暂停、放开、移出仓、留着只靠库，删工作树交给引擎，都不看这项。
   */
  decisionCapabilities?: DecisionCapabilities | undefined;
  /**
   * 环境页（#820 片 1）的版本那一项：读这台的发布目录（current 链接 + 状态文件）现算。只在正式环境装配
   * （main.ts 的 production；法国是）；别的环境不给，环境页写「没查成 + 原因」，不拿「还没发布过」顶。
   */
  deployLag?: (() => DeployLagInput) | undefined;
  /**
   * 这台机器此刻的内存、CPU 和各会话 scope 的占用（#1973，host-resources.ts）：读本机 /proc 和 cgroup。main.ts 两种装配都给
   * （读不到的照实写 unread）；测试不给时主页不带 resources，页面写「这台后端没给资源读数」，不画 0。
   */
  hostResources?: HostResourceSampler | undefined;
  /**
   * /france 页发版一键（#618，france-release.ts）：读 release-train 状态文件。
   * 只在正式环境装配（main.ts 的 liveFranceReleasePort）；没给时接口照样回 unreadable，页面画「没查成 + 原因」。
   */
  franceRelease?: FranceReleasePort | undefined;
  /**
   * /france 页「发版预检」（france-preflight.ts）：进程内读七项事实，不起子进程、不读 home。
   * 只在正式环境装配。没给时接口回没接上，不拿「能发」顶。
   */
  francePreflight?: ((signal?: AbortSignal) => PreflightReaders | undefined) | undefined;
  /**
   * /france 页「命令行工具」（#1969，cli-versions.ts）：读引擎记下的在用版本和官方最新，落后现算。
   * 没给（开发、内存版没有这张表）时整段写没查成，不拿空列表冒充都是最新。
   */
  cliTools?: CliToolsPort | undefined;
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
  log: Logger;
  now: () => Date;
  /**
   * 只有测试传入。不设时新哈希用 password.ts 的 SCRYPT_PARAMS（N=2^15、r=8、p=3）。
   * 改这里之前必须知道：不读环境变量，生产装配（main.ts）不设它；设了也只影响新算的哈希，验旧哈希仍看哈希自己带的参数。
   */
  scryptParams?: ScryptParams;
}
