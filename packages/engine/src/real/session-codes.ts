// 会话端口交给工作流的失败码和几个时间常量。失败分流（failure/）按这些码认账，改码要同时改那边；从 sessions.ts 拆出来，
// sessions.ts 原样重新导出。

/** 上下文比这个小才 fork 续到别的会话用户；大了开新会话带接力任务书（design 第九节「上下文越长越贵」）。 */
export const DEFAULT_FORK_MAX_CONTEXT_TOKENS = 100_000;

/** 切号停下的会话交回的失败码（#59）：失败分流 OS1 认它——马上续同一个会话，不算失败、不记重试的账。 */
export const ORG_SWITCH_CODE = 'org_switch';
export const orgSwitchFailure = (why: string) => ({ code: ORG_SWITCH_CODE, message: why, retryable: true });
/**
 * 排空到截止停下的会话交回的失败码（drain.ts）：失败分流 KL3 认它——不算失败、不记重试的账，新引擎起来按编号续同一个会话。
 * 引擎在停的那一刻会话被信号杀掉（kill-evidence.ts 对上了）也交这个码。
 */
export const ENGINE_STOP_CODE = 'engine_stop';
/** 引擎在排空、这次没起会话（startSession 拒了）：失败分流 ES1 认它——不记账，回去选路（选路这时回「过一会儿再选」）。 */
export const ENGINE_STOPPING_CODE = 'ENGINE_STOPPING';
/** 工人起来时收掉上一轮引擎留下、还开着的 runs 行（#157）写的原因。 */
export const ORPHAN_RUN_REASON =
  '引擎重启时这一段还没收场：一次性会话不脱开引擎进程跑，上一轮引擎一退它就断了（新引擎起来时收掉了它的 scope），按没跑完收掉';

/** 插头默认等第一帧的时限（adapters 的 DEFAULT_PROCESS_LIMITS.startupMs）。 */
export const STARTUP_BASE_MS = 180_000;
/** 续会话等第一帧最多放宽到这么久：再久就不是在读过程记录了。 */
export const RESUME_STARTUP_MAX_MS = 12 * 60_000;
/** 上下文每这么多 token 多等一分钟；不知道上下文多大就按上一轮跑了多久，每 10 分钟多等一分钟。 */
export const RESUME_STARTUP_TOKENS_PER_MINUTE = 40_000;
export const RESUME_STARTUP_RUN_MS_PER_MINUTE = 10 * 60_000;

/**
 * 脱开跑的会话过了总时限多久还没人接回就收掉：盖住看守在新工人上重试的等待（心跳超时 + 重试间隔），再留余量。
 * 会话自己的总时限由接回它的看守按原来的起点管；没人接回（工作流没了）时靠这个兜底。
 */
export const REATTACH_MARGIN_MS = 30 * 60_000;
