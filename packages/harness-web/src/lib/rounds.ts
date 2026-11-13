/** 这个会话跑了几轮。数字来自会话行的 turns（每次开跑加一），列表和会话页底部用同一句。 */
export function roundLabel(turns: number): string {
  return `${turns} 轮`;
}
