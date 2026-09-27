// pnpm test:changed 认「引擎起的会话」靠环境里的会话标记：要全跑时本机不跑（退出码 3），会话照旧全跑——交活只认它，
// 认不出会话就永远交不了活。标记由 adapters 起会话时写进环境，conventions 那边写死了同一个名字（它不依赖 adapters），
// engine 两边都依赖，在这里核对两边一致：改了一边、另一边没跟上，这条就红。
import { RUN_MARKER_KEY } from '@fleet-dao/adapters';
import { ENGINE_SESSION_MARKER, REFUSED_FULL_RUN } from '@fleet-dao/conventions';
import { describe, expect, it } from 'vitest';

describe('test:changed 认会话的标记', () => {
  it('和起会话时写进环境的是同一个名字；拒跑的退出码不和「测试没过」的 1、「没算成」的 2 混', () => {
    expect(ENGINE_SESSION_MARKER).toBe(RUN_MARKER_KEY);
    expect(REFUSED_FULL_RUN).not.toBe(1);
    expect(REFUSED_FULL_RUN).not.toBe(2);
  });
});
