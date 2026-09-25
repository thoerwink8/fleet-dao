// 编号：库主键（subtasks.id、session_runs.id、asks.id、批准编号）在这里生成，经 decide 本地活动记进历史。
// 不是判断，但和判断一样要进历史：工作流里用 uuid4 的话，哪天代码多调一次，后面的编号全部错位——重放照样全绿
// （uuid4 不产生命令），在途任务手里的编号却已经对不上库。进了历史，重放时直接取历史里的值，和代码里调了几次无关。

import { randomUUID } from 'node:crypto';

export interface NewIdsInput {
  count: number;
}

export function newIds(input: NewIdsInput): string[] {
  const count = Math.max(0, Math.floor(input.count));
  return Array.from({ length: count }, () => randomUUID());
}
