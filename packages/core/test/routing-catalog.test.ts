// 两层路由目录的边界表（specs/574-路由两层DB/需求.md）：认不出、缺键、空渠道、孤儿全是明确失败，
// 绝不拿空数组顶；故意造红的用例每条都对应一条「没读就当 ok」的反面。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ORG_ROUTING_DEFAULT_PATH,
  PURPOSES,
  type RoutingCatalog,
  type RoutingSource,
  resolveRoutingCatalog,
} from '../src/routing-catalog.ts';

const ORG_TEXT = readFileSync(new URL('../routing.default.json', import.meta.url), 'utf8');
const org: RoutingSource = { kind: 'text', text: ORG_TEXT };
const withPatch = (patch: (o: Record<string, unknown>) => void): RoutingSource => {
  const o = JSON.parse(ORG_TEXT) as Record<string, unknown>;
  patch(o);
  return { kind: 'text', text: JSON.stringify(o) };
};

describe('两层路由目录', () => {
  it('仓里的全组织默认本身认得出（路径、格式、所有用途都挂、第一层挂的模型第二层都有）', () => {
    expect(ORG_ROUTING_DEFAULT_PATH).toBe('packages/core/routing.default.json');
    const d = resolveRoutingCatalog(org);
    if (!d.ok) throw new Error(`仓里的默认认不出：${d.why}`);
    expect(d.catalog.formatVersion).toBe(1);
    for (const p of PURPOSES) {
      expect(d.catalog.purposes[p], `缺用途 ${p}`).toBeDefined();
    }
    for (const p of PURPOSES) {
      for (const m of d.catalog.purposes[p]?.models ?? []) {
        expect(d.catalog.models[m], `用途 ${p} 挂了 ${m}，但 models 里没有`).toBeDefined();
      }
    }
  });

  it('决定 0008：grok-4.7 不放进任何渠道（channels 里 mirasim 是讨论中继，不是普通派活渠道）', () => {
    const d = resolveRoutingCatalog(org);
    if (!d.ok) throw new Error(d.why);
    // 「普通派活渠道」= carpool / solo；它们不该出现 grok-4.7。讨论走 mirasim 是允许的。
    expect(d.catalog.models['grok-4.7']?.channels).not.toContain('carpool');
    expect(d.catalog.models['grok-4.7']?.channels).not.toContain('solo');
  });

  it('opus-5.5 渠道顺序是 carpool → solo → mirasim（拼车先，用满切独享，再满切 mirasim）；gpt-6-luna / deepseek-flash 只走 mirasim', () => {
    const d = resolveRoutingCatalog(org);
    if (!d.ok) throw new Error(d.why);
    expect(d.catalog.models['opus-5.5']?.channels).toEqual(['carpool', 'solo', 'mirasim']);
    expect(d.catalog.models['gpt-6-luna']?.channels).toEqual(['mirasim']);
    expect(d.catalog.models['deepseek-flash']?.channels).toEqual(['mirasim']);
  });

  it('讨论的模型顺序 = gpt-6-luna → opus-5.5 → deepseek-flash → grok-4.7 → kimi-k3（决定 0006：GPT → Claude → DeepSeek → Grok → Kimi）', () => {
    const d = resolveRoutingCatalog(org);
    if (!d.ok) throw new Error(d.why);
    expect(d.catalog.purposes.discuss?.models).toEqual([
      'gpt-6-luna',
      'opus-5.5',
      'deepseek-flash',
      'grok-4.7',
      'kimi-k3',
    ]);
  });

  it('【故意造红】文件读不到 / 认不出 / 不是 JSON：明确失败、有 code、有 why，绝不拿空默认顶', () => {
    const missing = resolveRoutingCatalog({ kind: 'missing' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe('ROUTING_CONFIG_MISSING');
      expect(missing.why).toContain('routing.default.json');
    }
    const unreadable = resolveRoutingCatalog({ kind: 'unreadable', error: 'EACCES' });
    expect(unreadable.ok).toBe(false);
    if (!unreadable.ok) expect(unreadable.code).toBe('ROUTING_CONFIG_UNREADABLE');
    const notJson = resolveRoutingCatalog({ kind: 'text', text: 'not json' });
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.code).toBe('ROUTING_CONFIG_NOT_JSON');
  });

  it('【故意造红】缺键：purposes / models 整个缺了；formatVersion 写错版；多写了认不出的字段', () => {
    const noPurposes = withPatch((o) => {
      delete o.purposes;
    });
    const d = resolveRoutingCatalog(noPurposes);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe('ROUTING_CONFIG_INVALID');

    const badVersion = withPatch((o) => {
      o.formatVersion = 999;
    });
    const d2 = resolveRoutingCatalog(badVersion);
    expect(d2.ok).toBe(false);
    if (!d2.ok) expect(d2.code).toBe('ROUTING_CONFIG_INVALID');

    const extra = withPatch((o) => {
      o.extraKey = 'x';
    });
    const d3 = resolveRoutingCatalog(extra);
    expect(d3.ok).toBe(false);
    if (!d3.ok) {
      expect(d3.code).toBe('ROUTING_CONFIG_INVALID');
      expect(d3.why).toContain('extraKey');
    }
  });

  it('【故意造红】缺用途：删掉任意一个用途（比如 sidekick），明确失败并点出哪个缺了', () => {
    for (const p of PURPOSES) {
      const broken = withPatch((o) => {
        const purposes = { ...(o.purposes as Record<string, unknown>) };
        delete purposes[p];
        o.purposes = purposes;
      });
      const d = resolveRoutingCatalog(broken);
      expect(d.ok).toBe(false);
      if (!d.ok) {
        expect(d.code).toBe('ROUTING_CONFIG_CROSS_REF');
        expect(d.why).toContain(p);
      }
    }
  });

  it('【故意造红】空渠道表：opus-5.5 的 channels 写空数组（min(1) 拦），明确失败', () => {
    const broken = withPatch((o) => {
      (o.models as Record<string, { channels: string[] }>)['opus-5.5'] = { channels: [] };
    });
    const d = resolveRoutingCatalog(broken);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe('ROUTING_CONFIG_INVALID');
  });

  it('【故意造红】空用途：任何用途的 models 写空数组，明确失败', () => {
    const broken = withPatch((o) => {
      (o.purposes as Record<string, { models: string[] }>).execute = { models: [] };
    });
    const d = resolveRoutingCatalog(broken);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe('ROUTING_CONFIG_INVALID');
  });

  it('【故意造红】第一层挂了第二层没有的模型、第二层没人用的孤儿模型、渠道顺序里重复：全都明确失败', () => {
    const missingModel = withPatch((o) => {
      (o.purposes as Record<string, { models: string[] }>).triage = {
        models: ['not-exist-model'],
      };
    });
    const d = resolveRoutingCatalog(missingModel);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.code).toBe('ROUTING_CONFIG_CROSS_REF');
      expect(d.why).toContain('not-exist-model');
    }

    const orphan = withPatch((o) => {
      (o.models as Record<string, unknown>)['orphan-model'] = { channels: ['mirasim'] };
    });
    const d2 = resolveRoutingCatalog(orphan);
    expect(d2.ok).toBe(false);
    if (!d2.ok) {
      expect(d2.code).toBe('ROUTING_CONFIG_CROSS_REF');
      expect(d2.why).toContain('orphan-model');
    }

    const dupChannel = withPatch((o) => {
      (o.models as Record<string, { channels: string[] }>)['opus-5.5'] = {
        channels: ['carpool', 'carpool', 'mirasim'],
      };
    });
    const d3 = resolveRoutingCatalog(dupChannel);
    expect(d3.ok).toBe(false);
    if (!d3.ok) {
      expect(d3.code).toBe('ROUTING_CONFIG_CROSS_REF');
      expect(d3.why).toContain('carpool');
    }
  });

  it('payload 的形状跟 RoutingCatalog 类型一致（给 db 副本写入前的最后一道约定）', () => {
    const d = resolveRoutingCatalog(org);
    if (!d.ok) throw new Error(d.why);
    const cat: RoutingCatalog = d.catalog;
    // 把 catalog 透到 JSON 再读回来形状不变：副本按 JSON.stringify 整份存。
    const round = JSON.parse(JSON.stringify(cat)) as RoutingCatalog;
    expect(round).toEqual(cat);
    expect(Object.keys(cat.purposes).sort()).toEqual([...PURPOSES].sort());
  });
});
