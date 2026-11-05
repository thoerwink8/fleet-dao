// 给人看的文案和契约里的名字不许带本仓私有词（决定 0125 第 9 条）。
// 注释、以及 import/export 的包路径，不是给人看的字，也不算契约里的名字，不扫。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 仓库名，和本仓对座位的叫法。比较时不计大小写。 */
export const PRIVATE_WORDS = ['fleet-dao', '帅位', '指挥官', '座位'] as const;

/** 井号加数字的单号样式，例如 #3853。命中时记成这个名字。 */
export const ISSUE_NUMBER_TERM = '#数字';

const ISSUE_NUMBER = /#\d+/;

export interface ScanResult {
  hit: boolean;
  terms: string[];
}

/** 碰到词表里的词，或井号加数字的单号，就判成命中。 */
export function scanPrivateWords(text: string): ScanResult {
  const terms: string[] = [];
  const lower = text.toLowerCase();
  for (const word of PRIVATE_WORDS) {
    if (lower.includes(word.toLowerCase())) terms.push(word);
  }
  if (ISSUE_NUMBER.test(text)) terms.push(ISSUE_NUMBER_TERM);
  return { hit: terms.length > 0, terms };
}

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** 丢掉注释。字符串里的 //、/* 照原样留下。 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? '';
    const n = src[i + 1] ?? '';
    if (c === "'" || c === '"' || c === '`') {
      out += c;
      i += 1;
      while (i < src.length) {
        const ch = src[i] ?? '';
        out += ch;
        i += 1;
        if (ch === '\\') {
          if (i < src.length) {
            out += src[i];
            i += 1;
          }
          continue;
        }
        if (ch === c) break;
      }
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 包路径里的仓库名是模块说明，不是文案，也不是契约对外的名字。 */
function stripModuleSpecifiers(src: string): string {
  return src.replace(/\bfrom\s*(['"])@fleet-dao\/[^'"]*\1/g, 'from $1$1');
}

function visibleCopy(src: string): string {
  return stripModuleSpecifiers(stripComments(src));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (!/\.tsx?$/.test(ent.name) || /\.test\.tsx?$/.test(ent.name)) continue;
    out.push(path);
  }
  return out;
}

describe('私有词', () => {
  it('故意拼进词表里的词，扫描结果是命中', () => {
    const result = scanPrivateWords('fleet-dao 帅位 指挥官 座位 #3853');
    expect(result.hit).toBe(true);
    expect(result.terms).toEqual(['fleet-dao', '帅位', '指挥官', '座位', ISSUE_NUMBER_TERM]);
  });

  it('契约源码和驾驶舱文案源码没有命中', () => {
    // 驾驶舱文案这条跨包读不进 ci-plan.ts 的 TEST_READS（那个文件在包的面上，改它本机连带测 api、engine、github、store）。
    // 缓存键在 ci-cache.ts 的 PRIVATE_WORDS_COPY_DIR 盖住同一目录，同一 PR 再推不会跳过这里。
    const dirs = [join(root, 'packages/harness-contract/src'), join(root, 'packages/harness-web/src')];
    const hits: string[] = [];
    for (const dir of dirs) {
      const files = sourceFiles(dir);
      expect(files.length, dir).toBeGreaterThan(0);
      for (const file of files) {
        const result = scanPrivateWords(visibleCopy(readFileSync(file, 'utf8')));
        if (result.hit) hits.push(`${relative(root, file)} [${result.terms.join('、')}]`);
      }
    }
    expect(hits).toEqual([]);
  });
});
