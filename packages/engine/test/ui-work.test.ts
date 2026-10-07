// 界面活的判法（ui-work.ts）：改到页面代码算界面活；名单读不成、是空的认不出，也按界面活处理（宁可不派 GPT）。
import { describe, expect, it } from 'vitest';
import { judgeUiWork } from '../src/ui-work.ts';

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
