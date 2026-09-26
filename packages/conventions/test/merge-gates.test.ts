import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type ChangedFile,
  checkSecondOpinion,
  DESCRIPTION_MAX,
  destructiveIn,
  parseRiskPaths,
  parseTier,
  type RiskPath,
  riskyFiles,
  secondOpinionFrom,
  statusDescription,
} from '../src/merge-gates.ts';

const HEAD = 'a'.repeat(40);

describe('档位', () => {
  it('开头是三档之一、后面跟理由就认：加粗、反引号、各种隔开的写法', () => {
    for (const [value, tier] of [
      ['直接合（纯文档）', '直接合'],
      ['先合后看——卫生规则只多认一种密钥', '先合后看'],
      ['CI 绿就合，只改测试', 'CI 绿就合'],
      ['`先审后合` 碰了登录', '先审后合'],
      ['**先审后合**：迁移', '先审后合'],
    ] as const) {
      expect(parseTier(value), value).toEqual({ tier });
    }
  });

  it('没这一栏、空的、认不出、只写档位没理由：各报一句怎么写', () => {
    expect(parseTier(undefined)).toEqual({ problem: expect.stringContaining('正文里认不出「档位」一栏') });
    expect(parseTier('  ')).toEqual({ problem: expect.stringContaining('「档位」一栏是空的') });
    expect(parseTier('低风险，直接合')).toEqual({
      problem: '「档位」写的「低风险，直接合」认不出：开头写「CI 绿就合」「先审后合」之一，后面跟理由。',
    });
    expect(parseTier('先合后看。')).toEqual({
      problem: '「档位」只写了「先合后看」没写理由：后面跟一句为什么是这一档，比如 先合后看——只改测试。',
    });
  });
});

const changed = (filename: string, status = 'modified', over: Partial<ChangedFile> = {}): ChangedFile => ({
  filename,
  status,
  ...over,
});

