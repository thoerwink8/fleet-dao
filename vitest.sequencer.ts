// 实验（不合并）：台内按耗时表从重到轻排，量对一台测试台的墙钟的影响。
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

const table: Record<string, number> = JSON.parse(
  readFileSync(new URL('./packages/conventions/test-timings.json', import.meta.url), 'utf8'),
).files;

export default class TimingsSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const ms = (s: TestSpecification) =>
      table[relative(this.ctx.config.root, s.moduleId).replaceAll('\\', '/')] ?? Number.POSITIVE_INFINITY;
    return [...files].sort((a, b) => ms(b) - ms(a) || (a.moduleId < b.moduleId ? -1 : 1));
  }
}
