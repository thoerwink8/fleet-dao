// 第三方许可证声明：vite 汇总的那份补上样式表里按包名引的库、换掉代码托管网站的链接，写成 licenses.txt；
// 缺了声明、认不出许可证、读不出 package.json、没拿到 vite 汇总的那份，都要报红；写出来的声明照样过产物扫描。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { afterEach, describe, expect, test } from 'vitest';
import {
  assertLicenses,
  checkEntries,
  cssPackageImports,
  findPackageDir,
  LICENSE_DATA,
  LICENSES_FILE,
  LINK_REMOVED,
  type LicenseEntry,
  readEntry,
  renderLicenses,
  thirdPartyLicenses,
} from './licenses';
import { scanDir } from './scan';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 在临时目录里按 { 相对路径: 内容 } 造一棵树，返回根目录。 */
function tree(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'licenses-'));
  dirs.push(d);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(d, name, '..'), { recursive: true });
    writeFileSync(join(d, name), body);
  }
  return d;
}

const pkg = (o: Record<string, unknown>) => JSON.stringify({ version: '1.0.0', ...o });
const MIT =
  'MIT License\n\nCopyright (c) 2020 Example Author (https://github.com/example/a)\n\nPermission is hereby granted…';

describe('补上样式表里按包名引的库', () => {
  test('@import、@import url()、@plugin 算；相对路径和网址不算', () => {
    const css = [
      '@import "tailwindcss";',
      "@import 'tw-animate-css' layer(base);",
      '@import url("@xyflow/react/dist/style.css");',
      '@import "./local.css";',
      '@import url(https://fonts.example/x.css);',
      '@plugin "@tailwindcss/typography";',
    ].join('\n');
    expect(cssPackageImports(css)).toEqual([
      'tailwindcss',
      'tw-animate-css',
      '@xyflow/react',
      '@tailwindcss/typography',
    ]);
  });

  test('照 Node 的办法往上找包；找不到就报错，不当没有', () => {
    const d = tree({
      'node_modules/tailwindcss/package.json': pkg({ name: 'tailwindcss' }),
      'src/app.css': '',
    });
    expect(findPackageDir(join(d, 'src'), 'tailwindcss')).toBe(join(d, 'node_modules', 'tailwindcss'));
    expect(() => findPackageDir(join(d, 'src'), 'no-such-pkg')).toThrow(/找不到这个包/);
  });

  test('照 vite 的读法读包：name、version、license，包里的许可证文件', () => {
    const d = tree({ 'package.json': pkg({ name: 'tailwindcss', license: 'MIT' }), LICENSE: `${MIT}\n\n` });
    expect(readEntry(d)).toEqual({ name: 'tailwindcss', version: '1.0.0', identifier: 'MIT', text: MIT });
    const bare = tree({ 'package.json': pkg({ name: 'c', license: 'ISC' }), 'README.md': '不是许可证' });
    expect(readEntry(bare)).toEqual({ name: 'c', version: '1.0.0', identifier: 'ISC' });
  });

  test('读不出 package.json（没有、不是 JSON、缺名字）：报错', () => {
    expect(() => readEntry(tree({ LICENSE: 'MIT' }))).toThrow(/读不出/);
    expect(() => readEntry(tree({ 'package.json': '{not json', LICENSE: 'MIT' }))).toThrow(/读不出/);
    expect(() => readEntry(tree({ 'package.json': '{"license":"MIT"}' }))).toThrow(/没有 name 或 version/);
  });
});

