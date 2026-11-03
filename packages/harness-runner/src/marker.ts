// 会话标记：每个会话一个值，子孙都继承，内核重启后也能按它认出上一代的进程。放在单独一个文件，procs.ts 和各 ProcessHost 实现都从这里取。

export const RUN_MARKER_KEY = 'FLEET_RUN_ID';

/**
 * 写进 `FLEET_RUN_ID` 的值。生产就是 runId，重启后的新进程仍按它找到上一代的孤儿。
 * Vitest 每个文件一个进程、库里的事件号都从 1 起，runId 会撞成同一个（d1-a1）：
 * 测试里的标记带上本进程号，收尸不会误杀别的测试还在跑的工人。
 */
export function runMarker(
  runId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  pid = process.pid,
): string {
  if (env.VITEST?.trim()) return `${pid}:${runId}`;
  return runId;
}
