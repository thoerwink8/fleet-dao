// 读取器拿到的一切外部能力都从这里注入。库函数不给默认值：没注入就当场报错，
// 免得测试或调用方悄悄碰到真进程、真网络、真文件。生产用 io.ts 的 productionQuotaIo()（命令行就是这么接的）。
import type { MirasimWire } from '../mirasim/wire.ts';
import type {
  PoolConfig,
  QuotaReading,
  ReaderType,
  ScopeMembership,
  SubscriptionInfo,
  UsageSource,
} from './types.ts';

export interface CommandResult {
  /** 进程退出码；被信号杀掉或没起来时为 null。 */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 起都没起来（找不到命令、没权限）。 */
  spawnError?: string;
  /** 被超时或叫停杀掉。 */
  killed: boolean;
}

export interface RunCommandOptions {
  cwd: string;
  /** 整份环境，不再合并宿主的。 */
  env: Record<string, string>;
  signal: AbortSignal;
}

export type RunCommand = (argv: string[], options: RunCommandOptions) => Promise<CommandResult>;

/** 浏览器式 WebSocket 里读取器用得到的那一小块。 */
export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

/** 必须注入的外部能力，一样都不能少。 */
export interface QuotaIo {
  fetch: typeof fetch;
  runCommand: RunCommand;
  readFile: (path: string) => Promise<string>;
  /** 列目录；目录不在就抛 ENOENT（「不在」和「空」是两回事）。 */
  listDir: (path: string) => Promise<string[]>;
  openWebSocket: (url: string) => WebSocketLike;
  /**
   * 子进程的工作目录：私有、空的、每次都是同一个。
   * 空：在别人的目录里起 Claude Code 会加载那里的项目设置和钩子；同一个：Claude Code 按工作目录在
   * ~/.claude/projects 下建目录，每次换一个就每次多留一个。
   */
  workDir: () => Promise<string>;
  /** 读取器进程的家目录，用来展开配置里的 ~。 */
  homeDir: string;
  /** 宿主环境（构造子进程环境时从里面挑白名单）。 */
  env: Record<string, string | undefined>;
}

export const QUOTA_IO_KEYS: readonly (keyof QuotaIo)[] = [
  'fetch',
  'runCommand',
  'readFile',
  'listDir',
  'openWebSocket',
  'workDir',
  'homeDir',
  'env',
];

export interface QuotaDeps extends QuotaIo {
  now?: () => Date;
  /** 估算用的用量记录，以后由引擎从库里给。 */
  usageRecords?: UsageSource;
  /** 换掉某种读取器（测试用假的；以后某家换了读法也从这里接）。 */
  readers?: Partial<Record<ReaderType, Reader>>;
  /**
   * 这几种读取器的凭据在别的用户家里（引擎用户进不去会话用户的家）：它们读文件改用这里的 readFile（以那个用户的身份读），
   * 配置里的 ~ 展开到这里的 homeDir；其余读取器照旧用上面的 readFile、homeDir（例如拼车的 Key 文件引擎自己读得到）。
   * 读不到要抛错，不许回空串。
   */
  asUser?: {
    readers: readonly ReaderType[];
    readFile: (path: string) => Promise<string>;
    homeDir: string;
    /**
     * 会话用户自己的 Mirasim 服务（mirasim-relay 读取器用）：回环口只许会话用户自己和 root 连，引擎用户直连、直读令牌都不行，
     * 所以连接经桥接（以会话用户的身份读令牌、连口，帧经 stdin/stdout 转，令牌不经引擎传值）。给了它，mirasim-relay 读取器
     * 就不再读令牌文件、不再自己开 WebSocket。读不到、连不上要抛错。
     */
    connectMirasim?: () => Promise<MirasimWire>;
    /**
     * 以会话用户的身份起命令（claude-usage 起 reclaude）。二进制在会话用户家里，引擎用户直接 spawn 是 EACCES。
     * 没给就用上面的 runCommand。起不来要在结果里带 spawnError，不许抛成没原因的空读数。
     */
    runCommand?: RunCommand;
    /** 会话用户进得去的工作目录。没给就用上面的 workDir（引擎自己的家，会话用户进不去）。 */
    workDir?: () => Promise<string>;
  };
}

export interface ReaderOutput {
  windows: QuotaReading[];
  subscription?: SubscriptionInfo;
  scopeModels?: Record<string, ScopeMembership>;
  notes?: string[];
}

export interface ReaderContext extends QuotaIo {
  pool: PoolConfig;
  /** 开始读这个池的时刻（ISO），没有上游采样时刻时当作读取时间。 */
  fetchedAt: string;
  now: () => Date;
  /** 超时或叫停时触发；读取器把它交给 fetch、子进程和 WebSocket。 */
  signal: AbortSignal;
  usageRecords?: UsageSource;
  /** 经桥接以会话用户的身份连这个池的 Mirasim 服务（QuotaDeps.asUser.connectMirasim）；没给就读取器自己读令牌、自己开 WebSocket。 */
  connectMirasim?: () => Promise<MirasimWire>;
  /** 同一轮里多个池共用一次上游调用（例如两个 Claude 组织只跑一次 /usage、一次 org list）。 */
  shared<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export type Reader = (ctx: ReaderContext) => Promise<ReaderOutput>;
