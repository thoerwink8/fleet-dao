// 流程配置的边界表：全组织默认坏了全部停派，项目的坏了这个项目停派，都不拿默认顶；禁令项目改不掉。
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type ConfigDecision,
  ORG_DEFAULT_PATH,
  profileFor,
  resolveFlowConfig,
  type Source,
  touchesHighRisk,
  uiFiles,
} from '../src/config.ts';

const ORG_TEXT = readFileSync(new URL('../flow.default.json', import.meta.url), 'utf8');
const org: Source = { kind: 'text', text: ORG_TEXT };
const orgWith = (patch: (o: Record<string, unknown>) => void): Source => {
  const o = JSON.parse(ORG_TEXT) as Record<string, unknown>;
  patch(o);
  return { kind: 'text', text: JSON.stringify(o) };
};
const project = (o: unknown): Source => ({ kind: 'text', text: JSON.stringify(o) });
const ok = (d: ConfigDecision) => {
  if (!d.ok) throw new Error(d.why);
  return d;
};

describe('流程配置', () => {
  it('仓里的全组织默认本身认得出（路径也对得上）', () => {
    expect(ORG_DEFAULT_PATH).toBe('packages/core/flow.default.json');
    const got = ok(resolveFlowConfig(org, { kind: 'missing' }));
    expect(got.usedOrgDefault).toBe(true);
    expect(got.config.bans.map((b) => b.id).sort()).toEqual(['gpt-no-ui', 'no-fable']);
  });

  it('项目只写不同的：整套换掉同名配置、改测试命令，其余照默认', () => {
    const got = ok(
      resolveFlowConfig(
        org,
        project({
          formatVersion: 1,
          testCommand: 'pnpm test:changed',
          uiPaths: ['packages/web/'],
          categoryProfiles: { 杂项: 'single' },
        }),
      ),
    );
    expect(got.usedOrgDefault).toBe(false);
    expect(got.config.testCommand).toBe('pnpm test:changed');
    expect(got.config.categoryProfiles).toEqual({ 需求: 'default', 缺陷: 'default', 杂项: 'single' });
    expect(profileFor(got.config, '杂项')).toMatchObject({ ok: true, name: 'single' });
    expect(uiFiles(got.config, ['packages/web/src/a.tsx', 'packages/api/src/b.ts'])).toEqual([
      'packages/web/src/a.tsx',
    ]);
  });

  it('fleet-dao 自己仓根的 .fleet/flow.json 认得出：测试命令是只跑改动影响到的那条；页面代码按界面类派（GPT 不写不验）', () => {
    const own = readFileSync(new URL('../../../.fleet/flow.json', import.meta.url), 'utf8');
    const got = ok(resolveFlowConfig(org, { kind: 'text', text: own }));
    expect(got.usedOrgDefault).toBe(false);
    expect(got.config.testCommand).toBe('pnpm test:changed');
    // 驾驶舱网页、飞书卡片算页面代码；后端、引擎不算（全组织默认里 uiPaths 是空的，不写这一条改网页的活也会派给 GPT 验）
    const touched = [
      'packages/web/src/routes/task-detail.tsx',
      'packages/web/src/app.css',
      'packages/feishu/src/cards.ts',
      'deploy/web/health/index.html',
      'packages/api/src/views.ts',
      'packages/engine/src/workflows/fusion.ts',
      'packages/feishu/src/gateway.ts',
    ];
    expect(uiFiles(got.config, touched)).toEqual(touched.slice(0, 4));
  });

  it('fleet-dao 自己声明了先审后合清单在哪：路径指的文件真在仓里（免得漏配、指错）', () => {
    const own = readFileSync(new URL('../../../.fleet/flow.json', import.meta.url), 'utf8');
    const got = ok(resolveFlowConfig(org, { kind: 'text', text: own }));
    expect(got.config.riskPathsFile).toBe('packages/conventions/high-risk-paths.json');
    expect(existsSync(new URL(`../../../${got.config.riskPathsFile}`, import.meta.url))).toBe(true);
  });

  it('项目没声明先审后合清单：合并出来的就没有这个字段（不拿全组织默认或别的项目顶）', () => {
    const got = ok(resolveFlowConfig(org, project({ formatVersion: 1 })));
    expect(got.config.riskPathsFile).toBeUndefined();
  });

  it('全组织默认里没有测试命令：项目不写，合并出来的就没有（不拿别的仓的命令顶）', () => {
    const got = ok(resolveFlowConfig(org, project({ formatVersion: 1, uiPaths: ['packages/web/'] })));
    expect(got.config.testCommand).toBeUndefined();
  });

  it('单上临时指定的配置优先', () => {
    const got = ok(resolveFlowConfig(org, { kind: 'missing' }));
    expect(profileFor(got.config, '需求', 'single')).toMatchObject({ ok: true, name: 'single' });
    expect(profileFor(got.config, '需求', '没有这套')).toEqual({
      ok: false,
      why: '没有叫「没有这套」的配置',
    });
  });

  it('高风险路径按目录算', () => {
    const got = ok(
      resolveFlowConfig(org, project({ formatVersion: 1, highRiskPaths: ['packages/db/migrations/'] })),
    );
    expect(touchesHighRisk(got.config, ['packages/db/migrations/0009.sql'])).toBe(true);
    expect(touchesHighRisk(got.config, ['packages/db/src/x.ts'])).toBe(false);
  });

  it.each<[string, Source, Source, 'org' | 'project', RegExp]>([
    ['全组织默认不在', { kind: 'missing' }, { kind: 'missing' }, 'org', /找不到/],
    [
      '全组织默认读不了',
      { kind: 'unreadable', error: 'EACCES' },
      { kind: 'missing' },
      'org',
      /读不了（EACCES）/,
    ],
    ['全组织默认不是 JSON', { kind: 'text', text: '{' }, { kind: 'missing' }, 'org', /不是 JSON/],
    [
      '全组织默认格式版本认不出',
      orgWith((o) => (o.formatVersion = 9)),
      { kind: 'missing' },
      'org',
      /格式版本 9/,
    ],
    [
      '全组织默认少了写死的禁令',
      orgWith((o) => (o.bans = [])),
      { kind: 'missing' },
      'org',
      /少了写死的禁令：gpt-no-ui、no-fable/,
    ],
    [
      '全组织默认的类别指到不存在的配置',
      orgWith((o) => (o.categoryProfiles = { 需求: 'x', 缺陷: 'default', 杂项: 'default' })),
      { kind: 'missing' },
      'org',
      /「需求」用的配置「x」不存在/,
    ],
    [
      '全组织默认多了认不出的字段',
      orgWith((o) => (o.whatever = 1)),
      { kind: 'missing' },
      'org',
      /whatever|Unrecognized/i,
    ],
    [
      '全组织默认里写了测试命令（会顶掉没写的项目）',
      orgWith((o) => (o.testCommand = 'pnpm check')),
      { kind: 'missing' },
      'org',
      /测试命令只能写在各项目仓里/,
    ],
    ['项目配置读不了', org, { kind: 'unreadable', error: 'EIO' }, 'project', /读不了（EIO）/],
    ['项目配置不是 JSON', org, { kind: 'text', text: 'formatVersion: 1' }, 'project', /不是 JSON/],
    ['项目配置格式版本认不出', org, project({ formatVersion: 2 }), 'project', /格式版本 2/],
    ['项目想改禁令', org, project({ formatVersion: 1, bans: [] }), 'project', /禁令只能写在全组织默认里/],
    [
      '项目配置里用了 Fable',
      org,
      project({
        formatVersion: 1,
        profiles: {
          default: {
            steps: { lead: ['fable-5.1'], sidekick: [], review: [], verify: [], discuss: [] },
            review: { vendors: 0, rounds: 1 },
            verify: { rounds: 1 },
            discuss: { vendors: 1, rounds: 1 },
          },
        },
      }),
      'project',
      /禁用的模型 fable-5\.1/,
    ],
    [
      '项目的类别指到不存在的配置',
      org,
      project({ formatVersion: 1, categoryProfiles: { 缺陷: 'nope' } }),
      'project',
      /不存在/,
    ],
    ['项目路径跳出仓', org, project({ formatVersion: 1, uiPaths: ['../web/'] }), 'project', /相对路径/],
    [
      '全组织默认里写了先审后合清单路径（会让所有项目都去找这份文件）',
      orgWith((o) => (o.riskPathsFile = 'packages/conventions/high-risk-paths.json')),
      { kind: 'missing' },
      'org',
      /先审后合清单的路径只能写在各项目仓里/,
    ],
    [
      '【故意造出的失败】riskPathsFile 不是字符串',
      org,
      project({ formatVersion: 1, riskPathsFile: 42 }),
      'project',
      /riskPathsFile/,
    ],
    [
      '【故意造出的失败】riskPathsFile 是空串',
      org,
      project({ formatVersion: 1, riskPathsFile: '' }),
      'project',
      /riskPathsFile/,
    ],
    [
      '【故意造出的失败】riskPathsFile 带 ..，跳出仓',
      org,
      project({ formatVersion: 1, riskPathsFile: '../secrets/high-risk-paths.json' }),
      'project',
      /riskPathsFile.*相对路径/,
    ],
  ])('【失败】%s → 停派', (_name, orgSource, projectSource, scope, why) => {
    const got = resolveFlowConfig(orgSource, projectSource);
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.scope).toBe(scope);
      expect(got.why).toMatch(why);
    }
  });
});
