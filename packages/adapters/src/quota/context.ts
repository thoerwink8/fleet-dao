// 读取器拿到的一切外部能力都从这里注入：测试给假的，生产用 io.ts 的默认实现。测试因此碰不到真网络、真进程。
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

export interface QuotaDeps {
  now?: () => Date;
  fetch?: typeof fetch;
  runCommand?: RunCommand;
  readFile?: (path: string) => Promise<string>;
  /** 列目录（估算读日账用）；目录不在时返回空数组。 */
  listDir?: (path: string) => Promise<string[]>;
  openWebSocket?: (url: string) => WebSocketLike;
  /** 建一个用完即删的空目录（给子进程当工作目录）。 */
  scratchDir?: () => Promise<ScratchDir>;
  /** 读取器进程的家目录，用来展开配置里的 ~。 */
  homeDir?: string;
  /** 进程环境（构造子进程环境用），默认 process.env。 */
  env?: Record<string, string | undefined>;
  /** 估算用的用量记录，以后由引擎从库里给。 */
  usageRecords?: UsageSource;
  /** 换掉某种读取器（测试用假的；以后某家换了读法也从这里接）。 */
  readers?: Partial<Record<ReaderType, Reader>>;
}

export interface ScratchDir {
  path: string;
  dispose(): Promise<void>;
}

export interface ReaderOutput {
  windows: QuotaReading[];
  subscription?: SubscriptionInfo;
  scopeModels?: Record<string, ScopeMembership>;
  notes?: string[];
}

export interface ReaderContext {
  pool: PoolConfig;
  /** 开始读这个池的时刻（ISO），没有上游采样时刻时当作读取时间。 */
  fetchedAt: string;
  now: () => Date;
  /** 超时或叫停时触发；读取器把它交给 fetch、子进程和 WebSocket。 */
  signal: AbortSignal;
  fetch: typeof fetch;
  runCommand: RunCommand;
  readFile: (path: string) => Promise<string>;
  listDir: (path: string) => Promise<string[]>;
  openWebSocket: (url: string) => WebSocketLike;
  scratchDir: () => Promise<ScratchDir>;
  homeDir: string;
  env: Record<string, string | undefined>;
  usageRecords?: UsageSource;
  /** 同一轮里多个池共用一次上游调用（例如两个 Claude 组织只跑一次 /usage、一次 org list）。 */
  shared<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export type Reader = (ctx: ReaderContext) => Promise<ReaderOutput>;
