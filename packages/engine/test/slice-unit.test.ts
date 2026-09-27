// fleet-agents.slice（父节点，装到法国机器上的静态单元文件）的 MemoryHigh/MemoryMax 和这里算出来的
// SLICE_MEMORY_HIGH_MB / SLICE_MEMORY_MAX_MB 必须是同一个数：两处各记一遍容易改一边忘了改另一边（#307 断链的教训），
// 这里直接读那份文件的文本核对，不是从 limits.ts 生成它——生成需要给 systemd 单元文件加一道构建步骤，这里先用测试守住。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SESSION_MEMORY_MAX_MB, SLICE_MEMORY_HIGH_MB, SLICE_MEMORY_MAX_MB } from '../src/limits.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SLICE_PATH = `${ROOT}deploy/france/fleet-agents.slice`;

/** 单元文件里的 `Key=数字M` 一行的数值（MiB）：没有这个键、值不是纯数字加 M 都当没查到，不猜。 */
function unitMemoryMb(text: string, key: string): number | undefined {
  const line = text.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  if (!line) return undefined;
  const m = /^([1-9]\d*)M$/.exec(line.slice(key.length + 1));
  return m ? Number(m[1]) : undefined;
}

describe('fleet-agents.slice 的总量上限和 limits.ts 的推导对得上（免得两本账）', () => {
  const text = readFileSync(SLICE_PATH, 'utf8');

  it('MemoryHigh、MemoryMax 都写了，且和 SLICE_MEMORY_HIGH_MB / SLICE_MEMORY_MAX_MB 一致', () => {
    expect(unitMemoryMb(text, 'MemoryHigh')).toBe(SLICE_MEMORY_HIGH_MB);
    expect(unitMemoryMb(text, 'MemoryMax')).toBe(SLICE_MEMORY_MAX_MB);
  });

  it('【故意造出的失败】读不到这两个键就是没查到，不当成「没设上限」悄悄放过', () => {
    expect(unitMemoryMb('[Slice]\nCPUAccounting=yes\n', 'MemoryHigh')).toBeUndefined();
    expect(unitMemoryMb('MemoryMax=infinity\n', 'MemoryMax')).toBeUndefined();
  });

  it('单会话的硬上限仍明显小于父节点：父节点这道总闸真兜得住', () => {
    expect(SESSION_MEMORY_MAX_MB).toBeLessThan(SLICE_MEMORY_MAX_MB);
  });
});
