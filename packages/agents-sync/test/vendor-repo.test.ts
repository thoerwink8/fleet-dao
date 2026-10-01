// agents/skills-vendor（网上公开的 skill，原样拷进来）：仓里这份真目录照锁文件核得过；和自研的不同名；说明里没漏；
// 目录、锁文件、格式检查的排除、先审后合的登记这几处连着的东西不能断。核锁本身的每一种「不对」在
// packages/agents-sync/test/vendor.test.ts 里各造了一次，这里只看仓里的真东西（放在 agents-sync 包里：agents/ 的 tsconfig 只管 test，跨包 import 会让 tsc 报错）。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWED_LICENSES, LOCK_NAME, readVendor } from '../src/vendor.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const VENDOR = join(ROOT, 'agents', 'skills-vendor');
const read = (rel: string): string => readFileSync(join(ROOT, ...rel.split('/')), 'utf8');

describe('第三方 skill（agents/skills-vendor/）', () => {
  const vendor = readVendor(ROOT);

  it('照锁文件核得过：登记的都在、文件不多不少、哈希对得上、许可证在白名单里', () => {
    if (!vendor.ok) throw new Error(vendor.why);
    expect(vendor.lock).not.toBeNull();
    expect(vendor.skills.size).toBeGreaterThan(0);
    for (const [name, e] of Object.entries(vendor.lock?.skills ?? {})) {
      expect(ALLOWED_LICENSES, name).toContain(e.license);
      expect(
        e.notes.length,
        `${name} 至少写一条「和本仓规矩冲突、用的时候要留意」（没有就写没有冲突）`,
      ).toBeGreaterThan(0);
    }
  });

  it('和 agents/skills/ 里自研的不同名（同名同步脚本会直接报错、一个都不发）', () => {
    if (!vendor.ok) throw new Error(vendor.why);
    const own = readdirSync(join(ROOT, 'agents', 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const name of vendor.skills.keys()) expect(own, name).not.toContain(name);
  });

  it('第三方 skill 的描述在开放标准的 1024 字以内（自研的另有 120 字上限，不适用这里）', () => {
    if (!vendor.ok) throw new Error(vendor.why);
    for (const [name, tree] of vendor.skills) {
      const md = tree.get('SKILL.md')?.toString('utf8') ?? '';
      const desc = /^description:\s*(.+)$/m.exec(md)?.[1] ?? '';
      expect(desc.length, `${name} 的描述`).toBeGreaterThan(0);
      expect(desc.length, `${name} 的描述`).toBeLessThanOrEqual(1024);
    }
  });

  it('README 里收下的每个 skill、审过没收的每个都列着（少列一个，看的人就不知道它审过没有）', () => {
    if (!vendor.ok || vendor.lock === null) throw new Error('锁文件没核过');
    const readme = read('agents/skills-vendor/README.md');
    for (const name of Object.keys(vendor.lock.skills))
      expect(readme, `收下的 ${name}`).toContain(`\`${name}\``);
    for (const name of Object.keys(vendor.lock.rejected))
      expect(readme, `没收的 ${name}`).toContain(`\`${name}\``);
  });

  it('审过没收的 skill 目录不在（没收就是没收）', () => {
    if (!vendor.ok || vendor.lock === null) throw new Error('锁文件没核过');
    for (const name of Object.keys(vendor.lock.rejected))
      expect(existsSync(join(VENDOR, name)), name).toBe(false);
  });

  it('顶层只有锁文件、README 和 skill 目录（别的东西进不来）', () => {
    const names = readdirSync(VENDOR, { withFileTypes: true })
      .filter((e) => !e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(names).toEqual(['README.md', LOCK_NAME].sort());
  });
});

describe('连着的几处不能断', () => {
  it('先审后合：agents/skills-vendor/ 和核对它的 vendor.ts 都登记在 high-risk-paths.json（改一个字都要第二意见）', () => {
    const list = JSON.parse(read('packages/conventions/high-risk-paths.json')) as {
      paths: { path: string; kind: string }[];
    };
    for (const path of ['agents/skills-vendor/', 'packages/agents-sync/src/vendor.ts']) {
      expect(list.paths.find((p) => p.path === path)?.kind, path).toBe('碰安全');
    }
  });

  it('格式检查不碰第三方目录（上游的 .ts 不合本仓格式，改了它就破坏「原样」），类型检查本来就只管 test', () => {
    const biome = JSON.parse(read('biome.json')) as { files?: { includes?: string[] } };
    expect(biome.files?.includes).toContain('!agents/skills-vendor');
    const tsconfig = JSON.parse(read('agents/tsconfig.json')) as { include?: string[] };
    expect(tsconfig.include).toEqual(['test']);
  });

  it('同步脚本认这个目录：sync.ts 读它、读不过整体没查成', () => {
    const sync = read('packages/agents-sync/src/sync.ts');
    expect(sync).toContain('readVendor(repo)');
    expect(sync).toContain('第三方 skill（agents/skills-vendor/）：');
  });

  it('自研 skill 的说明写了「公开的不放这里」、指向这个目录', () => {
    expect(read('agents/skills/README.md')).toContain('agents/skills-vendor/');
  });
});
