// 「你好」工作流：P0 验收用（deploy/hello.sh）——证明引擎工人在接活、Temporal 把这次执行的起止时间记进了库。
// 不调活动、不碰外部。名字不是非空字符串就明说失败，不回一句空话冒充跑通。

import { ApplicationFailure } from '@temporalio/workflow';

export async function helloWorkflow(name: unknown): Promise<string> {
  if (typeof name !== 'string' || name.trim() === '') {
    throw ApplicationFailure.nonRetryable(
      `要一个名字（非空字符串），收到的是 ${JSON.stringify(name) ?? String(name)}`,
      'INVALID_INPUT',
    );
  }
  return `你好，${name.trim()}`;
}
