import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// 包内 AGENTS.md 读到那个包的文件就会自动注入、之后每次调模型都重带（#3588 审计、#3598）：
// 只留不变量，来龙去脉进决定记录和方案。超了先删历史和例子，别调大上限。字符按 Unicode 码点数。
const LIMITS: Record<string, number> = {
  'packages/engine/AGENTS.md': 10_000,
  'packages/conventions/AGENTS.md': 8_000,
  'packages/api/AGENTS.md': 8_000,
};

describe('包内 AGENTS.md 字符数上限', () => {
  for (const [path, limit] of Object.entries(LIMITS)) {
    it(`${path} 不超过 ${limit} 字符`, () => {
      const text = readFileSync(`${ROOT}${path}`, 'utf8');
      expect([...text].length).toBeLessThanOrEqual(limit);
    });
  }
});
