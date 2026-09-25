// --apply 写完照查一遍（verify，cli.ts 在写完之后调）：写的时候报「改了」或「一致」、读回却漂移、缺失、没查成的，
// 补一行报出来，退出码跟着变；写的时候已经报过「没做成」的同一项不重复报。
import { describe, expect, it } from 'vitest';
import { exitCode, type Kind, type Line, line } from '../src/report.ts';
import { verify } from '../src/sync.ts';

const CLAUDE = '~/.claude/CLAUDE.md';
const CODEX = '~/.codex/AGENTS.md';
const SKILL = '~/.agents/skills/grill-me';

describe('写时没报错、读回不对：补一行', () => {
  it.each<[Kind, Kind]>([
    ['changed', 'drift'],
    ['changed', 'missing'],
    ['changed', 'unknown'],
    ['ok', 'drift'],
    ['ok', 'missing'],
    ['ok', 'unknown'],
  ])('写时 %s、读回 %s：报一行，结论照读回的，前面写明是写完读回不对', (wrote, after) => {
    const bad = verify([line(wrote, CLAUDE, '写上了')], [line(after, CLAUDE, '和仓里不一样')]);
    expect(bad).toEqual([{ kind: after, key: CLAUDE, text: `写完读回不对：${CLAUDE}：和仓里不一样` }]);
  });

  it('补的那行进了总账：读回漂移，退出码 1；只是没查成，退出码 2', () => {
    const done: Line[] = [line('changed', CLAUDE, '写上了'), line('ok', CODEX, '一致')];
    const drift = verify(done, [line('drift', CLAUDE, '和仓里不一样'), line('ok', CODEX, '一致')]);
    expect(exitCode(done)).toBe(0);
    expect(exitCode([...done, ...drift])).toBe(1);
    const unknown = verify(done, [line('ok', CLAUDE, '一致'), line('unknown', CODEX, '没查成——EIO')]);
    expect(exitCode([...done, ...unknown])).toBe(2);
  });

  it('几项里只报读回不对的那几项', () => {
    const done = [
      line('changed', CLAUDE, '写上了'),
      line('changed', CODEX, '写上了'),
      line('changed', SKILL, '装上了'),
    ];
    const after = [
      line('ok', CLAUDE, '一致'),
      line('missing', CODEX, '没有这个文件'),
      line('drift', SKILL, '内容不一样'),
    ];
    expect(verify(done, after).map((l) => [l.key, l.kind])).toEqual([
      [CODEX, 'missing'],
      [SKILL, 'drift'],
    ]);
  });
});

describe('不该报的不报', () => {
  it('写时已报没做成的同一项：读回再不对也不重复报', () => {
    const done = [line('failed', CLAUDE, '没做成——EACCES')];
    expect(verify(done, [line('missing', CLAUDE, '没有这个文件')])).toEqual([]);
    expect(verify(done, [line('unknown', CLAUDE, '没查成——EACCES')])).toEqual([]);
  });

  it('只认同一项：别的项报过没做成，不挡这一项', () => {
    const done = [line('failed', CODEX, '没做成——EACCES'), line('changed', CLAUDE, '写上了')];
    const after = [line('missing', CODEX, '没有这个文件'), line('drift', CLAUDE, '和仓里不一样')];
    expect(verify(done, after).map((l) => l.key)).toEqual([CLAUDE]);
  });

  it('读回一致、没装跳过：不报', () => {
    const done = [line('changed', CLAUDE, '写上了'), line('skip', CODEX, '没装，跳过')];
    expect(verify(done, [line('ok', CLAUDE, '一致'), line('skip', CODEX, '没装，跳过')])).toEqual([]);
  });
});
