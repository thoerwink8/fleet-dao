// 用途表没另配档位时用的默认档（#1958）。值只在 routing.default.json 的 defaults.effort，这里读那一份。
// 不放在 shared：shared 读这份文件是跨包相对路径，还得让 shared 依赖 db。db 已经依赖 shared，成环，
// 改 db 会把依赖 shared 的包全拉去重测（#1355：shared 不再读路由骨架）。
import { readFileSync } from 'node:fs';
import { isSessionEffort, SESSION_EFFORTS, type SessionEffort } from '@fleet-dao/shared';
import { ROUTING_DEFAULT_PATH } from './routing-config.ts';

function readDefaultEffort(): SessionEffort {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(ROUTING_DEFAULT_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`读不到路由骨架 ${ROUTING_DEFAULT_PATH.href}：${(err as Error).message}`);
  }
  const defaults =
    parsed !== null && typeof parsed === 'object' && 'defaults' in parsed
      ? (parsed as { defaults?: { effort?: unknown } }).defaults
      : undefined;
  const effort = defaults?.effort;
  if (!isSessionEffort(effort)) {
    throw new Error(
      `routing.default.json 的 defaults.effort 不是思考档位：${JSON.stringify(effort)}（只有 ${SESSION_EFFORTS.join(' / ')}）`,
    );
  }
  return effort;
}

/** 没配用这一档。创始人 2026-09-28 傍晚拍：总是显式传，不靠各家命令行自己的默认。骨架里那一档认不出就抛。 */
export const DEFAULT_SESSION_EFFORT: SessionEffort = readDefaultEffort();
