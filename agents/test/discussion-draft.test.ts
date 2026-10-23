// 讨论稿的起稿和推前检查（agents/skills/discussion-draft/scripts/draft.mjs，决定 0116，#3661）。
// 起因：一个对外仓 2026-10-23 的排查讨论稿第一版只有六节，缺「要改的已有规矩」「验收和风险」「结论和交接」，接手的人得重新问。
// 先钉判法（纯函数），再在临时 git 仓里真跑命令：起稿填对、同短名不新建、真模板起出来的稿过检查、改成已定少链接或单号就拒；
// 最后一条拿本仓自己的讨论稿跑同一个检查——这就是 fleet-dao 的推前查（CI 每个 PR 全跑）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runChild, runChildOk } from './child.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(ROOT, 'agents/skills/discussion-draft/scripts/draft.mjs');
const TEMPLATE = readFileSync(join(ROOT, 'agents/skills/discussion-draft/template.md'), 'utf8');

interface Config {
  layout: 'dated' | 'topic';
  file: string;
  dir: string;
  suffix: string;
  template: string | null;
  decisions: string[];
  task: RegExp;
  since: string | null;
  staleDays: number;
}
interface DraftCheck {
  errors: string[];
  reminders: string[];
}
interface DraftLib {
  parseConfig(raw: unknown): Config;
  headingsOf(text: string): string[];
  statusOf(text: string): string | null;
  checkDraft(input: {
    path: string;
    text: string;
    headings: string[];
    config: Config;
    exists: (p: string) => boolean;
    today: string;
  }): DraftCheck;
  isDraftPath(path: string, config: Config): boolean;
  fillTemplate(template: string, vars: Record<string, string>): string;
  validShort(short: string): boolean;
  checkDrafts(opts: { root: string; today: string; files?: string[] }): { code: number; lines: string[] };
}

const lib = (await import(pathToFileURL(SCRIPT).href)) as DraftLib;
const HEADINGS = lib.headingsOf(TEMPLATE);
const VARS = {
  标题: '体验排查',
  日期: '2026-10-23',
  起因: '需求方 2026-10-23 提了：六点',
  代码版本: '`abc1234`（1.0.0）',
};
const FRESH = lib.fillTemplate(TEMPLATE, VARS);

const decided = (conclusion: string) =>
  FRESH.replace('- 状态：讨论中', '- 状态：已定（2026-10-24，见 [决定](decisions/0001-x.md)）').replace(
    /## 八、结论[\s\S]*$/,
    `## 八、结论\n\n${conclusion}\n`,
  );

const check = (
  text: string,
  opts: { config?: Config; path?: string; today?: string; files?: string[] } = {},
) =>
  lib.checkDraft({
    path: opts.path ?? 'docs/2026-10-23-ux-survey.md',
    text,
    headings: HEADINGS,
    config: opts.config ?? lib.parseConfig(undefined),
    exists: (p) => (opts.files ?? ['docs/decisions/0001-x.md']).includes(p),
    today: opts.today ?? '2026-10-23',
  });

describe('模板', () => {
  it('八节标题，最后一节是结论；状态行是讨论中；四个占位都在', () => {
    expect(HEADINGS).toEqual([
      '## 一、提出的问题',
      '## 二、另外查出来的',
      '## 三、根因归拢',
      '## 四、要改的已有规矩',
      '## 五、要拍板的',
      '## 六、顺序、验收和风险',
      '## 七、没核实的',
      '## 八、结论',
    ]);
    expect(lib.statusOf(TEMPLATE)).toBe('讨论中');
    for (const key of Object.keys(VARS)) expect(TEMPLATE).toContain(`{{${key}}}`);
  });

  it('「怎么想」清单六步都在第一节里', () => {
    const first = TEMPLATE.slice(TEMPLATE.indexOf('## 一、'), TEMPLATE.indexOf('## 二、'));
    for (const step of ['复现', '追根因', '横向找', '比方案', '最小改法', '不做什么'])
      expect(first).toContain(step);
  });

  it('起稿去掉开头的说明注释、填好占位；模板缺占位或状态行不起', () => {
    expect(FRESH.startsWith('# 体验排查（2026-10-23，讨论稿）')).toBe(true);
    expect(FRESH).toContain('- 起因：需求方 2026-10-23 提了：六点');
    expect(FRESH).toContain('- 代码版本：`abc1234`（1.0.0）');
    expect(FRESH).not.toContain('{{');
    expect(() => lib.fillTemplate(TEMPLATE.replace('{{起因}}', '……'), VARS)).toThrow(/缺占位 \{\{起因\}\}/);
    expect(() => lib.fillTemplate(TEMPLATE.replace('- 状态：讨论中', ''), VARS)).toThrow(/状态：讨论中/);
  });
});