describe('高风险路径清单', () => {
  const list: RiskPath[] = [
    { path: 'packages/db/migrations/', kind: '改数据库', why: '真库', mode: 'migrations' },
    { path: 'deploy/', kind: '动生产', why: '真机' },
    { path: 'packages/api/src/auth.ts', kind: '碰安全', why: '登录' },
  ];

  it('仓里那份认得出：只有三种、每条有理由、指的路径都在；引擎代码不在里面', () => {
    const text = readFileSync(new URL('../high-risk-paths.json', import.meta.url), 'utf8');
    const parsed = parseRiskPaths(text);
    if (typeof parsed === 'string') throw new Error(parsed);
    const root = new URL('../../../', import.meta.url);
    for (const r of parsed) expect(existsSync(new URL(r.path, root)), r.path).toBe(true);
    const paths = parsed.map((r) => r.path);
    for (const must of [
      'packages/db/migrations/',
      'deploy/',
      'packages/hygiene/',
      'packages/api/src/auth.ts',
    ]) {
      expect(paths).toContain(must);
    }
    expect(paths.filter((p) => p.startsWith('packages/engine/'))).toEqual([]);
  });

  it('合并闸决定结论的判法都在清单里：从入口顺着相对导入走一遍，每个文件都得落进清单（漏一个，PR 改它就能放松门槛）；只做提醒的必填栏那一套不走进去', () => {
    const parsed = parseRiskPaths(readFileSync(new URL('../high-risk-paths.json', import.meta.url), 'utf8'));
    if (typeof parsed === 'string') throw new Error(parsed);
    const root = new URL('../../../', import.meta.url);
    const todo = ['packages/conventions/src/bin/merge-gate.ts'];
    const seen = new Set<string>();
    // 只做提醒：它们坏了改不了结论（merge-gate.test.ts「提醒那一半坏了也改不了结论」兜着）
    const reminderOnly = new Set([
      'packages/conventions/src/pr-fields.ts',
      'packages/conventions/src/plan.ts',
      'packages/conventions/src/markdown.ts',
      'packages/conventions/src/labels.ts',
    ]);
    while (todo.length > 0) {
      const rel = todo.pop() as string;
      if (seen.has(rel) || reminderOnly.has(rel)) continue;
      seen.add(rel);
      const text = readFileSync(new URL(rel, root), 'utf8');
      for (const m of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
        todo.push(new URL(m[1] as string, new URL(rel, root)).href.slice(root.href.length));
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(4); // 一个都没走到，下面那条就成了拿空的去比
    const missing = [...seen].filter((rel) => riskyFiles([changed(rel)], parsed).length === 0);
    expect(missing).toEqual([]);
  });

  it('目录按前缀、文件按全名比；改名的旧名字也算', () => {
    expect(
      riskyFiles(
        [
          changed('deploy/france.sh'),
          changed('packages/db/src/x.ts'),
          changed('packages/api/src/auth.ts'),
          changed('docs/deploy/x.md'),
          changed('scripts/old.sh', 'renamed', { previous: 'deploy/old.sh' }),
        ],
        list,
      ),
    ).toEqual([
      { file: 'deploy/france.sh', rule: 'deploy/', kind: '动生产' },
      { file: 'packages/api/src/auth.ts', rule: 'packages/api/src/auth.ts', kind: '碰安全' },
      { file: 'deploy/old.sh', rule: 'deploy/', kind: '动生产' },
    ]);
  });

  it('迁移：新迁移只建表、加列、建索引不算；改删已有的迁移、新迁移里删改已有东西、看不到内容都算；meta/ 不单算', () => {
    const add = (sql: string) =>
      changed('packages/db/migrations/0009_x.sql', 'added', {
        patch: `@@ -0,0 +1,3 @@\n${sql
          .split('\n')
          .map((l) => `+${l}`)
          .join('\n')}`,
      });
    const create = [
      'CREATE TABLE "x" ("id" text PRIMARY KEY);',
      '-- 顺手说一句：以后可能 DROP TABLE 旧表',
      'ALTER TABLE "tasks" ADD COLUMN "note" text;',
      'ALTER TABLE "x" ADD CONSTRAINT "x_fk" FOREIGN KEY ("id") REFERENCES "tasks"("id");',
      'CREATE INDEX "x_idx" ON "x" ("id");',
      'CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN DELETE FROM x; RETURN NEW; END; $$ LANGUAGE plpgsql;',
      'CREATE TRIGGER t AFTER INSERT ON "x" FOR EACH ROW EXECUTE FUNCTION f();',
      'ALTER TABLE "x"',
      '  ADD COLUMN "a" text,',
      `  ADD CONSTRAINT "c" CHECK ("a" in ('p', 'q'));`,
    ].join('\n');
    expect(riskyFiles([add(create), changed('packages/db/migrations/meta/_journal.json')], list)).toEqual([]);

    const hit = (f: ChangedFile) => riskyFiles([f], list)[0]?.note;
    expect(hit(add('ALTER TABLE "tasks" DROP COLUMN "note";'))).toBe('有「ALTER TABLE "TASKS" DROP」');
    expect(hit(add('drop table "old";'))).toBe('有「DROP TABLE "OLD"」');
    expect(hit(add('DELETE FROM "tasks" WHERE true;'))).toBe('有「DELETE FROM "TASKS" WHERE」');
    expect(hit(add('UPDATE "tasks" SET "x" = 1;'))).toBe('有「UPDATE "TASKS" SET "X"」');
    expect(hit(add('ALTER TABLE "tasks" ALTER COLUMN "x" SET NOT NULL;'))).toMatch(
      /^有「ALTER TABLE "TASKS" ALTER」/,
    );
    expect(hit(add('ALTER TABLE "a" RENAME TO "b";'))).toMatch(/^有「ALTER TABLE "A" RENAME」/);
    // 跨行、省掉关键字、和加列混在一个 ALTER 里、跟在注释和建表后面的，都认得出
    expect(hit(add('UPDATE\n  "tasks"\nSET "x" = 1;'))).toBe('有「UPDATE "TASKS" SET "X"」');
    expect(hit(add('ALTER TABLE "t" ALTER "x" TYPE int;'))).toMatch(/^有「ALTER TABLE "T" ALTER/);
    expect(hit(add('ALTER TABLE "t" DROP "x";'))).toMatch(/^有「ALTER TABLE "T" DROP/);
    expect(hit(add('ALTER TABLE "t" ADD COLUMN "a" text, DROP COLUMN "b";'))).toMatch(/^有「ALTER TABLE/);
    expect(hit(add('CREATE TABLE "y" ("id" int); -- 建表\nTRUNCATE "tasks";'))).toBe(
      '有「TRUNCATE "TASKS"」',
    );
    expect(hit(add('CREATE TABLE "y" ("id" int);\nDROP TRIGGER t ON "x";'))).toMatch(
      /^有「DROP TRIGGER T ON/,
    );
    // 替换、删掉已有的函数、视图、触发器也算改
    expect(hit(add('CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;'))).toMatch(
      /^有「CREATE OR REPLACE FUNCTION/,
    );
    expect(hit(add('CREATE OR REPLACE VIEW v AS SELECT 1;'))).toMatch(/^有「CREATE OR REPLACE VIEW/);
    expect(hit(add('DROP TRIGGER IF EXISTS t ON "x";'))).toMatch(/^有「DROP TRIGGER IF EXISTS/);
    expect(hit(changed('packages/db/migrations/0009_x.sql', 'added'))).toBe('看不到改动内容');
    expect(hit(changed('packages/db/migrations/0003_catalog.sql'))).toBe('改了已有的迁移');
    expect(hit(changed('packages/db/migrations/0003_catalog.sql', 'removed'))).toBe('删了已有的迁移');
    expect(destructiveIn('+++ b/x.sql\n-DROP TABLE "was_there";\n+CREATE TABLE "y" ();')).toBeUndefined();
  });

  it('故意坏掉的清单：不是 JSON、没有 paths、空的、缺字段、种类不对、缺理由、mode 不对、路径往外跳，都说为什么（调用方判没查成）', () => {
    const one = (item: unknown) => parseRiskPaths(JSON.stringify({ paths: [item] }));
    expect(parseRiskPaths('{坏')).toMatch(/^不是合法的 JSON/);
    expect(parseRiskPaths('{}')).toBe('没有 paths 列表');
    expect(parseRiskPaths('{"paths":[]}')).toBe('paths 是空的（一条都没有等于什么都不拦）');
    expect(one({ path: 'deploy/' })).toBe('paths 第 1 条 认不出（要有 path、kind、why 三个字符串）');
    expect(one({ path: 'deploy/', kind: '引擎核心', why: 'x' })).toBe(
      'paths 第 1 条（deploy/）的 kind「引擎核心」不是「改数据库」「动生产」「碰安全」之一',
    );
    expect(one({ path: 'deploy/', kind: '动生产', why: ' ' })).toBe('paths 第 1 条（deploy/）没写为什么');
    expect(one({ path: 'x.sql', kind: '改数据库', why: 'x', mode: 'migrations' })).toMatch(/mode 认不出/);
    expect(one({ path: 'db/', kind: '改数据库', why: 'x', mode: 'sql' })).toMatch(/mode 认不出/);
    for (const bad of ['/etc/', '../x', '']) {
      expect(one({ path: bad, kind: '动生产', why: 'x' })).toMatch(/不是仓内相对路径/);
    }
  });
});

describe('第二意见状态', () => {
  const status = (state: string, description = '') => ({ context: 'second-opinion', state, description });

  it('从当前头的状态里挑出 second-opinion；没有就是 null', () => {
    expect(secondOpinionFrom([{ context: 'ci', state: 'success' }, status('success', '通过')])).toEqual({
      state: 'success',
      description: '通过',
    });
    expect(secondOpinionFrom([{ context: 'ci', state: 'success' }])).toBeNull();
  });

  it('故意认不出的：没有 context、state 不认得，说为什么', () => {
    expect(secondOpinionFrom([{ state: 'success' }])).toBe('提交状态里有一条认不出（没有 context）');
    expect(secondOpinionFrom([status('ok')])).toBe('second-opinion 的 state「ok」认不出');
  });

  it('没改到那三种地方不要第二意见；改到了：通过不报，没有、还在跑、没过各报一句，带上是哪几个文件', () => {
    const hits = riskyFiles(
      [
        { filename: 'packages/db/migrations/0009_x.sql', status: 'added', patch: '+DROP TABLE "old";' },
        { filename: 'deploy/france.sh', status: 'modified' },
      ],
      [
        { path: 'packages/db/migrations/', kind: '改数据库', why: '真库', mode: 'migrations' },
        { path: 'deploy/', kind: '动生产', why: '真机' },
      ],
    );
    const where =
      '改到了先审后合的地方：packages/db/migrations/0009_x.sql（改数据库：有「DROP TABLE "OLD"」）、deploy/france.sh（动生产）（清单和理由见 packages/conventions/high-risk-paths.json）';
    expect(checkSecondOpinion(HEAD, null, [])).toEqual([]);
    expect(checkSecondOpinion(HEAD, { state: 'success', description: '' }, hits)).toEqual([]);
    expect(checkSecondOpinion(HEAD, null, hits)).toEqual([
      `等第二意见：当前头 aaaaaaa 上还没有 second-opinion 状态，${where}。第二意见审完写上，合并闸自动重算；推了新提交的，旧头上的不算。`,
    ]);
    expect(checkSecondOpinion(HEAD, { state: 'pending', description: '' }, hits)).toEqual([
      `等第二意见：当前头 aaaaaaa 上的 second-opinion 还在跑（pending），${where}。`,
    ]);
    expect(checkSecondOpinion(HEAD, { state: 'failure', description: '有两条必须改' }, hits)).toEqual([
      `第二意见没过：当前头 aaaaaaa 上的 second-opinion 是 failure：有两条必须改，${where}。按意见改完推上去，对新头重跑第二意见。`,
    ]);
    expect(checkSecondOpinion(HEAD, { state: 'error', description: '' }, hits)[0]).toMatch(/^第二意见没过/);
  });
});

describe('状态说明', () => {
  it('放第一条，多的写另有几条；再长也不超过 GitHub 的 140 个字符', () => {
    expect(statusDescription(['是草稿。'])).toBe('是草稿。');
    expect(statusDescription(['是草稿。', '缺档位。'])).toBe('是草稿。（另有 1 条，点详情看）');
    const long = statusDescription(['很'.repeat(300), '第二条']);
    expect([...long].length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(long).toMatch(/…（另有 1 条，点详情看）$/);
  });
});
