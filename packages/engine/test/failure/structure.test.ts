// 分流、熔断、停滞判断要是纯函数：同样的证据永远判出同样的结论，引擎把结论记进历史、重放时才对得上。
// 所以这几个文件里不许取时钟、不许随机、不许碰网络和文件；只有 ask.ts 等 Jev（要等网络），也只引本目录的东西。
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('../../src/failure/', import.meta.url));
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
    if (!source.startsWith('./')) out.push(`${file} 引了本目录外的 ${source}`);
  }
  if (file !== 'ask.ts') {
    for (const [label, re] of IMPURE) if (re.test(code)) out.push(`${file}：${label}`);
  }
  return out;
}

describe('失败分流模块是纯的', () => {
  it('除了 ask.ts，不取时钟、不随机、不碰网络和文件；所有文件只引本目录', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.flatMap((f) => problems(f, readFileSync(`${DIR}${f}`, 'utf8')))).toEqual([]);
  });

  it('故意写进去的违规都拦得住', () => {
    const planted = [
      "import { x } from '@fleet-dao/shared';",
      'const t = Date.now();',
      'const d = new Date();',
      'const r = Math.random();',
      'await fetch(url);',
      'setTimeout(f, 10);',
    ];
    expect(planted.map((code) => problems('x.ts', code).length)).toEqual(planted.map(() => 1));
    expect(problems('x.ts', "const t = new Date(ms).toISOString();\nimport { a } from './a.ts';")).toEqual(
      [],
    );
    expect(problems('ask.ts', 'setTimeout(f, 10);')).toEqual([]);
  });
});
