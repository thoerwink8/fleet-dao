// Clash Party 的 agy 覆写（#3991）：装文件幂等且不动别的覆写、mode 设成 rule；热加载用的补丁去重；覆写文件本身的形状。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  applyPatch,
  defaultDataDir,
  GROUP_NAME,
  installFiles,
  OVERRIDE_ID,
  OVERRIDE_SRC,
  patchRuntimeConfig,
} from '../clash-party/install.mjs';

const dirs: string[] = [];
function dataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'clash-party-'));
  dirs.push(d);
  mkdirSync(join(d, 'override'));
  writeFileSync(
    join(d, 'override.yaml'),
    'items:\n  - id: ths-direct\n    name: 同花顺直连\n    type: local\n    ext: yaml\n    global: true\n    updated: 1\n',
  );
  writeFileSync(join(d, 'mihomo.yaml'), 'mode: global\nmixed-port: 7890\n');
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('installFiles', () => {
  it('拷覆写、登记 global、mode 改 rule，重跑不重复，别的覆写原样留着', () => {
    const d = dataDir();
    installFiles(d);
    installFiles(d);
    expect(existsSync(join(d, 'override', `${OVERRIDE_ID}.yaml`))).toBe(true);
    const items = parse(readFileSync(join(d, 'override.yaml'), 'utf8')).items;
    expect(items.map((i: { id: string }) => i.id)).toEqual(['ths-direct', OVERRIDE_ID]);
    expect(items[1]).toMatchObject({ type: 'local', ext: 'yaml', global: true });
    expect(items[0].updated).toBe(1);
    const m = parse(readFileSync(join(d, 'mihomo.yaml'), 'utf8'));
    expect(m).toMatchObject({ mode: 'rule', 'mixed-port': 7890 });
  });

  it('数据目录不存在就报错，不替人建', () => {
    expect(() => installFiles(join(tmpdir(), 'clash-party-not-there-3991'))).toThrow(/没找到 Clash Party/);
  });

  it('override.yaml 坏了就停，不覆盖', () => {
    const d = dataDir();
    writeFileSync(join(d, 'override.yaml'), 'items: [\n');
    expect(() => installFiles(d)).toThrow(/override.yaml 读不出/);
  });
});

describe('覆写文件', () => {
  const patch = parse(readFileSync(OVERRIDE_SRC, 'utf8'));
  it('只有一个仅美国的 url-test 组，规则全指向它，不引用订阅里的组名', () => {
    expect(patch['+proxy-groups']).toHaveLength(1);
    const g = patch['+proxy-groups'][0];
    expect(g).toMatchObject({ name: GROUP_NAME, type: 'url-test', 'include-all-proxies': true });
    const re = new RegExp(String(g.filter).replace(/^\(\?i\)/, ''), 'i');
    for (const n of ['US - 洛杉矶 - 02', 'US01', '美国 BGP', 'United States 3'])
      expect(re.test(n), n).toBe(true);
    for (const n of ['HK - 香港 - 01', 'JP - 东京 - 03', 'Austria 1', 'Russia'])
      expect(re.test(n), n).toBe(false);
    for (const r of patch['+rules']) expect(String(r).endsWith(`,${GROUP_NAME}`)).toBe(true);
    const rules: string[] = patch['+rules'];
    for (const must of ['PROCESS-NAME,agy.exe', 'DOMAIN-SUFFIX,google', 'DOMAIN-SUFFIX,googleapis.com'])
      expect(rules.some((r) => r.startsWith(must))).toBe(true);
  });

  it('套到订阅配置上：规则在最前、组在最前、mode=rule，重复套不叠', () => {
    const base = { mode: 'global', rules: ['MATCH,x'], 'proxy-groups': [{ name: 'x', type: 'select' }] };
    const once = patchRuntimeConfig(structuredClone(base), patch);
    const twice = patchRuntimeConfig(structuredClone(once), patch);
    expect(twice).toEqual(once);
    expect(once.mode).toBe('rule');
    expect(once.rules.at(-1)).toBe('MATCH,x');
    expect(once.rules[0]).toBe(patch['+rules'][0]);
    expect(once['proxy-groups'].map((g: { name: string }) => g.name)).toEqual([GROUP_NAME, 'x']);
  });
});

describe('applyPatch', () => {
  it('+ 前插、后缀 + 追加、无 + 整体替换，对象递归', () => {
    expect(
      applyPatch({ a: [2], b: [1], c: [1], d: { x: 1 } }, { '+a': [1], 'b+': [2], c: [9], d: { y: 2 } }),
    ).toEqual({
      a: [1, 2],
      b: [1, 2],
      c: [9],
      d: { x: 1, y: 2 },
    });
  });
});

describe('defaultDataDir', () => {
  it('Windows 读 APPDATA，没有就报错', () => {
    expect(defaultDataDir({ APPDATA: 'C:\\A' }, 'win32')).toMatch(/mihomo-party$/);
    expect(() => defaultDataDir({}, 'win32')).toThrow(/APPDATA/);
  });
});
