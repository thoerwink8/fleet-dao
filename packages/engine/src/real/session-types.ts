// 会话端口的对外形状：依赖（SessionPortsDeps）、交出去的端口（SessionPorts）。从 sessions.ts 拆出来，别的 session-*.ts 只依赖
// 这里的类型，不反过来依赖 sessions.ts（那是装配的地方）。sessions.ts 原样重新导出，import 路径不变。

import type { LedgerFs, MirasimConnect, SessionUser } from '@fleet-dao/adapters';
import type { Db } from '@fleet-dao/db';
import type { RepoRef } from '@fleet-dao/github';
import type { EngineDrain } from '../drain.ts';
import type { JevPort } from '../failure/jev.ts';
import type { StallPolicy } from '../failure/stall.ts';
import type {
  AwaitSessionInput,
  LaunchSessionInput,
  PortContext,
  SessionEnd,
  StartSessionResult,
  StopSessionInput,
} from '../ports.ts';
import type { UserExec } from './exec.ts';
import type { HostRunners } from './hosts.ts';
import type { KillEvidenceDeps } from './kill-evidence.ts';
import type { MirrorGitHub } from './mirror.ts';
import type { OrgSwitchSessions } from './org-switch.ts';
import type { SegmentPortsDepsForSessions } from './sessions-segment.ts';
import type { WorkTrees } from './worktrees.ts';

