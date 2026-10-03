// 追踪用：挂进 vitest 的 setupFiles（test-graph-audit.ts 的 runTrace 就是这么挂的），每个测试文件跑完时把这一轮
// 加载过的模块、读过的文件、列过的目录写成一行 JSON，追加到 $FLEET_TRACE_OUT。没设 $FLEET_TRACE_OUT 时整段不生效。
// 改这里之前必须知道：
// - 记的是「这个进程真读了什么」，不是「代码里可能读什么」。静态图（test-graph.ts）漏没漏边，靠它核对。
// - vitest 自己转译、加载的仓内模块不经 Node 的模块钩子，只在它的 evaluatedModules 里：跑完从那里取。
// - 子进程：往 process.env 里放 NODE_OPTIONS=--import=<trace-child.ts> 和当前测试文件名，子进程默认继承 process.env，
//   自己写一行。测试给子进程造了一份不含 NODE_OPTIONS 的 env 时记不到（是「没查到」，不是「查过了没读」）。
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { afterAll } from 'vitest';
import { startTracing } from './trace-child.ts';

const OUT = process.env.FLEET_TRACE_OUT;
type Worker = { filepath?: string; evaluatedModules?: { fileToModulesMap?: Map<string, unknown> } };
const worker = () => (globalThis as { __vitest_worker__?: Worker }).__vitest_worker__;

if (OUT !== undefined && OUT !== '') {
  const sink = startTracing();
  // jsdom 环境里 import.meta.url 不是 file: 的，子进程钩子的路径由 runTrace 经环境变量给
  const childPath = process.env.FLEET_TRACE_CHILD ?? '';
  const child = childPath === '' ? '' : pathToFileURL(childPath).href;
  const opts = (process.env.NODE_OPTIONS ?? '').replace(/\s*--import=\S*trace-child\.ts/g, '');
  if (child !== '') process.env.NODE_OPTIONS = `${opts} --import=${child}`.trim();
  process.env.FLEET_TRACE_TEST = worker()?.filepath ?? '';
  // setupFiles 在每个测试文件前都跑一遍：上一个文件的记录在它的 afterAll 里已经写走、清空
  afterAll(() => {
    const w = worker();
    appendFileSync(
      OUT,
      `${JSON.stringify({
        testFile: w?.filepath ?? '',
        root: process.env.FLEET_TRACE_ROOT ?? '',
        loaded: [...sink.loaded, ...(w?.evaluatedModules?.fileToModulesMap?.keys() ?? [])],
        read: sink.read,
        listed: sink.listed,
      })}\n`,
    );
    sink.loaded.length = 0;
    sink.read.length = 0;
    sink.listed.length = 0;
  });
}