describe('配置', () => {
  it('不写全用默认：docs、-survey.md、GitHub 单号', () => {
    const c = lib.parseConfig(undefined);
    expect([c.dir, c.suffix, c.decisions, c.staleDays, c.since]).toEqual([
      'docs',
      '-survey.md',
      ['docs/decisions', 'docs/decisions.md'],
      7,
      null,
    ]);
    expect(c.task.test('任务：#3661')).toBe(true);
    expect(c.task.test('见 a.md#3')).toBe(false);
  });

  it('写错的不悄悄忽略', () => {
    expect(() => lib.parseConfig({ dirs: 'x' })).toThrow(/不认识「dirs」/);
    expect(() => lib.parseConfig({ task: '[' })).toThrow(/不是合法的正则/);
    expect(() => lib.parseConfig({ since: '10-23' })).toThrow(/YYYY-MM-DD/);
    expect(() => lib.parseConfig({ staleDays: 0 })).toThrow(/正整数/);
    expect(() => lib.parseConfig([])).toThrow(/对象/);
    expect(lib.parseConfig({ decisions: 'docs\\decisions/' }).decisions).toEqual(['docs/decisions']);
  });

  it('只认 dir 下、带日期和后缀、不早于 since 的文件', () => {
    const c = lib.parseConfig({ since: '2026-10-23' });
    expect(lib.isDraftPath('docs/2026-10-23-ux-survey.md', c)).toBe(true);
    expect(lib.isDraftPath('docs/2026-10-22-ux-survey.md', c)).toBe(false);
    expect(lib.isDraftPath('docs/sub/2026-10-23-ux-survey.md', c)).toBe(false);
    expect(lib.isDraftPath('docs/2026-10-23-ux.md', c)).toBe(false);
    expect(lib.isDraftPath('docs/2026-10-23-survey.md', c)).toBe(false);
    expect(lib.isDraftPath('docs\\2026-10-23-ux-survey.md', c)).toBe(true);
  });

  it('短名进文件名：字母数字和单个连字符', () => {
    expect(['ux-audit', '体验-排查', 'a1'].every(lib.validShort)).toBe(true);
    expect(['', '-a', 'a--b', 'a b', 'a/b', '../x'].some(lib.validShort)).toBe(false);
  });
});

describe('按主题放（layout: topic）的配置', () => {
  it('没配新键：布局 dated、文件名 讨论稿.md，其余默认不变', () => {
    for (const raw of [undefined, {}, { dir: 'x', suffix: '-a.md' }]) {
      const c = lib.parseConfig(raw);
      expect([c.layout, c.file]).toEqual(['dated', '讨论稿.md']);
    }
    const t = lib.parseConfig({ layout: 'topic', dir: 'specs' });
    expect([t.layout, t.dir, t.file]).toEqual(['topic', 'specs', '讨论稿.md']);
    expect(lib.parseConfig({ layout: 'topic', file: '稿.md' }).file).toBe('稿.md');
  });

  it('互斥和写错都报错：topic 写 suffix / since，dated 写 file，layout 值不对，file 带目录', () => {
    expect(() => lib.parseConfig({ layout: 'topic', suffix: '-x.md' })).toThrow(/topic 时不能写 suffix/);
    expect(() => lib.parseConfig({ layout: 'topic', since: '2026-10-23' })).toThrow(/topic 时不能写 since/);
    expect(() => lib.parseConfig({ file: '稿.md' })).toThrow(/file 只在 layout 是 topic/);
    expect(() => lib.parseConfig({ layout: 'dated', file: '稿.md' })).toThrow(/file 只在 layout 是 topic/);
    expect(() => lib.parseConfig({ layout: 'nested' })).toThrow(/dated 或 topic/);
    expect(() => lib.parseConfig({ layout: 'topic', file: 'a/b.md' })).toThrow(/不带目录/);
  });

  it('只认 <dir>/<单号>-<短名>/<file>：往深一层、别的文件名、没有单号前缀都不算，反斜杠照认', () => {
    const c = lib.parseConfig({ layout: 'topic', dir: 'specs' });
    expect(lib.isDraftPath('specs/12-x/讨论稿.md', c)).toBe(true);
    expect(lib.isDraftPath('specs\\12-x\\讨论稿.md', c)).toBe(true);
    expect(lib.isDraftPath('./specs/T1-x/讨论稿.md', c)).toBe(true);
    expect(lib.isDraftPath('specs/12-x/sub/讨论稿.md', c)).toBe(false);
    expect(lib.isDraftPath('specs/讨论稿.md', c)).toBe(false);
    expect(lib.isDraftPath('specs/12-x/方案.md', c)).toBe(false);
    expect(lib.isDraftPath('specs/notes/讨论稿.md', c)).toBe(false);
    expect(lib.isDraftPath('docs/12-x/讨论稿.md', c)).toBe(false);
    expect(
      lib.isDraftPath('specs/12-x/稿.md', lib.parseConfig({ layout: 'topic', dir: 'specs', file: '稿.md' })),
    ).toBe(true);
  });
});

