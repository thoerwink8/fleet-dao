// 上线项目登记表（#1985，vps-apps.ts）：表里每个单元在 docs/ops.md 里对得上，deploy/france 下每个常驻单元都有着落，
// 目录不互相套（套了资源页就算两遍）。末尾两条是故意造红：拿一张写错的表跑同一套核对，必须报出来。
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { NOT_APPS, VPS_APPS, type VpsApp } from '../src/vps-apps.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const ops = readFileSync(`${root}docs/ops.md`, 'utf8');
const between = (text: string, name: string) => {
  const m = new RegExp(`<!-- fleet:${name}:start -->([\\s\\S]*?)<!-- fleet:${name}:end -->`).exec(text);
  if (!m?.[1]) throw new Error(`docs/ops.md 里没有 fleet:${name} 区块`);
  return m[1];
};
/** 由 deploy/ 生成的单元表（单元的事实）。 */
const unitsBlock = between(ops, 'units');
/** 去掉登记表自己那一节：核对的是别处（服务表、端口表、目录表）写没写到，不拿登记表证明登记表。 */
const opsElsewhere = ops.replace(/<!-- vps-apps:start -->[\s\S]*?<!-- vps-apps:end -->/, '');

/** 核对一张表，返回问题（空 = 对得上）。 */
function problems(apps: readonly VpsApp[], franceUnits: readonly string[]): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  const registered = new Set<string>();
  for (const app of apps) {
    if (ids.has(app.id)) out.push(`编号 ${app.id} 重复`);
    ids.add(app.id);
    for (const u of app.units) {
      registered.add(u.name);
      if (u.name.startsWith('fleet-')) {
        if (!unitsBlock.includes(`| ${u.name} |`))
          out.push(`${app.id} 的单元 ${u.name} 不在 docs/ops.md 的单元表里`);
      } else if (!opsElsewhere.includes(app.external ? u.name.replace(/\.service$/, '') : u.name)) {
        out.push(`${app.id} 的单元 ${u.name} 在 docs/ops.md 里找不到`);
      }
      if (!u.cgroup.endsWith(`/${u.name}`)) out.push(`${u.name} 的 cgroup 路径 ${u.cgroup} 不以单元名结尾`);
    }
    if (app.units.length === 0 && !app.idleNote) out.push(`${app.id} 没有单元，要写 idleNote`);
    if (app.dirs.length === 0 && !app.databases && !app.diskNote)
      out.push(`${app.id} 没有目录和库，要写 diskNote`);
  }
  for (const f of franceUnits) {
    if (!registered.has(f) && !NOT_APPS[f]) out.push(`deploy/france/${f} 既没登记、也不在 NOT_APPS 里`);
  }
  const dirs = apps.flatMap((a) => a.dirs.map((d) => ({ d, id: a.id })));
  for (const a of dirs) {
    if (!a.d.startsWith('/') || a.d.endsWith('/'))
      out.push(`${a.id} 的目录 ${a.d} 要写绝对路径、不带结尾的 /`);
    for (const b of dirs) {
      if (a !== b && (a.d === b.d || b.d.startsWith(`${a.d}/`)))
        out.push(`目录 ${b.d}（${b.id}）套在 ${a.d}（${a.id}）里`);
    }
  }
  return out;
}

/** deploy/france 下的常驻单元：.service、.slice（.socket、.timer、.path 只是触发器）。 */
const franceUnits = readdirSync(`${root}deploy/france`).filter(
  (f) => f.endsWith('.service') || f.endsWith('.slice'),
);

describe('登记表', () => {
  test('每个单元对得上 docs/ops.md，deploy/france 下每个常驻单元都有着落，目录不互相套', () => {
    expect(franceUnits.length).toBeGreaterThan(5);
    expect(problems(VPS_APPS, franceUnits)).toEqual([]);
  });

  test('至少有指挥官点名的几项：驾驶舱、引擎、Temporal、数据库、AI 会话、自动发布、发布版本', () => {
    expect(VPS_APPS.map((a) => a.id)).toEqual(
      expect.arrayContaining([
        'cockpit',
        'engine',
        'temporal',
        'postgres',
        'sessions',
        'release',
        'releases',
      ]),
    );
  });

  test('docs/ops.md 有登记表那一节，列的应用和这份一致', () => {
    const m = /<!-- vps-apps:start -->([\s\S]*?)<!-- vps-apps:end -->/.exec(ops);
    expect(m, 'docs/ops.md 里没有 vps-apps 那一节').toBeTruthy();
    for (const app of VPS_APPS) expect(m?.[1]).toContain(`| ${app.name} |`);
  });

  test('【故意造红】单元名写错、漏登记、目录互相套：都报出来', () => {
    const bad: VpsApp[] = [
      {
        id: 'x',
        name: 'x',
        place: '/x',
        units: [{ name: 'fleet-nope.service', cgroup: 'system.slice/fleet-nope.service' }],
        dirs: ['/srv/a'],
      },
      { id: 'y', name: 'y', place: '/y', units: [], dirs: ['/srv/a/b'], idleNote: '只占磁盘' },
    ];
    const got = problems(bad, ['fleet-engine.service']);
    expect(got).toContain('x 的单元 fleet-nope.service 不在 docs/ops.md 的单元表里');
    expect(got).toContain('deploy/france/fleet-engine.service 既没登记、也不在 NOT_APPS 里');
    expect(got).toContain('目录 /srv/a/b（y）套在 /srv/a（x）里');
  });
});
