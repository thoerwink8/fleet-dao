import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { withIssueLinks } from './request-stream';

const html = (text: string) => renderToStaticMarkup(<>{withIssueLinks(text)}</>);

describe('系统的话里的单子网址', () => {
  test('「开出 #12：网址」并成一个能点的 #12，不铺整串网址', () => {
    const out = html(
      '创始人甲 确定开单（草稿第 2 版），已结案。开出 #12：https://github.com/example/canary/issues/12',
    );
    expect(out).toContain('开出 <a href="https://github.com/example/canary/issues/12"');
    // 外链后面带一个小箭头图标（TextLink），链接文字还是「#12」
    expect(out).toContain('>#12<svg');
    expect(out).not.toContain('#12：');
    expect(out).not.toContain('>https://');
  });

  test('没有网址的原样留着；只有网址的也收成 #号', () => {
    expect(html('再聊聊：范围太大')).toBe('再聊聊：范围太大');
    expect(html('见 https://github.com/a/b/pull/7 。')).toMatch(/>#7<svg[\s\S]*<\/a> 。/);
  });
});
