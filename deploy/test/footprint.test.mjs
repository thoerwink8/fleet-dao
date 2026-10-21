// 按目录量磁盘占用的 root 脚本（deploy/france/footprint/fleet-footprint.mjs，#3456）：目录清单只认合规矩的、
// 一个目录量不成不拖累别的且保留上次量成的数、journal 里的「Consumed … CPU time」汇总对得上 2026-10-21 的手算、
// 输出原子写且不含文件名。用法：node --test deploy/test/footprint.test.mjs（run.sh 的 node-tests 里跑）。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  EVERY_MS,
  main,
  measureAll,
  measureTimers,
  parseCpuTime,
  parseDirs,
  parseManifest,
  parseMemory,
  parsePrevious,
  realDu,
  summarizeJournal,
  writeSizes,
} from '../france/footprint/fleet-footprint.mjs';

const at = (iso) => () => new Date(iso);

test('清单：合规矩的才收，路径不是绝对的、带 ..、结尾有 /、是 /、重复，timers 不是服务单元名：整份拒绝', () => {
  assert.deepEqual(parseDirs('{"schema":1,"dirs":["/var/lib/a","/opt/b"]}'), ['/var/lib/a', '/opt/b']);
  assert.deepEqual(parseManifest('{"schema":1,"dirs":["/a"],"timers":["x.service"]}').timers, ['x.service']);
  assert.deepEqual(parseManifest('{"schema":1,"dirs":["/a"]}').timers, []);
  for (const bad of [
    'not json',
    '{"schema":2,"dirs":["/a"]}',
    '{"schema":1,"dirs":[]}',
    '{"schema":1,"dirs":["relative"]}',
    '{"schema":1,"dirs":["/a/../etc"]}',
    '{"schema":1,"dirs":["/a/"]}',
    '{"schema":1,"dirs":["/"]}',
    '{"schema":1,"dirs":["/a","/a"]}',
    '{"schema":1,"dirs":["/a"],"timers":["--help.service"]}',
    '{"schema":1,"dirs":["/a"],"timers":["x.timer"]}',
    '{"schema":1,"dirs":["/a"],"timers":"x.service"}',
  ]) {
    assert.throws(() => parseManifest(bad), undefined, bad);
  }
});

test('一个目录量不成：不拖累别的，保留上次量成的数和测于，写原因；从没量成过 bytes 是 null', async () => {
  const previous = parsePrevious(
    JSON.stringify({
      schema: 1,
      dirs: [{ path: '/big', bytes: 5_000_000_000, measuredAt: '2026-10-21T00:00:00.000Z' }],
    }),
  );
  const du = async (p) => {
    if (p === '/big') throw new Error('超过 300 秒没量完，被停掉');
    if (p === '/new') throw new Error('没有这个目录（或这台机器上没有）');
    return { bytes: 1234, skipped: 2 };
  };
  const r = await measureAll({
    dirs: ['/big', '/ok', '/new'],
    previous,
    du,
    now: at('2026-10-21T01:00:00.000Z'),
  });
  const [big, ok, fresh] = r.dirs;
  assert.equal(big.bytes, 5_000_000_000, '测不完时给上次量成的大小');
  assert.equal(big.measuredAt, '2026-10-21T00:00:00.000Z', '带上次量成的时刻');
  assert.match(big.error, /没量完/);
  assert.equal(ok.bytes, 1234);
  assert.equal(ok.skipped, 2);
  assert.equal(ok.error, null);
  assert.equal(ok.measuredAt, '2026-10-21T01:00:00.000Z');
  assert.equal(fresh.bytes, null, '从没量成过不给数');
  assert.equal(fresh.measuredAt, null);
  assert.match(fresh.error, /没有这个目录/);
  assert.equal(r.everyMs, EVERY_MS);
});

test('上次的文件认不出：当没有，不影响这一轮', () => {
  assert.equal(parsePrevious('垃圾').size, 0);
  assert.equal(parsePrevious('{"schema":9,"dirs":[]}').size, 0);
  assert.equal(parsePrevious('{"schema":1,"dirs":[{"path":"/a","bytes":-1,"measuredAt":"x"}]}').size, 0);
});

