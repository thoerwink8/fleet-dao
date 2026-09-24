// 第二版（错误的改法）：在 a 前面直接加一步 b，没包 patched()。在途的老任务一重放就对不上历史（TMPRL1100）。
import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as steps from './steps.ts';

export const goSignal = defineSignal('go');
export const stepsQuery = defineQuery<string[]>('steps');

const { stepA, stepB, stepC } = proxyActivities<typeof steps>({ startToCloseTimeout: '1 minute' });

export async function evolving(): Promise<string[]> {
  const done: string[] = [];
  let go = false;
  setHandler(goSignal, () => {
    go = true;
  });
  setHandler(stepsQuery, () => done);
  done.push(await stepB());
  done.push(await stepA());
  await condition(() => go);
  done.push(await stepC());
  return done;
}
