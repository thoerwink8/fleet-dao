// 发版前「等在跑的会话收尾」最多等多久（分钟），发版确认框的文案读这一个数（#2017）。
// 来源是 deploy/release.sh 的 DRAIN_GRACE（600）+ DRAIN_STOP_REPORT（120）+ DRAIN_SLACK（60）= 780 秒；
// lib/release-wait.test.ts 读脚本核对，脚本改了这里不改就红。
export const RELEASE_WAIT_MAX_MINUTES = 13;
