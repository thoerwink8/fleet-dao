// tier.ts：按改动面分档（specs/509-需求梳理/流程重做方案.md §四）。
// happy path 三档各一例；故意造红：空输入不许默认 fast；>50 动 refine 直接 heavyweight。

import { RUN_TIERS } from '@fleet-dao/db';
import { SEGMENT_TIERS } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  decideTier,
  TIER_HEAVYWEIGHT_FILE_THRESHOLD,
  TierDecisionSchema,
  TierEnum,
  TierError,
} from '../../src/runner/tier.ts';

describe('派工档的叫法三处一致', () => {
  it('runs 表收的（库里有约束）、驾驶舱认的，和这里分出来的档一字不差：加一档要三处一起改', () => {
    expect([...RUN_TIERS]).toEqual(TierEnum.options);
    expect([...SEGMENT_TIERS]).toEqual(TierEnum.options);
  });
});

describe('decideTier · happy path 三档', () => {
  it('一个文件 → fast / effort=medium（jobs 例：packages/api/src/cli.ts）', () => {
    const d = decideTier(['packages/api/src/cli.ts']);
    expect(TierDecisionSchema.parse(d)).toEqual(d);
    expect(d.tier).toBe('fast');
    expect(d.effort).toBe('medium');
    expect(d.reason).toContain('packages/api/src/cli.ts');
  });

  it('同一 packages/<包>/ 下几个文件 → medium / effort=high（jobs 例：packages/shared/src/*.ts）', () => {
    const d = decideTier([
      'packages/shared/src/a.ts',
      'packages/shared/src/b.ts',
      'packages/shared/src/sub/c.ts',
    ]);
    expect(TierDecisionSchema.parse(d)).toEqual(d);
    expect(d.tier).toBe('medium');
    expect(d.effort).toBe('high');
    expect(d.reason).toContain('packages/shared/');
  });

  it('跨包（packages/api + packages/core）→ heavyweight / effort=high；reason 要带「碰接口包」', () => {
    const d = decideTier(['packages/api/src/index.ts', 'packages/core/src/routing.ts']);
    expect(TierDecisionSchema.parse(d)).toEqual(d);
    expect(d.tier).toBe('heavyweight');
    expect(d.effort).toBe('high');
    expect(d.reason).toContain('碰接口包');
  });

  it('同一接口包内多文件（packages/api/src/a.ts + packages/api/src/b.ts）→ medium（顺序判定，第 4 条先于第 5 条）', () => {
    const d = decideTier(['packages/api/src/a.ts', 'packages/api/src/b.ts']);
    expect(d.tier).toBe('medium');
    expect(d.effort).toBe('high');
  });
});

describe('decideTier · 边界与造红', () => {
  it('空文件列表 → 抛 TierError，不默认 fast（明确失败路径）', () => {
    expect(() => decideTier([])).toThrow(TierError);
    expect(() => decideTier([])).toThrowError(/空的文件列表/);
  });

  it('改动面 >50 个文件 → 不再 refine，直接 heavyweight', () => {
    const many: string[] = [];
    for (let i = 0; i < TIER_HEAVYWEIGHT_FILE_THRESHOLD + 1; i++) {
      many.push(`packages/shared/src/f${i}.ts`);
    }
    const d = decideTier(many);
    expect(d.tier).toBe('heavyweight');
    expect(d.effort).toBe('high');
    expect(d.reason).toContain(`${TIER_HEAVYWEIGHT_FILE_THRESHOLD}`);
  });

  it('改动面恰好 50 个、且同包 · 没碰接口 → 仍走 refine：medium', () => {
    const many: string[] = [];
    for (let i = 0; i < TIER_HEAVYWEIGHT_FILE_THRESHOLD; i++) {
      many.push(`packages/engine/src/f${i}.ts`);
    }
    const d = decideTier(many);
    expect(d.tier).toBe('medium');
    expect(d.effort).toBe('high');
  });

  it('由「packages/<包>/」之外的路径 + 包内路径混合 → 跨面：heavyweight', () => {
    const d = decideTier(['packages/engine/src/x.ts', 'agents/config/claude-permissions.json']);
    expect(d.tier).toBe('heavyweight');
    expect(d.effort).toBe('high');
  });

  it('reason 必非空（zod schema 约束 + 全三档 happy path 都验证）', () => {
    for (const d of [
      decideTier(['packages/api/src/a.ts']),
      decideTier(['packages/engine/src/a.ts', 'packages/engine/src/b.ts']),
      decideTier(['packages/api/src/a.ts', 'packages/core/src/b.ts']),
    ]) {
      expect(d.reason.length).toBeGreaterThan(0);
    }
  });
});
