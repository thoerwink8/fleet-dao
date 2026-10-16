// 实时推送的约定：这些表一有写入，数据库就 NOTIFY fleet_changes（触发器在 packages/db 的迁移里，测试逐表核对），
// 驾驶舱后端 LISTEN 它，再经 SSE 推给页面。
// 只增不改：删掉或改名一张还在写的表，正在监听它的页面会悄悄收不到变化。表本身删了（老会话表和进度表，#2357）才从这里摘。

export const FLEET_CHANGES_CHANNEL = 'fleet_changes';

export const REALTIME_TABLES = [
  'tasks',
  'subtasks',
  // 三段流水（scope / manual / verify，迁移 0023）：主页的流水线图、任务详情的流水读它。触发器在 0035。
  'runs',
  'quota_windows',
  'notifications',
  'asks',
  'channels',
  'settings',
  'audit_log',
  'approvals',
  // 别的环境推来的快照（一个环境一行，id 是 node_id）：看板的环境切换器、环境页并排读它。触发器在 0036。
  'node_reports',
  // 提需求（#2060）：需求一有动静（新消息、进度卡、引擎提问、单子状态）就推，id 是需求号（seq）。触发器在 0066。
  'requests',
] as const;

export type RealtimeTable = (typeof REALTIME_TABLES)[number];

/**
 * NOTIFY 的载荷，也是 SSE change 事件的 data：收到后按 id 回库里读。id 一律是文本：
 * 单列主键的表就是主键；quota_windows 是 pool_id（额度按池刷新；池本身改了——最近读成时刻、到期日、成员表——也按池报成它）；
 * settings 是 key。
 */
export interface ChangeEvent {
  table: RealtimeTable;
  id: string;
}
