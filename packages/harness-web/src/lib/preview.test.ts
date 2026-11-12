import { describe, expect, it } from 'vitest';
import { previewText, repairMojibake, sessionTitle } from './preview';

const garbled = String.fromCharCode(0xe4, 0xbc, 0x9a, 0xe8, 0xaf, 0x9d);

describe('会话标题和预览', () => {
  it('有标题用标题，没有就叫新会话，不拿会话号当标题', () => {
    expect(sessionTitle('修登录页')).toBe('修登录页');
    expect(sessionTitle('  ')).toBe('新会话');
    expect(sessionTitle(undefined)).toBe('新会话');
  });

  it('Latin-1 误读的 UTF-8 还原成中文，正常中文不动', () => {
    expect(repairMojibake(garbled)).toBe('会话');
    expect(repairMojibake('会话')).toBe('会话');
  });

  it('预览取人话，内部事件和乱码 JSON 行都不拿来充', () => {
    expect(previewText('session.turn.started', { text: '' })).toBe('');
    expect(previewText('session.created', { agent: 'claude' })).toBe('');
    expect(previewText('session.message', { text: garbled })).toBe('会话');
    expect(
      previewText('transcript.assistant', {
        text: '{"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]}}',
      }),
    ).toBe('你好');
  });

  it('只有 stderr、没有正文时预览不含 stderr', () => {
    const preview = previewText('session.turn.settled', {
      outcome: 'stopped',
      text: '',
      stderr: '同步配置…',
    });
    expect(preview).not.toContain('同步配置');
    expect(preview).toBe('已停止');
    expect(previewText('session.message', { text: '把第二行改掉' })).toBe('把第二行改掉');
  });
});
