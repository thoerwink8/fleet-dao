import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, type ClaudeArgsSpec } from '../src/claude-code/args.ts';

const ID = '8e188c1c-4430-4735-9eb2-bbb3d9f012c6';
const base: ClaudeArgsSpec = {
  model: 'claude-opus-5-5',
  session: { mode: 'new', id: ID },
  permissionMode: 'bypassPermissions',
};

describe('buildClaudeArgs', () => {
  it('新会话：无头 stream-json 必带 --verbose，只读项目级设置，权限弹窗一律当场拒，用我们给的会话号', () => {
    expect(buildClaudeArgs(base)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'claude-opus-5-5',
      '--setting-sources',
      'project',
      '--strict-mcp-config',
      '--permission-mode',
      'bypassPermissions',
      '--permission-prompts',
      'none',
      '--session-id',
      ID,
    ]);
  });

  it('续会话用 --resume，不再带 --session-id', () => {
    const args = buildClaudeArgs({ ...base, session: { mode: 'resume', id: ID } });
    expect(args.slice(-2)).toEqual(['--resume', ID]);
    expect(args).not.toContain('--session-id');
  });

  it('--allowedTools 放在最后、值并成一个参数（它吃变长参数，后面不能再有别的）', () => {
    const args = buildClaudeArgs({ ...base, allowedTools: ['Read', 'Bash(git diff:*)'], effort: 'high' });
    expect(args.slice(-2)).toEqual(['--allowedTools', 'Read,Bash(git diff:*)']);
    expect(args).toContain('--effort');
  });

  it('不用 --bare（经 reclaude 起会认证失败，回一条 <synthetic> 占位）', () => {
    expect(buildClaudeArgs(base)).not.toContain('--bare');
  });

  it('默认存会话记录（干活的会话要能续）；persistSession: false 才带 --no-session-persistence', () => {
    expect(buildClaudeArgs(base)).not.toContain('--no-session-persistence');
    expect(buildClaudeArgs({ ...base, persistSession: true })).not.toContain('--no-session-persistence');
    expect(buildClaudeArgs({ ...base, persistSession: false })).toContain('--no-session-persistence');
  });

  it('不存记录又要续会话、fork：写错了，当场拒（不存的会话续不上）', () => {
    expect(() =>
      buildClaudeArgs({ ...base, persistSession: false, session: { mode: 'resume', id: ID } }),
    ).toThrow('只能是新会话');
    expect(() =>
      buildClaudeArgs({
        ...base,
        persistSession: false,
        session: { mode: 'fork', from: '11111111-1111-4111-8111-111111111111', id: ID },
      }),
    ).toThrow('只能是新会话');
  });

  it('拒绝不合法的模型名和会话号', () => {
    expect(() => buildClaudeArgs({ ...base, model: '--bare' })).toThrow('模型名');
    expect(() => buildClaudeArgs({ ...base, model: 'opus 5' })).toThrow('模型名');
    expect(() => buildClaudeArgs({ ...base, session: { mode: 'resume', id: 'latest' } })).toThrow('UUID');
  });
});

describe('fork（换会话用户接着干：带着旧会话的记录开一个新编号）', () => {
  const FROM = '11111111-1111-4111-8111-111111111111';

  it('拼成 --resume <旧编号> --fork-session --session-id <新编号>', () => {
    const args = buildClaudeArgs({ ...base, session: { mode: 'fork', from: FROM, id: ID } });
    expect(args.slice(-5)).toEqual(['--resume', FROM, '--fork-session', '--session-id', ID]);
  });

  it('from、id 都要是 UUID', () => {
    expect(() => buildClaudeArgs({ ...base, session: { mode: 'fork', from: 'latest', id: ID } })).toThrow(
      'UUID',
    );
    expect(() =>
      buildClaudeArgs({ ...base, session: { mode: 'fork', from: FROM, id: 'not-a-uuid' } }),
    ).toThrow('UUID');
  });

  it('from 和 id 不能一样（fork 出来的必须是新编号）', () => {
    expect(() => buildClaudeArgs({ ...base, session: { mode: 'fork', from: FROM, id: FROM } })).toThrow(
      '不能和旧会话号一样',
    );
  });
});
