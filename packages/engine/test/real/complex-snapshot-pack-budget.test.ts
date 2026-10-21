// 复杂快照 PACK / BUNDLE 预算解析的有界顺序读取（#3507）。
// 脚本 complex-snapshot.mjs 一加载就跑，导入不了；这里把预算解析那一段源码（顺序预读缓冲、validatePackedBudget、
// bundlePackOffset，以及它们用的 sameFile、safeOpenFile）原文切出来，在合成 PACK 上跑真实函数，只换：
// 读文件的计数包装、失败注入、以及（Windows 上）文件打开函数——生产的 Linux 逐级 dirfd 打开器不能在 Windows 跑，
// Linux 上这些用例改用原文切出的真打开器。断言只数读取字节和调用次数，不看毫秒。
import { createHash, randomBytes } from 'node:crypto';
import {
  constants,
  fstatSync,
  mkdtempSync,
  closeSync as nodeCloseSync,
  openSync as nodeOpenSync,
  readSync as nodeReadSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDeflate, createInflate, deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChildBytes } from '../child.ts';

const SOURCE = readFileSync(new URL('../../src/real/complex-snapshot.mjs', import.meta.url), 'utf8');
const WINDOW = 64 * 1024;
const MAX_OBJECTS = 250000;
const MAX_OBJECT_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
const MAX_METADATA = 32 * 1024 * 1024;
const IS_LINUX = process.platform === 'linux';

function functionSource(name: string): string {
  const start = SOURCE.indexOf(`function ${name}(`);
  const end = SOURCE.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`脚本里找不到函数 ${name}`);
  return SOURCE.slice(start, end + 3);
}

function regionSource(): string {
  const start = SOURCE.indexOf('// 在交给Git之前逐对象验证解压预算');
  const end = SOURCE.indexOf('// 恢复仓里按清单顺序核对象类型');
  if (start < 0 || end <= start) throw new Error('脚本里找不到预算解析段');
  return SOURCE.slice(start, end);
}

const LOADED_SOURCE = [
  functionSource('sameFile'),
  functionSource('safeOpenFile'),
  regionSource(),
  functionSource('bundlePackOffset'),
  'if (deps.open) safeOpenFile = deps.open;',
  'return { validatePackedBudget, bundlePackOffset };',
].join('\n');

interface Probe {
  reads: number;
  bytes: number;
  opened: number;
  closed: number;
  chunkSizes: number[];
  inFlight: number;
  mutatedWhileWriting: number;
}

interface Component {
  path: string;
  length: number;
}

interface Options {
  /** Linux 才用：换回脚本原文里的 safeOpenFile。 */
  realOpener?: boolean;
  /** 第 n 次读之前（n 从 1 起）执行；可抛错或改文件。 */
  beforeRead?: (call: number) => void;
}

function load(options: Options = {}) {
  const probe: Probe = {
    reads: 0,
    bytes: 0,
    opened: 0,
    closed: 0,
    chunkSizes: [],
    inFlight: 0,
    mutatedWhileWriting: 0,
  };
  const deps = {
    Buffer,
    resolve,
    constants,
    fstatSync,
    MAX_OBJECTS,
    MAX_OBJECT_BYTES,
    MAX_TOTAL,
    MAX_METADATA,
    fail(message: string): never {
      throw new Error(message);
    },
    openSync(path: string, flags: number) {
      probe.opened += 1;
      return nodeOpenSync(path, flags);
    },
    closeSync(fd: number) {
      probe.closed += 1;
      nodeCloseSync(fd);
    },
    readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
      probe.reads += 1;
      // 缓冲还交在 zlib 手里（异步 write 没结束）时不许再往里读：那会改写 zlib 正在消费的内存。
      if (probe.inFlight > 0) throw new Error('异步 write 未结束就读进共用缓冲');
      options.beforeRead?.(probe.reads);
      const got = nodeReadSync(fd, buffer, offset, length, position);
      probe.bytes += got;
      return got;
    },
    createInflate(settings: { chunkSize: number }) {
      probe.chunkSizes.push(settings.chunkSize);
      const inflater = createInflate(settings);
      const write = inflater.write.bind(inflater) as (
        chunk: Buffer,
        cb: (error?: Error | null) => void,
      ) => boolean;
      (inflater as unknown as { write: typeof write }).write = (chunk, cb) => {
        const copy = Buffer.from(chunk);
        probe.inFlight += 1;
        return write(chunk, (error) => {
          probe.inFlight -= 1;
          if (Buffer.compare(copy, chunk) !== 0) probe.mutatedWhileWriting += 1;
          cb(error);
        });
      };
      return inflater;
    },
    // Windows 上没有 /proc/self/fd：只在合成夹具里换成普通只读打开。
    open: options.realOpener
      ? undefined
      : (path: string) => {
          probe.opened += 1;
          return nodeOpenSync(path, 'r');
        },
  };
  const loaded = new Function('deps', `const { ${Object.keys(deps).join(', ')} } = deps;\n${LOADED_SOURCE}`)(
    deps,
  ) as {
    validatePackedBudget: (
      component: Component,
      expectedCount: number,
      initialOffset?: number,
      exact?: boolean,
    ) => Promise<void>;
    bundlePackOffset: (component: Component) => number;
  };
  return { probe, ...loaded };
}

