// 演练「代码升级」的小工作流：第一版。先做 a，等「go」，再做 c。
import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as steps from './steps.ts';

export const goSignal = defineSignal('go');
export const stepsQuery = defineQuery<string[]>('steps');

const { stepA, stepC } = proxyActivities<typeof steps>({ startToCloseTimeout: '1 minute' });

export async function evolving(): Promise<string[]> {
  const done: string[] = [];
  let go = false;
  setHandler(goSignal, () => {
    go = true;
  });
  setHandler(stepsQuery, () => done);
  done.push(await stepA());
  await condition(() => go);
  done.push(await stepC());
  return done;
}
