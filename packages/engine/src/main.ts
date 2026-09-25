// 进程入口：node packages/engine/src/main.ts
// 环境变量：TEMPORAL_ADDRESS（默认 127.0.0.1:7243）、TEMPORAL_NAMESPACE（默认 fleet）、FLEET_TASK_QUEUE（默认 fleet）、
// FLEET_ENGINE_PORTS（real / fake，必须写）、FLEET_SHUTDOWN_GRACE_SECONDS、FLEET_MAX_ACTIVITIES；
// 真端口另要的见 deploy/france/engine.env.example。
import { runEngineWorker } from './worker.ts';

try {
  await runEngineWorker();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
