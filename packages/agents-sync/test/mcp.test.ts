// MCP 服务器配置（src/mcp.ts）：~/.claude.json 里 mcpServers.playwright.args 的 --output-dir。
// 覆盖「没装 Claude」「没 .claude.json」「没配 playwright」「配了但没 --output-dir」「值不对」「已经对了」「读不懂」几种。
import { existsSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Backups } from '../src/backup.ts';
import {
  applyMcp,
  checkMcp,
  fixArgs,
  judgeArgs,
  locate,
  MCP_TARGET,
  OUTPUT_DIR,
  OUTPUT_FLAG,
  SERVER_NAME,
} from '../src/mcp.ts';
import { placeOn } from '../src/targets.ts';
import { cleanup, ctxFor, get, getJson, kinds, PLATFORM, put, tempDir } from './helpers.ts';

afterEach(cleanup);

const NOW = new Date('2026-09-30T18:00:00Z');
const REL = placeOn(MCP_TARGET, PLATFORM);
const KEY = `~/.claude.json#mcpServers.${SERVER_NAME}`;

function machine(installed: 'claude' | 'none' = 'claude') {
  const home = tempDir('home');
  const ctx = ctxFor(home, installed === 'claude' ? ['claude'] : ['grok']);
  return {
    home,
    check: () => checkMcp(ctx),
    apply: () => applyMcp(ctx, new Backups(home, PLATFORM, NOW)),
    read: () => get(home, REL),
    readJson: () => getJson(home, REL) as { mcpServers?: Record<string, { args?: unknown[] }> },
    writeJson: (v: unknown) => put(home, REL, `${JSON.stringify(v, null, 2)}\n`),
    write: (text: string) => put(home, REL, text),
  };
}

const playwrightEntry = (args: unknown[] = []) => ({
  type: 'stdio',
  command: 'cmd',
  args,
});

describe('locate / judgeArgs / fixArgs（纯函数）', () => {
  it('没配 playwright：root 里没有 mcpServers、或 mcpServers 里没有它，都是 absent', () => {
    expect(locate({}).kind).toBe('absent');
    expect(locate({ mcpServers: {} }).kind).toBe('absent');
    expect(locate({ mcpServers: { other: { args: ['x'] } } }).kind).toBe('absent');
  });

  it('配了：args 原文列出；没写 args 字段当空数组', () => {
    const a = locate({ mcpServers: { playwright: playwrightEntry(['/c', 'x.cmd']) } });
    expect(a).toEqual({ kind: 'has', args: ['/c', 'x.cmd'] });
    expect(locate({ mcpServers: { playwright: { type: 'stdio', command: 'cmd' } } })).toEqual({
      kind: 'has',
      args: [],
    });
  });

  it('【故意造出的失败】整份不是对象、mcpServers 不是对象、playwright 不是对象、args 不是数组：unreadable，不猜成没配', () => {
    const cases: unknown[] = [
      'not an object',
      { mcpServers: 'not an object' },
      { mcpServers: { playwright: 'not an object' } },
      { mcpServers: { playwright: { args: 'not an array' } } },
    ];
    for (const root of cases) expect(locate(root).kind, JSON.stringify(root)).toBe('unreadable');
  });

  it('args 里没 --output-dir：missing；有就对／不对两说', () => {
    expect(judgeArgs(['/c', 'x.cmd']).kind).toBe('missing');
    expect(judgeArgs(['/c', 'x.cmd', OUTPUT_FLAG, OUTPUT_DIR])).toEqual({ kind: 'ok' });
    expect(judgeArgs([OUTPUT_FLAG, '别的地方'])).toEqual({ kind: 'drift', have: '别的地方' });
  });

  it('【故意造出的失败】--output-dir 写两遍、悬在末尾没值、值不是字符串：broken，不猜哪个对', () => {
    expect(judgeArgs([OUTPUT_FLAG, 'a', OUTPUT_FLAG, 'b']).kind).toBe('broken');
    expect(judgeArgs(['/c', 'x.cmd', OUTPUT_FLAG]).kind).toBe('broken');
    expect(judgeArgs([OUTPUT_FLAG, 42]).kind).toBe('broken');
    expect(fixArgs([OUTPUT_FLAG, 'a', OUTPUT_FLAG, 'b']).ok).toBe(false);
  });

  it('fixArgs 不该不动：已经对了返回 null', () => {
    expect(fixArgs(['/c', OUTPUT_FLAG, OUTPUT_DIR])).toEqual({ ok: true, args: null });
  });

  it('fixArgs 缺的补上、值不对的改成该有的；别的参数一个不动、顺序也不动', () => {
    const added = fixArgs(['/c', 'x.cmd', '--headless']);
    expect(added).toEqual({ ok: true, args: ['/c', 'x.cmd', '--headless', OUTPUT_FLAG, OUTPUT_DIR] });
    const replaced = fixArgs(['/c', 'x.cmd', OUTPUT_FLAG, './_pottery', '--browser', 'chrome']);
    expect(replaced).toEqual({
      ok: true,
      args: ['/c', 'x.cmd', OUTPUT_FLAG, OUTPUT_DIR, '--browser', 'chrome'],
    });
  });
});

