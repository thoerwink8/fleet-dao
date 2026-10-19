// Codex登记的可信入口；家族来源来自登记，不从用户正文或继承环境猜。
import { isMainModule } from './is-main.mjs';
import { runStop } from './stop.mjs';

if (isMainModule(import.meta)) await runStop('codex');
