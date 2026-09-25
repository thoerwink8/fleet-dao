import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BEGIN, blockAt, END, findMarkers, replaceBlock, sharedBlock } from '../src/block.ts';
import { AGENTS_MD, BLOCK } from './helpers.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('标记', () => {
  it('没有标记：none', () => {
    expect(findMarkers('# 我自己的\n- 一条\n')).toEqual({ kind: 'none' });
  });

  it('一对：圈出从开始标记行首到结束标记行尾', () => {
    const text = `前言\n${BLOCK}\n后记\n`;
    const m = findMarkers(text);
    expect(m.kind).toBe('one');
    if (m.kind !== 'one') return;
    expect(blockAt(text, m)).toBe(BLOCK);
  });

  it('两个开始标记、只有开始、结束在前：都算不成对', () => {
    expect(findMarkers(`${BEGIN}\n${BEGIN}\n${END}\n`).kind).toBe('broken');
    expect(findMarkers(`${BEGIN}\n内容\n`).kind).toBe('broken');
    expect(findMarkers(`${END}\n内容\n${BEGIN}\n`)).toEqual({
      kind: 'broken',
      why: '结束标记在开始标记前面',
    });
  });

  it('行尾的 \\r 和空白不妨碍认标记', () => {
    const text = `前言\r\n${BEGIN}  \r\n内容\r\n${END}\r\n`;
    expect(findMarkers(text).kind).toBe('one');
  });
});

describe('换块', () => {
  it('标记外的每个字节原样留着', () => {
    const before = '我的前言\n\n';
    const after = '\n\n我的后记，不许动\n';
    const old = `${BEGIN}\n旧的内容\n${END}`;
    const text = before + old + after;
    const m = findMarkers(text);
    if (m.kind !== 'one') throw new Error('应认出一对标记');
    expect(replaceBlock(text, m, BLOCK)).toBe(before + BLOCK + after);
  });

  it('文件是 \\r\\n 换行的，换进去的块也用 \\r\\n', () => {
    const text = `前言\r\n${BEGIN}\r\n旧\r\n${END}\r\n后记\r\n`;
    const m = findMarkers(text);
    if (m.kind !== 'one') throw new Error('应认出一对标记');
    expect(replaceBlock(text, m, BLOCK)).toBe(`前言\r\n${BLOCK.replaceAll('\n', '\r\n')}\r\n后记\r\n`);
  });
});

describe('仓里的通用段', () => {
  it('从 AGENTS.md 取出含两行标记的一块', () => {
    expect(sharedBlock(AGENTS_MD)).toEqual({ ok: true, block: BLOCK });
  });

  it('标记不成对、没有标记、标记之间是空的：都给出原因，不拿空的顶上', () => {
    expect(sharedBlock(`# 仓\n${BEGIN}\n内容\n`)).toMatchObject({ ok: false });
    expect(sharedBlock('# 仓\n')).toEqual({ ok: false, why: '没有通用段的标记' });
    expect(sharedBlock(`${BEGIN}\n${END}\n`)).toEqual({ ok: false, why: '两行标记之间是空的' });
  });

  it('本仓的 AGENTS.md：标记成对，圈住的是通用段、不含「本仓」那半', () => {
    const got = sharedBlock(readFileSync(join(REPO, 'AGENTS.md'), 'utf8'));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.block.startsWith(`${BEGIN}\n`)).toBe(true);
    expect(got.block.endsWith(`\n${END}`)).toBe(true);
    expect(got.block).toContain('\n## 怎么跟我说话\n');
    expect(got.block).toContain('\n## 我的机器与模型\n');
    expect(got.block).not.toContain('## 本仓');
  });
});
