// 法国指挥官会话（#3294 第 2 片）和任务工作流共用的两个字面量。工作流文件只许引不含活动实现的模块，所以单放一个文件。
import { MAX_ROUND_RESETS } from './task-contract.ts';

/** 指挥官会话的裁决经引擎执行时「继续」的 by 和操作记录的 actor。 */
export const COMMANDER_ACTOR = 'engine:commander';

/**
 * 老历史（没记 status.park）的停下由指挥官续时「继续」的 by（#3423）。工作流收到 COMMANDER_ACTOR 会核 status.park 的编号，
 * 老历史没有它就不认；这个 by 走普通「继续」那一支（和人点的一样），引擎发之前现问过工作流还停着。
 */
export const COMMANDER_LEGACY_ACTOR = 'engine:commander:legacy';

/** 已继续 MAX_ROUND_RESETS 次仍没过时停下的标题（workflows/task-runtime.ts 的 exhaustRounds）：这一停是「交指挥官」，不用等 15 分钟。 */
export const ROUNDS_HANDOFF_TITLE = `已继续 ${MAX_ROUND_RESETS} 次仍没过，交指挥官`;
