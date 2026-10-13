// 驾驶舱「发布到法国」等在跑会话收尾的上限。lib.mjs 的 LIMITS.sessionsMs 和发版确认框的「最多 N 分钟」都读这一个数。
// 这个文件不引 Node 内置模块：驾驶舱前端打包时也要能读它。
export const SESSION_WAIT_MS = 13 * 60_000;
