// 进程入口：node packages/engine/src/main.ts
// 环境变量：TEMPORAL_ADDRESS（默认 127.0.0.1:7243）、TEMPORAL_NAMESPACE（默认 fleet）、FLEET_TASK_QUEUE（默认 fleet）、
// FLEET_ENGINE_PORTS（real / fake，必须写）、FLEET_SHUTDOWN_GRACE_SECONDS、FLEET_MAX_ACTIVITIES；
// 真端口另要的见 deploy/france/desired-config.json 的 engine 段（期望配置；env 样例文件 #747 删了，发布时照期望写）。
import { runEngineWorker } from './worker.ts';

try {
  await runEngineWorker();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
// 收尾都做完了（runEngineWorker 的 finally：定时器、连接、状态文件）：照退，不等还挂着的句柄——被强停的活动留下的子进程管道、
// 没清的计时器会让进程一直不退，systemd 等到 TimeoutStopSec 才 SIGKILL（#2238）
process.exit(process.exitCode ?? 0);
