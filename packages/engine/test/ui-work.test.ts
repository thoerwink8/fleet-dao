// 界面活的判法（ui-work.ts）：改到页面代码算界面活；名单读不成、是空的认不出，也按界面活处理（宁可不派 GPT）。
import { describe, expect, it } from 'vitest';
import { judgeImplementUiWork, judgeUiWork, pathsIn } from '../src/ui-work.ts';

describe('pathsIn（单子文字里写在反引号里的路径）', () => {
  it('目录补结尾斜杠、文件原样；不带斜杠又不像文件名的不算；网址、绝对路径、带空格的不算', () => {
    expect(
      pathsIn(
        '`packages/web` `packages/engine/src/a.ts:12` `uiWork` `https://x.y/z` `/etc/x` `a b/c` `README.md`',
      ),
    ).toEqual(['packages/web/', 'packages/engine/src/a.ts', 'README.md']);
  });

  it('通配：取通配前面那段目录；通配的是页面后缀的再补一条', () => {
    expect(pathsIn('`packages/web/**/*.tsx`')).toEqual(['packages/web/', 'x.tsx']);
    expect(pathsIn('`*.css`')).toEqual(['x.css']);
  });
});

describe('judgeImplementUiWork（动手前判：上一轮改到的文件名 + 单子里写的路径）', () => {
  const none: string[] = [];

  it('已知的模块写了页面目录（第 1 轮没有文件名）：界面活', () => {
    expect(
      judgeImplementUiWork({ touches: ['`packages/web/src/pages/`：页面'], changedFiles: none }),
    ).toMatchObject({
      uiWork: true,
      recognized: true,
    });
  });

  it('模块栏是后端、正文里另写了页面路径：界面活', () => {
    expect(
      judgeImplementUiWork({
        touches: ['`packages/engine/src/a.ts`'],
        request: '顺带改 `deploy/web/health/index.html`',
        changedFiles: none,
      }),
    ).toMatchObject({ uiWork: true, recognized: true });
  });

  it('上一轮改到了页面文件：界面活，哪怕单子里写的都是后端', () => {
    expect(
      judgeImplementUiWork({
        touches: ['`packages/engine/src/a.ts`'],
        changedFiles: ['packages/engine/src/a.ts', 'packages/web/src/x.tsx'],
      }),
    ).toMatchObject({ uiWork: true, recognized: true });
  });

  it('单子里写的和上一轮改到的都只有后端：认出来了，不是界面活', () => {
    expect(
      judgeImplementUiWork({
        touches: ['`packages/engine/src/a.ts`：引擎', '`packages/db/routing.default.json`'],
        request: '改 `packages/engine/src/b.ts`',
        changedFiles: ['packages/engine/src/a.ts'],
      }),
    ).toMatchObject({ uiWork: false, recognized: true });
  });

  it('【故意造出的失败】单子里一个路径都没认出来：判不出，按界面活处理', () => {
    expect(
      judgeImplementUiWork({ touches: ['驾驶舱页面'], request: '没有路径', changedFiles: none }),
    ).toMatchObject({
      uiWork: true,
      recognized: false,
    });
    expect(judgeImplementUiWork({ touches: [], changedFiles: none })).toMatchObject({
      uiWork: true,
      recognized: false,
    });
  });

  it('【故意造出的失败】模块栏有一项认不出路径（别的项都是后端）：判不出，按界面活处理', () => {
    expect(
      judgeImplementUiWork({
        touches: ['`packages/engine/src/a.ts`', '那个管页面的模块'],
        changedFiles: none,
      }),
    ).toMatchObject({ uiWork: true, recognized: false });
  });

  it('【故意造出的失败】上一轮的文件名单里有读不成文件名的项：判不出，按界面活处理', () => {
    expect(
      judgeImplementUiWork({ touches: ['`packages/engine/src/a.ts`'], changedFiles: ['a.ts', ''] }),
    ).toMatchObject({ uiWork: true, recognized: false });
  });
});

describe('judgeUiWork', () => {
  it('改到驾驶舱前端、健康页目录下的任何文件：界面活', () => {
    expect(judgeUiWork(['packages/engine/src/a.ts', 'packages/web/src/api/x.ts'])).toMatchObject({
      uiWork: true,
      recognized: true,
    });
    expect(judgeUiWork(['deploy/web/health/health.js'])).toMatchObject({ uiWork: true, recognized: true });
  });

  it('不在那两个目录、但是页面文件后缀（tsx/css/html…，不分大小写、认反斜杠）：界面活', () => {
    for (const f of ['x/Panel.TSX', 'a/b.css', 'index.html', 'src\\view.vue']) {
      expect(judgeUiWork([f])).toMatchObject({ uiWork: true, recognized: true });
    }
  });

  it('只改后端、文档、脚本：认出来了，不是界面活', () => {
    expect(judgeUiWork(['packages/engine/src/a.ts', 'docs/design.md', 'agents/hooks/x.mjs'])).toEqual({
      uiWork: false,
      recognized: true,
      why: '没有改到页面代码',
    });
  });

  it('名字里带 web 但不是那个目录（packages/webhook、deploy/website）：不误判成界面活', () => {
    expect(judgeUiWork(['packages/webhook/src/a.ts', 'deploy/website/x.ts']).uiWork).toBe(false);
  });

  it('【故意造出的失败】名单是空的：认不出，按界面活处理（不当成「不是界面」）', () => {
    expect(judgeUiWork([])).toMatchObject({ uiWork: true, recognized: false });
  });

  it('【故意造出的失败】名单里有读不成文件名的项（空串、不是字符串）：认不出，按界面活处理，哪怕别的项都不是页面', () => {
    expect(judgeUiWork(['packages/engine/src/a.ts', ''])).toMatchObject({ uiWork: true, recognized: false });
    expect(judgeUiWork(['packages/engine/src/a.ts', undefined])).toMatchObject({
      uiWork: true,
      recognized: false,
    });
  });
});