describe('按主题放：状态一条线', () => {
  const topic = lib.parseConfig({ layout: 'topic', dir: 'specs' });
  const path = 'specs/12-x/讨论稿.md';
  const topicCheck = (text: string, today = '2026-10-23') =>
    lib.checkDraft({ path, text, headings: HEADINGS, config: topic, today, exists: () => true });
  const withStatus = (status: string, conclusion?: string) => {
    const base = FRESH.replace('- 状态：讨论中', `- 状态：${status}`);
    return conclusion === undefined
      ? base
      : base.replace(/## 八、结论[\s\S]*$/, `## 八、结论\n\n${conclusion}\n`);
  };
  const good = '- 决定：[0118](../../docs/decisions/0118-x.md)\n- 任务：#12';

  it('讨论中：八节齐才过；状态行带注释也认', () => {
    expect(topicCheck(FRESH)).toEqual({ errors: [], reminders: [] });
    expect(topicCheck(FRESH.replace('## 七、没核实的', '## 七、没核实')).errors).toEqual([
      expect.stringContaining('## 七、没核实的'),
    ]);
  });

  it('已定 / 在做 / 做完：结论节要有决定链接和单号', () => {
    const decisions = lib.parseConfig({ layout: 'topic', dir: 'specs', decisions: 'docs/decisions' });
    for (const s of ['已定（2026-10-24）', '在做', '做完']) {
      const ok = lib.checkDraft({
        path,
        text: withStatus(s, good),
        headings: HEADINGS,
        config: decisions,
        today: '2026-10-24',
        exists: () => true,
      });
      expect([s, ok.errors]).toEqual([s, []]);
      const bad = lib.checkDraft({
        path,
        text: withStatus(s, '- 任务：待开'),
        headings: HEADINGS,
        config: decisions,
        today: '2026-10-24',
        exists: () => true,
      });
      expect(bad.errors).toEqual([
        expect.stringContaining('没有指向决定'),
        expect.stringContaining('没有任务编号'),
      ]);
    }
  });

  it('搁置 / 被取代：不查正文', () => {
    for (const s of ['搁置（等平台升级）', '被取代（见 specs/13-y）'])
      expect(topicCheck(`# x\n\n- 状态：${s}\n\n## 一、提出的问题\n`).errors).toEqual([]);
  });

  it('未复核、认不出的状态报错', () => {
    expect(topicCheck(withStatus('未复核')).errors).toEqual([expect.stringContaining('未复核')]);
    expect(topicCheck(withStatus('随便')).errors).toEqual([expect.stringContaining('「随便」认不出')]);
  });

  it('dated 布局仍不认 在做 / 做完 / 被取代', () => {
    for (const s of ['在做', '做完', '被取代'])
      expect(check(withStatus(s)).errors).toEqual([expect.stringContaining('认不出')]);
  });

  it('讨论中超期提醒取 H1 里第一个日期；没有日期不提醒', () => {
    expect(topicCheck(FRESH, '2026-10-30').reminders).toEqual([]);
    expect(topicCheck(FRESH, '2026-10-31').reminders).toEqual([expect.stringContaining('8 天')]);
    expect(topicCheck(FRESH.replace('2026-10-23，讨论稿', '讨论稿'), '2027-01-01').reminders).toEqual([]);
  });
});

describe('查一份稿', () => {
  it('刚起的稿过', () => {
    expect(check(FRESH)).toEqual({ errors: [], reminders: [] });
  });

  it('讨论中少一节就不过，报出缺哪节', () => {
    const r = check(FRESH.replace('## 四、要改的已有规矩', '## 四、要改的'));
    expect(r.errors).toEqual([expect.stringContaining('## 四、要改的已有规矩')]);
  });

  it('注释里的标题不算数', () => {
    const r = check(FRESH.replace('## 七、没核实的', '<!--\n## 七、没核实的\n-->'));
    expect(r.errors).toEqual([expect.stringContaining('## 七、没核实的')]);
  });

  it('讨论中超过 7 天只提醒，正好 7 天不提醒', () => {
    expect(check(FRESH, { today: '2026-10-30' }).reminders).toEqual([]);
    const r = check(FRESH, { today: '2026-10-31' });
    expect(r.errors).toEqual([]);
    expect(r.reminders).toEqual([expect.stringContaining('8 天')]);
  });

  it('没有状态行、状态认不出都不过', () => {
    expect(check(FRESH.replace(/^- 状态：.*$/m, '')).errors).toEqual([
      expect.stringContaining('没有「- 状态：」'),
    ]);
    expect(check(FRESH.replace('- 状态：讨论中', '- 状态：做完了')).errors).toEqual([
      expect.stringContaining('「做完了」认不出'),
    ]);
  });

  it('已定：结论节有指得到的决定链接和单号才过', () => {
    expect(check(decided('- 决定：[0001](decisions/0001-x.md)\n- 任务：#12')).errors).toEqual([]);
  });

  it('已定：没改的占位、只有状态行里的决定链接，都不算', () => {
    const r = check(
      FRESH.replace('- 状态：讨论中', '- 状态：已定（2026-10-24，见 [决定](decisions/0001-x.md)）'),
    );
    expect(r.errors).toEqual([
      expect.stringContaining('没有指向决定'),
      expect.stringContaining('没有任务编号'),
    ]);
  });

  it('已定：决定链接指不到文件、没有单号分别报', () => {
    expect(check(decided('- 决定：[0002](decisions/0002-y.md)\n- 任务：#12')).errors).toEqual([
      expect.stringContaining('指不到文件：docs/decisions/0002-y.md'),
    ]);
    expect(check(decided('- 决定：[0001](decisions/0001-x.md)\n- 任务：待开')).errors).toEqual([
      expect.stringContaining('没有任务编号'),
    ]);
  });

  it('已定：别的仓的单号格式和单文件决定', () => {
    const config = lib.parseConfig({ task: String.raw`\[T-[a-z0-9]{4}\]`, decisions: 'docs/decisions.md' });
    const ok = decided('- 决定：[改绑](decisions.md#2026-10-23-改绑)\n- 任务：[T-akb5] 第一批');
    expect(check(ok, { config, files: ['docs/decisions.md'] }).errors).toEqual([]);
    expect(check(ok.replace('[T-akb5]', '#12'), { config, files: ['docs/decisions.md'] }).errors).toEqual([
      expect.stringContaining('T-[a-z0-9]{4}'),
    ]);
  });

  it('搁置的稿不再查八节', () => {
    expect(check('# x\n\n- 状态：搁置（等平台升级再看）\n\n## 一、提出的问题\n').errors).toEqual([]);
  });
});

describe('命令', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** 临时 git 仓：有 docs/ 和一个提交，package.json 带版本和可选配置。 */
  const repo = (config?: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'discussion-draft-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'docs', 'decisions'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', version: '2.3.4', discussionDraft: config }),
    );
    runChildOk('git', ['init', '-q'], { cwd: dir });
    runChildOk(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'],
      {
        cwd: dir,
      },
    );
    return dir;
  };
  const run = (dir: string, ...args: string[]) => runChild('node', [SCRIPT, ...args, '--root', dir]);
  const draftFile = (dir: string) => join(dir, 'docs', '2026-10-23-ux-audit-survey.md');

  it('起稿：自动填状态、起因、日期、代码版本；起出来的稿过检查', () => {
    const dir = repo();
    const r = run(dir, 'new', '--', 'ux-audit', '--ask', '撤回要恢复原状', '--date', '2026-10-23');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('docs/2026-10-23-ux-audit-survey.md');
    const text = readFileSync(draftFile(dir), 'utf8');
    const head = runChildOk('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir });
    expect(text).toContain('# ux-audit（2026-10-23，讨论稿）');
    expect(text).toContain('- 状态：讨论中');
    expect(text).toContain('- 起因：需求方 2026-10-23 提了：撤回要恢复原状');
    expect(text).toContain(`- 代码版本：\`${head}\`（2.3.4）`);
    const c = run(dir, 'check', '--today', '2026-10-23');
    expect([c.status, c.stdout.trim()]).toEqual([0, '讨论稿检查过了：1 份']);
  });

  it('同短名已有稿（哪天起的都算）：报出旧稿、不新建、退出 1', () => {
    const dir = repo();
    expect(run(dir, 'new', 'ux-audit', '--ask', '第一次', '--date', '2026-10-23').status).toBe(0);
    const again = run(dir, 'new', 'ux-audit', '--ask', '第二次', '--date', '2026-10-25');
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('同主题已有稿：docs/2026-10-23-ux-audit-survey.md');
    expect(readFileSync(draftFile(dir), 'utf8')).toContain('第一次');
  });

  it('改成已定没补结论就拒（退出 1），补上决定和单号就过；讨论中太久只提醒', () => {
    const dir = repo();
    run(dir, 'new', 'ux-audit', '--ask', '六点', '--date', '2026-10-23');
    const fresh = readFileSync(draftFile(dir), 'utf8');
    expect(run(dir, 'check', '--today', '2026-11-05').stdout).toContain('讨论中已经 13 天');
    writeFileSync(draftFile(dir), fresh.replace('- 状态：讨论中', '- 状态：已定（2026-10-24）'));
    const bad = run(dir, 'check', '--today', '2026-10-24');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('没有指向决定');
    writeFileSync(join(dir, 'docs', 'decisions', '0001-x.md'), '# x\n');
    writeFileSync(
      draftFile(dir),
      decided('- 决定：[0001](decisions/0001-x.md)\n- 任务：#12').replace('# 体验排查', '# ux-audit'),
    );
    expect(run(dir, 'check', '--today', '2026-10-24').status).toBe(0);
  });

  it('只给文件时只查其中是稿的；推的文件里删掉的稿跳过', () => {
    const dir = repo();
    writeFileSync(draftFile(dir), '# 坏稿\n');
    expect(run(dir, 'check', 'README.md').stdout.trim()).toBe('讨论稿检查过了：0 份');
    expect(run(dir, 'check', 'docs/2026-10-23-ux-audit-survey.md').status).toBe(1);
    expect(run(dir, 'check', 'docs/2026-10-24-gone-survey.md').status).toBe(0);
  });

  it('别的仓的约定：模板在仓里、旧稿按 since 跳过、单号另一种格式', () => {
    const dir = repo({
      template: 'docs/templates/讨论稿.md',
      since: '2026-10-23',
      task: String.raw`\[T-[a-z0-9]{4}\]`,
    });
    mkdirSync(join(dir, 'docs', 'templates'));
    writeFileSync(
      join(dir, 'docs', 'templates', '讨论稿.md'),
      TEMPLATE.replace('不做什么**：……', '不做什么**：（本仓措辞）'),
    );
    writeFileSync(join(dir, 'docs', '2026-10-01-old-survey.md'), '# 用模板之前的旧稿\n');
    expect(run(dir, 'new', 'ux-audit', '--ask', '六点', '--date', '2026-10-23').status).toBe(0);
    expect(readFileSync(draftFile(dir), 'utf8')).toContain('（本仓措辞）');
    expect(run(dir, 'check', '--today', '2026-10-23').stdout.trim()).toBe('讨论稿检查过了：1 份');
  });

  it('没查成退出 2：配置写错、模板读不到、参数不对', () => {
    expect(run(repo({ dirr: 'docs' }), 'check').status).toBe(2);
    const noTemplate = run(repo({ template: 'docs/none.md' }), 'check');
    expect([noTemplate.status, noTemplate.stderr.includes('读不到模板')]).toEqual([2, true]);
    expect(run(repo(), 'new', 'ux-audit').status).toBe(2);
    expect(run(repo(), 'new', 'a b', '--ask', 'x').status).toBe(2);
    expect(run(repo(), 'check', '--today', '昨天').status).toBe(2);
    expect(run(repo(), 'remove').status).toBe(2);
  });
});

