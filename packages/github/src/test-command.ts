// 从仓根的文件推出测试命令。有 package.json 就只看它，不退回 Makefile。认不出就不编一条。

export type TestCommandResult = { ok: true; command: string } | { ok: false; reason: string };

const RUNNER = /^(pnpm|npm|yarn|bun|make)(\s|$)/;
const PACKAGE_MANAGER = /^(pnpm|npm|yarn|bun)(?:@|$)/;
const LOCK_TO_PM: readonly [string, 'pnpm' | 'yarn' | 'npm' | 'bun'][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function packageManagerOf(
  raw: unknown,
  names: readonly string[],
): 'pnpm' | 'npm' | 'yarn' | 'bun' | undefined {
  if (typeof raw === 'string') {
    const name = PACKAGE_MANAGER.exec(raw.trim())?.[1];
    if (name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun') return name;
  }
  for (const [file, pm] of LOCK_TO_PM) {
    if (names.includes(file)) return pm;
  }
  return undefined;
}

function scriptOf(scripts: unknown, key: 'test' | 'check'): string | undefined {
  if (!isRecord(scripts)) return undefined;
  const value = scripts[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 从仓根文件推出交给会话跑的那一条。认不出就 ok:false，调用方不许自己编一条 pnpm test。 */
export function testCommandFromRepo(input: {
  packageJson: string | null;
  names: readonly string[];
  makefile?: string | null;
}): TestCommandResult {
  if (input.packageJson !== null) {
    let raw: unknown;
    try {
      raw = JSON.parse(input.packageJson);
    } catch {
      return { ok: false, reason: 'package.json 认不出' };
    }
    if (!isRecord(raw)) return { ok: false, reason: 'package.json 认不出' };
    const test = scriptOf(raw.scripts, 'test');
    const check = scriptOf(raw.scripts, 'check');
    const script = test ?? check;
    const which = test ? 'test' : 'check';
    if (!script) return { ok: false, reason: 'package.json 里没有 test 或 check 脚本' };
    const pm = packageManagerOf(raw.packageManager, input.names);
    if (pm) return { ok: true, command: `${pm} ${which}` };
    if (RUNNER.test(script)) return { ok: true, command: script };
    return { ok: false, reason: '认不出包管理器，不能编一条测试命令' };
  }
  if (input.makefile && /^test\s*:/m.test(input.makefile)) return { ok: true, command: 'make test' };
  return { ok: false, reason: '仓里没有能认出的测试命令' };
}
