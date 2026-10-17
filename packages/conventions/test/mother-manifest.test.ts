import { describe, expect, it } from 'vitest';
import { readManifest, withManifest } from '../src/mother-manifest.ts';

const block = (json: string) => `<!-- fleet:mother-manifest -->\n${json}\n<!-- /fleet:mother-manifest -->`;

describe('母单 manifest 严格读取', () => {
  it('保留顺序，记录精确字符边界，空数组也是完整清单', () => {
    const text = `需求\r\n${block('[42,7]').replaceAll('\n', '\r\n')}\r\n验收`;
    const parsed = readManifest(text);
    expect(parsed).toEqual({ kind: 'valid', children: [42, 7], start: 4, end: text.indexOf('\r\n验收') });
    if (parsed.kind !== 'valid') throw new Error('没有读出清单');
    expect(text.slice(parsed.start, parsed.end)).toBe(block('[42,7]').replaceAll('\n', '\r\n'));
    expect(readManifest(block('[]'))).toMatchObject({ kind: 'valid', children: [] });
    expect(readManifest('没有清单')).toEqual({ kind: 'absent' });
  });

  it('引用、围栏和缩进代码中的示例不是真清单', () => {
    const example = block('[1]');
    const text = [
      example
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n'),
      `\`\`\`md\n${example}\n\`\`\``,
      `~~~~\n${example}\n~~~~`,
      example
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n'),
      block('[99]'),
    ].join('\n');
    expect(readManifest(text)).toMatchObject({ kind: 'valid', children: [99] });
  });

  it.each([
    block('[1,1]'),
    block('[0]'),
    block('[-1]'),
    block('[1.5]'),
    block('[9007199254740992]'),
    block('["1"]'),
    block('[true]'),
    block('[null]'),
    block('{}'),
    block('[1,]'),
    block('not-json'),
    block('[1]\n'),
    block('\n[1]'),
    '<!-- fleet:mother-manifest -->\n[1]',
    '<!-- /fleet:mother-manifest -->',
    `${block('[1]')}\n${block('[2]')}`,
    '<!-- fleet:mother-manifest -->\n[1]\n<!-- fleet:mother-manifest -->',
    '<!-- fleet:mother-manifest --> extra\n[1]\n<!-- /fleet:mother-manifest -->',
  ])('畸形或重复段不能当没写：%s', (text) => {
    expect(readManifest(text)).toMatchObject({ kind: 'invalid', why: expect.any(String) });
    expect(() => withManifest(text, [2])).toThrow();
  });
});

describe('母单 manifest 写入', () => {
  it('缺失时前置，数字排序去重，需求正文原样保留；重复运行不改字', () => {
    const original = '## 场景\n\n需求原文\r\n';
    const result = withManifest(original, [10, 2, 10]);
    expect(result).toBe(`${block('[2,10]')}\n\n${original}`);
    expect(withManifest(result, [2, 10])).toBe(result);
  });

  it('已有合法段只原位替换，前后换行和文字保留', () => {
    const before = `上文\r\n${block('[1]')}\r\n下文`;
    expect(withManifest(before, [])).toBe(`上文\r\n${block('[]')}\r\n下文`);
  });

  it.each(['<!-- 未闭合', '```md\n未闭合'])('原正文含 %s 时前置段仍能严格读取', (body) => {
    expect(readManifest(withManifest(body, [8]))).toMatchObject({ kind: 'valid', children: [8] });
  });

  it.each([[0], [-1], [1.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1]])(
    '拒绝非法子单号 %j，不写坏清单',
    (...children) => {
      expect(() => withManifest('正文', children)).toThrow();
    },
  );
});
