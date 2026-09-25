// --retire-old：只撤指向旧仓的链接和那两个旧子代理，每项先备份；别的一律不碰。
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Backups } from '../src/backup.ts';
import { exitCode } from '../src/report.ts';
import { retireOld } from '../src/retire.ts';
import { cleanup, expectKind, get, linkDir, PLATFORM, put, tempDir } from './helpers.ts';

afterEach(cleanup);

const NOW = new Date('2026-09-25T07:00:00Z');
const STAMP = '2026-09-25T07-00-00-000Z';

function oldMachine() {
  const home = tempDir('home');
  const old = tempDir('old-repo');
  const plugin = tempDir('plugin');
  for (const s of ['dispatch', 'grill-me', 'dao-commit'])
    put(old, `host/skills/${s}/SKILL.md`, `旧仓的 ${s}\n`);
  put(plugin, 'skills/github/SKILL.md', '插件的 github\n');
  linkDir(join(old, 'host', 'skills', 'dispatch'), join(home, '.claude', 'skills', 'dispatch'));
  linkDir(join(old, 'host', 'skills', 'grill-me'), join(home, '.claude', 'skills', 'grill-me'));
  linkDir(join(old, 'host', 'skills', 'dao-commit'), join(home, '.pi', 'agent', 'skills', 'dao-commit'));
  linkDir(join(plugin, 'skills', 'github'), join(home, '.claude', 'skills', 'github'));
  linkDir(join(plugin, 'skills', 'github'), join(home, '.agents', 'skills', 'github'));
  put(home, '.claude/skills/chain-first/SKILL.md', '本脚本装的真目录\n');
  put(home, '.claude/skills/synced/bucket/SKILL.md', 'claude.ai 同步来的\n');
  for (const a of ['dao-vps-readback', 'dao-chain-diagnoser', 'dao-scout', 'dao-fixer']) {
    put(home, `.claude/agents/${a}.md`, `# ${a}\n`);
  }
  const run = () => retireOld({ home, platform: PLATFORM, oldRepo: old }, new Backups(home, PLATFORM, NOW));
  return { home, old, plugin, run };
}

describe('--retire-old', () => {
  it('只撤指向旧仓的链接，旧仓里的文件一个不少', () => {
    const m = oldMachine();
    const lines = m.run();
    expectKind(lines, '~/.claude/skills/dispatch', 'changed');
    expectKind(lines, '~/.claude/skills/grill-me', 'changed');
    expectKind(lines, '~/.pi/agent/skills/dao-commit', 'changed');
    expect(readdirSync(join(m.home, '.claude', 'skills')).sort()).toEqual([
      'chain-first',
      'github',
      'synced',
    ]);
    expect(existsSync(join(m.home, '.pi', 'agent', 'skills', 'dao-commit'))).toBe(false);
    for (const s of ['dispatch', 'grill-me', 'dao-commit']) {
      expect(get(m.old, `host/skills/${s}/SKILL.md`)).toBe(`旧仓的 ${s}\n`);
    }
    expect(exitCode(lines)).toBe(0);
  });

  it('不指向旧仓的链接、真目录一律不碰', () => {
    const m = oldMachine();
    m.run();
    expect(lstatSync(join(m.home, '.claude', 'skills', 'github')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(m.home, '.agents', 'skills', 'github')).isSymbolicLink()).toBe(true);
    expect(get(m.home, '.claude/skills/github/SKILL.md')).toBe('插件的 github\n');
    expect(get(m.home, '.claude/skills/chain-first/SKILL.md')).toBe('本脚本装的真目录\n');
    expect(get(m.home, '.claude/skills/synced/bucket/SKILL.md')).toBe('claude.ai 同步来的\n');
  });

  it('撤的每个链接先记下指向哪（links.json），输出逐项列出', () => {
    const m = oldMachine();
    const lines = m.run();
    const record = join(m.home, '.fleet-dao', 'backups', STAMP, 'links.json');
    const links = JSON.parse(readFileSync(record, 'utf8')) as { path: string; target: string }[];
    expect(links.map((l) => l.path).sort()).toEqual([
      '.claude/skills/dispatch',
      '.claude/skills/grill-me',
      '.pi/agent/skills/dao-commit',
    ]);
    expect(links.find((l) => l.path === '.claude/skills/dispatch')?.target).toBe(
      join(m.old, 'host', 'skills', 'dispatch'),
    );
    expect(lines.find((l) => l.key === '~/.claude/skills/dispatch')?.text).toContain(record);
  });

  it('两个旧子代理先备份再撤，dao-scout、dao-fixer 留着', () => {
    const m = oldMachine();
    const lines = m.run();
    for (const a of ['dao-vps-readback', 'dao-chain-diagnoser']) {
      expectKind(lines, `~/.claude/agents/${a}.md`, 'changed');
      expect(existsSync(join(m.home, '.claude', 'agents', `${a}.md`))).toBe(false);
      const saved = join(m.home, '.fleet-dao', 'backups', STAMP, '.claude', 'agents', `${a}.md`);
      expect(readFileSync(saved, 'utf8')).toBe(`# ${a}\n`);
    }
    expect(readdirSync(join(m.home, '.claude', 'agents')).sort()).toEqual(['dao-fixer.md', 'dao-scout.md']);
  });

  it('第二遍：没有要撤的，一处不动', () => {
    const m = oldMachine();
    m.run();
    const again = m.run();
    expect(again.filter((l) => l.kind !== 'ok')).toEqual([]);
    expect(again[0]?.text).toContain('没有要撤的');
  });
});
