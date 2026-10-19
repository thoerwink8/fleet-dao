// Codex宿主钩子可能没有终端env ID；仅本次事件号可在明确登记的入口选来源。
import { runProgress } from './continuation-progress.mjs';
import { isMainModule } from './is-main.mjs';

if (isMainModule(import.meta)) runProgress('codex');
