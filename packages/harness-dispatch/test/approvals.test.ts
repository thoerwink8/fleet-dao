import { describe, expect, it } from 'vitest';
import {
  allowFrame,
  approvalsFor,
  clipInput,
  denyFrame,
  initializeFrame,
  needsPerson,
  parseControlRequest,
  parseControlResponse,
  toolCategory,
} from '../src/ade/approvals.ts';

describe('审批帧', () => {
  it('命令、联网、改文件分开；只有改文件不用人点', () => {
    expect(toolCategory('Bash')).toBe('command');
    expect(toolCategory('WebFetch')).toBe('network');
    expect(toolCategory('Edit')).toBe('edit');
    expect(toolCategory('其他工具')).toBe('other');
    expect(needsPerson('edit')).toBe(false);
    expect(needsPerson('command')).toBe(true);
    expect(needsPerson('network')).toBe(true);
    expect(needsPerson('other')).toBe(true);
    expect(approvalsFor('claude')).toBe('per-call');
    expect(approvalsFor('grok')).toBe('none');
    expect(approvalsFor('codex')).toBe('none');
  });

  it('允许帧带原参数，拒绝帧不带', () => {
    const input = { command: 'git init' };
    const allow = JSON.parse(allowFrame('req-1', input)) as {
      response: { response: { behavior: string; updatedInput: unknown } };
    };
    expect(allow.response.response.behavior).toBe('allow');
    expect(allow.response.response.updatedInput).toEqual(input);
    const deny = JSON.parse(denyFrame('req-1')) as {
      response: { response: { behavior: string; updatedInput?: unknown } };
    };
    expect(deny.response.response.behavior).toBe('deny');
    expect(deny.response.response.updatedInput).toBeUndefined();
  });

  it('认 control_request，别的行不管', () => {
    const line = JSON.stringify({
      type: 'control_request',
      request_id: 'req-9',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git init' } },
    });
    expect(parseControlRequest(line)).toEqual({
      kind: 'can_use_tool',
      requestId: 'req-9',
      tool: 'Bash',
      input: { command: 'git init' },
    });
    expect(parseControlRequest('你好')).toBeNull();
    const init = JSON.parse(initializeFrame('init-1')) as {
      type: string;
      request: { subtype: string };
    };
    expect(init.type).toBe('control_request');
    expect(init.request.subtype).toBe('initialize');
    expect(
      parseControlResponse(
        JSON.stringify({
          type: 'control_response',
          response: { subtype: 'success', request_id: 'init-1', response: {} },
        }),
      ),
    ).toEqual({ requestId: 'init-1' });
    expect(parseControlResponse('你好')).toBeNull();
    expect(clipInput('x'.repeat(2001)).truncated).toBe(true);
    expect(clipInput('x'.repeat(2001)).text).toHaveLength(2000);
  });
});
