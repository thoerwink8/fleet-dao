// 第三方许可证声明：演示版是公开发出去的，用到的第三方库（多是 MIT）的许可证要求随分发附上版权和许可声明，
// 而演示版的包去掉了全部注释，所以打包时另生成一份 licenses.txt 放在产物根上（页面上不放链接）。
// 汇总用 vite 自带的 build.license：它按打包图里的模块认包、读包里的许可证文件，写出一份 JSON（LICENSE_DATA）。
// 这里补它不管的两件事再写成声明：样式表里按包名引进来的库（Tailwind 这类不进打包图，vite 认不出），
// 指向代码托管网站的链接（换成占位：打包扫描照样扫这份文件）。认不出许可证的库让打包失败。
// 演示版构建完由 scripts/demo.ts 查声明在不在（assertLicenses）。这个文件只在打包时在 Node 里跑，不进浏览器的包。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Plugin } from 'vite';

/** 产物根上的声明文件。 */
export const LICENSES_FILE = 'licenses.txt';
/** vite 的 build.license 写出的中间数据：读完就从产物里拿掉，不发出去。 */
export const LICENSE_DATA = '.vite/licenses.json';

const BOM = String.fromCharCode(0xfeff);
const TITLE = '第三方开源软件许可声明';
const RULE = '─'.repeat(60);
export const LINK_REMOVED = '[链接略]';
const HOSTED_LINK_RE =
  /(?:(?:[a-z][a-z0-9+.-]*:)?\/\/)?(?:[\w.+-]+@)?(?:[a-z0-9-]+\.)*(?:github\.com|githubusercontent\.com|github\.io)\b(?:[/:][^\s)>\]"'`]*)?/gi;

/** 声明里的一项，和 vite 的 build.license 给的 JSON 一个样子：许可证写法（SPDX）、包里许可证文件的原文。 */
export interface LicenseEntry {
  name: string;
  version: string;
  identifier?: string;
  text?: string;
}

/** 样式表里按包名引进来的（`@import "tailwindcss"`、`@plugin "…"`）；相对路径和网址不算。 */
export function cssPackageImports(css: string): string[] {
  const names = new Set<string>();
  for (const m of css.matchAll(/@(?:import|plugin)\s+(?:url\(\s*)?["']([^"']+)["']/g)) {
    const spec = m[1] ?? '';
    if (/^([./~]|[a-z][a-z0-9+.-]*:)/i.test(spec)) continue;
    names.add(
      spec
        .split('/')
        .slice(0, spec.startsWith('@') ? 2 : 1)
        .join('/'),
    );
  }
  return [...names];
}

/** 照 Node 找包的办法，从一个目录往上找 node_modules/<包名>。找不到就报错：认不出的不能当没有。 */
export function findPackageDir(from: string, name: string): string {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) break;
  }
  throw new Error(`样式表里引了 ${name}，从 ${from} 往上找不到这个包`);
}

/** 照 vite 的 build.license 的读法读一个包：package.json 的 name、version、license，包里第一个许可证文件。 */
export function readEntry(dir: string): LicenseEntry {
  const file = join(dir, 'package.json');
  let pkg: { name?: unknown; version?: unknown; license?: unknown };
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`读不出 ${file}：${(e as Error).message}`);
  }
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string')
    throw new Error(`${file} 里没有 name 或 version`);
  const licenseFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
  return {
    name: pkg.name,
    version: pkg.version,
    ...(typeof pkg.license === 'string' ? { identifier: pkg.license.trim() } : {}),
    ...(licenseFile ? { text: readFileSync(join(dir, licenseFile), 'utf8').trim() } : {}),
  };
}

/** 认不出许可证（没写许可证、包里也没有许可证文件）、写明不许用（UNLICENSED）、一项都没有，都报错。 */
export function checkEntries(entries: readonly LicenseEntry[]): void {
  if (!entries.length) throw new Error('一个第三方库都没认出来：不能发一份空的许可声明');
  const unknown = entries.filter((e) => !e.identifier && !e.text?.trim());
  if (unknown.length)
    throw new Error(
      `认不出这些库的许可证（package.json 没写，包里也没有许可证文件）：${unknown.map((e) => `${e.name}@${e.version}`).join('、')}`,
    );
  const closed = entries.filter((e) => /^unlicensed$/i.test(e.identifier ?? ''));
  if (closed.length)
    throw new Error(
      `这些库写明不许别人用（UNLICENSED），不能打进包里发出去：${closed.map((e) => e.name).join('、')}`,
    );
}

