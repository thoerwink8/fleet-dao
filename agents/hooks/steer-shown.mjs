// 旧的「转给模型看过的引导」记录的路径（~/.fleet-dao/steer-shown）：现在没人往里写，开会话对账（founder-inbox.mjs）还读。
// 单独一个文件，是为了 founder-inbox.mjs 不用 import main-thread.mjs：main-thread.mjs 现在要在运行中按需加载 founder-inbox.mjs
// （inbox-tick.mjs，单 #2382），两边互相 import 会让入口的顶层 await 永远等不到（退出码 13）。main-thread.mjs 仍从这里再导出，老的引用不变。
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 记「转给模型看过的引导到哪一刻」的目录（~/.fleet-dao/steer-shown）；测试用 FLEET_STEER_SHOWN_DIR 换。
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [home]
 */
export function steerShownDir(env = process.env, home = homedir()) {
  const o = env.FLEET_STEER_SHOWN_DIR;
  return typeof o === 'string' && o ? o : join(home, '.fleet-dao', 'steer-shown');
}

/**
 * 这个会话的那一份：<目录>/<会话号>.json，内容 { at: 毫秒 }。
 * @param {string} dir
 * @param {string} sessionId
 */
export function shownFile(dir, sessionId) {
  return join(dir, `${sessionId.replace(/[^\w.-]/g, '_')}.json`);
}
