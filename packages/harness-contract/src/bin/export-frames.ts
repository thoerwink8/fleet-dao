// 导出 hostd 帧协议：frames/schema.json（JSON Schema）、frames/samples/*.json（合法样例帧）、frames/invalid/*.txt（必须被拒的）。
// `node packages/harness-contract/src/bin/export-frames.ts` 重写；`--check` 只核对仓里的文件和现生成的一致（测试也跑这个）。
// Rust 一侧（crates/hostd/tests/frames.rs）读同一个目录对拍。
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  HOSTD_FRAME_SAMPLES,
  HOSTD_INVALID_SAMPLES,
  HOSTD_PROTOCOL_VERSION,
  HostdFrame,
} from '../hostd-frames.ts';

export const FRAMES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frames');

/** 目录里应有的全部文件：相对路径 → 内容。 */
export function expectedFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const schema = { ...z.toJSONSchema(HostdFrame), title: 'HostdFrame', 'x-protocol': HOSTD_PROTOCOL_VERSION };
  files.set('schema.json', `${JSON.stringify(schema, null, 2)}\n`);
  for (const [name, frame] of Object.entries(HOSTD_FRAME_SAMPLES))
    files.set(`samples/${name}.json`, `${JSON.stringify(frame)}\n`);
  for (const [name, text] of Object.entries(HOSTD_INVALID_SAMPLES))
    files.set(`invalid/${name}.txt`, `${text}\n`);
  return files;
}

function onDisk(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else files.set(p, readFileSync(join(dir, p), 'utf8'));
    }
  };
  try {
    walk('');
  } catch {
    // 目录还没有
  }
  return files;
}

/** JSON 文件比内容不比排版（仓里的格式化工具会改排版）；其余逐字比。 */
function sameContent(path: string, a: string, b: string): boolean {
  if (!path.endsWith('.json')) return a === b;
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
}

/** 仓里的文件和现生成的差在哪；空数组 = 一致。 */
export function drift(dir = FRAMES_DIR): string[] {
  const want = expectedFiles();
  const have = onDisk(dir);
  const out: string[] = [];
  for (const [p, text] of want) {
    if (!have.has(p)) out.push(`缺 ${p}`);
    else if (!sameContent(p, have.get(p) as string, text)) out.push(`不一致 ${p}`);
  }
  for (const p of have.keys()) if (!want.has(p)) out.push(`多出 ${p}`);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const d = drift();
    if (d.length) {
      console.error(
        `frames/ 和定义对不上：\n${d.join('\n')}\n重新导出：node packages/harness-contract/src/bin/export-frames.ts`,
      );
      process.exit(1);
    }
  } else {
    rmSync(FRAMES_DIR, { recursive: true, force: true });
    for (const [p, text] of expectedFiles()) {
      mkdirSync(dirname(join(FRAMES_DIR, p)), { recursive: true });
      writeFileSync(join(FRAMES_DIR, p), text);
    }
    console.log(`写了 ${expectedFiles().size} 个文件到 ${FRAMES_DIR}`);
  }
}