function clean(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(HOSTED_LINK_RE, LINK_REMOVED).trim();
}

/**
 * 声明的全文：每一项是名称、版本、许可证写法，后面是许可证原文。开头带 UTF-8 的 BOM：香港的 nginx 发 .txt
 * 不写字符集，没有 BOM 时浏览器按本机默认的编码（中文系统上是 GBK）去猜，就成了乱码。
 */
export function renderLicenses(entries: readonly LicenseEntry[]): string {
  checkEntries(entries);
  const sorted = [...entries].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  const items = sorted.map((e) =>
    [
      RULE,
      `${e.name} ${e.version}${e.identifier ? `（${clean(e.identifier)}）` : ''}`,
      '',
      e.text?.trim() ? clean(e.text) : '（包里没有附许可证原文，以上面写的许可证为准。）',
    ].join('\n'),
  );
  const head = `${TITLE}\n\n源码可按名称和版本号从 npm 仓库（https://www.npmjs.com）取得。`;
  return `${BOM}${[head, ...items].join('\n\n')}\n`;
}

/** 构建完查产物里的声明：没有、不是这里生成的、一项都没列，都报错。返回列了几个库。 */
export function assertLicenses(clientDir: string): number {
  const file = join(clientDir, LICENSES_FILE);
  if (!existsSync(file))
    throw new Error(`产物里没有第三方许可证声明 ${LICENSES_FILE}：许可证要求随分发附上声明，没有它不能发`);
  const text = readFileSync(file, 'utf8');
  if (!text.startsWith(`${BOM}${TITLE}`))
    throw new Error(`${LICENSES_FILE} 开头不是「${TITLE}」：不是打包时生成的那份`);
  const n = text.split('\n').filter((l) => l === RULE).length;
  if (!n) throw new Error(`${LICENSES_FILE} 一个库都没列`);
  return n;
}

function toPath(id: string): string {
  return id
    .replace(/^\0/, '')
    .replace(/[?#].*$/, '')
    .split('\\')
    .join('/');
}

/**
 * 打包插件：只在打给浏览器的那一份（client）里生成。排在 vite 自带的 build.license 后面（order: 'post'）：
 * 拿它写的 LICENSE_DATA，补上样式表里按包名引进来的库，写成 LICENSES_FILE，再把 LICENSE_DATA 从产物里拿掉。
 */
export function thirdPartyLicenses(): Plugin {
  let root = process.cwd();
  return {
    name: 'third-party-licenses',
    apply: 'build',
    applyToEnvironment: (env) => env.name === 'client',
    configResolved(config) {
      root = config.root;
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const data = bundle[LICENSE_DATA];
        if (data?.type !== 'asset')
          throw new Error(
            `没拿到 vite 汇总的许可证（${LICENSE_DATA}）：vite.config.ts 的 build.license 关了？`,
          );
        const entries = JSON.parse(String(data.source)) as LicenseEntry[];
        const seen = new Set(entries.map((e) => `${e.name}@${e.version}`));
        for (const out of Object.values(bundle)) {
          if (out.type !== 'chunk') continue;
          for (const id of out.moduleIds) {
            const path = toPath(id);
            const abs = isAbsolute(path) ? path : resolve(root, path);
            if (!/\.css$/i.test(abs) || !existsSync(abs)) continue;
            for (const name of cssPackageImports(readFileSync(abs, 'utf8'))) {
              const entry = readEntry(findPackageDir(dirname(abs), name));
              if (seen.has(`${entry.name}@${entry.version}`)) continue;
              seen.add(`${entry.name}@${entry.version}`);
              entries.push(entry);
            }
          }
        }
        delete bundle[LICENSE_DATA];
        this.emitFile({ type: 'asset', fileName: LICENSES_FILE, source: renderLicenses(entries) });
      },
    },
  };
}
