// 进程入口。先把驾驶舱接口听上，再加载 boot.ts（那一包要连库、装路由，比听端口慢得多）。
// 发布重启时端口归 fleet-api.socket：等装配完才 listen，中间 TCP 通、HTTP 挂起。
// 地址对不上、配置读不成，在听上之前就退出（和以前一样，不听一个半截的端口）。
import { ConfigError } from './config.ts';
import { EarlyListenError, openEarly } from './early-listen.ts';
import { ListenFdError } from './listen.ts';

try {
  await openEarly();
  await import('./boot.ts');
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ConfigError || err instanceof ListenFdError || err instanceof EarlyListenError) {
    console.error(message);
    process.exit(1);
  }
  console.error(err instanceof Error ? (err.stack ?? message) : message);
  process.exit(1);
}