describe('按主题放：命令', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const repo = (config: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'discussion-topic-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'specs', '5-旧方案'), { recursive: true });
    writeFileSync(join(dir, 'specs', '5-旧方案', '方案.md'), '# 旧\n');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', version: '1.0.0', discussionDraft: config }),
    );
    runChildOk('git', ['init', '-q'], { cwd: dir });
    runChildOk(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'],
      {
        cwd: dir,
      },
    );
    return dir;
  };
  const TOPIC = { layout: 'topic', dir: 'specs' };
  const run = (dir: string, ...args: string[]) => runChild('node', [SCRIPT, ...args, '--root', dir]);

  it('起稿：生成 <dir>/<单号>-<短名>/讨论稿.md，check 认得（别的主题目录没有稿不算缺）', () => {
    const dir = repo(TOPIC);
    const r = run(dir, 'new', 'ux', '--issue', '77', '--ask', '六点', '--date', '2026-10-23');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('specs/77-ux/讨论稿.md');
    const text = readFileSync(join(dir, 'specs', '77-ux', '讨论稿.md'), 'utf8');
    expect(text).toContain('- 状态：讨论中');
    expect(text).toContain('# ux（2026-10-23，讨论稿）');
    const c = run(dir, 'check', '--today', '2026-10-23');
    expect([c.status, c.stdout.trim()]).toEqual([0, '讨论稿检查过了：1 份']);
  });

  it('缺 --issue、单号不是字母数字、短名第一段纯数字，都退出 2 且不建目录', () => {
    const dir = repo(TOPIC);
    const noIssue = run(dir, 'new', 'ux', '--ask', '六点');
    expect([noIssue.status, noIssue.stderr.includes('先开单')]).toEqual([2, true]);
    expect(run(dir, 'new', 'x', '--issue', '8/8', '--ask', 'd').status).toBe(2);
    expect(run(dir, 'new', '2-x', '--issue', '88', '--ask', 'd').status).toBe(2);
    expect(existsSync(join(dir, 'specs', '88-2-x'))).toBe(false);
  });

  it('单号已有目录（新稿或旧方案）：报出来、退出 1、不新建', () => {
    const dir = repo(TOPIC);
    const old = run(dir, 'new', 'x', '--issue', '5', '--ask', 'c');
    expect(old.status).toBe(1);
    expect(old.stderr).toContain('specs/5-旧方案');
    expect(existsSync(join(dir, 'specs', '5-x'))).toBe(false);
  });

  it('单号 7 不被 77 挡住：只认「7-」开头的目录', () => {
    const dir = repo(TOPIC);
    mkdirSync(join(dir, 'specs', '77-a'));
    expect(run(dir, 'new', 'y', '--issue', '7', '--ask', 'e').status).toBe(0);
  });

  it('dated 布局给 --issue 是不认识的参数（退出 2）', () => {
    const dir = repo(undefined);
    mkdirSync(join(dir, 'docs'));
    const r = run(dir, 'new', 'ux', '--issue', '77', '--ask', '六点');
    expect([r.status, r.stderr.includes('--issue')]).toEqual([2, true]);
    expect(existsSync(join(dir, 'docs', 'ux'))).toBe(false);
  });

  it('配置互斥退出 2', () => {
    expect(run(repo({ ...TOPIC, suffix: '-x.md' }), 'check').status).toBe(2);
    expect(run(repo({ file: 'a.md' }), 'check').status).toBe(2);
  });

  it('check 只给文件：只查其中是稿的', () => {
    const dir = repo(TOPIC);
    mkdirSync(join(dir, 'specs', '9-bad'));
    writeFileSync(join(dir, 'specs', '9-bad', '讨论稿.md'), '# 坏稿\n');
    expect(run(dir, 'check', 'specs/5-旧方案/方案.md').stdout.trim()).toBe('讨论稿检查过了：0 份');
    expect(run(dir, 'check', 'specs/9-bad/讨论稿.md').status).toBe(1);
  });
});

describe('本仓自己的讨论稿', () => {
  it('都过推前检查（和 pnpm discuss:check 同一个判法）', () => {
    const today = new Date().toISOString().slice(0, 10);
    const r = lib.checkDrafts({ root: ROOT, today });
    expect(r.lines.filter((line) => line.startsWith('✗'))).toEqual([]);
    expect(r.code).toBe(0);
  });
});