export interface SessionPortsDeps {
  db: Db;
  trees: WorkTrees;
  /** 以会话用户的身份跑命令（生产 scopeExec）。 */
  exec: UserExec;
  gh: MirrorGitHub & {
    commitIdentity(repo: { owner: string; name: string }): Promise<{ name: string; email: string }>;
  };
  /** 引擎自己的临时目录（从镜像打的 bundle 落在这里，读进内存就删）。 */
  tmpDir: string;
  /** 这台机器给人看的名字（例如「法国」）：只有人能修的（重新登录）要写清去哪台机器。 */
  machine: string;
  /** 起 Claude Code 的命令（绝对路径）：reclaude 装在会话用户自己家里。 */
  claudeCommand(user: SessionUser): string[];
  /** 起 cursor-agent 的命令（绝对路径）：装在会话用户自己家里，生产用 hosts.ts 的 cursorLaunchCommand 现找版本目录。 */
  cursorCommand(user: SessionUser): string[];
  /** 起 grok 的命令（绝对路径）：装在会话用户自己家里，生产用 hosts.ts 的 grokLaunchCommand 先看在不在。 */
  grokCommand(user: SessionUser): string[];
  /** 会话用户自己的 Mirasim 服务：连接工厂、账本目录、读账本用的文件访问（real/index.ts 的 mirasimDepsFor 生产装配）。 */
  mirasimConnect(user: SessionUser): MirasimConnect;
  mirasimLedgerDir(user: SessionUser): string;
  mirasimLedgerFs(user: SessionUser): LedgerFs;
  forkMaxContextTokens?: number;
  /** 会话出网经的代理（FLEET_SESSION_PROXY）：cursor-agent、grok 的会话带上，Claude 不带（hosts.ts）。不给就直连。 */
  sessionProxy?: string;
  /** 经 sudo 调的帮手（fleet-agent-scope）；测试里换成假的。 */
  helper?: string;
  sudo?: readonly string[];
  /** 会话目录里跑的 git、sh（测试里换成 PATH 上的）。 */
  gitBin?: string;
  shBin?: string;
  /** 宿主环境（会话环境只从里面抄一小撮基础变量，见 adapters/env.ts）。 */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /** 起会话的插头，按执行方式给；测试里换成假的（不起真执行体）。没给的用真插头。 */
  run?: HostRunners;
  /**
   * 发给别家之前的卫生检查（和推分支、开 PR 同一套规则：github 包的 assertPublishable，只管真密钥；也只管
   * fleet-dao 这个仓——别的仓按它们自己的标准，见 packages/github 的 hygiene-scope.ts）。查出来、没扫成都抛
   * 带码的错（HYGIENE_BLOCKED / HYGIENE_UNSCANNED）。
   * 开 PR 前验证的会话起之前整份提示词过一遍；没配就不起验证会话（明确报错），不当成查过没事。
   */
  screen?: (repo: RepoRef, what: string, texts: { path: string; text: string }[]) => void;
  stallPolicy?: Partial<StallPolicy>;
  /** 规则认不出的失败、拿不准的停滞去问 Jev（real/jev-port.ts）；不给就不问，照默认走。 */
  jev?: JevPort;
  /** 问一次 Jev 最多等多久，默认 askJev 的 2 秒；超了当没判出来（后台那一问答回来照样记进判断记录）。 */
  jevTimeoutMs?: number;
  /** 同一个会话的停滞题多久最多问一次 Jev（看守每分钟判一次，拿不准的区间有半个多小时）。 */
  stallJevEveryMs?: number;
  now?: () => Date;
  /** 看守多久醒一次（心跳、写进度）、多久判一次停滞、进度攒多久写一次、等进程起来最多多久。 */
  tickMs?: number;
  stallCheckMs?: number;
  flushMs?: number;
  spawnTimeoutMs?: number;
  /**
   * 停机排空（drain.ts）：引擎在停时不起新会话（抛 ENGINE_STOPPING，失败分流 ES1 不记账、回去选路）；过了闸的会话登记在它上面，
   * 交回工作流（或没起来）就撤掉，停机时等它们。不给就不闸（测试、只起一次的工具）。
   */
  drain?: EngineDrain;
  /** 会话被信号杀掉时去哪查证据（kill-evidence.ts）：测试换成假的；不给就读真的 cgroup、发布目录。 */
  killEvidence?: KillEvidenceDeps;
  /**
   * 会话脱开引擎进程（发布不碰在跑的会话）：每个会话一个收发目录 <ioRoot>/<runId>（输入输出走文件、退出码由会话那一侧写），
   * 引擎重启后照目录接回。不给就照旧接管道（测试、只起一次的工具）：引擎一退会话就断。
   */
  ioRoot?: string;
  /**
   * 三段（对题 / 动手 / 验收）走 runner 的依赖（#554-4）：`brief.segment` 给定了就调 launchSegment；
   * 不给就走 Fusion 原链路（其余字段都不动）。生产 Spawner 还没接（#554-2 / #555 那一档）——
   * 本切片只挂了测试入口；没装 spawner / buildCommand / runs 时，launchSegment 当场 SEGMENT_NOT_WIRED。
   */
  segment?: SegmentPortsDepsForSessions;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export type SessionPorts = {
  startSession(input: LaunchSessionInput, ctx: PortContext): Promise<StartSessionResult>;
  awaitSession(input: AwaitSessionInput, ctx: PortContext): Promise<SessionEnd>;
  stopSession(input: StopSessionInput, ctx: PortContext): Promise<void>;
} & {
  /**
   * 工人起来接活之前（只在这时调）：收掉上一轮留下的会话 scope（fleet-agent-scope list 再逐个 stop）、清掉它们的临时目录，
   * runs 里还开着的一次性会话那几行收成没跑完（#157），上一轮选路时预占、还没开跑的名额清掉（#757）；回收了几个会话。
   */
  reapOrphanSessions(): Promise<number>;
  /** 切号（#59，real/org-switch.ts）用的两样：停下、还剩哪些。 */
  orgSwitch: OrgSwitchSessions;
  /** 引擎停机（工人停下之后、关库之前）：放手脱开跑的会话，不停它们、不再写库，新引擎起来接回。回放手的编号。 */
  releaseDetached(): string[];
  /**
   * 排空到截止（drain.ts）：把进程已经起来、还没收场的会话都停下（插头收进程），它们交回 engine_stop，新引擎起来按编号续上；
   * 交回这一次叫停的会话编号（已经在停的不重复叫停）。
   */
  drainStop(why: string): string[];
};
