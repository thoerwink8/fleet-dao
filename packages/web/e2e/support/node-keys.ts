// 看板多机的 e2e：后端起的时候带两把环境通行证（FLEET_NODE_KEYS 里只放哈希），用例拿明文往 /api/nodes/report 推一份快照。
// wsl 推快照（收到过、可以按时间变成失联）；idle 配了钥匙却一次不推（看板上是「从没收到过」）。明文只在测试里用，不是真密钥。
import { createHash } from 'node:crypto';

export const NODE_TOKEN_WSL = 'e2e-node-token-wsl-0123456789abcdefghijklmnopqrstuv';
export const NODE_TOKEN_IDLE = 'e2e-node-token-idle-0123456789abcdefghijklmnopqrstu';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** 给后端的 FLEET_NODE_KEYS（{"<环境编号>":"<通行证的 sha256>"}）。 */
export const E2E_NODE_KEYS = JSON.stringify({
  wsl: sha256(NODE_TOKEN_WSL),
  idle: sha256(NODE_TOKEN_IDLE),
});
