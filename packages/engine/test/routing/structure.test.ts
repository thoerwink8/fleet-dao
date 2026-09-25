// 选路要是纯函数：同样的输入永远选出同一条，引擎把结果记进历史、重放时才对得上。
// 所以 routing/ 里不许取时钟、不许随机、不许碰网络和文件；只引本目录和 @fleet-dao/shared（硬禁令、额度类型）。
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('../../src/routing/', import.meta.url));
const files = readdirSync(DIR).filter((f) => f.endsWith('.ts'));

const IMPURE: [string, RegExp][] = [
  ['取时钟', /\bDate\.now\s*\(|new Date\(\s*\)|performance\.now/],
  ['随机数', /Math\.random|crypto\./],
  ['网络、进程、文件', /\bfetch\s*\(|\bprocess\.|\brequire\s*\(/],
  ['定时器', /\bset(?:Timeout|Interval|Immediate)\s*\(/],
];

function problems(file: string, code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*(?:import|export)[^'"]*from\s+'([^']+)'/gm)) {
    const source = m[1] ?? '';
    if (!source.startsWith('./') && source !== '@fleet-dao/shared') out.push(`${file} 引了 ${source}`);
  }
  for (const [label, re] of IMPURE) if (re.test(code)) out.push(`${file}：${label}`);
  return out;
}

describe('选路模块是纯的', () => {
  it('不取时钟、不随机、不碰网络和文件；只引本目录和 shared', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.flatMap((f) => problems(f, readFileSync(`${DIR}${f}`, 'utf8')))).toEqual([]);
  });

  it('故意写进去的违规都拦得住', () => {
    const planted = [
      "import { x } from '@fleet-dao/db';",
      "import { y } from '../failure/index.ts';",
      'const t = Date.now();',
      'const d = new Date();',
      'const r = Math.random();',
      'await fetch(url);',
      'setTimeout(f, 10);',
    ];
    expect(planted.map((code) => problems('x.ts', code).length)).toEqual(planted.map(() => 1));
    expect(
      problems(
        'x.ts',
        "import { hardBanFor } from '@fleet-dao/shared';\nconst t = new Date(ms).toISOString();",
      ),
    ).toEqual([]);
  });
});