test('du 真跑一回：占的块、512 的倍数、不比文件内容小；没有的目录给固定原因', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-du-'));
  try {
    writeFileSync(join(dir, 'a.bin'), Buffer.alloc(100_000));
    const { bytes } = await realDu(dir);
    assert.ok(bytes >= 100_000, `量到 ${bytes}`);
    assert.equal(bytes % 512, 0);
    await assert.rejects(realDu(join(dir, '没有的')), /没有这个目录/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('输出只有数字和固定的话；写是原子的（目录里不留临时文件），权限 644；写不出要抛', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-out-'));
  try {
    const dirsFile = join(dir, 'dirs.json');
    const sizesFile = join(dir, 'sizes.json');
    writeFileSync(dirsFile, '{"schema":1,"dirs":["/srv/x"],"timers":["t.service"]}');
    const logs = [];
    await main({
      dirsFile,
      sizesFile,
      du: async () => ({ bytes: 42, skipped: 0 }),
      journal: async () => 'Consumed 1.5s CPU time, 10.0M memory peak, 0B memory swap peak.\n',
      now: at('2026-10-21T02:00:00.000Z'),
      log: (l) => logs.push(l),
    });
    const got = JSON.parse(readFileSync(sizesFile, 'utf8'));
    assert.equal(got.schema, 1);
    assert.equal(got.dirs[0].path, '/srv/x');
    assert.equal(got.dirs[0].bytes, 42);
    assert.deepEqual(got.timers, [
      { unit: 't.service', runs24h: 1, cpuSeconds24h: 1.5, peakMemoryBytes: 10 * 1024 * 1024 },
    ]);
    assert.deepEqual(readdirSync(dir).sort(), ['dirs.json', 'sizes.json']);
    if (process.platform !== 'win32') assert.equal(statSync(sizesFile).mode & 0o777, 0o644);
    assert.match(logs.join(''), /量了 1 个目录/);
    await assert.rejects(writeSizes(got, join(dir, '没有的目录', 'sizes.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('读不到清单：抛（单元红），不写出一份假的 sizes.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-nodirs-'));
  try {
    mkdirSync(join(dir, 'o'));
    await assert.rejects(
      main({ dirsFile: join(dir, '没有'), sizesFile: join(dir, 'o', 'sizes.json'), log: () => {} }),
    );
    assert.deepEqual(readdirSync(join(dir, 'o')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('systemd 的 Consumed 行：各种时间和内存写法都认', () => {
  assert.equal(parseCpuTime('1min 3.2s'), 63.2);
  assert.equal(parseCpuTime('1h 2min 3s'), 3723);
  assert.ok(Math.abs(parseCpuTime('850ms') - 0.85) < 1e-9);
  assert.equal(parseCpuTime('2d'), 172800);
  assert.equal(parseCpuTime('垃圾'), undefined);
  assert.equal(parseMemory('116.0M'), Math.round(116 * 1024 * 1024));
  assert.equal(parseMemory('1.5G'), Math.round(1.5 * 1024 ** 3));
  assert.equal(parseMemory('0B'), 0);
  assert.equal(parseMemory('怪'), undefined);
});

test('journal 汇总：次数、CPU 秒相加、内存取单次最大；旧版没有内存峰值给 null；一行都没有给原因', async () => {
  const lines = [
    'Starting x.service - x...',
    'Finished x.service - x.',
    'Consumed 2.0s CPU time, 68.2M memory peak, 0B memory swap peak.',
    'Consumed 1min 1s CPU time, 116.0M memory peak, 0B memory swap peak, 1.1M read from disk.',
    'Consumed 850ms CPU time.',
    // 真机上 -o cat 的样子：带单元名前缀
    'x.service: Consumed 1.5s CPU time.',
  ].join('\n');
  const s = summarizeJournal(lines);
  assert.equal(s.runs24h, 4);
  assert.equal(s.cpuSeconds24h, 65.35);
  assert.equal(s.peakMemoryBytes, Math.round(116 * 1024 * 1024));
  assert.equal(summarizeJournal('Consumed 1s CPU time.').peakMemoryBytes, null);
  assert.equal(summarizeJournal('Starting...\n'), undefined);
  const r = await measureTimers({
    units: ['a.service', 'b.service', 'c.service'],
    journal: async (u) => {
      if (u === 'b.service') throw new Error('journalctl 超过 60 秒没读完，被停掉');
      return u === 'a.service' ? lines : '';
    },
  });
  assert.equal(r[0].runs24h, 4);
  assert.match(r[1].why, /超过 60 秒/);
  assert.match(r[2].why, /没有一回/);
});

test('2026-10-21 手算：refill 1422 次 3193 秒 ≈ 0.037 核；radar 126 次 179 秒 ≈ 0.002 核', () => {
  const run = (secs, n) =>
    Array.from({ length: n }, () => `Consumed ${secs}s CPU time, 100.0M memory peak.`).join('\n');
  const refill = summarizeJournal(run(3193 / 1422, 1422));
  assert.equal(refill.runs24h, 1422);
  assert.ok(Math.abs(refill.cpuSeconds24h / 86400 - 0.037) < 0.001);
  const radar = summarizeJournal(run(179 / 126, 126));
  assert.equal(radar.runs24h, 126);
  assert.ok(Math.abs(radar.cpuSeconds24h / 86400 - 0.002) < 0.0005);
});
