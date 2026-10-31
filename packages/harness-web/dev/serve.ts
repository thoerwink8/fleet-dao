// 本机开发一条命令：`pnpm --filter @fleet-dao/harness-web dev`（= node dev/serve.ts）。
// 起 PGlite（fleet2 真迁移）、灌样例事件、起 harness-api 和开发后端（127.0.0.1:8790）；
// 前端另开一个终端 `pnpm --filter @fleet-dao/harness-web dev:web`，开 http://localhost:5180/next/ 。
// 想看实时：在这个进程的标准输入敲命令往会话里写事件（见启动提示）。
import { createInterface } from 'node:readline';
import { seed } from './seed.ts';
import { startStack } from './stack.ts';

const dataDir = process.env.HARNESS_WEB_DATA_DIR;
const stack = await startStack({
  port: Number(process.env.HARNESS_WEB_DEV_PORT ?? 8790),
  ...(dataDir ? { dataDir } : {}),
});
const made = await seed(stack);
console.log(`开发后端已起：${stack.url}（接口层 ${stack.apiUrl()}，库：${dataDir ?? '内存，退出即没'}）`);
console.log(made.length > 0 ? `灌了样例会话：${made.join('、')}` : '库里已有样例会话，没重灌');
console.log('前端：另开终端跑 dev:web，然后打开 http://localhost:5180/next/');
console.log('实时演示：在这里输入 `emit <会话号> <类型> <JSON载荷>`，例如');
console.log('  emit cmd-demo-login-fix worker.progress.reported {"summary":"又一条进度","percent":90}');
console.log('断后端演示：输入 `api stop` / `api start`（只停接口层，开发后端还在）。');

createInterface({ input: process.stdin }).on('line', (line) => {
  const [cmd, a, b, ...rest] = line.trim().split(/\s+/);
  void (async () => {
    try {
      if (cmd === 'emit' && a && b) {
        const id = await stack.emit(a, b, rest.length ? JSON.parse(rest.join(' ')) : {});
        console.log(`已写入事件 #${id}`);
      } else if (cmd === 'api' && a === 'stop') {
        await stack.stopApi();
        console.log('接口层已停');
      } else if (cmd === 'api' && a === 'start') {
        await stack.startApi();
        console.log('接口层已起');
      } else if (line.trim()) console.log('认不出：emit <会话号> <类型> <JSON> | api stop | api start');
    } catch (err) {
      console.log(`出错：${err instanceof Error ? err.message : String(err)}`);
    }
  })();
});

process.on('SIGINT', () => void stack.close().finally(() => process.exit(0)));
