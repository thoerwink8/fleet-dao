// 自测的时间预算。活动限时（activity-options）和工作流都能引用；这个文件不碰 Node 自带模块，
// 工作流沙箱进得来。数字只写在常量上，限时用它们相加，不另写一套。

/**
 * 测试命令最多跑多久（毫秒）。从拿到机器名额起算，等名额的时间不算进去。
 * 夹具一改就升成全跑，受影响的包在 2 个进程下墙钟约 17 分钟
 * （2026-10-16 这张单实测 1024 秒）。要全跑之后那次还要在整机锁上排队，
 * 和这一跑合用这 30 分钟，12 分钟会记成自测超时。
 */
export const SELF_CHECK_TEST_MS = 30 * 60_000;

/** tsc 最多跑多久（毫秒）。 */
export const SELF_CHECK_TSC_MS = 5 * 60_000;

/** 同一台机器上同时跑自测的上限。 */
export const SELF_CHECK_SLOTS = 2;

/** 看树里装没装依赖、有没有 tsc，各给这么久。这两下发生在拿到名额之前。 */
export const SELF_CHECK_PROBE_MS = 30_000;

/** 活动限时在整点之外多留的收尾，避免刚好卡满被判 StartToClose。 */
const SELF_CHECK_QUEUE_SLACK_MS = 60_000;

/**
 * 排队余量：名额满时，后来的要等前面一轮测试加 tsc 跑完才拿得到。
 * 拿名额前还有两次看目录（依赖、tsc），再留一分钟收尾。
 * 两个名额、四张单同时自测时，等的那两张盖得住；再多就活动限时到了，工作流记 skipped，不再整段重跑。
 */
export const SELF_CHECK_QUEUE_MARGIN_MS =
  SELF_CHECK_TEST_MS + SELF_CHECK_TSC_MS + 2 * SELF_CHECK_PROBE_MS + SELF_CHECK_QUEUE_SLACK_MS;

/** 自测活动的 StartToClose（毫秒）：测试预算 + tsc 预算 + 排队余量。 */
export const SELF_CHECK_ACTIVITY_MS = SELF_CHECK_TEST_MS + SELF_CHECK_TSC_MS + SELF_CHECK_QUEUE_MARGIN_MS;
