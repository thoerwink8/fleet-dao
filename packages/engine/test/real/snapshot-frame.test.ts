import { describe, expect, it } from 'vitest';
import { SNAPSHOT_TOTAL_BYTES, SnapshotFrameReader } from '../../src/real/snapshot-frame.ts';

function reader() {
  const items: { name: string; bytes: Buffer[] }[] = [];
  const parser = new SnapshotFrameReader({
    begin: async ({ name }) => {
      items.push({ name, bytes: [] });
    },
    write: async (chunk) => {
      items.at(-1)?.bytes.push(Buffer.from(chunk));
    },
    end: async () => {},
  });
  return { parser, items };
}

describe('v3 增量帧严格边界', () => {
  it('包含所有帧头的1GiB边界可流过，多1字节在组件开始前拒绝', async () => {
    const sink = { begin: async () => {}, write: async () => {}, end: async () => {} };
    // JSON/PACK/BUNDLE/END 共36字节，PACK长度为10位十进制。
    const payload = SNAPSHOT_TOTAL_BYTES - 36;
    const parser = new SnapshotFrameReader(sink);
    await parser.write(Buffer.from(`JSON 0\nPACK ${payload}\n`));
    const block = Buffer.alloc(64 * 1024);
    let left = payload;
    while (left) {
      const take = Math.min(left, block.length);
      await parser.write(block.subarray(0, take));
      left -= take;
    }
    await parser.write(Buffer.from('BUNDLE 0\nEND\n'));
    parser.finish();
    const over = new SnapshotFrameReader(sink);
    await expect(over.write(Buffer.from(`JSON 0\nPACK ${SNAPSHOT_TOTAL_BYTES + 1}\n`))).rejects.toThrow(
      '总预算',
    );
  });
  it('每一个字节边界都可切分，组件原样恢复', async () => {
    const { parser, items } = reader();
    const bytes = Buffer.from(`JSON 2\n{}PACK 3\nabcBUNDLE 2\nxyBLOB ${'a'.repeat(64)} 0\nEND\n`);
    for (const byte of bytes) await parser.write(Buffer.from([byte]));
    parser.finish();
    expect(items.map((item) => [item.name, Buffer.concat(item.bytes).toString()])).toEqual([
      ['JSON', '{}'],
      ['PACK', 'abc'],
      ['BUNDLE', 'xy'],
      [`BLOB ${'a'.repeat(64)}`, ''],
    ]);
  });
  it.each([
    'JSON 33554433\n',
    `JSON 0\nPACK ${SNAPSHOT_TOTAL_BYTES}\n`,
    'JSON 0\nJSON 0\n',
    'JSON 0\nPACK 0\nBUNDLE 0\nEND\nX',
    `JSON 0\nPACK 0\nBUNDLE 0\nBLOB ${'a'.repeat(64)} 0\nBLOB ${'a'.repeat(64)} 0\n`,
    'JSON 9007199254740992\n',
    'JSON 01\n',
  ])('在落组件前拒绝坏声明：%s', async (frame) => {
    const { parser } = reader();
    await expect(parser.write(Buffer.from(frame))).rejects.toThrow();
  });
  it.each(['JSON 2\n{', 'JSON 0\nPACK 0\nBUNDLE 0\n', 'JSON '])('截断不得得到完整凭据', async (frame) => {
    const { parser } = reader();
    await parser.write(Buffer.from(frame));
    expect(() => parser.finish()).toThrow('不完整');
  });
});
