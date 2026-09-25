// deploy/lib/snapshot.sh 的 ours 段照 targets.ts 另抄了一份落点（它是另一套判据，故意不借这边的代码）。
// 这边加了落点、那边没跟上，「两遍之间 diff 为空」就查不到新落点被改过：这里当场红。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RULES_TARGETS, SKILL_TARGETS } from '../src/targets.ts';

const SNAPSHOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'deploy',
  'lib',
  'snapshot.sh',
);

function agentsSyncSection(): string {
  const text = readFileSync(SNAPSHOT, 'utf8');
  const start = text.indexOf('snapshot_agents_sync() {');
  const end = text.indexOf('\n}\n', start);
  expect(start).toBeGreaterThan(-1);
  return text.slice(start, end);
}

describe('snapshot.sh 里的落点跟得上 targets.ts', () => {
  it('每一份全局文件、每一个 skill 目录、清单都在', () => {
    const section = agentsSyncSection();
    const want = [
      ...RULES_TARGETS.map((t) => t.file.linux),
      ...SKILL_TARGETS.map((t) => t.dir.linux),
      '.fleet-dao/agents-sync.json',
    ];
    expect(want.filter((p) => !section.includes(p))).toEqual([]);
  });
});
