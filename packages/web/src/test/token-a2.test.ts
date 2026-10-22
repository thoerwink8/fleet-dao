// #1444 的 19 处：六个共用件里的写死尺寸换成 token 类名。
// #1446 已经落在主线上。这里把每一处「写死值 → token 类名」钉住，写回去就红。
// 后来删掉的组件（整池暂停的 pool-holds.tsx、老流程那一块的 usage.tsx 和 run-timeline.tsx）身上的处数跟着去掉，这里只留下还在的。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { scanFile } from '../../scripts/lint-design.ts';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 一处写死尺寸和换上的 token 类名。from 是原来的任意值类名，to 是现在的 token 类名。
 * channel-status.tsx 在 #3533 迁到 layout 层（探针格换 ProbeCells、故障说明换 Descriptions），原来钉的三处类名不再在业务层写，不再钉；
 * 任意尺寸仍由 R0 兜（最后一条用例）。
 */
const SITES: readonly { file: string; where: string; from: string; to: string }[] = [];

const COUNTS: Record<string, number> = {};

/** 迁到 layout 层之后仍要保持 R0 一条没有的文件。 */
const MIGRATED = ['src/components/channel-status.tsx'] as const;

// 发版卡的一处（grid-cols-release）在片 7（#1853）改用 KeyValue，不再有写死的标签列宽，这一处不再钉。
// 整池暂停面板删了之后，原来钉在 pool-holds.tsx 的那一处跟着去掉。
// 老流程那一块删了（#2357、#2710 收尾）之后，usage.tsx、run-timeline.tsx 两个组件整个没了，钉在它俩身上的 13 处跟着去掉。
describe('token A2：写死尺寸换成 token', () => {
  test('留下来的组件各对上钉住的处数', () => {
    expect(SITES).toHaveLength(0);
    for (const [file, n] of Object.entries(COUNTS)) {
      expect(SITES.filter((site) => site.file === file)).toHaveLength(n);
    }
  });

  test('组件里不再有这些任意尺寸，类名是 token', () => {
    const files = [...new Set(SITES.map((site) => site.file))];
    for (const file of files) {
      const abs = join(webRoot, file);
      const source = readFileSync(abs, 'utf8');
      expect(
        scanFile(abs, file).filter((h) => h.rule === 'R0'),
        file,
      ).toEqual([]);
      for (const site of SITES.filter((item) => item.file === file)) {
        expect(source.includes(site.from), `${file} ${site.where} 还留着 ${site.from}`).toBe(false);
        expect(source.includes(site.to), `${file} ${site.where} 没用 ${site.to}`).toBe(true);
      }
    }
  });

  test('迁到 layout 层的文件没有任意尺寸', () => {
    for (const file of MIGRATED) {
      expect(
        scanFile(join(webRoot, file), file).filter((h) => h.rule === 'R0'),
        file,
      ).toEqual([]);
    }
  });
});
