// 登录长度上限和登录后跳转：前后端共用这一份。用例是原来前端 login.test 和后端 auth.test 里的，一条不丢。
import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX,
  PasswordLoginRequest,
  safeNext,
  UpdateCredentialsRequest,
  USERNAME_MAX,
} from '../src/web-api/auth.ts';

describe('safeNext：登录后回哪里，只认站内路径', () => {
  it.each([
    ['/tasks/t-1', '/tasks/t-1'],
    ['/audit?target=t-9', '/audit?target=t-9'],
    ['/settings#notify', '/settings#notify'],
  ])('站内路径 %s 原样放行', (input, out) => {
    expect(safeNext(input)).toBe(out);
  });

  it.each([
    ['没给', null],
    ['空串', ''],
    ['外站完整地址', 'https://evil.example/steal'],
    ['不带协议的外站（//）', '//evil.example/steal'],
    ['反斜杠绕过（/\\）', '/\\evil.example'],
    ['不是以 / 开头', 'tasks/t-1'],
    ['javascript 伪协议', 'javascript:alert(1)'],
    ['带换行的控制字符', '/ok\r\nSet-Cookie: x=1'],
    ['带空字符', '/ok\u0000'],
    ['登录页自己（回去就循环）', '/login'],
    ['登录页自己（带查询）', '/login?next=%2F'],
    ['太长', `/${'a'.repeat(1000)}`],
  ])('【故意造出的失败】%s：一律回首页', (_name, input) => {
    expect(safeNext(input)).toBe('/');
  });
});

describe('safeNext：后端原来的用例', () => {
  it('登录后跳回的地址只许站内路径', () => {
    expect(safeNext('/tasks/1?x=2')).toBe('/tasks/1?x=2');
    for (const bad of [
      '//evil.example',
      'https://evil.example',
      '/\\evil.example',
      'evil',
      '/a\nb',
      undefined,
    ]) {
      expect(safeNext(bad)).toBe('/');
    }
  });
});

describe('账密长度上限', () => {
  it('登录和改凭据的上限就是导出的 USERNAME_MAX、PASSWORD_MAX', () => {
    const username = 'a'.repeat(USERNAME_MAX);
    const password = 'b'.repeat(PASSWORD_MAX);
    expect(PasswordLoginRequest.safeParse({ username, password }).success).toBe(true);
    expect(PasswordLoginRequest.safeParse({ username: `${username}a`, password }).success).toBe(false);
    expect(PasswordLoginRequest.safeParse({ username, password: `${password}b` }).success).toBe(false);
    expect(UpdateCredentialsRequest.safeParse({ username }).success).toBe(true);
    expect(UpdateCredentialsRequest.safeParse({ username: `${username}a` }).success).toBe(false);
    expect(UpdateCredentialsRequest.safeParse({ newPassword: password }).success).toBe(true);
    expect(UpdateCredentialsRequest.safeParse({ newPassword: `${password}b` }).success).toBe(false);
    expect(UpdateCredentialsRequest.safeParse({ currentPassword: password }).success).toBe(true);
    expect(UpdateCredentialsRequest.safeParse({ currentPassword: `${password}b` }).success).toBe(false);
  });
});
