// pretool 钩子拦下「用 Bash 改仓里的文件」（单 #2844）：sed -i、perl -i、node -e 写文件、python 写文件、> >> tee 写进仓里。
// 派工交代里写「改代码只用 Edit/Write」拦不住：Bash 会吞反斜杠和 ${}。要在调用前当场拦。
// 判断放在 agents/hooks/shell-edit.mjs 的纯函数 shellEditVerdict(command, cwd)，decide 只在 Bash 工具调用时接上它。
// 只用文件系统认「仓里」：从 cwd 往上找 .git（目录或文件）。本测试在临时目录里造一个假仓。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface Block {
  code: 2;
  message: string;
}
interface ShellEditLib {
  shellEditVerdict(command: string, cwd: string): Block | null;
}
interface PretoolLib {
  decide(raw: string, fallbackCwd?: string): { code: 0 | 2; message?: string };
}

const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url));
const lib = (await import(pathToFileURL(join(HOOKS, 'shell-edit.mjs')).href)) as ShellEditLib;
const pretool = (await import(pathToFileURL(join(HOOKS, 'pretool.mjs')).href)) as PretoolLib;

let base = '';
let repo = ''; // 假仓根（.git 是目录），正斜杠写法
let sub = ''; // 仓里的子目录
let wt = ''; // 工作树：.git 是文件
let outside = ''; // 仓外
const fwd = (p: string) => p.replace(/\\/g, '/');

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'shell-edit-'));
  repo = fwd(join(base, 'repo'));
  sub = `${repo}/packages/x`;
  wt = fwd(join(base, 'wt'));
  outside = fwd(join(base, 'outside'));
  mkdirSync(`${repo}/.git`, { recursive: true });
  mkdirSync(sub, { recursive: true });
  mkdirSync(`${repo}/_tmp`, { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(`${wt}/.git`, 'gitdir: ../repo/.git\n');
  mkdirSync(outside, { recursive: true });
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

// 表格在 beforeAll 之前就展开了，路径用占位符，这里才换成真的
const fill = (c: string) =>
  c.replaceAll('@REPO@', repo).replaceAll('@OUT@', outside).replaceAll('@TMP@', fwd(tmpdir()));
const verdict = (command: string, cwd = repo) => lib.shellEditVerdict(fill(command), cwd);

describe('该拦：用 Bash 改仓里的文件', () => {
  it.each([
    ['sed -i', "sed -i 's/a/b/' src/a.ts"],
    ['sed -i 带备份后缀', "sed -i.bak 's/a/b/' src/a.ts"],
    ['sed --in-place', "sed --in-place 's/a/b/' src/a.ts"],
    ['sed --in-place=后缀', "sed --in-place=.bak 's/a/b/' src/a.ts"],
    ['sed -ni 连写', "sed -ni 's/a/b/p' src/a.ts"],
    ['sed -e 在前 -i 在后', "sed -e 's/a/b/' -i src/a.ts"],
    ['sed -i 通配', "sed -i 's/a/b/' src/*.ts"],
    ['sed -i 绝对路径', "sed -i 's/a/b/' @REPO@/src/a.ts"],
    ['sed -i 在管道后', "git ls-files | head -1; sed -i 's/a/b/' README.md"],
    ['sed -i 套在 bash -c 里', `bash -c "sed -i 's/a/b/' src/a.ts"`],
    ['perl -pi -e', "perl -pi -e 's/a/b/' src/a.ts"],
    ['perl -i.bak', "perl -i.bak -pe 's/a/b/' src/a.ts"],
    ['node -e writeFileSync', `node -e "require('fs').writeFileSync('src/a.ts','x')"`],
    ['node --eval appendFileSync', `node --eval "fs.appendFileSync('@REPO@/a.md','x')"`],
    [
      'node -e 路径是变量、代码里别处写死了仓里的路径',
      `node -e "const f='src/a.ts'; fs.writeFile(f, s, cb)"`,
    ],
    ['python -c open w', `python -c "open('src/a.py','w').write('x')"`],
    ['python3 -c open a', `python3 -c "open('src/a.py', 'a').write('x')"`],
    ['python -c open 路径是变量、别处写死了仓里的路径', `python -c "p='src/a.py'; open(p, 'w').write(s)"`],
    ['python -c write_text', `python -c "Path('src/a.py').write_text('x')"`],
    ['heredoc 喂 python', "python - <<'EOF'\nopen('src/a.py','w').write('x')\nEOF"],
    [
      'heredoc 喂 python3 write_text',
      "python3 <<EOF\nfrom pathlib import Path\nPath('a.md').write_text('x')\nEOF",
    ],
    ['> 写仓里', 'echo hi > src/a.ts'],
    ['>> 追加仓里', 'echo hi >> src/a.ts'],
    ['cat > 文件 <<EOF', "cat > src/a.ts <<'EOF'\nx\nEOF"],
    ['cat <<EOF > 文件', "cat <<'EOF' > src/a.ts\nx\nEOF"],
    ['2> 写仓里', 'node x.js 2> err.log'],
    ['&> 写仓里', 'node x.js &> out.log'],
    ['tee', 'printf x | tee src/a.ts'],
    ['tee -a', 'printf x | tee -a src/a.ts'],
    ['> 绝对路径', 'echo hi > @REPO@/a.md'],
    ['在仓的子目录里跑', 'echo hi > a.md'],
  ])('%s', (_name, command) => {
    const v = command === 'echo hi > a.md' ? verdict(command, sub) : verdict(command);
    expect(v, command).not.toBeNull();
    expect(v?.code).toBe(2);
    expect(v?.message).toContain('Edit/Write');
    expect(v?.message).toContain('_tmp/');
  });

  it('提示里带认出来的那一段', () => {
    const v = verdict("sed -i 's/a/b/' src/a.ts");
    expect(v?.message).toContain('sed -i');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 提示里要原样写出 ${}
    expect(v?.message).toContain('${}');
  });

  it('工作树里（.git 是文件）也认是仓', () => {
    expect(verdict('echo hi > a.md', wt)?.code).toBe(2);
    expect(verdict('echo hi > _tmp/a.md', wt)).toBeNull();
  });

  it('cd 进仓里再写', () => {
    expect(verdict(`cd ${repo}/packages && echo hi > a.md`, outside)?.code).toBe(2);
  });

  it.runIf(process.platform === 'win32')('Windows 的几种路径写法', () => {
    const win = repo.replace(/\//g, '\\'); // D:\...
    const gitBash = repo.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`); // /d/...
    expect(verdict(`echo hi > "${win}\\a.md"`, outside)?.code).toBe(2);
    expect(verdict(`echo hi > ${repo}/a.md`, outside)?.code).toBe(2);
    expect(verdict(`echo hi > ${gitBash}/a.md`, outside)?.code).toBe(2);
    expect(verdict('sed -i s/a/b/ a.md', win)?.code).toBe(2);
    expect(verdict('sed -i s/a/b/ a.md', gitBash)?.code).toBe(2);
    expect(verdict(`echo hi > "${win}\\_tmp\\a.md"`, outside)).toBeNull();
    expect(verdict(`echo hi > ${gitBash}/_tmp/a.md`, outside)).toBeNull();
  });
});

describe('该放：目标在 _tmp/、仓外、/dev/null', () => {
  it.each([
    ['sed -i 改 _tmp', "sed -i 's/a/b/' _tmp/a.txt"],
    ['sed -i 改仓外', "sed -i 's/a/b/' @OUT@/a.txt"],
    ['perl -i 改 _tmp', "perl -pi -e 's/a/b/' _tmp/a.txt"],
    ['> _tmp', 'echo hi > _tmp/a.txt'],
    ['>> _tmp 绝对路径', 'echo hi >> @REPO@/_tmp/a.txt'],
    ['> 仓外', 'echo hi > @OUT@/a.txt'],
    ['> 系统临时目录', 'echo hi > @TMP@/shell-edit-x.txt'],
    ['> /dev/null', 'echo hi > /dev/null'],
    ['2>&1 和 2>/dev/null', 'node x.js 2>&1 | head; node y.js 2>/dev/null'],
    ['&> /dev/null', 'node x.js &> /dev/null'],
    ['tee _tmp', 'printf x | tee _tmp/a.txt'],
    ['tee 仓外', 'printf x | tee -a @OUT@/a.txt'],
    ['cat > _tmp <<EOF', "cat > _tmp/a.md <<'EOF'\nx\nEOF"],
    ['node -e 写 _tmp', `node -e "fs.writeFileSync('_tmp/a.json','{}')"`],
    ['node -e 写仓外', `node -e "fs.writeFileSync('@OUT@/a.json','{}')"`],
    ['node -e 写系统临时目录（路径是表达式）', `node -e "fs.writeFileSync(path.join(os.tmpdir(),'a'),'x')"`],
    ['python -c 写 _tmp', `python -c "open('_tmp/a.txt','w').write('x')"`],
    ['heredoc 喂 python 写 _tmp', "python3 - <<'EOF'\nopen('_tmp/a.txt','w').write('x')\nEOF"],
  ])('%s', (_name, command) => {
    expect(verdict(command), command).toBeNull();
  });

  it('子目录里的 _tmp/ 也放行：.gitignore 的 _tmp/ 任何一层都忽略，在 packages/x 里写 _tmp/a.md 不算改仓里的文件', () => {
    // 红：2026-10-22 之前只认仓根的 _tmp/，cd 进子目录后写 _tmp/ 被拦（#3631）
    expect(verdict('echo hi > _tmp/a.md', sub)).toBeNull();
    expect(verdict(`echo hi > ${repo}/packages/x/_tmp/a.md`)).toBeNull();
    expect(verdict("cat > _tmp/a.md <<'EOF'\nx\nEOF", sub)).toBeNull();
    expect(verdict(`node -e "fs.writeFileSync('_tmp/a.json','{}')"`, sub)).toBeNull();
  });

  it('写临时目录（系统 TEMP、会话 scratchpad 形式的路径）：放行', () => {
    expect(verdict(`echo hi > ${fwd(tmpdir())}/shell-edit-scratch.md`, sub)).toBeNull();
    expect(verdict(`sed -i 's/a/b/' ${fwd(tmpdir())}/a.md`, sub)).toBeNull();
  });

  it('_tmp 只认目录名正好是 _tmp：_tmp_x、借 _tmp 跳出去的仍拦', () => {
    expect(verdict('echo hi > packages/_tmp_x/a.md', repo)?.code).toBe(2);
    expect(verdict('echo hi > _tmp/../src/a.ts', repo)?.code).toBe(2);
  });

  it('在仓外跑、也没有 .git 往上：整条放行', () => {
    expect(verdict("sed -i 's/a/b/' a.txt", outside)).toBeNull();
    expect(verdict('echo hi > a.txt', outside)).toBeNull();
  });

  it('cd 到仓外再写', () => {
    expect(verdict(`cd ${outside} && echo hi > a.txt`)).toBeNull();
  });
});

describe('该放：只读的命令', () => {
  it.each([
    ['sed 不带 -i', "sed -n '1,5p' src/a.ts"],
    ['sed 脚本里有字母 i', "sed -e 's/i/x/' src/a.ts"],
    ['sed 输出重定向到 _tmp', "sed 's/a/b/' src/a.ts > _tmp/out.ts"],
    ['grep', 'grep -rn "a > b" src'],
    ['cat 读', 'cat src/a.ts | head'],
    ['perl 不带 -i', "perl -ne 'print if /a/' src/a.ts"],
    ['node -e 只打印', `node -e "console.log(require('./package.json').name)"`],
    ['python -c 只读', `python -c "print(open('src/a.py').read())"`],
    ['python -c open r', `python -c "open('src/a.py','r').read()"`],
    ['引号里的 > 不是重定向', `echo "a > b" 'c >> d'`],
    ['比较运算在引号里', `awk '$1>2' src/a.txt`],
    ['算术里的 >', 'echo $((1>2))'],
    ['git diff 到 _tmp', 'git diff > _tmp/x.patch'],
  ])('%s', (_name, command) => {
    expect(verdict(command), command).toBeNull();
  });
});

describe('该放：heredoc 喂给不落盘的命令', () => {
  it('git commit -F - <<EOF，正文里写着 sed -i 和 >', () => {
    const c =
      "git commit -F - <<'EOF'\n修 bug：不再用 sed -i src/a.ts 和 echo x > src/a.ts\n\nCo-Authored-By: x\nEOF";
    expect(verdict(c)).toBeNull();
  });
  it('gh pr create --body-file -', () => {
    const c = "gh pr create --title t --body-file - <<'EOF'\n用 `python -c \"open('a','w')\"` 的写法\nEOF";
    expect(verdict(c)).toBeNull();
  });
  it('heredoc 喂 cat（不带重定向）', () => {
    expect(verdict("cat <<'EOF'\necho x > src/a.ts\nEOF")).toBeNull();
  });
  it('heredoc 之后的命令仍照判', () => {
    expect(verdict("git commit -F - <<'EOF'\nx\nEOF\nsed -i s/a/b/ src/a.ts")?.code).toBe(2);
  });
});

describe('路径认不清：一律放行，宁可漏拦', () => {
  it.each([
    ['变量拼出来的 > 目标', 'echo hi > $OUT'],
    ['双引号变量', 'echo hi > "$DIR/a.txt"'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 样例是 bash 命令，不是模板串
    ['大括号变量', 'echo hi > ${HOME}/a.txt'],
    ['命令替换', 'echo hi > $(mktemp)'],
    ['反引号', 'echo hi > `mktemp`'],
    ['sed -i 目标是变量', 'sed -i s/a/b/ "$FILE"'],
    ['sed -i 目标是命令替换', "sed -i 's/a/b/' $(git ls-files)"],
    ['tee 目标是变量', 'printf x | tee "$LOG"'],
    ['node -e 写文件、路径全是运算出来的', `node -e "fs.writeFile(p, s, cb)"`],
    ['python -c 写文件、路径是变量', `python -c "open(path, 'w').write(s)"`],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 样例是 bash 命令，不是模板串
    ['node -e 路径是模板串', 'node -e "fs.writeFileSync(`${dir}/a`, x)"'],
    ['cd 到变量后的相对路径', 'cd "$DIR" && echo hi > a.txt'],
    ['cd 到命令替换后的相对路径', 'cd $(mktemp -d) && sed -i s/a/b/ a.txt'],
  ])('%s', (_name, command) => {
    expect(verdict(command), command).toBeNull();
  });

  it('输入不是字符串或命令是空：放行不抛', () => {
    expect(lib.shellEditVerdict('', repo)).toBeNull();
    expect(lib.shellEditVerdict(undefined as unknown as string, repo)).toBeNull();
    expect(lib.shellEditVerdict('echo hi > a.txt', '')).toBeNull();
  });
});

describe('接进 decide：只在 Bash 工具调用时跑', () => {
  const call = (tool: string, command: string, cwd = repo) =>
    JSON.stringify({ tool_name: tool, tool_input: { command }, cwd, hook_event_name: 'PreToolUse' });

  it('Bash 里 sed -i 改仓里的文件：拦下（退出码 2）', () => {
    const v = pretool.decide(call('Bash', "sed -i 's/a/b/' src/a.ts"));
    expect(v.code).toBe(2);
    expect(v.message).toContain('Edit/Write');
  });
  it('Bash 里写 _tmp：放行', () => {
    expect(pretool.decide(call('Bash', 'echo hi > _tmp/a.txt')).code).toBe(0);
  });
  it('Bash 里不落盘的 heredoc：放行', () => {
    expect(pretool.decide(call('Bash', "git commit -F - <<'EOF'\nx > y\nEOF")).code).toBe(0);
  });
  it('PowerShell 工具不归这条管', () => {
    expect(pretool.decide(call('PowerShell', 'echo hi > src/a.ts')).code).toBe(0);
  });
});