// ---- 合成 PACK 零件 ----

function objectHeader(type: number, size: number): Buffer {
  const out: number[] = [];
  let first = (type << 4) | (size % 16);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(first | 128);
    first = rest % 128;
    rest = Math.floor(rest / 128);
  }
  out.push(first);
  return Buffer.from(out);
}

function varint(value: number): Buffer {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 128;
    out.push(byte);
  } while (rest > 0);
  return Buffer.from(out);
}

/** delta 载荷：源长、目标长，后面跟一条无意义的拷贝指令；校验只看前两个数。 */
function deltaPayload(target: number): Buffer {
  return Buffer.concat([varint(10), varint(target), Buffer.from([0x90, 0x01])]);
}

function blob(data: Buffer | string, level?: number): Buffer {
  const payload = Buffer.from(data);
  return Buffer.concat([
    objectHeader(3, payload.length),
    deflateSync(payload, level === undefined ? {} : { level }),
  ]);
}

function ofsDelta(target: number, offsetBytes: Buffer = Buffer.from([0x05])): Buffer {
  const payload = deltaPayload(target);
  return Buffer.concat([objectHeader(6, payload.length), offsetBytes, deflateSync(payload)]);
}

function refDelta(target: number): Buffer {
  const payload = deltaPayload(target);
  return Buffer.concat([objectHeader(7, payload.length), randomBytes(20), deflateSync(payload)]);
}

function pack(
  objects: Buffer[],
  settings: { version?: number; count?: number; trailer?: boolean } = {},
): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK');
  header.writeUInt32BE(settings.version ?? 2, 4);
  header.writeUInt32BE(settings.count ?? objects.length, 8);
  const body = Buffer.concat([header, ...objects]);
  return settings.trailer === false ? body : Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function smallBlobs(count: number): Buffer[] {
  return Array.from({ length: count }, (_, i) => blob(`synthetic-small-blob-${i}`));
}

let dir: string;
let counter = 0;

function put(bytes: Buffer): Component {
  counter += 1;
  const path = join(dir, `file-${counter}.bin`);
  writeFileSync(path, bytes);
  return { path, length: bytes.length };
}

async function validate(
  bytes: Buffer,
  expected: number,
  settings: { offset?: number; exact?: boolean; probeOptions?: Options; length?: number } = {},
) {
  const file = put(bytes);
  const env = load(settings.probeOptions);
  const run = env.validatePackedBudget(
    { path: file.path, length: settings.length ?? file.length },
    expected,
    settings.offset ?? 0,
    settings.exact ?? true,
  );
  return { env, run, file };
}

async function accepted(bytes: Buffer, expected: number, settings: Parameters<typeof validate>[2] = {}) {
  const { env, run, file } = await validate(bytes, expected, settings);
  await run;
  expect(env.probe.opened).toBe(env.probe.closed);
  expect(env.probe.mutatedWhileWriting).toBe(0);
  return { probe: env.probe, file };
}

async function rejected(
  bytes: Buffer,
  expected: number,
  message: RegExp | string,
  settings: Parameters<typeof validate>[2] = {},
) {
  const { env, run } = await validate(bytes, expected, settings);
  await expect(run).rejects.toThrow(message);
  expect(env.probe.opened).toBe(env.probe.closed);
  return env.probe;
}

