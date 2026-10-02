// 钉住：.github/workflows 下每个文件的 YAML 都得能解析。
// GitHub 对解析不了的工作流文件不会在 PR 上报错，只在每次推送之后多一条「workflow file issue」的红、一个 job 也不起：
// release.yml 因为 run 块里写了顶格的 $body，从 #597 合进主线起坏了 42 次推送，「发布 vN」收尾从来没真跑起来过。
// 这条测试在 CI 里把这一类先挡在合并之前（.github/workflows/ 一改，CI 全跑，见 ci-plan 的 PATH_RULES）。
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

const dir = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url));

/** 解析问题的第一行（空数组＝能解析）。 */
function yamlProblems(text: string): string[] {
  return parseDocument(text).errors.map((e) => e.message.split('\n')[0] ?? e.message);
}

describe('.github/workflows 下的文件 YAML 必须能解析', () => {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

  it('目录里读得到工作流文件（读不到要红，不能因为「没有可查的」就算过）', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`${f} 能解析`, () => {
      expect(yamlProblems(readFileSync(dir + f, 'utf8'))).toEqual([]);
    });
  }

  // 故意造出的失败：把 release.yml 坏掉的那种写法原样造一份，判定器必须说它解析不了。
  const indented = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: |',
    '          msg="x',
    '',
    '          $body',
    '',
    '          y"',
  ];
  it('run 块里顶格的行判为解析不了（release.yml 坏掉的写法）', () => {
    const bad = indented.map((l) => (l.trim() === '$body' ? '$body' : l)).join('\n');
    expect(yamlProblems(bad).length).toBeGreaterThan(0);
  });

  it('同样的内容缩进写对了就判为能解析（判定器不是见 $ 就红）', () => {
    expect(yamlProblems(indented.join('\n'))).toEqual([]);
  });
});
