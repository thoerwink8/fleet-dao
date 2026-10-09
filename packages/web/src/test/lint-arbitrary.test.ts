// 任意尺寸 lint（#182 / #1446）：写死 text-[13px] 这种类名不再让进。
// 扫描脚本在 packages/web/scripts/lint-arbitrary.ts。
// 本测试盯两块：
//   1) 扫描器本身：造几段假的代码看它是否认得出 / 认得对。
//   2) 整个 packages/web/src：0 处写死尺寸。白名单里的每一项都要写理由。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ALLOWLIST, scan, scanFile } from '../../scripts/lint-arbitrary.ts';

describe('lint-arbitrary: 扫描器本身', () => {
  test('扫出写死的 text-[13px]', () => {
    const hits = scanFileVirtual(`<div className="text-[13px]">hi</div>`);
    expect(hits.map((h) => h.match)).toEqual(['text-[13px]']);
  });

  test('扫出写死的 max-w-[380px]', () => {
    const hits = scanFileVirtual(`<div className="max-w-[380px]">hi</div>`);
    expect(hits.map((h) => h.match)).toEqual(['max-w-[380px]']);
  });

  test('扫出 grid 列写死 240px', () => {
    const hits = scanFileVirtual(`<div className="grid-cols-[240px_1fr]">hi</div>`);
    expect(hits.map((h) => h.match)).toEqual(['grid-cols-[240px_1fr]']);
  });

  test('2xl: 这种数字开头的断点后面的写死尺寸也要报', () => {
    const hits = scanFileVirtual(`<div className="2xl:max-w-[380px]">hi</div>`);
    expect(hits.map((h) => h.match)).toEqual(['2xl:max-w-[380px]']);
  });

  test('放行用 CSS 变量的任意值（尺寸源头是 token）', () => {
    const hits = scanFileVirtual(`<div className="shadow-[0_1px_0_var(--border)]">hi</div>`);
    expect(hits).toEqual([]);
  });

  test('放行 data-[spacing=0]（数据属性选择器，不是尺寸）', () => {
    const hits = scanFileVirtual(`<div className="data-[spacing=0]:rounded-none text-sm">hi</div>`);
    expect(hits).toEqual([]);
  });

  test('对一行里的多个写死值都扫出来', () => {
    const hits = scanFileVirtual(`<div className="text-[11px] leading-4 max-w-[380px]">hi</div>`);
    expect(hits.map((h) => h.match)).toEqual(['text-[11px]', 'max-w-[380px]']);
  });

  test('标准 Tailwind 档位不动（text-sm、h-8 这些不是任意值）', () => {
    const hits = scanFileVirtual(`<div className="text-sm h-8 px-3">hi</div>`);
    expect(hits).toEqual([]);
  });

  test('白名单每一项都写了理由', () => {
    expect(ALLOWLIST.length).toBeGreaterThan(0);
    for (const rule of ALLOWLIST) {
      expect(rule.reason.trim().length).toBeGreaterThan(0);
      expect(rule.pattern).toBeInstanceOf(RegExp);
    }
  });
});

describe('lint-arbitrary: 整个 src 0 处写死尺寸', () => {
  test('packages/web/src', () => {
    expect(scan()).toEqual([]);
  });
});

// 造一个临时文件喂给 scanFile，不碰仓里的真文件。
function scanFileVirtual(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'lint-arb-'));
  const path = join(dir, 'sample.tsx');
  writeFileSync(path, source);
  try {
    return scanFile(path, 'sample.tsx');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 放在最后：故意写一个任意尺寸值，扫描器必须报出来。
test('故意写入 text-[13px]，扫描器要报出来', () => {
  const hits = scanFileVirtual(`<div className="data-[spacing=0]:rounded-none text-[13px]">hi</div>`);
  expect(hits.map((h) => h.match)).toEqual(['text-[13px]']);
});
