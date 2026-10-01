// 派活时按内存做准入（#219）：父节点 fleet-agents.slice 的 memory.current 余量放不下一个新会话就缓一缓，
// 文件不存在（本机开发没有 cgroup）跳过，存在但读不出来、数认不出就当「没查成」——这是「父节点增长过大被挡、
// 恢复后又派得动」的故意造出失败的测试（需求.md「算不出上限要明确报错、不派」）。
import { describe, expect, it } from 'vitest';
import { SLICE_MEMORY_HIGH_MB } from '../../src/limits.ts';
import {
  admitSessionMemory,
  type MemoryAdmissionDeps,
  parseMemoryCurrent,
  SESSION_RESERVE_MB,
} from '../../src/real/memory-admission.ts';

/** 把一份内存读数（MiB）变成 memory.current 文件里该有的字节串。 */
const mbText = (mb: number) => String(mb * 1024 * 1024);
/** 不在法国机器上：readText 抛 ENOENT。 */
const enoent = (): Error => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });

function depsOf(over: Partial<MemoryAdmissionDeps>): MemoryAdmissionDeps {
  return {
    readText: async () => {
      throw enoent();
    },
    cgroupRoot: '/sys/fs/cgroup',
    slicePath: 'fleet.slice/fleet-agents.slice',
    sliceHighMb: SLICE_MEMORY_HIGH_MB,
    reservePerSessionMb: SESSION_RESERVE_MB,
    ...over,
  };
}

describe('memory.current 解析', () => {
  it('纯数字、单位字节：读出字节数', () => {
    expect(parseMemoryCurrent('1073741824\n')).toBe(1073741824);
    expect(parseMemoryCurrent('0')).toBe(0);
  });

  it('【故意造出的失败】认不出就抛，不返回 0、undefined 冒充「现在用量是零」', () => {
    expect(() => parseMemoryCurrent('')).toThrow(/认不出/);
    expect(() => parseMemoryCurrent('  \n')).toThrow(/认不出/);
    expect(() => parseMemoryCurrent('12.5')).toThrow(/认不出/);
    expect(() => parseMemoryCurrent('abc')).toThrow(/认不出/);
    expect(() => parseMemoryCurrent('-1')).toThrow(/认不出/);
  });
});

describe('按内存做准入：父节点 fleet-agents.slice 的余量', () => {
  it('高水位附近：放不下一份新会话预留就缓一缓，写明「在等内存」', async () => {
    // 父节点现在用到 high - 1M：离高水位只有 1M，远不够一份新会话预留（2048M）。
    const used = SLICE_MEMORY_HIGH_MB - 1;
    const v = await admitSessionMemory(depsOf({ readText: async () => mbText(used) }));
    expect(v.kind).toBe('wait');
    if (v.kind !== 'wait') throw new Error('unreachable');
    expect(v.detail).toContain('fleet-agents.slice');
    expect(v.detail).toContain(`${SLICE_MEMORY_HIGH_MB}M`);
    expect(v.currentMb).toBe(used);
  });

  it('高水位下面留得出一份新会话预留：让派', async () => {
    // 现在用量 = 高水位 - 2048M：刚好放得下一份预留，让派。
    const used = SLICE_MEMORY_HIGH_MB - SESSION_RESERVE_MB;
    const v = await admitSessionMemory(depsOf({ readText: async () => mbText(used) }));
    expect(v.kind).toBe('ok');
    if (v.kind !== 'ok') throw new Error('unreachable');
    expect(v.currentMb).toBe(used);
  });

  it('【父节点增长过大被挡、恢复后又派得动】同一份依赖：先顶住、回落到余量够就放行', async () => {
    let used = SLICE_MEMORY_HIGH_MB - 100; // 顶住：余量只有 100M，远不够 2048M 预留。
    const deps = depsOf({ readText: async () => mbText(used) });
    expect((await admitSessionMemory(deps)).kind).toBe('wait');
    used = SLICE_MEMORY_HIGH_MB - SESSION_RESERVE_MB - 100; // 回落：余量比一份预留还多 100M。
    expect((await admitSessionMemory(deps)).kind).toBe('ok');
  });

  it('本机开发没有 cgroup（memory.current 不存在）：跳过准入，不拦派活', async () => {
    const v = await admitSessionMemory(depsOf({}));
    expect(v.kind).toBe('skip');
  });

  it('【故意造出的失败】文件在、读不出来（EACCES）：报「没查成」，不闷头放、也不悄悄派', async () => {
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const v = await admitSessionMemory(
      depsOf({
        readText: async () => {
          throw eacces;
        },
      }),
    );
    expect(v.kind).toBe('readError');
    if (v.kind !== 'readError') throw new Error('unreachable');
    expect(v.detail).toContain('没读成');
  });

  it('【故意造出的失败】文件在、内容认不出：报「没查成」，不拿空、0 冒充没事', async () => {
    const v = await admitSessionMemory(depsOf({ readText: async () => 'garbage' }));
    expect(v.kind).toBe('readError');
    if (v.kind !== 'readError') throw new Error('unreachable');
    expect(v.detail).toContain('没读成');
  });
});
