// 演示版打包后的产物扫描：出现真名、内部叫法、GitHub 地址、创始人的 GitHub 用户名、源码对照文件，就算失败。
// 名单独立写在这里，不从品牌文件（src/brand/）里读——拿被查的东西自己的说法去查它，查不出错。
// 这个文件只在打包时由 scripts/demo.ts 在 Node 里跑，不进浏览器的包。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

export interface ScanHit {
  /** 相对扫描目录的路径，分隔符统一成 /。 */
  file: string;
  term: string;
  /** 命中处前后各一小段，看得出是哪里带出来的。文件名命中时是文件名本身。 */
  context: string;
}

export interface ScanResult {
  files: number;
  hits: ScanHit[];
}

/**
 * 内置的禁用词，按子串比、不分大小写：项目的真名和旧名、创始人的 GitHub 用户名、GitHub 地址、内部叫法、
 * 规矩原话（拿一句去 GitHub 搜就能对上公开仓）。
 * 真域名不写在公开仓里：发布时从服务器配置传进来（FLEET_DEMO_FORBID，逗号或空白分隔），见 forbiddenTerms。
 */
export const BUILTIN_TERMS: readonly string[] = [
  'fleet',
  'windsurf',
  'thoerwink',
  'github.com',
  'githubusercontent.com',
  'github.io',
  'reclaude',
  'mirasim',
  'typesafe',
  'digitalplat',
  'temporal',
  '驾驶舱',
  '帅位',
  '人闸',
  '拼车',
  '独享',
  '总指挥',
  '指挥官',
  '审官',
  '出比 5.1',
  '不做 UI 类活',
  'GPT 族不碰',
  'GPT 不碰',
  '不用 Fable',
];

/** 三个字母的短名按整词比（前后不是字母、数字、_、$），免得误伤别的词。 */
export const BUILTIN_WORDS: readonly string[] = ['jev', 'dao'];

/** 按文本扫内容的扩展名；别的（字体、图片）只看文件名。 */
const TEXT = new Set([
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.json',
  '.txt',
  '.svg',
  '.xml',
  '.webmanifest',
  '.map',
  '.md',
]);

/** 内置名单加上配置里给的（FLEET_DEMO_FORBID）。 */
export function forbiddenTerms(extra: string | undefined): string[] {
  const more = (extra ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...BUILTIN_TERMS, ...more])];
}

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
}

function around(text: string, at: number, len: number): string {
  return text
    .slice(Math.max(0, at - 40), at + len + 40)
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_PER_TERM = 3;

function findAll(text: string, lower: string, term: string, word: boolean): number[] {
  const found: number[] = [];
  if (word) {
    const re = new RegExp(`(?<![A-Za-z0-9_$])${term}(?![A-Za-z0-9_$])`, 'gi');
    for (const m of text.matchAll(re)) {
      found.push(m.index);
      if (found.length >= MAX_PER_TERM) break;
    }
    return found;
  }
  let i = lower.indexOf(term);
  while (i >= 0 && found.length < MAX_PER_TERM) {
    found.push(i);
    i = lower.indexOf(term, i + term.length);
  }
  return found;
}

/** 扫一段文字（产物里的一个文件，或测试里渲染出来的一页）；file 只用来标明是哪里的字。 */
export function scanText(file: string, text: string, terms: readonly string[] = BUILTIN_TERMS): ScanHit[] {
  const hits: ScanHit[] = [];
  const lower = text.toLowerCase();
  for (const term of terms.map((t) => t.toLowerCase())) {
    for (const at of findAll(text, lower, term, false))
      hits.push({ file, term, context: around(text, at, term.length) });
  }
  for (const word of BUILTIN_WORDS) {
    for (const at of findAll(text, lower, word, true))
      hits.push({ file, term: word, context: around(text, at, word.length) });
  }
  return hits;
}

/**
 * 扫一个目录。一个文件都没扫到直接报错：「没扫到」不能冒充「扫了没事」
 * （构建输出目录写错、构建没跑，都会走到这里）。
 */
export function scanDir(dir: string, terms: readonly string[] = BUILTIN_TERMS): ScanResult {
  const files: string[] = [];
  walk(dir, files);
  if (!files.length) throw new Error(`没扫到任何文件：${dir} 是空的（构建没跑成，还是目录给错了？）`);
  const hits: ScanHit[] = [];
  const lowerTerms = terms.map((t) => t.toLowerCase());
  for (const abs of files) {
    const file = relative(dir, abs).split('\\').join('/');
    const lowerName = file.toLowerCase();
    for (const term of lowerTerms) {
      if (lowerName.includes(term)) hits.push({ file, term, context: file });
    }
    for (const word of BUILTIN_WORDS) {
      if (findAll(file, lowerName, word, true).length) hits.push({ file, term: word, context: file });
    }
    const ext = extname(abs).toLowerCase();
    if (ext === '.map') hits.push({ file, term: '源码对照文件（sourcemap）', context: file });
    if (!TEXT.has(ext)) continue;
    const text = readFileSync(abs, 'utf8');
    hits.push(...scanText(file, text, lowerTerms));
    const map = text.toLowerCase().indexOf('sourcemappingurl');
    if (map >= 0) hits.push({ file, term: 'sourceMappingURL', context: around(text, map, 16) });
  }
  return { files: files.length, hits };
}

export function formatHits(hits: readonly ScanHit[]): string {
  return hits.map((h) => `  ${h.file}：「${h.term}」 …${h.context}…`).join('\n');
}
