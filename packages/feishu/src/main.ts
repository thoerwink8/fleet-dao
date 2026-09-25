// 进程入口（香港，以 fleet 用户跑；单元在仓根 deploy/hk/fleet-feishu.service，怎么装、怎么发见 docs/ops.md 第十二节；
// 配置样例见 deploy/feishu.env.example）：
//   node packages/feishu/src/main.ts
// 停机：先断开长连接不再收新事件，再把手上的活做完（最多 20 秒）才退——重启时不掐断正在回的话。
import { createBackend } from './backend.ts';
import { type Config, ConfigError, loadConfig } from './config.ts';
import { createGateway } from './gateway.ts';
import { createLark } from './lark.ts';
import { jsonLogger } from './log.ts';

const log = jsonLogger();

function load(): Config {
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

const config = load();
const groups = [config.teamChatId, ...(config.testChatId ? [config.testChatId] : [])];
const lark = createLark({ appId: config.appId, appSecret: config.appSecret, groups, log });
const gateway = createGateway({
  feishu: lark.port,
  backend: createBackend({ baseUrl: config.backendUrl, gatewayToken: config.gatewayToken }),
  log,
  founders: config.founders,
  teamChatId: config.teamChatId,
  testChatId: config.testChatId,
  publicUrl: config.publicUrl,
  ackEmoji: config.ackEmoji,
  askBudgetPerDay: config.askBudgetPerDay,
  boardRefreshMs: config.boardRefreshMs,
});
lark.wire(gateway);

try {
  await lark.connect();
} catch (err) {
  log.error('连不上飞书（凭据不对，或网络不通）', { error: String(err) });
  process.exit(1);
}
log.info('飞书网关已连上', {
  bot: lark.channel.botIdentity?.name,
  founders: config.founders.length,
  groups: groups.length,
  backend: config.backendUrl,
});
gateway.start();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info('收到停机信号：先停收事件，再把手上的活做完', { signal });
  try {
    await lark.disconnect();
    await gateway.stop(20_000);
  } finally {
    log.info('网关已停', { stats: gateway.stats });
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