describe('查（--check）', () => {
  it('没装 Claude Code：跳过', () => {
    const m = machine('none');
    expect(kinds(m.check(), KEY)).toEqual(['skip']);
    expect(existsSync(join(m.home, '.claude.json'))).toBe(false);
  });

  it('装了 Claude 但没 ~/.claude.json：跳过（Claude Code 还没起过），不算漂移', () => {
    const m = machine();
    expect(kinds(m.check(), KEY)).toEqual(['skip']);
  });

  it('有 .claude.json 但没配 playwright：跳过、不凭空装，不算缺失', () => {
    const m = machine();
    m.writeJson({ mcpServers: { context7: { type: 'http', url: 'https://x' } } });
    expect(kinds(m.check(), KEY)).toEqual(['skip']);
    const text = m.check()[0]?.text ?? '';
    expect(text).toContain('没配');
  });

  it('配了但没 --output-dir：missing', () => {
    const m = machine();
    m.writeJson({ mcpServers: { playwright: playwrightEntry(['/c', 'x.cmd']) } });
    expect(kinds(m.check(), KEY)).toEqual(['missing']);
  });

  it('--output-dir 值不对：drift；值对了：ok', () => {
    const bad = machine();
    bad.writeJson({ mcpServers: { playwright: playwrightEntry(['/c', 'x.cmd', OUTPUT_FLAG, './_tmp']) } });
    expect(kinds(bad.check(), KEY)).toEqual(['drift']);
    const good = machine();
    good.writeJson({
      mcpServers: { playwright: playwrightEntry(['/c', 'x.cmd', OUTPUT_FLAG, OUTPUT_DIR]) },
    });
    expect(kinds(good.check(), KEY)).toEqual(['ok']);
  });

  it('【故意造出的失败】~/.claude.json 不是 JSON：报没查成，不猜成没配', () => {
    const m = machine();
    m.write('{ this is not JSON\n');
    expect(kinds(m.check(), KEY)).toEqual(['unknown']);
    expect(m.check()[0]?.text ?? '').toContain('没查成');
  });

  it('【故意造出的失败】mcpServers 不是对象 / args 不是数组：unknown', () => {
    for (const root of [{ mcpServers: 'nope' }, { mcpServers: { playwright: { args: 'nope' } } }]) {
      const m = machine();
      m.writeJson(root);
      expect(kinds(m.check(), KEY), JSON.stringify(root)).toEqual(['unknown']);
    }
  });

  it('【故意造出的失败】--output-dir 写两遍：unknown，不猜哪个对', () => {
    const m = machine();
    m.writeJson({
      mcpServers: { playwright: playwrightEntry(['/c', 'x.cmd', OUTPUT_FLAG, 'a', OUTPUT_FLAG, 'b']) },
    });
    expect(kinds(m.check(), KEY)).toEqual(['unknown']);
  });
});

