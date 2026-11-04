// hostd 帧协议（#3871）：导出的 JSON Schema 和样例帧和定义一致；样例逐条过得了解析并原样回写；非法样例都被拒。
// Rust 一侧（crates/hostd/tests/frames.rs）读同一个 frames/ 目录做同样的对拍。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { drift, FRAMES_DIR } from '../src/bin/export-frames.ts';
import {
  HOSTD_FRAME_SAMPLES,
  HOSTD_PROTOCOL_VERSION,
  HostdFrame,
  parseHostdFrame,
} from '../src/hostd-frames.ts';

describe('hostd 帧：frames/ 目录', () => {
  it('和定义一致（不一致就重新导出：node packages/harness-contract/src/bin/export-frames.ts）', () => {
    expect(drift()).toEqual([]);
  });

  it('样例帧每一条都解析得了，并且原样回写（不多不少）', () => {
    const files = readdirSync(join(FRAMES_DIR, 'samples'));
    expect(files.length).toBe(Object.keys(HOSTD_FRAME_SAMPLES).length);
    for (const f of files) {
      const text = readFileSync(join(FRAMES_DIR, 'samples', f), 'utf8').trim();
      const parsed = parseHostdFrame(text);
      expect(parsed.ok, f).toBe(true);
      if (parsed.ok) expect(JSON.parse(JSON.stringify(parsed.frame)), f).toEqual(JSON.parse(text));
    }
  });

  it('每种帧类型至少有一条样例', () => {
    const types = new Set(Object.values(HOSTD_FRAME_SAMPLES).map((f) => f.type));
    const all = HostdFrame.options.map((o) => o.shape.type.value);
    expect([...types].sort()).toEqual([...all].sort());
  });

  it('非法样例都被拒', () => {
    for (const f of readdirSync(join(FRAMES_DIR, 'invalid'))) {
      const text = readFileSync(join(FRAMES_DIR, 'invalid', f), 'utf8').trim();
      expect(parseHostdFrame(text).ok, f).toBe(false);
    }
  });

  it('JSON Schema 带协议版本，握手样例报的就是这个版本', () => {
    const schema = JSON.parse(readFileSync(join(FRAMES_DIR, 'schema.json'), 'utf8'));
    expect(schema['x-protocol']).toBe(HOSTD_PROTOCOL_VERSION);
    expect(HOSTD_FRAME_SAMPLES['hello-req']).toMatchObject({ protocol: HOSTD_PROTOCOL_VERSION });
  });
});