describe('写成声明', () => {
  const a: LicenseEntry = { name: 'a', version: '1.0.0', identifier: 'MIT', text: MIT };
  const b: LicenseEntry = {
    name: '@s/b',
    version: '2.0.0',
    identifier: 'ISC',
    text: 'ISC License\r\n\r\nCopyright (c) Example',
  };

  test('认不出许可证、写明不许用、一项都没有：报错', () => {
    expect(() => checkEntries([a, { name: 'x', version: '1.0.0' }])).toThrow(
      /认不出这些库的许可证.*x@1\.0\.0/,
    );
    expect(() =>
      checkEntries([{ name: 'y', version: '1.0.0', identifier: 'UNLICENSED', text: '版权所有' }]),
    ).toThrow(/UNLICENSED/);
    expect(() => checkEntries([])).toThrow(/一个第三方库都没认出来/);
    expect(() => renderLicenses([{ name: 'x', version: '1.0.0' }])).toThrow(/认不出/);
  });

  test('按名字排，只有名字、版本、许可证和原文；开头带 BOM；代码托管网站的链接换成占位', () => {
    const text = renderLicenses([a, b, { name: 'c', version: '1.0.0', identifier: 'MIT' }]);
    expect(text.startsWith('\uFEFF第三方开源软件许可声明\n')).toBe(true);
    expect(text.indexOf('@s/b 2.0.0（ISC）')).toBeLessThan(text.indexOf('\na 1.0.0（MIT）'));
    expect(text).toContain(`Copyright (c) 2020 Example Author (${LINK_REMOVED})`);
    expect(text).toContain('c 1.0.0（MIT）\n\n（包里没有附许可证原文');
    expect(text).not.toMatch(/github|\r/i);
  });

  test('先红后绿：原样抄进来的许可证带着 GitHub 地址，产物扫描拦下；写成的声明扫不出东西', () => {
    const raw = tree({ 'index.html': '<!doctype html>', [LICENSES_FILE]: MIT });
    expect(scanDir(raw).hits.map((h) => `${h.file}:${h.term}`)).toEqual([`${LICENSES_FILE}:github.com`]);
    const out = tree({ 'index.html': '<!doctype html>', [LICENSES_FILE]: renderLicenses([a, b]) });
    expect(scanDir(out).hits).toEqual([]);
  });

  test('先红后绿：产物里缺了声明、是空的、一项都没列，都报错；有了就数出列了几个库', () => {
    const d = tree({ 'index.html': '<!doctype html>' });
    expect(() => assertLicenses(d)).toThrow(/没有第三方许可证声明/);
    writeFileSync(join(d, LICENSES_FILE), '');
    expect(() => assertLicenses(d)).toThrow(/开头不是/);
    writeFileSync(join(d, LICENSES_FILE), '\uFEFF第三方开源软件许可声明\n\n');
    expect(() => assertLicenses(d)).toThrow(/一个库都没列/);
    writeFileSync(join(d, LICENSES_FILE), renderLicenses([a, b]));
    expect(assertLicenses(d)).toBe(2);
  });
});

describe('打包插件', () => {
  type Hook = (this: unknown, ...args: unknown[]) => unknown;
  const run = (p: Plugin, ctx: unknown, bundle: Record<string, unknown>) =>
    (p.generateBundle as unknown as { handler: Hook }).handler.call(ctx, {}, bundle);

  test('排在 vite 的 build.license 后面、只在打给浏览器的那一份里跑', () => {
    const p = thirdPartyLicenses();
    expect((p.generateBundle as { order?: string }).order).toBe('post');
    const apply = p.applyToEnvironment as (env: { name: string }) => boolean;
    expect(apply({ name: 'client' })).toBe(true);
    expect(apply({ name: 'ssr' })).toBe(false);
  });

  test('拿 vite 汇总的那份，补上样式表里引的库，写成声明，中间数据不发出去', () => {
    const root = tree({
      'node_modules/css-only/package.json': pkg({ name: 'css-only', license: 'MIT' }),
      'node_modules/css-only/LICENSE': 'MIT License\n\nCopyright (c) Example',
      'node_modules/js-lib/package.json': pkg({ name: 'js-lib', license: 'MIT' }),
      'src/app.css': '@import "css-only";\n@import "js-lib";\n@import "./local.css";',
    });
    const p = thirdPartyLicenses();
    (p.configResolved as unknown as Hook).call(undefined, { root });
    const fromVite: LicenseEntry[] = [{ name: 'js-lib', version: '1.0.0', identifier: 'MIT', text: 'MIT' }];
    const bundle: Record<string, unknown> = {
      'assets/root.js': {
        type: 'chunk',
        moduleIds: [
          join(root, 'src/root.tsx'),
          `${join(root, 'src/app.css')}?direct`,
          '\0vite/preload-helper.js',
        ],
      },
      [LICENSE_DATA]: { type: 'asset', source: JSON.stringify(fromVite) },
    };
    const emitted: { fileName?: string; source?: unknown }[] = [];
    run(p, { emitFile: (f: (typeof emitted)[number]) => emitted.push(f) }, bundle);
    expect(bundle[LICENSE_DATA]).toBeUndefined();
    expect(emitted.map((f) => f.fileName)).toEqual([LICENSES_FILE]);
    const text = String(emitted[0]?.source);
    expect(text.match(/^\S+ 1\.0\.0（MIT）$/gm)).toEqual(['css-only 1.0.0（MIT）', 'js-lib 1.0.0（MIT）']);
  });

  test('没拿到 vite 汇总的那份（build.license 关了）：报错，不发一份缺库的声明', () => {
    const p = thirdPartyLicenses();
    expect(() => run(p, { emitFile() {} }, { 'assets/root.js': { type: 'chunk', moduleIds: [] } })).toThrow(
      /build\.license/,
    );
  });
});
