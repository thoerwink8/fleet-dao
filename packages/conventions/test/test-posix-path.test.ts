// Windows 上把 Git 的 usr\bin 排到 PATH 最前面（src/test-posix-path.ts）：只管 win32；已经在 Git Bash 里不动；
// 找不到 Git 的 sh 要明说（不悄悄当没事）。
import { describe, expect, it } from 'vitest';
import { type PosixPathEnv, posixToolsPrepend } from '../src/test-posix-path.ts';

const files = (...present: string[]) => {
  const set = new Set(present.map((p) => p.toLowerCase()));
  return (p: string) => set.has(p.toLowerCase());
};
const win = (path: string, ...present: string[]): PosixPathEnv => ({
  platform: 'win32',
  path,
  exists: files(...present),
});

describe('posixToolsPrepend', () => {
  it('不是 Windows：不动，也不说话', () => {
    expect(posixToolsPrepend({ platform: 'linux', path: '/usr/bin', exists: () => true })).toEqual({});
  });

  it('PowerShell 里：PATH 里有 Git\\cmd，就把同一个 Git 的 usr\\bin 排到最前面', () => {
    const r = posixToolsPrepend(
      win(
        'C:\\Windows\\system32;D:\\Tools\\Git\\cmd',
        'D:\\Tools\\Git\\cmd\\git.exe',
        'D:\\Tools\\Git\\usr\\bin\\sh.exe',
      ),
    );
    expect(r).toEqual({ prepend: 'D:\\Tools\\Git\\usr\\bin' });
  });

  it('git 在 mingw64\\bin 里（再往上两层才是 usr\\bin）：一样找得到', () => {
    const r = posixToolsPrepend(
      win('C:\\Git\\mingw64\\bin', 'C:\\Git\\mingw64\\bin\\git.exe', 'C:\\Git\\usr\\bin\\sh.exe'),
    );
    expect(r.prepend).toBe('C:\\Git\\usr\\bin');
  });

  it('已经在 Git Bash 里（PATH 头一个就是 usr\\bin）：不动', () => {
    const r = posixToolsPrepend(
      win('D:\\Tools\\Git\\usr\\bin;D:\\Tools\\Git\\mingw64\\bin', 'D:\\Tools\\Git\\usr\\bin\\sh.exe'),
    );
    expect(r).toEqual({});
  });

  it('【故意造出的失败】有 git 但它旁边没有 sh：不凭空加目录，写明起 sh 的测试会红', () => {
    const r = posixToolsPrepend(win('C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\Git\\cmd\\git.exe'));
    expect(r.prepend).toBeUndefined();
    expect(r.note).toContain('sh');
  });

  it('【故意造出的失败】PATH 是空的、读不到：不抛、写明没找到', () => {
    const r = posixToolsPrepend({ platform: 'win32', path: undefined, exists: () => false });
    expect(r.prepend).toBeUndefined();
    expect(r.note).toContain('PATH');
  });
});