describe('写（--apply）', () => {
  it('没装 Claude Code：跳过、不建文件', () => {
    const m = machine('none');
    expect(kinds(m.apply(), KEY)).toEqual(['skip']);
    expect(existsSync(join(m.home, '.claude.json'))).toBe(false);
  });

  it('装了 Claude 但没 ~/.claude.json：跳过、不凭空建', () => {
    const m = machine();
    expect(kinds(m.apply(), KEY)).toEqual(['skip']);
    expect(existsSync(join(m.home, '.claude.json'))).toBe(false);
  });

  it('没配 playwright：跳过、不凭空装', () => {
    const m = machine();
    m.writeJson({ mcpServers: { context7: { type: 'http', url: 'https://x' } } });
    expect(kinds(m.apply(), KEY)).toEqual(['skip']);
    expect(m.readJson().mcpServers?.[SERVER_NAME]).toBeUndefined();
  });

  it('已经对了：ok、零改动、不留备份', () => {
    const m = machine();
    m.writeJson({
      mcpServers: { playwright: playwrightEntry(['/c', 'x.cmd', OUTPUT_FLAG, OUTPUT_DIR]) },
    });
    expect(kinds(m.apply(), KEY)).toEqual(['ok']);
    expect(existsSync(join(m.home, '.fleet-dao', 'backups'))).toBe(false);
  });

  it('配了但没 --output-dir：在 args 末尾补上，别的 MCP、args 里别的参数一个不动；改前留备份', () => {
    const m = machine();
    const before = {
      mcpServers: {
        playwright: playwrightEntry(['/c', 'D:/tools/playwright-mcp.cmd', '--headless']),
        context7: { type: 'http', url: 'https://mcp.context7.com/mcp' },
      },
      someOtherKey: { nested: ['别动我'] },
    };
    m.writeJson(before);
    expect(kinds(m.apply(), KEY)).toEqual(['changed']);
    const after = m.readJson();
    expect(after.mcpServers?.[SERVER_NAME]?.args).toEqual([
      '/c',
      'D:/tools/playwright-mcp.cmd',
      '--headless',
      OUTPUT_FLAG,
      OUTPUT_DIR,
    ]);
    expect(after.mcpServers?.context7).toEqual(before.mcpServers.context7);
    expect((after as Record<string, unknown>).someOtherKey).toEqual(before.someOtherKey);
    // 留了备份，内容是改前的原文
    const backupRoot = join(m.home, '.fleet-dao', 'backups');
    const [stamp] = readdirSync(backupRoot);
    const restored = getJson(join(backupRoot, stamp as string), REL);
    expect(restored).toEqual(before);
  });

  it('--output-dir 值不对的改成 _tmp/playwright，位置不动，args 里别的参数不动', () => {
    const m = machine();
    m.writeJson({
      mcpServers: {
        playwright: playwrightEntry(['/c', 'x.cmd', OUTPUT_FLAG, './_pottery', '--browser', 'chrome']),
      },
    });
    expect(kinds(m.apply(), KEY)).toEqual(['changed']);
    expect(m.readJson().mcpServers?.[SERVER_NAME]?.args).toEqual([
      '/c',
      'x.cmd',
      OUTPUT_FLAG,
      OUTPUT_DIR,
      '--browser',
      'chrome',
    ]);
  });

  it('CRLF 的 .claude.json：写回也是 CRLF', () => {
    const m = machine();
    m.write('{\r\n  "mcpServers": {\r\n    "playwright": {\r\n      "args": ["x"]\r\n    }\r\n  }\r\n}\r\n');
    m.apply();
    expect(m.read()).toContain('\r\n');
    expect(m.read()).not.toMatch(/[^\r]\n/); // 没有混进 LF-only 的行
  });

  it('【故意造出的失败】args 里 --output-dir 写两遍：failed、整份不改', () => {
    const m = machine();
    const before = {
      mcpServers: { playwright: playwrightEntry(['/c', 'x.cmd', OUTPUT_FLAG, 'a', OUTPUT_FLAG, 'b']) },
    };
    m.writeJson(before);
    expect(kinds(m.apply(), KEY)).toEqual(['failed']);
    expect(m.readJson()).toEqual(before);
  });

  it('【故意造出的失败】~/.claude.json 不是 JSON：failed、不拿空的顶上重写', () => {
    const m = machine();
    const before = '{ not json\n';
    m.write(before);
    expect(kinds(m.apply(), KEY)).toEqual(['failed']);
    expect(m.read()).toBe(before);
  });

  it('【故意造出的失败】args 不是数组：failed、不改', () => {
    const m = machine();
    const before = { mcpServers: { playwright: { args: 'nope' } } };
    m.writeJson(before);
    expect(kinds(m.apply(), KEY)).toEqual(['failed']);
    expect(m.readJson()).toEqual(before);
  });

  it.skipIf(PLATFORM === 'win32')('【故意造出的失败】~/.claude.json 是个链接：不跟过去改，failed', () => {
    const m = machine();
    const real = put(tempDir('dotfiles'), 'claude.json', '{"mcpServers":{}}\n');
    symlinkSync(real, join(m.home, '.claude.json'));
    expect(kinds(m.check(), KEY)).toEqual(['unknown']);
    expect(kinds(m.apply(), KEY)).toEqual(['failed']);
  });

  it('幂等：写完再写一次零改动', () => {
    const m = machine();
    m.writeJson({ mcpServers: { playwright: playwrightEntry(['/c', 'x.cmd']) } });
    m.apply();
    const second = m.apply();
    expect(kinds(second, KEY)).toEqual(['ok']);
  });
});

describe('和仓里约定', () => {
  it('输出目录就是通用段说的那个 _tmp/playwright（改它要同时改仓里 .gitignore 的 _tmp/ 那一条）', () => {
    expect(OUTPUT_DIR).toBe('_tmp/playwright');
    expect(OUTPUT_DIR).not.toContain('\\');
    expect(OUTPUT_DIR.startsWith('/')).toBe(false);
    expect(OUTPUT_DIR.startsWith('./')).toBe(false);
  });
});
