// #1967：默认档位和工人型号只写在 routing.default.json。effort.ts、worker-lib.mjs 再各写一份，这道检查就红。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadRoutingConfig } from '../src/routing-config.ts';

const effortTs = readFileSync(new URL('../../shared/src/effort.ts', import.meta.url), 'utf8');
const workerLib = readFileSync(
  new URL('../../../agents/skills/commander/scripts/worker-lib.mjs', import.meta.url),
  'utf8',
);

/** 源码里又把默认档或工人型号写死一份，就报出来。 */
export function duplicateSeedProblems(effortSource: string, workerSource: string): string[] {
  const problems: string[] = [];
  if (/DEFAULT_SESSION_EFFORT\s*=\s*['"]high['"]/.test(effortSource)) {
    problems.push('effort.ts 又把默认档位写成了 high');
  }
  if (/from 'node:fs'/.test(effortSource)) {
    problems.push('effort.ts 用 node:fs 读骨架：驾驶舱打包进不了浏览器');
  }
  if (/DEFAULT_EFFORT\s*=\s*['"]high['"]/.test(workerSource)) {
    problems.push('worker-lib.mjs 又把 DEFAULT_EFFORT 写成了 high');
  }
  if (/ROUTING_MODEL_OF\s*=\s*\{/.test(workerSource)) {
    problems.push('worker-lib.mjs 又写了一份 ROUTING_MODEL_OF');
  }
  if (/CLAUDE_DEFAULT_MODEL\s*=\s*['"]/.test(workerSource)) {
    problems.push('worker-lib.mjs 又写了一份 CLAUDE_DEFAULT_MODEL');
  }
  return problems;
}

describe('默认模型和档位只在 routing.default.json', () => {
  it('骨架有 defaults，工人型号是完整型号', async () => {
    const cfg = await loadRoutingConfig();
    expect(cfg.defaults).toEqual({
      effort: 'high',
      workers: { grok: 'grok-4.7', codex: 'gpt-5.6-luna', claude: 'sonnet-5.5' },
      claudeCliModel: 'claude-sonnet-5-5',
    });
  });

  it('effort.ts 和 worker-lib.mjs 不再各写一份', () => {
    expect(duplicateSeedProblems(effortTs, workerLib)).toEqual([]);
  });

  it('【故意造出的失败】源码里再写死一份，这道检查报出来', () => {
    const problems = duplicateSeedProblems(
      `export const DEFAULT_SESSION_EFFORT = 'high';\nimport { readFileSync } from 'node:fs';`,
      [
        `export const DEFAULT_EFFORT = 'high';`,
        `export const ROUTING_MODEL_OF = { grok: 'grok-4.7' };`,
        `export const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5-5';`,
      ].join('\n'),
    );
    expect(problems).toEqual([
      'effort.ts 又把默认档位写成了 high',
      'effort.ts 用 node:fs 读骨架：驾驶舱打包进不了浏览器',
      'worker-lib.mjs 又把 DEFAULT_EFFORT 写成了 high',
      'worker-lib.mjs 又写了一份 ROUTING_MODEL_OF',
      'worker-lib.mjs 又写了一份 CLAUDE_DEFAULT_MODEL',
    ]);
  });
});
