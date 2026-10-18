// 自测的时间预算。活动限时（activity-options）和工作流都能引用；这个文件不碰 Node 自带模块，
// 工作流沙箱进得来。数字只写在常量上，限时用它们相加，不另写一套。
//
// 一次自测分几段，各有各的上限，互不借用：
//   看目录（两次，各 SELF_CHECK_PROBE_MS）→ 排队（所有等槽、等锁合起来 SELF_CHECK_QUEUE_MS）
//   → 测试真执行（SELF_CHECK_TEST_MS）→ tsc（SELF_CHECK_TSC_MS）→ 收尾（杀掉以后等管道关、放锁，SELF_CHECK_CLEANUP_MS）。
// 排队不吃测试执行的预算：#2969 的 30 分钟里有 11 分 35 秒在等 test:changed 自己的本机测试槽，vitest 只剩约 18 分钟。

/**
 * 测试真执行最多多久（毫秒）。从真拿到测试容量起算：test:changed 从它打出「拿到本机测试槽」（或 vitest 开跑）那一刻起，
 * 别的测试命令从拿到自测名额起。排队的时间不算进去。
 * 夹具一改就升成全跑，受影响的包在 2 个进程下墙钟约 17 分钟（2026-10-16 这张单实测 1024 秒）。
 * 要全跑之后改跑受影响包的那一次和前面那次合用这 30 分钟（前面那次判出要全跑就退出，几乎不占）。
 */
export const SELF_CHECK_TEST_MS = 30 * 60_000;

/** tsc 最多跑多久（毫秒）。 */
export const SELF_CHECK_TSC_MS = 5 * 60_000;

/** 同一台机器上同时跑自测的上限（tsc 和不走 test:changed 的测试命令用；vitest 的容量归 test:changed 的本机测试槽）。 */
export const SELF_CHECK_SLOTS = 2;

/** 看树里装没装依赖、有没有 tsc，各给这么久。这两下发生在排队之前。 */
export const SELF_CHECK_PROBE_MS = 30_000;

/**
 * 一次自测里所有排队合起来最多多久（毫秒）：等 test:changed 的本机测试槽、等受影响包的整机锁、tsc 等自测名额。
 * 比 test:changed 自己等槽的上限（15 分钟，packages/conventions/src/test-slots.ts）多一截：正常是它先退出 2、记没跑成。
 */
export const SELF_CHECK_QUEUE_MS = 20 * 60_000;

/**
 * 放一次自测名额、整机锁最多等多久（毫秒）。超了记日志往下走，没放掉的靠持有者进程已死、过期被回收，不无限拖住活动。
 * 一次自测最多放三次（受影响包的锁、自测名额、排队中被叫停时拿到的那一个）。
 */
export const SELF_CHECK_RELEASE_MS = 10_000;

/**
 * 收尾最多多久（毫秒）：一条命令超时、被叫停后，exec 杀掉它再等管道关（KILL_SETTLE_MS，10 秒，real/exec.ts），再放名额、放锁
 * （各自最多 SELF_CHECK_RELEASE_MS）。一次自测最多五条命令（两次看目录、测试、受影响包、tsc）、三次放名额：5 × 10 秒 + 3 × 10 秒。
 */
export const SELF_CHECK_CLEANUP_MS = 80_000;

/** 活动限时在各段之外多留的一点，避免刚好卡满被判 StartToClose。 */
const SELF_CHECK_SLACK_MS = 60_000;

/**
 * 自测活动的 StartToClose（毫秒）：各段上限相加，唯一出处。
 * 以前是「测试 + tsc + 再一轮测试加 tsc 的排队余量」共 72 分钟，排队和执行混在一起；现在分段相加共 58 分 20 秒。
 */
export const SELF_CHECK_ACTIVITY_MS =
  2 * SELF_CHECK_PROBE_MS +
  SELF_CHECK_QUEUE_MS +
  SELF_CHECK_TEST_MS +
  SELF_CHECK_TSC_MS +
  SELF_CHECK_CLEANUP_MS +
  SELF_CHECK_SLACK_MS;

/** 工作流跑自测时写进进度（任务行 doing）的那一句。看门狗认它：自测限时以内不算「在干活却没有会话」。 */
export const SELF_CHECK_DOING = '引擎跑测试和类型检查';
