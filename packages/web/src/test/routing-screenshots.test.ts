// #1380 验收第 7 条：桌面、手机各一张，放仓根 _tmp/，路径给 PR 正文引用。
// 桌面：_tmp/1380-routing-desktop.png（1440×900）
// 手机：_tmp/1380-routing-mobile.png（390×844）
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 读 PNG 的宽高。不是 PNG、没有 IHDR 就返回 null，测试自己判失败。 */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('路由页截图（#1380）', () => {
  test('桌面宽度截图在 _tmp/1380-routing-desktop.png', () => {
    const size = pngSize(readFileSync(path.join(process.cwd(), '_tmp/1380-routing-desktop.png')));
    expect(size).toEqual({ width: 1440, height: 900 });
  });

  test('手机宽度截图在 _tmp/1380-routing-mobile.png', () => {
    const size = pngSize(readFileSync(path.join(process.cwd(), '_tmp/1380-routing-mobile.png')));
    expect(size).toEqual({ width: 390, height: 844 });
  });
});
