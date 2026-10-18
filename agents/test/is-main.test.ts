// 钩子入口判定（agents/hooks/is-main.mjs）：经软链接跑也认得出是入口，被 import 时不是入口。
// macOS 的临时目录 /var 是指向 /private/var 的软链接，只比字面路径时钩子一声不响什么都不做（Linux CI 上没有这层，测不出来，这里自己造软链接）。
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import { runChildOk } from './child.ts';

const HELPER = fileURLToPath(new URL('../hooks/is-main.mjs', import.meta.url));
const base = mkdtempSync(join(tmpdir(), 'is-main-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

it.skipIf(process.platform === 'win32')(
  '经软链接目录直接跑认作入口，旧 Node 的退路也认得出；被 import 的模块不是入口',
  () => {
    const real = join(base, 'real');
    mkdirSync(real);
    copyFileSync(HELPER, join(real, 'is-main.mjs'));
    writeFileSync(
      join(real, 'lib.mjs'),
      "import { isMainModule } from './is-main.mjs';\nexport const libIsMain = isMainModule(import.meta);\n",
    );
    writeFileSync(
      join(real, 'entry.mjs'),
      [
        "import { isMainModule } from './is-main.mjs';",
        "import { libIsMain } from './lib.mjs';",
        // 去掉 main 字段，模拟没有 import.meta.main 的旧 Node，走真实路径比较那条退路
        'console.log(JSON.stringify([isMainModule(import.meta), isMainModule({ url: import.meta.url }), libIsMain]));',
      ].join('\n'),
    );
    const link = join(base, 'link');
    symlinkSync(real, link);
    expect(JSON.parse(runChildOk(process.execPath, [join(link, 'entry.mjs')]))).toEqual([true, true, false]);
  },
);
