// 第二版（正确的改法）：在 a 前面加一步 b，用 patched() 包住。在途的老任务照老步序走，新起的走新步序。
import {
  condition,
  defineQuery,
  defineSignal,
  patched,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
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
  if (patched('evolving-add-b')) done.push(await stepB());
  done.push(await stepA());
  await condition(() => go);
  done.push(await stepC());
  return done;
}
