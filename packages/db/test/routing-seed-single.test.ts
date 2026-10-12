// 默认模型和档位只在 routing.default.json。effort.ts、worker-lib.mjs 再写一份就红。路由里写别名也红。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRoutingConfig, parseRoutingConfig } from '../src/routing-config.ts';
import { DEFAULT_SESSION_EFFORT } from '../src/routing-defaults.ts';
import { bareAliasProblems, seedLiteralProblems } from '../src/routing-seed-single.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const text = (rel: string) => readFileSync(`${root}${rel}`, 'utf8');

const REAL = ['packages/shared/src/effort.ts', 'agents/skills/commander/scripts/worker-lib.mjs'].map(
  (path) => ({ path, text: text(path) }),
);

describe('默认模型和档位只在 routing.default.json', () => {
  it('effort.ts 和 worker-lib.mjs 不再各写一份默认档位或默认型号', () => {
    expect(seedLiteralProblems(REAL)).toEqual([]);
  });

  it('【故意造出的失败】代码里又写死默认档位、型号表或 Claude 默认型号：报出来', () => {
    const bad = {
      path: 'packages/shared/src/effort.ts',
      text: `export const DEFAULT_SESSION_EFFORT: SessionEffort = 'high';\nexport const DEFAULT_EFFORT = 'low';\nexport const ROUTING_MODEL_OF = { claude: 'sonnet' };\nexport const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5-5';\n`,
    };
    expect(seedLiteralProblems([bad])).toEqual([
      'packages/shared/src/effort.ts 又写了一份默认值（DEFAULT_SESSION_EFFORT）：默认模型和档位只在 routing.default.json',
      'packages/shared/src/effort.ts 又写了一份默认值（DEFAULT_EFFORT）：默认模型和档位只在 routing.default.json',
      'packages/shared/src/effort.ts 又写了一份默认值（ROUTING_MODEL_OF）：默认模型和档位只在 routing.default.json',
      'packages/shared/src/effort.ts 又写了一份默认值（CLAUDE_DEFAULT_MODEL）：默认模型和档位只在 routing.default.json',
    ]);
  });

  it('仓里的骨架有 defaults，型号都是完整的', async () => {
    const cfg = await loadRoutingConfig();
    expect(cfg.defaults?.effort).toBe('high');
    expect(DEFAULT_SESSION_EFFORT).toBe(cfg.defaults?.effort);
    // 假后端不连库，展示档写在这一行。和骨架对不上这里就红，不能自己另定一档。
    expect(text('packages/web/src/api/mock/server.ts')).toContain(`defaultEffort: '${cfg.defaults?.effort}'`);
    expect(cfg.defaults?.models).toEqual({ grok: 'grok-4.7', codex: 'gpt-5.6-luna', claude: 'sonnet-5.5' });
    expect(cfg.defaults?.claudeModel).toBe('claude-sonnet-5-5');
    expect(bareAliasProblems(['auto', 'sonnet-5.5', 'claude-sonnet-5-5'])).toEqual([]);
  });

  it('【故意造出的失败】路由里写了别名：报错，不把 cursor 的上游串 auto 当成别名', () => {
    expect(bareAliasProblems(['sonnet', 'auto'])).toEqual(['型号 sonnet 是别名，路由里要写完整型号']);
    expect(() =>
      parseRoutingConfig(
        JSON.stringify({
          purposes: { default: ['sonnet'] },
          models: { sonnet: [{ routeId: 'r', enabled: true }] },
        }),
      ),
    ).toThrow(/型号 sonnet 是别名，路由里要写完整型号/);
  });
});
