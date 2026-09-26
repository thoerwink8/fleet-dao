// ciTextCheck：PR 标题、正文按内容规则和已知敏感值名单扫，复用 rules.ts / values.ts 同一套判法，这里只测标题、
// 正文两段分得开、退出码和别的卫生检查一致。文件末尾还真跑一遍命令行入口（bin/ci-pr-text.ts），标题正文经环境变量传。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ciTextCheck } from '../src/ci-text.ts';
import type { LoadedValues } from '../src/values.ts';
import { pseudoRandom } from './helpers.ts';

const LIST: LoadedValues = { ok: true, source: '测试名单', values: ['fake-org-778899'] };
const NO_LIST: LoadedValues = { ok: false, reason: '已知敏感值名单没读到（找过：/nope）', tried: ['/nope'] };

describe('ciTextCheck', () => {
  it('干净：退出码 0', () => {
    expect(ciTextCheck({ title: '修个小 bug', body: '没什么好说的', values: LIST })).toEqual({
      code: 0,
      lines: ['卫生检查（PR 标题和正文）：查出 0 条'],
    });
  });

  it('标题里有令牌：退出码 1，报在标题上，不打值', () => {
    const token = ['ghp', pseudoRandom(36, 601)].join('_');
    const result = ciTextCheck({ title: `顺手带上 ${token}`, body: '', values: LIST });
    expect(result.code).toBe(1);
    expect(result.lines).toContain('PR 标题:1 令牌');
    expect(result.lines.join('\n')).not.toContain(token);
  });

  it('正文里有名单上的值：退出码 1，报在正文上、行号按正文自己算', () => {
    const result = ciTextCheck({ title: '改文档', body: '第一行\n用户 fake-org-778899', values: LIST });
    expect(result.code).toBe(1);
    expect(result.lines).toContain('PR 正文:2 名单里的敏感值');
    expect(result.lines.join('\n')).not.toContain('fake-org-778899');
  });

  it('标题、正文都干净但没查名单上的值：只要没读到名单就是退出码 2，不当成干净', () => {
    const result = ciTextCheck({ title: '改文档', body: '没问题', values: NO_LIST });
    expect(result.code).toBe(2);
    expect(result.lines.at(-1)).toMatch(/^没扫全：/);
  });

  it('名单没读到、但不靠名单的规则照样查出来：退出码仍是 2（没扫全压过查出问题），查出的照样列出来', () => {
    const token = ['ghp', pseudoRandom(36, 602)].join('_');
    const result = ciTextCheck({ title: token, body: '', values: NO_LIST });
    expect(result.code).toBe(2);
    expect(result.lines).toContain('PR 标题:1 令牌');
    expect(result.lines.at(-1)).toMatch(/^没扫全：/);
  });
});

// 真跑一遍命令行入口：标题、正文从环境变量 PR_TITLE / PR_BODY 读（工作流那边就是这么传的），不是命令行参数。
// 名单指到临时文件，不读这台机器上真的名单（结果不能随机器而变）。
describe('入口（bin/ci-pr-text.ts）', () => {
  const bin = fileURLToPath(new URL('../src/bin/ci-pr-text.ts', import.meta.url));
  let scratch: string;
  const run = (title: string, body: string) =>
    spawnSync(process.execPath, [bin], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FLEET_SENSITIVE_VALUES_FILE: join(scratch, 'list.txt'),
        PR_TITLE: title,
        PR_BODY: body,
      },
    });

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'fleet-hygiene-ci-text-bin-'));
    writeFileSync(join(scratch, 'list.txt'), 'fake-org-778899\n');
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('标题、正文两个环境变量都没设：当空文本处理，干净，退出码 0', () => {
    const env: Record<string, string | undefined> = { ...process.env };
    env.FLEET_SENSITIVE_VALUES_FILE = join(scratch, 'list.txt');
    delete env.PR_TITLE;
    delete env.PR_BODY;
    const r = spawnSync(process.execPath, [bin], { encoding: 'utf8', env });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('查出 0 条');
  });

  it('正文里有名单上的值：退出码 1，标准错误里报出来但不打值', () => {
    const r = run('改文档', '用户 fake-org-778899');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('名单里的敏感值');
    expect(r.stderr).not.toContain('fake-org-778899');
  });
});
