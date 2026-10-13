// windows-quote.mjs：发版车（release-train、release-onekey）起 cmd.exe 套壳的 pnpm 时用的转义。
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPTS = fileURLToPath(new URL('../skills/commander/scripts/', import.meta.url));

interface WindowsQuote {
  windowsQuoteArg(arg: string): string;
  windowsCmdLine(command: string, args: string[]): string;
}
const winQuote = (await import(pathToFileURL(join(SCRIPTS, 'windows-quote.mjs')).href)) as WindowsQuote;

describe('Windows 引号（windows-quote.mjs）', () => {
  // golden 值是 09-28 拿真的 pnpm.cmd（cmd.exe /d /s /c 包一层）跑通刁钻输入后现算的实际输出。
  it.each([
    ['hello', '^"hello^"'],
    ['a b', '^"a b^"'],
    ['with"quote', '^"with\\^"quote^"'],
    ['50% off', '^"50^% off^"'],
    ['a&b', '^"a^&b^"'],
    ['a^b', '^"a^^b^"'],
    ['a|b', '^"a^|b^"'],
    ['(x)', '^"^(x^)^"'],
    ['tail\\', '^"tail\\\\^"'],
    ['', '^"^"'],
    ['<x>', '^"^<x^>^"'],
    ['!bang', '^"^!bang^"'],
    ['a""b', '^"a\\^"\\^"b^"'],
    ['back\\"slash', '^"back\\\\\\^"slash^"'],
    ['pipe|and&amp', '^"pipe^|and^&amp^"'],
  ])('windowsQuoteArg(%j) -> %j', (input, expected) => {
    expect(winQuote.windowsQuoteArg(input)).toBe(expected);
  });

  it('windowsCmdLine：command 和每个参数各自转义、空格隔开，外面再包一层引号', () => {
    expect(winQuote.windowsCmdLine('node', ['-e', 'a&b', '50% x'])).toBe(
      '"^"node^" ^"-e^" ^"a^&b^" ^"50^% x^""',
    );
    expect(winQuote.windowsCmdLine('grok', [])).toBe('"^"grok^""');
  });
});
