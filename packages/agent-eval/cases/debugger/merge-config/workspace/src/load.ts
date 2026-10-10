import { type Config, DEFAULTS } from './defaults.ts';
import { mergeConfig } from './merge.ts';

/** 出厂默认值加上调用方的覆盖，得到这一次要用的配置。 */
export function loadConfig(override: Record<string, unknown> = {}): Config {
  return mergeConfig(DEFAULTS, override);
}