function ceilWindows(bytes: number): number {
  return Math.ceil(bytes / WINDOW);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-pack-budget-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('复杂快照 PACK 预算解析：读取量随包长而不随对象数放大', { timeout: 60_000 }, () => {
  it('多个小对象：读到的字节不超过包字节加一个窗口，调用数随窗口数而不随对象数', async () => {
    for (const count of [1, 500, 5000, 20000]) {
      const bytes = pack(smallBlobs(count));
      const { probe } = await accepted(bytes, count);
      expect(probe.bytes).toBeLessThanOrEqual(bytes.length + WINDOW);
      expect(probe.reads).toBeLessThanOrEqual(ceilWindows(bytes.length) + 1);
    }
  });

  it('小对象的 inflate 输出块按对象大小取，不是每个对象都分配 64KiB', async () => {
    const { probe } = await accepted(pack(smallBlobs(300)), 300);
    expect(probe.chunkSizes).toHaveLength(300);
    expect(Math.max(...probe.chunkSizes)).toBeLessThan(WINDOW);
  });

  it('大对象跨多个窗口：不压缩的 300KiB 对象之后跟着小对象', async () => {
    const big = blob(randomBytes(300 * 1024), 0);
    const bytes = pack([blob('before'), big, ...smallBlobs(50), big, blob('after')]);
    const { probe } = await accepted(bytes, 54, { exact: false });
    expect(probe.bytes).toBeLessThanOrEqual(bytes.length + WINDOW);
    expect(probe.reads).toBeLessThanOrEqual(ceilWindows(bytes.length) + 1);
  });

  it('压缩后很小、解压出很多输出的对象（5MiB 零）可以接受', async () => {
    const zeros = Buffer.alloc(5 * 1024 * 1024);
    const bytes = pack([blob(zeros), blob('tail')]);
    const { probe } = await accepted(bytes, 2);
    expect(probe.bytes).toBeLessThanOrEqual(bytes.length + WINDOW);
  });

  it('对象头、delta 偏移、REF 基底、压缩流在窗口边界上的每一种对齐都能校验', async () => {
    // 第一个对象不压缩，长度调到让它在窗口末尾前 shift 字节结束，后面紧跟各种需要跨界读取的对象。
    const tail = [
      blob('x'.repeat(200)),
      ofsDelta(300, Buffer.from([0x81, 0x80, 0x05])),
      refDelta(400),
      blob(randomBytes(1500), 0),
      ofsDelta(20),
      blob('end'),
    ];
    for (let shift = -3; shift <= 60; shift += 1) {
      const probeSize = (n: number) => pack([blob(Buffer.alloc(n, 7), 0)], { trailer: false }).length;
      const base = 60000;
      const length = base + (WINDOW - shift - probeSize(base));
      const first = blob(Buffer.alloc(length, 7), 0);
      expect(12 + first.length).toBe(WINDOW - shift);
      const bytes = pack([first, ...tail]);
      const { probe } = await accepted(bytes, 1 + tail.length);
      expect(probe.bytes).toBeLessThanOrEqual(bytes.length + WINDOW);
    }
  });

  it('PACK 不在文件开头（BUNDLE 头在前）：各种起始 offset，尾界仍精确', async () => {
    const inner = pack(smallBlobs(4000));
    for (const offset of [0, 1, 137, 4093, WINDOW - 1, WINDOW, WINDOW + 5, 200_000]) {
      const bytes = Buffer.concat([randomBytes(offset), inner]);
      const { probe } = await accepted(bytes, 4000, { offset, exact: true });
      expect(probe.bytes).toBeLessThanOrEqual(inner.length + WINDOW);
      expect(probe.reads).toBeLessThanOrEqual(ceilWindows(inner.length) + 1);
      await rejected(Buffer.concat([bytes, Buffer.from([0])]), 4000, '对象包尾部或身份不符', { offset });
    }
  });

  it('BUNDLE 允许对象数少于清单，不允许多；PACK 必须精确', async () => {
    const bytes = pack(smallBlobs(10));
    await accepted(bytes, 12, { exact: false });
    await rejected(bytes, 9, '对象包数量不符或越界', { exact: false });
    await rejected(bytes, 12, '对象包数量不符或越界', { exact: true });
  });

  it('bundlePackOffset 找到头部空行后的 PACK，整体校验通过', async () => {
    const headerText = Buffer.from(
      '# v2 git bundle\n1234567890123456789012345678901234567890 refs/heads/main\n\n',
    );
    const inner = pack(smallBlobs(2500));
    const file = put(Buffer.concat([headerText, inner]));
    const env = load();
    const offset = env.bundlePackOffset(file);
    expect(offset).toBe(headerText.length);
    await env.validatePackedBudget(file, 2500, offset, false);
    expect(env.probe.bytes).toBeLessThanOrEqual(file.length + WINDOW);
    expect(env.probe.opened).toBe(env.probe.closed);
  });
});

describe('复杂快照 PACK 预算解析：原有拒绝一条不少', { timeout: 60_000 }, () => {
  const good = () => pack([blob('one'), blob('two'), ofsDelta(20)]);

  it('非法包头、版本、数量', async () => {
    const bytes = good();
    await rejected(Buffer.concat([Buffer.from('PACX'), bytes.subarray(4)]), 3, '对象包头非法');
    const v4 = Buffer.from(bytes);
    v4.writeUInt32BE(4, 4);
    await rejected(v4, 3, '对象包头非法');
    await rejected(bytes.subarray(0, 11), 3, '对象包头非法');
    await rejected(Buffer.alloc(0), 0, '对象包头非法');
    await rejected(bytes, 4, '对象包数量不符或越界');
    const huge = Buffer.from(bytes);
    huge.writeUInt32BE(MAX_OBJECTS + 1, 8);
    await rejected(huge, MAX_OBJECTS + 1, '对象包数量不符或越界');
    await rejected(huge, MAX_OBJECTS + 1, '对象包数量不符或越界', { exact: false });
  });

  it('非法对象类型', async () => {
    for (const type of [0, 5]) {
      const bad = Buffer.concat([objectHeader(type, 3), deflateSync(Buffer.from('abc'))]);
      await rejected(pack([bad]), 1, '对象包类型非法');
    }
  });

  it('对象长度头超过 10 字节、声明超过 256MiB', async () => {
    const long = Buffer.concat([Buffer.alloc(10, 0x83), Buffer.from([0x01]), deflateSync(Buffer.from('a'))]);
    await rejected(pack([long]), 1, '对象长度头越界');
    await rejected(
      pack([Buffer.concat([objectHeader(3, MAX_OBJECT_BYTES + 1), deflateSync(Buffer.alloc(1))])]),
      1,
      '单对象解压超过 256MiB',
    );
  });

  it('delta 偏移 10 字节可以，11 字节拒绝', async () => {
    const ten = Buffer.concat([Buffer.alloc(9, 0x81), Buffer.from([0x01])]);
    await accepted(pack([ofsDelta(20, ten)]), 1);
    const eleven = Buffer.concat([Buffer.alloc(10, 0x81), Buffer.from([0x01])]);
    await rejected(pack([ofsDelta(20, eleven)]), 1, 'delta偏移越界');
  });

  it('截断：对象头、REF 基底、压缩流中段、缺尾部', async () => {
    const one = pack([blob('hello-hello-hello')], { trailer: false });
    await rejected(one.subarray(0, 12), 1, '对象包头截断');
    const ref = pack([refDelta(30)], { trailer: false });
    await rejected(ref.subarray(0, 12 + 1 + 10), 1, '对象包头截断');
    await rejected(one.subarray(0, one.length - 3), 1, '对象压缩流截断');
    // 压缩流刚好是文件末尾时 zlib 没有多余输入可以报“结束”，按截断拒绝；尾部不足 20 字节则是尾界不符。
    await rejected(one, 1, '对象压缩流截断');
    await rejected(pack([blob('hello-hello-hello')]).subarray(0, one.length + 19), 1, '对象包尾部或身份不符');
    const midBig = pack([blob(randomBytes(200_000), 0)], { trailer: false });
    await rejected(midBig.subarray(0, 100_000), 1, '对象压缩流截断');
  });

  // 坏流时 zlib 只发 error 事件、不调 write 回调：只等回调会一直挂到外层 240 秒期限。
  it('压缩流损坏：立即拒绝，不挂住', { timeout: 15_000 }, async () => {
    const payload = Buffer.from('compressible '.repeat(200));
    const bad = Buffer.concat([objectHeader(3, payload.length), Buffer.alloc(40, 0xff)]);
    await rejected(pack([bad]), 1, /./);
    const flipped = Buffer.from(blob(payload));
    const at = flipped.length - 8;
    flipped.writeUInt8(flipped.readUInt8(at) ^ 0x55, at);
    await rejected(pack([flipped]), 1, /./);
  });

  it('声明长度与实际 inflate 不符', async () => {
    const payload = Buffer.from('some object payload');
    const packed = deflateSync(payload);
    await rejected(
      pack([Buffer.concat([objectHeader(3, payload.length + 1), packed])]),
      1,
      '对象解压长度不符',
    );
    await rejected(
      pack([Buffer.concat([objectHeader(3, payload.length - 1), packed])]),
      1,
      '对象实际解压越界',
    );
  });

  it('delta 目标：单个超过 256MiB、合计超过 1GiB 都拒绝；刚好 256MiB 可以', async () => {
    await accepted(pack([ofsDelta(MAX_OBJECT_BYTES)]), 1);
    await rejected(pack([ofsDelta(MAX_OBJECT_BYTES + 1)]), 1, 'delta对象解压超过 256MiB');
    await rejected(
      pack([
        ofsDelta(MAX_OBJECT_BYTES),
        ofsDelta(MAX_OBJECT_BYTES),
        ofsDelta(MAX_OBJECT_BYTES),
        ofsDelta(MAX_OBJECT_BYTES),
        ofsDelta(1),
      ]),
      5,
      '对象解压总量超过 1GiB',
    );
    await rejected(
      pack([
        refDelta(MAX_OBJECT_BYTES),
        refDelta(MAX_OBJECT_BYTES),
        refDelta(MAX_OBJECT_BYTES),
        refDelta(MAX_OBJECT_BYTES),
        refDelta(1),
      ]),
      5,
      '对象解压总量超过 1GiB',
    );
  });

  it('实际 inflate 总量超过 1GiB 时中途拒绝', async () => {
    // 5 个 250MiB 全零对象，压缩后每个才 250KiB 左右。
    const zeros = (async () => {
      const chunks: Buffer[] = [];
      const deflater = createDeflate();
      deflater.on('data', (chunk: Buffer) => chunks.push(chunk));
      const done = new Promise<void>((done) => deflater.on('end', () => done()));
      const block = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < 250; i += 1) await new Promise<void>((ok) => deflater.write(block, () => ok()));
      deflater.end();
      await done;
      return Buffer.concat([objectHeader(3, 250 * 1024 * 1024), ...chunks]);
    })();
    const object = await zeros;
    await rejected(pack([object, object, object, object, object]), 5, '对象实际解压越界');
  }, 120_000);

  it('尾部多一个字节或身份变化', async () => {
    const bytes = good();
    await rejected(Buffer.concat([bytes, Buffer.from([1])]), 3, '对象包尾部或身份不符');
    await rejected(bytes, 3, '对象包尾部或身份不符', { length: bytes.length + 1 });
    await rejected(bytes, 3, '对象包尾部或身份不符', { length: bytes.length - 1 });
    const file = put(bytes);
    const env = load({
      beforeRead: (call) => {
        if (call === 1) utimesSync(file.path, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
      },
    });
    await expect(env.validatePackedBudget(file, 3)).rejects.toThrow('对象包尾部或身份不符');
    expect(env.probe.opened).toBe(env.probe.closed);
  });

  it('读文件失败原样抛出，描述符照关', async () => {
    const bytes = pack(smallBlobs(5000));
    for (const failAt of [1, 2]) {
      const file = put(bytes);
      const env = load({
        beforeRead: (call) => {
          if (call === failAt) throw new Error('EIO 注入');
        },
      });
      await expect(env.validatePackedBudget(file, 5000)).rejects.toThrow('EIO 注入');
      expect(env.probe.opened).toBe(env.probe.closed);
    }
  });
});

describe('复杂快照 PACK 预算解析：真 Git 夹具', { timeout: 120_000 }, () => {
  function git(cwd: string, args: string[], input?: Buffer | string): Buffer {
    const result = runChildBytes('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 'fleet-test@localhost',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 'fleet-test@localhost',
      },
      ...(input === undefined ? {} : { input }),
    });
    if (result.status !== 0)
      throw new Error(`git ${args[0]}：${result.stderr.toString('utf8').slice(0, 300)}`);
    return result.stdout;
  }

  it('git pack-objects 和 git bundle 产出的包（含 delta）都能校验，读取量有界', async () => {
    const repo = mkdtempSync(join(dir, 'repo-'));
    git(repo, ['init', '-q', '-b', 'main']);
    const COUNT = 3000;
    const common = 'shared line of text that every blob has the same copy of\n'.repeat(8);
    const parts: Buffer[] = [];
    for (let i = 0; i < COUNT; i += 1) {
      const data = Buffer.from(`${common}unique ${i}\n`);
      parts.push(Buffer.from(`blob\nmark :${i + 1}\ndata ${data.length}\n`), data, Buffer.from('\n'));
    }
    parts.push(Buffer.from('commit refs/heads/main\ncommitter t <t@x> 1700000000 +0000\ndata 1\nx\n'));
    for (let i = 0; i < COUNT; i += 1) parts.push(Buffer.from(`M 100644 :${i + 1} f${i}.txt\n`));
    parts.push(Buffer.from('\n'));
    git(repo, ['fast-import', '--quiet'], Buffer.concat(parts));
    const objects = git(repo, ['rev-list', '--objects', '--all'])
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(0, 40));
    const packBytes = git(repo, ['pack-objects', '--stdout'], `${objects.join('\n')}\n`);
    const packFile = put(packBytes);
    const env = load();
    await env.validatePackedBudget(packFile, objects.length);
    expect(env.probe.bytes).toBeLessThanOrEqual(packBytes.length + WINDOW);
    expect(env.probe.reads).toBeLessThanOrEqual(ceilWindows(packBytes.length) + 1);

    // 这个包里确实有 delta 对象（verify-pack 才列 chain length）。
    const indexed = mkdtempSync(join(dir, 'idx-'));
    const copy = join(indexed, 'x.pack');
    writeFileSync(copy, packBytes);
    git(indexed, ['index-pack', copy]);
    expect(git(indexed, ['verify-pack', '-v', copy]).toString('utf8')).toMatch(/chain length = \d+/);

    const bundlePath = join(dir, 'real.bundle');
    git(repo, ['bundle', 'create', bundlePath, '--all', 'HEAD']);
    const bundleBytes = readFileSync(bundlePath);
    const bundle: Component = { path: bundlePath, length: bundleBytes.length };
    const bundleEnv = load();
    const offset = bundleEnv.bundlePackOffset(bundle);
    await bundleEnv.validatePackedBudget(bundle, objects.length, offset, false);
    expect(bundleEnv.probe.bytes).toBeLessThanOrEqual(bundleBytes.length - offset + WINDOW);
    expect(bundleEnv.probe.reads).toBeLessThanOrEqual(ceilWindows(bundleBytes.length - offset) + 1);
  });
});

// Linux 才有生产的逐级 dirfd 打开器；Windows 上明确跳过，不报过。
describe.skipIf(!IS_LINUX)('复杂快照 PACK 预算解析：生产打开器（仅 Linux）', { timeout: 60_000 }, () => {
  it('多小对象走原文里的 safeOpenFile，读取同样有界；符号链接拒绝', async () => {
    const bytes = pack(smallBlobs(5000));
    const { probe } = await accepted(bytes, 5000, { probeOptions: { realOpener: true } });
    expect(probe.bytes).toBeLessThanOrEqual(bytes.length + WINDOW);
    expect(probe.reads).toBeLessThanOrEqual(ceilWindows(bytes.length) + 1);
    const file = put(bytes);
    const env = load({ realOpener: true });
    const link = join(dir, 'link.pack');
    symlinkSync(file.path, link);
    await expect(env.validatePackedBudget({ path: link, length: file.length }, 5000)).rejects.toThrow();
  });
});
