// 实时推送的约定：这些表一有写入，数据库就 NOTIFY fleet_changes（触发器在 packages/db 的迁移里，测试逐表核对），
// 驾驶舱后端 LISTEN 它，再经 SSE 推给页面。
// 只增不改：删掉或改名一张表，正在监听它的页面会悄悄收不到变化。

export const FLEET_CHANGES_CHANNEL = 'fleet_changes';

export const REALTIME_TABLES = [
  'tasks',
  'subtasks',
  'session_runs',
  'progress_events',
  'quota_windows',
  'notifications',
  'asks',
  'stage_policies',
  'channels',
  'settings',
  'audit_log',
] as const;

export type RealtimeTable = (typeof REALTIME_TABLES)[number];

/**
 * NOTIFY 的载荷，也是 SSE change 事件的 data：收到后按 id 回库里读。id 一律是文本：
 * 单列主键的表就是主键；quota_windows 是 pool_id（额度按池刷新；池本身改了——最近读成时刻、到期日、成员表——也按池报成它）；
 * stage_policies 是阶段名（改路由顺序也发）；settings 是 key。
 */
export interface ChangeEvent {
  table: RealtimeTable;
  id: string;
}
