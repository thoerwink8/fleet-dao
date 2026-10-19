import { readFileSync } from 'node:fs';
import { policyOrigin } from '@fleet-dao/shared';
import { parseEnv } from '../../../../deploy/france/auto-release/config.mjs';

/** 只读已有 API 配置中的唯一 origin；不 source/eval、不装入环境、不回显配置或底层异常。 */
export function policySourceOrigin(
  read: () => string = () => readFileSync('/etc/fleet-dao/api.env', 'utf8'),
): string {
  try {
    const entries = parseEnv(read()).entries.filter((e) => e.key === 'FLEET_PUBLIC_URL');
    if (entries.length !== 1) throw new Error('missing or duplicate');
    return policyOrigin(entries[0]?.value ?? '').origin;
  } catch {
    throw new Error(
      'CI 策略 source origin 未确认：api.env 的 FLEET_PUBLIC_URL 必须唯一且为规范 HTTPS origin',
    );
  }
}
