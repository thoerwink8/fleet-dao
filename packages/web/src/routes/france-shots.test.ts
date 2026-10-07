// #1217 的截图：验收要 1920×1080 和 1366×768 的改前、改后。
// PNG 在文本 diff 里没有像素。尺寸和画面写在 e2e/shots/1217/尺寸和画面.txt，这里对照原图钉住：
// 文件头前 24 字节、IHDR 里的宽高、sha256、字节数对不上就红，不拿文件名当尺寸。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const shotDir = join(dirname(fileURLToPath(import.meta.url)), '../../e2e/shots/1217');
const ledgerPath = join(shotDir, '尺寸和画面.txt');

/** 验收要的八张：改前法国、改前环境、改后一台、改后两台，各两个视口。 */
const REQUIRED: Record<string, { width: number; height: number; when: '改前' | '改后' }> = {
  'before-france-1920x1080.png': { width: 1920, height: 1080, when: '改前' },
  'before-france-1366x768.png': { width: 1366, height: 768, when: '改前' },
  'before-env-1920x1080.png': { width: 1920, height: 1080, when: '改前' },
  'before-env-1366x768.png': { width: 1366, height: 768, when: '改前' },
  'after-france-one-1920x1080.png': { width: 1920, height: 1080, when: '改后' },
  'after-france-one-1366x768.png': { width: 1366, height: 768, when: '改后' },
  'after-france-two-1920x1080.png': { width: 1920, height: 1080, when: '改后' },
  'after-france-two-1366x768.png': { width: 1366, height: 768, when: '改后' },
};

/** 画面说明里必须出现的字：改前两页还分开，改后侧栏只剩法国；一台是卡片，两台是并排。 */
const SCENE: Record<string, readonly string[]> = {
  'before-france-1920x1080.png': [
    '改前的法国页',
    '侧栏同时有「法国」和「环境」',
    '没有引擎总开关',
    '一行六格',
  ],
  'before-france-1366x768.png': [
    '改前的法国页',
    '侧栏同时有「法国」和「环境」',
    '没有引擎总开关',
    '两行三格',
  ],
  'before-env-1920x1080.png': [
    '改前的环境页',
    '标题「环境」',
    '侧栏「环境」亮着',
    '引擎总开关',
    '没有发版卡',
  ],
  'before-env-1366x768.png': ['改前的环境页', '标题「环境」', '侧栏「环境」亮着', '引擎总开关', '没有发版卡'],
  'after-france-one-1920x1080.png': [
    '改后只剩一台',
    '侧栏只有「法国」',
    '没有「环境」',
    '引擎总开关',
    '不画对照列',
    '一行六格',
    '发版一键',
  ],
  'after-france-one-1366x768.png': [
    '改后只剩一台',
    '侧栏只有「法国」',
    '没有「环境」',
    '引擎总开关',
    '两行三格',
    '不是对照列',
  ],
  'after-france-two-1920x1080.png': [
    '改后两台并排',
    '侧栏只有「法国」',
    '没有「环境」',
    '两列并排',
    '本机 WSL',
  ],
  'after-france-two-1366x768.png': [
    '改后两台并排',
    '侧栏只有「法国」',
    '没有「环境」',
    '两列并排',
    '本机 WSL',
  ],
};

interface ShotNote {
  file: string;
  when: string;
  head: string;
  widthBytes: string;
  width: number;
  heightBytes: string;
  height: number;
  sha256: string;
  bytes: number;
  scene: string;
}

function pngSize(buf: Buffer, file: string): { width: number; height: number } {
  const sig = buf.subarray(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a') throw new Error(`${file} 不是 PNG（签名是 ${sig}）`);
  const kind = buf.subarray(12, 16).toString('ascii');
  if (kind !== 'IHDR') throw new Error(`${file} 第一块是 ${kind}，不是 IHDR，读不出宽高`);
  if (buf.length < 24) throw new Error(`${file} 比 24 字节还短，没有 IHDR`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function parseLedger(text: string): ShotNote[] {
  const chunks = text.split('\n[').slice(1);
  return chunks.map((chunk) => {
    const lines = chunk.split('\n');
    const file = lines[0]?.replace(/\]\s*$/, '') ?? '';
    const field = (key: string) => {
      const line = lines.find((l) => l.startsWith(`${key}: `));
      if (line === undefined) throw new Error(`${file} 的说明缺 ${key}`);
      return line.slice(key.length + 2);
    };
    const dim = (key: string) => {
      const raw = field(key);
      const m = /^([0-9a-f]{8}) = (\d+)$/.exec(raw);
      if (m === null) throw new Error(`${file} 的 ${key} 认不出：${raw}`);
      return { hex: m[1] as string, n: Number(m[2]) };
    };
    const width = dim('width-bytes');
    const height = dim('height-bytes');
    return {
      file,
      when: field('when'),
      head: field('png-head'),
      widthBytes: width.hex,
      width: width.n,
      heightBytes: height.hex,
      height: height.n,
      sha256: field('sha256'),
      bytes: Number(field('bytes')),
      scene: field('scene'),
    };
  });
}

describe('法国页合成的截图', () => {
  const notes = parseLedger(readFileSync(ledgerPath, 'utf8'));
  const byFile = new Map(notes.map((n) => [n.file, n]));

  test('说明文件写了怎么从文件头读宽高，八张图一张不缺、不多', () => {
    const text = readFileSync(ledgerPath, 'utf8');
    for (const line of ['1920 = 0x780', '1080 = 0x438', '1366 = 0x556', '768 = 0x300']) {
      expect(text, `说明里没有 ${line}`).toContain(line);
    }
    expect(notes.map((n) => n.file).sort()).toEqual(Object.keys(REQUIRED).sort());
    const pngs = readdirSync(shotDir).filter((name) => name.endsWith('.png'));
    expect(pngs.sort()).toEqual(Object.keys(REQUIRED).sort());
  });

  test('每张图的文件头、宽高、sha256 和说明里写的一致', () => {
    for (const [file, want] of Object.entries(REQUIRED)) {
      const note = byFile.get(file);
      expect(note, `${file} 没有写进尺寸和画面.txt`).toBeTruthy();
      if (note === undefined) continue;
      const buf = readFileSync(join(shotDir, file));
      const size = pngSize(buf, file);
      expect(size, file).toEqual({ width: want.width, height: want.height });
      expect(note.when, file).toBe(want.when);
      expect(note.width, file).toBe(want.width);
      expect(note.height, file).toBe(want.height);
      expect(note.widthBytes, file).toBe(buf.subarray(16, 20).toString('hex'));
      expect(note.heightBytes, file).toBe(buf.subarray(20, 24).toString('hex'));
      expect(Number.parseInt(note.widthBytes, 16), file).toBe(want.width);
      expect(Number.parseInt(note.heightBytes, 16), file).toBe(want.height);
      expect(note.head, file).toBe(buf.subarray(0, 24).toString('hex'));
      expect(buf.readUInt32BE(16), file).toBe(Number.parseInt(note.head.slice(32, 40), 16));
      expect(buf.readUInt32BE(20), file).toBe(Number.parseInt(note.head.slice(40, 48), 16));
      expect(note.bytes, file).toBe(buf.length);
      expect(note.sha256, file).toBe(createHash('sha256').update(buf).digest('hex'));
      for (const phrase of SCENE[file] ?? []) {
        expect(note.scene, `${file} 的画面说明没有「${phrase}」`).toContain(phrase);
      }
    }
  });

  test('八张图的 sha256 各不相同：改前、改后、两个视口不是同一张', () => {
    const hashes = notes.map((n) => n.sha256);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});
