// 钉住调工具前钩子（agents/hooks/pretool.mjs）拦的规矩（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 几条规矩：fleet-dao 里不用 git stash（list、show 放行）；
// 本机不切号、不登录、不退出（ssh 到别处的放行）；bash 里会被当命令执行的反引号全机都拦（单引号、带引号的 heredoc 里放行，
// PowerShell 不管）；fleet-dao 开单走 pnpm issue:new；认不出的输入按拦处理；
// 密钥文件的内容不进对话：碰到密钥路径只放行不读内容的（列目录、看权限、判断在不在），看结构走 secret-shape.mjs，
// 它一个值都不打（2026-09-27 帅位按字段名猜着遮值，把 reclaude 的设备密钥和账号名打进了对话）。脚本改了这些判断，这里会红。
// 命令字符串拆开拼：免得跑这条测试的命令、或者有人 grep 它时，本机的护栏把自己拦下。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface PretoolLib {
  decide(raw: string, fallbackCwd?: string): { code: number; message?: string };
  SHELL_TOOLS: Record<string, string>;
  GITIGNORE_NOT_BLOCKED: Record<string, string>;
}
interface ShapeLib {
  main(argv: string[], io: { out(line: string): void; err(line: string): void }): number;
}

const HOOKS = fileURLToPath(new URL('../../hooks/', import.meta.url));
const HOOK = join(HOOKS, 'pretool.mjs');
const SHAPE_SCRIPT = join(HOOKS, 'secret-shape.mjs');
const lib = (await import(pathToFileURL(HOOK).href)) as PretoolLib;
const shape = (await import(pathToFileURL(SHAPE_SCRIPT).href)) as ShapeLib;

const s = `st${'ash'}`;
const rc = `recl${'aude'}`;
const bt = '`';
const create = `cre${'ate'}`;
const F = '/work/fleet-dao';
const O = '/work/other';
const RC = `.recl${'aude'}`;
const ETC = `/etc/fleet${'-dao'}`;
const CRED = `.creden${'tials'}.json`;
const SHAPE = '"$HOME/.fleet-dao/hooks/secret-shape.mjs"';

/** [命令, 该给的退出码, 会话目录, 工具名（不写是 Bash；写了 undefined 就是没给工具名）] */
type Case = [string, 0 | 2, string, (string | undefined)?];

const cases: Case[] = [
  [`git ${s} push -q x`, 2, F],
  [`git ${s}`, 2, F],
  [`git -C ../wt ${s} pop`, 2, F],
  [`git ${s} list`, 0, F],
  [`git ${s} show -p`, 0, F],
  ['git status && pnpm test', 0, F],
  [`${rc} org use other-org`, 2, O],
  [`echo "${bt}${rc} login${bt}"`, 2, O],
  [`${rc} logout`, 2, F],
  [`ssh vps 'sudo -u some-user ${rc} login'`, 0, F],
  [`${rc} status`, 0, O],
  [`ssh vps "echo ${bt}${rc} login${bt}"`, 2, F],
  [`ssh vps "x=$(${rc} login)"`, 2, F],
  [`gh issue ${create} --title x`, 2, F],
  [`gh issue ${create} -R owner/fleet-dao --title x`, 2, O],
  [`gh issue ${create} -R owner/fleet-dao-canary --title x`, 0, F],
  [`gh issue ${create} --repo=owner/fleet-dao-canary --title x`, 0, F],
  // 反引号：2026-09-26 那次的原样（node -e 双引号里夹 Markdown 路径）
  [`node -e "p=p.replace(a,'验收见 ${bt}specs/157-x/需求.md${bt}「怎么算做完」')"`, 2, F],
  [`git commit -m "fix: ${bt}foo${bt} 改了"`, 2, O],
  [`echo ${bt}date${bt}`, 2, O],
  [`cat <<EOF\n用 ${bt}code${bt}\nEOF`, 2, O],
  [`cat <<-EOF\n\t用 ${bt}code${bt}\n\tEOF`, 2, O],
  [`echo '单引号里 ${bt}code${bt} 不执行'`, 0, F],
  [`gh api x --jq '.[] | "${bt}\\(.a)${bt}"'`, 0, F],
  [`cat > f.md <<'EOF'\n用 ${bt}code${bt} 写的\nEOF\npnpm test`, 0, F],
  [`cat <<"EOF"\n${bt}x${bt}\nEOF`, 0, F],
  [`cat <<\\EOF\n${bt}x${bt}\nEOF`, 0, F],
  [`git commit -m "$(cat <<'EOF'\nfix(x): 改 ${bt}foo${bt}\n\nCo-Authored-By: a\nEOF\n)"`, 0, F],
  [`git commit -m "$(cat <<EOF\nfix(x): 改 ${bt}foo${bt}\nEOF\n)"`, 2, F],
  [`cat <<'EOF'\n${bt}x${bt}\nEOF\necho "${bt}y${bt}"`, 2, O],
  [`echo "转义过的 \\${bt}code\\${bt} 不执行"`, 0, O],
  [`echo $'ansi ${bt}x${bt}'`, 0, O],
  [`ls # 注释里 ${bt}x${bt} 不执行`, 0, O],
  ['cat <<< "here-string"; echo ok', 0, O],
  ['echo "a $(echo "b") c"', 0, O],
  [`echo "a $(echo "b ${bt}c${bt}") d"`, 2, O],
  // PowerShell 里反引号是转义符，不归这条管
  ['Write-Output "a`nb"', 0, O, 'PowerShell'],
  // 认不出的输入：按拦处理
  ['ls', 2, O, undefined],
  ['ls', 2, O, 'Edit'],
];

function input(c: Case): string {
  const [command, , cwd] = c;
  const tool = c.length >= 4 ? c[3] : 'Bash';
  return JSON.stringify({ ...(tool === undefined ? {} : { tool_name: tool }), tool_input: { command }, cwd });
}

describe('调工具前钩子拦的规矩', () => {
  it.each(cases.map((c) => [JSON.stringify(c[0]), c[3] ?? 'Bash', c[1], c] as const))(
    '%s（%s）→ 退出码 %i',
    (_name, _tool, want, c) => {
      const got = lib.decide(input(c));
      expect(got.code).toBe(want);
      if (want === 2) expect(got.message?.length ?? 0).toBeGreaterThan(0);
    },
  );

  it('输入不是 JSON、没有命令：按拦处理', () => {
    expect(lib.decide('不是 JSON').code).toBe(2);
    expect(lib.decide(JSON.stringify({ tool_name: 'Bash', tool_input: {} })).code).toBe(2);
  });
});

// ~/.claude/settings.json 里的这条钩子，Grok、Devin、Cursor 默认也借道读，送进来的是它们自己的格式（targets.ts 的 HOOK_TARGETS）。
// 认不得它们的格式就会把它们的每条终端命令都拦下；认得了，规矩在它们那里照样拦。
describe('借道读这条钩子的几家：格式认得、规矩照拦', () => {
  const stash = `git ${s} pop`;
  it('Grok：camelCase 的 toolName、toolInput，终端工具叫 run_terminal_command', () => {
    const grok = (command: string) =>
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        toolName: 'run_terminal_command',
        toolInput: { command },
        cwd: F,
      });
    expect(lib.decide(grok('git status')).code).toBe(0);
    expect(lib.decide(grok(stash)).code).toBe(2);
    expect(lib.decide(grok(`${rc} login`)).code).toBe(2);
  });

  it('Devin：终端工具叫 exec，输入里没有会话目录——按钩子进程的工作目录认是不是 fleet-dao', () => {
    const devin = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'exec',
      tool_input: { command: stash },
    });
    expect(lib.decide(devin, F).code).toBe(2);
    expect(lib.decide(devin, O).code).toBe(0);
  });

  it('Cursor：终端工具叫 Shell', () => {
    const cursor = (command: string) =>
      JSON.stringify({ tool_name: 'Shell', tool_input: { command }, cwd: F });
    expect(lib.decide(cursor('pnpm test')).code).toBe(0);
    expect(lib.decide(cursor(`gh issue ${create} --title x`)).code).toBe(2);
  });

  it('别家的终端不一定是 bash：反引号那条只对 Bash 管', () => {
    const cmd = `echo ${bt}date${bt}`;
    expect(lib.decide(JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd }, cwd: O })).code).toBe(
      2,
    );
    for (const tool of ['run_terminal_command', 'exec', 'Shell', 'PowerShell']) {
      expect(
        lib.decide(JSON.stringify({ tool_name: tool, tool_input: { command: cmd }, cwd: O })).code,
        tool,
      ).toBe(0);
    }
  });
});

// 同步起子进程：卡死由子进程自己的上限管，不靠 vitest 的超时（它打断不了同步用例，机器一忙又把慢报成红，#264）
describe('命令行外壳：stdin 进、退出码出', { timeout: 0 }, () => {
  const run = (stdin: string) => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: stdin,
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    // status 不是 null：子进程真退出过、拿到了退出码，写 stdin 时碰上的管道已关（Linux EPIPE、Windows EOF）
    // 不算没跑完——和 packages/adapters/test/claude-args.test.ts 的 runHook 同一个坑，同一个改法。这份的 HOOK
    // 是真 pretool.mjs，它一起手就整份读完 stdin 才可能退出（agents/hooks/pretool.mjs 的 isMain），实测碰不上
    // 这个坑，这里按同一个模式顺手修，不另配复现测试。
    if (r.status === null) throw new Error(`钩子没跑完：${r.error?.message ?? r.signal}`);
    return r;
  };

  it('拦下：退出码 2，理由在 stderr', () => {
    const r = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: `git ${s}` }, cwd: F }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('fleet-dao 里不用 git');
  });

  it('放行：退出码 0，什么都不说', () => {
    const r = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: F }));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('输入不是 JSON：退出码 2', () => {
    const r = run('不是 JSON');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('按拦处理');
  });

  it('读密钥文件：退出码 2，stderr 指到安全查看脚本', () => {
    const r = run(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: `cat ~/${RC}/device.json` }, cwd: O }),
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('secret-shape.mjs');
  });
});

// —— 密钥文件：值不进对话 ——

/** 2026-09-27 那次的原样：for 循环把 ~/.reclaude/*.json 逐个 node -e 读出来，按字段名猜着遮值 */
const INCIDENT = `for f in ~/${RC}/*.json; do node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const k of Object.keys(j))console.log(k,/token|secret|key/i.test(k)?"***":j[k])' "$f"; done`;

/** [工具名, 命令, 该给的退出码] */
type SecretCase = [string, string, 0 | 2];

const secretCases: SecretCase[] = [
  ['Bash', INCIDENT, 2],
  // 家目录、分隔符的各种写法：~、$HOME、${HOME}、%USERPROFILE%、$env:USERPROFILE、反斜杠、Git Bash 的 /c/Users/…
  ['Bash', `cat ~/${RC}/device.json`, 2],
  ['Bash', `cat $HOME/${RC}/*.json`, 2],
  ['Bash', `head -c 64 \${HOME}/${RC}/claude-ca-bundle.pem`, 2],
  ['Bash', `cat /c/Users/alice/${RC}/device.key`, 2],
  ['Bash', `cat 'C:\\Users\\alice\\${RC}\\ca.key'`, 2],
  ['PowerShell', `Get-Content $env:USERPROFILE\\${RC}\\device.json`, 2],
  ['PowerShell', `type %USERPROFILE%\\.claude\\${CRED}`, 2],
  ['Bash', `type %USERPROFILE%\\.claude\\${CRED}`, 2],
  ['PowerShell', `gc ~\\.claude\\${CRED}`, 2],
  ['Bash', `jq . ~/.claude/${CRED}`, 2],
  // 路径拆开写在代码里、整个目录、reclaude 留的 Claude 配置副本
  [
    'Bash',
    `node -e "console.log(require('fs').readFileSync(require('path').join(require('os').homedir(), '${RC}', 'device.json'), 'utf8'))"`,
    2,
  ],
  ['Bash', `grep -r org ~/${RC}/`, 2],
  ['Bash', `cat ~/${RC}/backups/x/claude.json`, 2],
  // 钩子看不清的写法：cd 进去、赋给变量、$( )、管道交给会读文件的、输出写进文件（下一条再读）
  ['Bash', `cd ~/${RC} && cat device.json`, 2],
  ['Bash', `P=~/${RC}/device.json; cat "$P"`, 2],
  ['Bash', `cat $(ls ~/${RC}/*.json)`, 2],
  ['Bash', `echo "$(cat ~/${RC}/device.json)"`, 2],
  ['Bash', `ls ~/${RC}/*.json | xargs cat`, 2],
  ['Bash', `ls ~/${RC} |\n  xargs cat`, 2],
  ['Bash', `cat ~/${RC}/device.json > /tmp/x`, 2],
  ['Bash', `cp ~/${RC}/device.json /tmp/d.json && jq . /tmp/d.json`, 2],
  ['Bash', `find ~/${RC} -name '*.json' -delete`, 2],
  ['Bash', 'git show HEAD:deploy/tls.key', 2],
  ['Bash', 'git add -p deploy/tls.key', 2],
  ['PowerShell', `Get-ChildItem $HOME\\${RC}\\*.json | Get-Content`, 2],
  ['PowerShell', `Get-ChildItem $HOME\\${RC} | ForEach-Object { Get-Content $_.FullName }`, 2],
  ['PowerShell', `[IO.File]::ReadAllText("$env:USERPROFILE\\${RC}\\device.json")`, 2],
  ['PowerShell', `$p = "$HOME\\${RC}\\device.json"; Get-Content $p`, 2],
  // 套一层：sudo、bash -c、pwsh -Command、cmd /c、ssh 到法国
  ['Bash', `sudo -u fleet cat ${ETC}/api.env`, 2],
  ['Bash', `bash -c 'cat ~/${RC}/device.json'`, 2],
  ['Bash', `bash -c 'cat "$1"' _ ~/${RC}/device.json`, 2],
  ['Bash', `pwsh -Command "Get-Content ~/${RC}/device.json"`, 2],
  ['Bash', `cmd /c type %USERPROFILE%\\.claude\\${CRED}`, 2],
  ['Bash', `ssh fr 'cat ${ETC}/api.env'`, 2],
  ['Bash', `ssh fr "sudo cat ${ETC}/engine.env"`, 2],
  ['Bash', `ssh fr 'grep TOKEN ${ETC}/*.env'`, 2],
  ['Bash', `ssh fr 'cat ${ETC}/reclaude-api.key'`, 2],
  ['Bash', `ssh fr 'cat ${ETC}/github/gh-app-x.json'`, 2],
  // 别的密钥文件
  ['Bash', 'cat ~/.secrets/github.pass', 2],
  ['Bash', 'cat deploy/tls.key', 2],
  ['Bash', 'cat ~/.fleet-dao/vault-key.txt', 2],
  ['Bash', 'age -d -i ~/.fleet-dao/vault-key.txt x.json.age', 2],
  ['Bash', 'cat ~/.ssh/id_ed25519', 2],
  // 放着密钥文件的点目录里、能匹配上密钥文件名的通配（* 按匹配点开头的名字算：PowerShell、rg 都这样）
  ['Bash', 'cat ~/.ssh/*', 2],
  ['Bash', 'cat ~/.ssh/id_*', 2],
  ['Bash', 'cat ~/.ssh/{id_rsa,config}', 2],
  ['Bash', 'cat ~/.claude/.*', 2],
  ['Bash', 'cat ~/.claude/*', 2],
  ['PowerShell', 'Get-Content ~\\.ssh\\*', 2],
  // 借道读这条钩子的几家
  ['run_terminal_command', `cat ~/${RC}/device.json`, 2],
  ['exec', `cat ~/${RC}/device.json`, 2],
  ['Shell', `cat ~/${RC}/device.json`, 2],
  // —— 放行：只列目录、看权限、判断在不在 ——
  ['Bash', `ls -la ~/${RC}/`, 0],
  ['Bash', `test -f ~/${RC}/device.json`, 0],
  ['Bash', `stat -c %a ${ETC}/api.env`, 0],
  ['Bash', `ssh fr 'stat -c %a ${ETC}/api.env'`, 0],
  ['Bash', `ssh fr 'ls -la ${ETC}/'`, 0],
  ['Bash', `[ -s ~/${RC}/device.json ] && echo 有 || echo 没有`, 0],
  ['Bash', `[[ -f ~/${RC}/device.json && -s ~/${RC}/device.json ]]`, 0],
  ['Bash', `ls ~/${RC}/*.json | wc -l`, 0],
  ['Bash', `find ~/${RC} -name '*.json'`, 0],
  ['Bash', `echo ~/${RC}/*.json`, 0],
  ['Bash', `ls ~/${RC}/ && reclaude status`, 0],
  ['Bash', 'mkdir -p ~/.secrets && chmod 700 ~/.secrets', 0],
  ['Bash', 'git check-ignore -v .secrets/x.pass', 0],
  ['Bash', 'git rm --cached deploy/tls.key', 0],
  ['Bash', `ssh fr "echo 'X=1' | sudo tee -a ${ETC}/api.env"`, 0],
  ['Bash', 'ssh-keygen -lf ~/.ssh/id_ed25519', 0],
  ['Bash', 'cat ~/.ssh/id_ed25519.pub', 0],
  ['Bash', 'cat ~/.ssh/*.pub', 0],
  ['Bash', 'cat ~/.ssh/config', 0],
  ['Bash', 'ls ~/.ssh/*', 0],
  ['Bash', 'chmod 600 ~/.ssh/*', 0],
  ['Bash', 'cat ~/.claude/*.md', 0],
  ['Bash', 'cat .claude/settings.json', 0],
  ['Bash', 'openssl x509 -in /etc/letsencrypt/live/x/fullchain.pem -noout -enddate', 0],
  ['Bash', "ssh -i ~/.ssh/fr.key fr 'systemctl status fleet-api'", 0],
  ['Bash', `cat ~/${RC}-org-switch-last.json`, 0],
  ['Bash', `ls # 注释里写到的不算：cat ~/${RC}/device.json`, 0],
  ['PowerShell', `Test-Path $env:USERPROFILE\\${RC}\\device.json`, 0],
  ['PowerShell', `Get-Item $HOME\\.claude\\${CRED} | Select-Object Length, LastWriteTime`, 0],
  ['PowerShell', `Get-ChildItem -Force $env:USERPROFILE\\${RC} | Format-Table Name, Length`, 0],
  ['PowerShell', `Get-FileHash $HOME\\${RC}\\device.json`, 0],
  // 查看脚本本身；别的机器上的文件，把它经 ssh 喂给那头的 node
  ['Bash', `node ${SHAPE} ~/${RC}/*.json`, 0],
  ['PowerShell', `node ${SHAPE} $env:USERPROFILE\\${RC}\\device.json`, 0],
  ['Bash', `cat ${SHAPE} | ssh fr 'node --input-type=module - ${ETC}/api.env'`, 0],
  // 只出指纹：值不过屏幕
  ['Bash', `cat ~/${RC}/device.json | sha256sum`, 0],

  // —— /etc/fleet-dao 下的一律算（飞书、网关通行证、备份、目录配置、敏感值名单……不按文件名挑） ——
  ['Bash', `ssh fr 'cat ${ETC}/feishu.env'`, 2],
  ['Bash', `ssh fr 'cat ${ETC}/gateway-token.env'`, 2],
  ['Bash', `ssh fr 'cat ${ETC}/backup.env'`, 2],
  ['Bash', `ssh fr 'jq . ${ETC}/catalog.json'`, 2],
  ['Bash', `ssh fr 'cat ${ETC}/sensitive-values.txt'`, 2],
  ['Bash', `ssh fr 'cat < ${ETC}/api.env'`, 2],
  ['Bash', `cp ${ETC}/feishu.env /tmp/f`, 2],
  ['Bash', `scp fr:${ETC}/feishu.env .`, 2],
  // 管道那头的远端脚本：写死的密钥路径照样不许读（if 里的也剥出来看）
  ['Bash', `echo x | ssh hk 'cat ${ETC}/feishu.env'`, 2],
  ['Bash', `echo x | ssh hk 'if true; then cat ${ETC}/feishu.env; fi'`, 2],
  // 放行：只数个数、只出指纹、只往里写、列目录
  ['Bash', `ssh fr "grep -c '^FLEET_CANARY_REPO=' ${ETC}/engine.env"`, 0],
  ['Bash', `ssh fr 'grep -q ^FEISHU_APP_ID= ${ETC}/feishu.env && echo 有'`, 0],
  ['Bash', `ssh fr 'sha256sum < ${ETC}/gateway-token.env'`, 0],
  ['Bash', `ssh fr 'ls -la ${ETC}/backup'`, 0],
  ['Bash', `sudo install -m 640 -o root -g fleet /tmp/new.env ${ETC}/engine.env`, 0],
  ['Bash', `scp -i ~/.ssh/fr.key ./feishu.env fr:${ETC}/feishu.env`, 0],

  // —— 各家 AI 命令行、git、gh 存在家里的登录凭据 ——
  ['Bash', 'cat ~/.cursor/fleet-api-key', 2],
  ['Bash', 'cat ~/.grok/auth.json', 2],
  ['Bash', 'cat ~/.grok/*', 2],
  ['Bash', 'jq . ~/.codex/auth.json', 2],
  ['Bash', 'cat ~/.gemini/oauth_creds.json', 2],
  ['Bash', 'cat ~/.git-credentials', 2],
  ['Bash', 'cat ~/.config/gh/hosts.yml', 2],
  ['Bash', 'cat ~/.fleet-dao/sensitive-values.txt', 2],
  ['PowerShell', 'Get-Content $env:USERPROFILE\\.codex\\auth.json', 2],
  ['Bash', 'ls -la ~/.grok/ ~/.codex/ ~/.cursor/', 0],
  ['Bash', 'cat ~/.codex/config.toml', 0],
  ['Bash', 'cat ~/.grok/*.toml', 0],
  ['Bash', 'stat -c %a ~/.cursor/fleet-api-key', 0],
];

const secretInput = (tool: string, command: string) =>
  JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: O });

describe('密钥文件：碰到只放行不读内容的，值不进对话', () => {
  it.each(
    secretCases.map(([tool, command, want]) => [JSON.stringify(command), tool, want, command] as const),
  )('%s（%s）→ 退出码 %i', (_name, tool, want, command) => {
    const got = lib.decide(secretInput(tool, command));
    expect(got.code).toBe(want);
    if (want === 2) expect(got.message).toContain('secret-shape.mjs');
  });

  it('拦下时第一行就说清怎么办（Grok 只把第一行交给模型）：看结构用旁边的安全查看脚本，判断在不在用 stat、test', () => {
    const got = lib.decide(secretInput('Bash', INCIDENT));
    expect(got.code).toBe(2);
    const first = got.message?.split('\n')[0] ?? '';
    expect(first).toContain(`node ${SHAPE}`);
    expect(first).toMatch(/stat/);
    expect(first).toMatch(/Test-Path/);
    expect(existsSync(SHAPE_SCRIPT)).toBe(true);
  });

  // 文档里照着跑的命令不能被这条拦掉（原样抄来，占位的机器名换成 fr、hk）：docs/reclaude-self-check.md 第 2 节的自检
  // （只读 state.json 的一个字段、数日志条数），docs/ops.md 第九节「两台同一份」「目录配置」那几条管道（值不过屏幕）。
  // 不在测试里现读文档：agents 的测试读包外文件，CI 按改动选测试时要把那份文件接到 agents 上（ci-plan 是碰安全的路径）。
  it.each([
    `python3 -c "import json;print(json.load(open('$HOME/${RC}/state.json'))['daemon'].get('leak_report'))"`,
    `grep -c "event: non-cc-client" ~/${RC}/logs/daemon.log     # 看有没有**新增**（记下当前条数，之后只许不涨）`,
    `ssh fr 'cat ${ETC}/gateway-token.env' | ssh hk 'f=${ETC}/gateway-token.env; t=$(mktemp ${ETC}/.new.XXXXXX); if cat > "$t" && grep -qE "^FLEET_FEISHU_GATEWAY_TOKEN=[0-9a-f]{64}$" "$t" && chown root:fleet "$t" && chmod 640 "$t"; then mv "$t" "$f"; else rm -f "$t"; echo "没换：收到的不是完整的通行证" >&2; exit 1; fi'`,
    `ssh fr 'sha256sum < ${ETC}/gateway-token.env'; ssh hk 'sha256sum < ${ETC}/gateway-token.env'`,
    `~/.fleet-dao/bin/age -d -i ~/.fleet-dao/vault-key.txt france${ETC}/catalog.json.age | ssh fr 'f=${ETC}/catalog.json; t=$(mktemp ${ETC}/.new.XXXXXX); if cat > "$t" && [ -s "$t" ] && node -e "JSON.parse(require(\\"fs\\").readFileSync(process.argv[1], \\"utf8\\"))" "$t" && chown root:fleet "$t" && chmod 640 "$t"; then mv "$t" "$f"; else rm -f "$t"; echo "没换：收到的是空的或不是完整的 JSON" >&2; exit 1; fi'`,
    `~/.fleet-dao/bin/age -d -i ~/.fleet-dao/vault-key.txt france${ETC}/catalog.json.age | sha256sum; ssh fr 'sha256sum < ${ETC}/catalog.json'`,
  ])('文档里照着跑的照样放行：%s', (command) => {
    expect(lib.decide(secretInput('Bash', command)).code).toBe(0);
  });
});

// 读文件、搜内容的工具（Claude Code 的 Read、Grep，Cursor 同名；Grok 的 read_file、grep；Devin 的 read、grep）：
// 要读的路径碰到同一张密钥名单就拦。只拦命令、Read 照样能把密钥文件读进对话，等于没拦。
// [说明, 钩子输入（原样）, 该给的退出码, 会话目录（输入里没带时钩子进程的工作目录）]
type ReadCase = [string, Record<string, unknown>, 0 | 2, string?];
const HOME_A = '/home/alice';
const readCases: ReadCase[] = [
  [
    'Read 读 reclaude 的设备文件',
    { tool_name: 'Read', tool_input: { file_path: `${HOME_A}/${RC}/device.json` } },
    2,
  ],
  [
    'Read 读 Windows 路径的设备密钥',
    { tool_name: 'Read', tool_input: { file_path: `C:\\Users\\alice\\${RC}\\device.key` } },
    2,
  ],
  [
    'Read 读 Claude 的登录凭据',
    { tool_name: 'Read', tool_input: { file_path: `${HOME_A}/.claude/${CRED}` } },
    2,
  ],
  ['Read 读法国的环境文件', { tool_name: 'Read', tool_input: { file_path: `${ETC}/api.env` } }, 2],
  [
    'Read 读 *.key',
    { tool_name: 'Read', tool_input: { file_path: '/work/repo/deploy/tls.key', limit: 5 } },
    2,
  ],
  ['Read 读 SSH 私钥', { tool_name: 'Read', tool_input: { file_path: `${HOME_A}/.ssh/id_ed25519` } }, 2],
  [
    'Grep 在 reclaude 目录里搜',
    { tool_name: 'Grep', tool_input: { pattern: 'sk', path: `${HOME_A}/${RC}` } },
    2,
  ],
  [
    'Grep 的 glob 指到密钥文件',
    { tool_name: 'Grep', tool_input: { pattern: 'x', path: HOME_A, glob: `${RC}/*.json` } },
    2,
  ],
  ['Grep 搜 *.pem 的内容', { tool_name: 'Grep', tool_input: { pattern: 'BEGIN', glob: '**/*.pem' } }, 2],
  [
    'Grep 没给路径、会话目录就在 .secrets 里',
    { tool_name: 'Grep', tool_input: { pattern: 'x' }, cwd: `${HOME_A}/.secrets` },
    2,
  ],
  // Grok：camelCase 的 toolName、toolInput；路径可以是 ~ 开头、相对会话目录
  [
    'Grok 的 read_file',
    { toolName: 'read_file', toolInput: { path: `~/${RC}/device.json` }, cwd: '/work/repo' },
    2,
  ],
  [
    'Grok 的 read_file 相对路径、会话目录在 reclaude 里',
    { toolName: 'read_file', toolInput: { target_file: 'device.json' }, cwd: `${HOME_A}/${RC}` },
    2,
  ],
  [
    'Grok 的 grep',
    { toolName: 'grep', toolInput: { pattern: 'x', path: '~/.secrets' }, cwd: '/work/repo' },
    2,
  ],
  // Devin：自己的小写工具名，输入里没有会话目录
  ['Devin 的 read', { tool_name: 'read', tool_input: { file_path: `${HOME_A}/.claude/${CRED}` } }, 2],
  ['Devin 的 exec', { tool_name: 'exec', tool_input: { command: `cat ~/${RC}/device.json` } }, 2],
  // Cursor：Read、Grep 同名，路径字段叫什么都认
  [
    'Cursor 的 Read',
    { tool_name: 'Read', tool_input: { path: `${HOME_A}/${RC}/device.json` }, cwd: '/w' },
    2,
  ],
  // 认不出的输入：按拦处理
  ['Read 没有要读的路径', { tool_name: 'Read', tool_input: {} }, 2],
  ['Read 没有 tool_input', { tool_name: 'Read' }, 2],
  ['Grep 的输入不是对象', { tool_name: 'Grep', tool_input: 'x' }, 2],
  // —— 放行 ——
  [
    'Read 读代码',
    { tool_name: 'Read', tool_input: { file_path: '/work/repo/README.md' }, cwd: '/work/repo' },
    0,
  ],
  [
    'Read 读 reclaude 的 state.json（自检文档照读的那份）',
    { tool_name: 'Read', tool_input: { file_path: `${HOME_A}/${RC}/state.json` } },
    0,
  ],
  ['Read 读 SSH 公钥', { tool_name: 'Read', tool_input: { file_path: `${HOME_A}/.ssh/id_ed25519.pub` } }, 0],
  [
    'Grep 在代码里搜密钥文件的名字（名字写在 pattern 里）',
    { tool_name: 'Grep', tool_input: { pattern: `\\${RC}/device\\.json|${CRED}`, path: '/work/repo' } },
    0,
  ],
  [
    'Grep 按类型、glob 搜代码',
    {
      tool_name: 'Grep',
      tool_input: { pattern: 'TODO', path: '/work/repo/src', glob: '*.ts', output_mode: 'content' },
    },
    0,
  ],
  [
    'Grep 没给路径、会话目录是代码目录',
    { tool_name: 'Grep', tool_input: { pattern: 'x' }, cwd: '/work/repo' },
    0,
  ],
  [
    'Grok 的 read_file 读代码',
    { toolName: 'read_file', toolInput: { target_file: 'src/main.rs' }, cwd: '/work/repo' },
    0,
  ],
  ['Devin 的 grep', { tool_name: 'grep', tool_input: { pattern: 'x', path: '/work/repo' } }, 0],
  // 各家命令行的登录凭据、/etc/fleet-dao 下的任何文件
  ['Read 读 grok 的登录态', { tool_name: 'Read', tool_input: { file_path: `${HOME_A}/.grok/auth.json` } }, 2],
  [
    'Read 读 cursor 的 API 密钥',
    { tool_name: 'Read', tool_input: { file_path: `${HOME_A}/.cursor/fleet-api-key` } },
    2,
  ],
  ['Read 读法国的飞书凭据', { tool_name: 'Read', tool_input: { file_path: `${ETC}/feishu.env` } }, 2],
  [
    'Read 读 codex 的配置（不是凭据）',
    { tool_name: 'Read', tool_input: { file_path: `${HOME_A}/.codex/config.toml` } },
    0,
  ],
];

describe('读文件、搜内容的工具：路径碰到密钥名单就拦', () => {
  it.each(readCases.map((c) => [c[0], c[2], c] as const))('%s → 退出码 %i', (_name, want, c) => {
    const [, input, , fallback] = c;
    const got = lib.decide(JSON.stringify(input), fallback ?? '/work/repo');
    expect(got.code).toBe(want);
    if (want === 2 && !String(_name).includes('没有') && !String(_name).includes('不是对象')) {
      expect(got.message?.split('\n')[0]).toContain('secret-shape.mjs');
    }
  });

  it('Devin 的输入里没有会话目录：按钩子进程的工作目录认', () => {
    const devin = JSON.stringify({ tool_name: 'grep', tool_input: { pattern: 'x' } });
    expect(lib.decide(devin, `${HOME_A}/${RC}`).code).toBe(2);
    expect(lib.decide(devin, '/work/repo').code).toBe(0);
  });
});

// 从家目录（或更上层）、~/.claude、~/.ssh 往下搜内容：路径里一个密钥文件名都没写，也会把它们搜进对话（Claude 的 Grep
// 连点开头的隐藏文件一起搜，2026-09-27 本机实测；grep -r 也搜）。要打出内容的拦；只列文件名、只数个数，或者 glob、
// 文件类型限定到碰不到密钥文件名的放行。[说明, 钩子输入, 该给的退出码]；输入里没带会话目录的按 /work/repo 算。
type BroadCase = [string, Record<string, unknown>, 0 | 2];
const grepTool = (input: Record<string, unknown>, cwd = '/work/repo') => ({
  tool_name: 'Grep',
  tool_input: { pattern: 'sk-', ...input },
  cwd,
});
const sh = (command: string, cwd = '/work/repo', tool = 'Bash') => ({
  tool_name: tool,
  tool_input: { command },
  cwd,
});
const broadCases: BroadCase[] = [
  ['Grep 从家目录搜（~）', grepTool({ path: '~' }), 2],
  ['Grep 从家目录搜、打内容', grepTool({ path: '~', output_mode: 'content' }), 2],
  ['Grep 从 Windows 的家目录搜', grepTool({ path: 'C:\\Users\\alice\\' }), 2],
  ['Grep 从 Git Bash 写法的家目录搜', grepTool({ path: '/c/Users/alice' }), 2],
  ['Grep 从 %USERPROFILE% 搜', grepTool({ path: '%USERPROFILE%' }), 2],
  ['Grep 从盘符根上搜', grepTool({ path: 'C:\\' }), 2],
  ['Grep 从根目录搜', grepTool({ path: '/' }), 2],
  ['Grep 从 /etc 搜（法国的 /etc/fleet-dao 在下面）', grepTool({ path: '/etc' }), 2],
  ['Grep 从 ~/.claude 搜（登录凭据在里面）', grepTool({ path: '~/.claude' }), 2],
  ['Grep 从 ~/.ssh 搜', grepTool({ path: '~/.ssh' }), 2],
  ['Grep 没给路径、会话目录就是家目录', grepTool({}, HOME_A), 2],
  ['Grep 从 .. 退回家目录', grepTool({ path: '..' }, `${HOME_A}/repo`), 2],
  ['Grep 的 glob 能匹配上 device.json', grepTool({ path: '~', glob: '*.json', output_mode: 'content' }), 2],
  ['Grep 的 glob 花括号里有一个能匹配上', grepTool({ path: '~', glob: '*.{ts,json}' }), 2],
  ['Grep 的 glob 只排除、不限定', grepTool({ path: '~', glob: '!*.ts' }), 2],
  ['Grep 的类型是 json', grepTool({ path: '~', type: 'json' }), 2],
  ['Grok 的 grep 从家目录搜', { toolName: 'grep', toolInput: { pattern: 'x', path: '~' }, cwd: '/w' }, 2],
  ['grep -rn 从 ~ 搜', sh('grep -rn sk- ~'), 2],
  ['grep -r 从 "$HOME/" 搜', sh('grep -r org_ "$HOME/"'), 2],
  ['grep -R 从根目录搜', sh('grep -R x /'), 2],
  ['grep -r 从 /etc 搜', sh('grep -r TOKEN /etc'), 2],
  ['grep -d recurse', sh('grep -d recurse x ~'), 2],
  ['grep -r 用 -e 给模式、起点是家目录', sh('grep -r -e x ~'), 2],
  ['grep -r 的 --include 能匹配上 device.json', sh("grep -r --include='*.json' x ~"), 2],
  ['grep -r 没写起点、会话目录是家目录', sh('grep -rn x', HOME_A), 2],
  ['grep -rn 从 . 搜、会话目录是 Windows 的家目录', sh('grep -rn x .', 'C:\\Users\\alice'), 2],
  ['rg 从家目录搜', sh('rg sk- ~'), 2],
  ['rg 从 ~/.ssh 搜', sh('rg PRIVATE ~/.ssh'), 2],
  ['rg 的 -g 只排除', sh("rg -g '!*.ts' x ~"), 2],
  ['rg -t json', sh('rg -t json x ~'), 2],
  ['ssh 到别的机器上 grep -r 没写起点（那头的家目录）', sh("ssh fr 'grep -rn TOKEN'"), 2],
  ['sudo grep -r /etc', sh('sudo grep -r TOKEN /etc'), 2],
  ['bash -c 里 grep -r ~', sh('bash -c "grep -r x ~"'), 2],
  ['PowerShell 里 grep -r 家目录', sh('grep -r x $env:USERPROFILE', '/w', 'PowerShell'), 2],
  ['Grok 的终端 grep -r ~', sh('grep -r x ~', '/w', 'run_terminal_command'), 2],
  ['grep -r 从 ~/.codex 搜（登录凭据在里面）', sh('grep -r token ~/.codex'), 2],
  [
    'Grep 从 ~/.config 搜（gh 的令牌在 gh/hosts.yml）',
    grepTool({ path: '~/.config', output_mode: 'content' }),
    2,
  ],
  ['grep -r 的 --include 能匹配上 gh 的 hosts.yml', sh("grep -r --include='*.yml' oauth ~"), 2],
  // —— 放行 ——
  ['Grep 从家目录搜、只列文件名', grepTool({ path: '~', output_mode: 'files_with_matches' }), 0],
  ['Grep 从家目录搜、只数个数', grepTool({ path: '~', output_mode: 'count' }), 0],
  ['Grep 从家目录搜、glob 限定到 *.ts', grepTool({ path: '~', glob: '*.ts', output_mode: 'content' }), 0],
  ['Grep 从家目录搜、glob 限定到 **/*.{ts,tsx}', grepTool({ path: '~', glob: '**/*.{ts,tsx}' }), 0],
  ['Grep 从家目录搜、类型限定到 ts', grepTool({ path: '~', type: 'ts' }), 0],
  ['Grep 从 ~/.ssh 搜、glob 只是 config', grepTool({ path: '~/.ssh', glob: 'config' }), 0],
  ['Grep 从家目录下的代码目录搜', grepTool({ path: 'C:\\Users\\alice\\projects' }), 0],
  ['Grep 从 ~/.claude/skills 搜', grepTool({ path: '~/.claude/skills', output_mode: 'content' }), 0],
  ['Grep 从 /etc/nginx 搜', grepTool({ path: '/etc/nginx' }), 0],
  ['Grep 没给路径、会话目录是代码目录', grepTool({}, `${HOME_A}/repo`), 0],
  ['grep -rl 只列文件名', sh('grep -rl sk- ~'), 0],
  ['grep -rc 只数个数', sh('grep -rc sk- ~'), 0],
  ['grep -r --include=*.ts', sh('grep -r --include=*.ts x ~'), 0],
  ["grep -r --include '*.ts'", sh("grep -r --include '*.ts' x ~"), 0],
  ['grep -r 从 /etc/nginx 搜', sh('grep -r server_name /etc/nginx'), 0],
  ['grep -r 没写起点、会话目录是代码目录', sh('grep -rn x'), 0],
  ['grep 不递归、读一个文件', sh('grep -A3 alias ~/.bashrc'), 0],
  ['grep 接在管道后面', sh('git log --oneline | grep -i fix', HOME_A), 0],
  ['git grep 只搜跟踪的文件', sh('git grep -n x', HOME_A), 0],
  ['rg -l', sh('rg -l x ~'), 0],
  ["rg -g '*.ts'", sh("rg -g '*.ts' x ~"), 0],
  ['rg -tts', sh('rg -tts x ~'), 0],
  ['rg 在代码目录里搜', sh('rg x src/'), 0],
  ['ssh 到别的机器上从代码目录 grep -r', sh("ssh fr 'grep -rn x /srv/fleet-dao'"), 0],
];

describe('从家目录（或更上层）往下搜内容：路径里没写密钥文件名也拦', () => {
  it.each(broadCases.map((c) => [c[0], c[2], c[1]] as const))('%s → 退出码 %i', (_name, want, input) => {
    const got = lib.decide(JSON.stringify(input), '/work/repo');
    expect(got.code).toBe(want);
    if (want === 2) {
      const first = got.message?.split('\n')[0] ?? '';
      expect(first).toContain('往下');
      expect(first).toContain(CRED);
      expect(got.message).toContain('secret-shape.mjs');
    }
  });
});

// 仓根 .gitignore「密钥文件名单」那一段（照抄）：每一行这里都拦（照那一行造个路径 cat 它），除了钩子里
// GITIGNORE_NOT_BLOCKED 写明理由不拦的；只列目录、看权限的照样放行。
const GITIGNORE_SECRET_NAMES = [
  '.secrets/',
  '*.pass',
  '*.key',
  '*.pem',
  'vault-key.txt',
  '*.age',
  '*.p12',
  '*.pfx',
  '*.ppk',
  '*.kdbx',
  '*.jks',
  '*.keystore',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_ecdsa_sk',
  'id_ed25519_sk',
  '.env',
  '.env.*',
  '.pgpass',
  '.netrc',
  '.credentials.json',
];

describe('密钥文件名单照 .gitignore 那一段', () => {
  const sampleFor = (line: string) => `~/${line.replace(/\*/g, 'x').replace(/\/$/, '/x')}`;

  it.each(GITIGNORE_SECRET_NAMES)('%s', (line) => {
    const sample = sampleFor(line);
    const exempt = Object.hasOwn(lib.GITIGNORE_NOT_BLOCKED, line);
    expect([sample, lib.decide(secretInput('Bash', `cat ${sample}`)).code]).toEqual([sample, exempt ? 0 : 2]);
    expect([sample, lib.decide(secretInput('Bash', `ls -la ${sample}`)).code]).toEqual([sample, 0]);
  });

  it('写明不拦的每一条都在名单里、都有理由', () => {
    for (const [line, why] of Object.entries(lib.GITIGNORE_NOT_BLOCKED)) {
      expect(GITIGNORE_SECRET_NAMES).toContain(line);
      expect(why.length).toBeGreaterThan(0);
    }
  });
});

describe('安全查看脚本 secret-shape.mjs：只打字段名、类型、长度，一个值都不打', () => {
  const FAKE = 'sk-rec-FAKE000000000000000000000000';
  const ORG = 'fake-org-name-for-test';
  let dir = '';
  const at = (name: string) => join(dir, name);
  const run = (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = shape.main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const noValue = (text: string) => {
    expect(text).not.toContain('sk-rec-');
    expect(text).not.toContain('FAKE');
    expect(text).not.toContain(ORG);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'secret-shape-'));
    const device = {
      sk: FAKE,
      device_id: 123456,
      org_name: ORG,
      org_id: 654321,
      ok: true,
      gone: null,
      teams: { 'team-2026': { role: 'owner' } },
      list: [FAKE, { nested: FAKE }],
    };
    writeFileSync(at('device.json'), JSON.stringify(device));
    writeFileSync(at('state.json'), JSON.stringify({ daemon: { leak_report: false } }));
    writeFileSync(at('api.env'), `# 注释\nexport FLEET_TOKEN="${FAKE}"\nEMPTY=\nPLAIN=${ORG} # 行尾注释\n`);
    writeFileSync(at('broken.json'), `{"sk": "${FAKE}", `);
    writeFileSync(at('bad.env'), `GOOD=1\n${FAKE}\nALSO_GOOD=2\n`);
    writeFileSync(at('db.pass'), `${ORG}=${FAKE}\n`);
    writeFileSync(
      at('ca.pem'),
      `-----BEGIN ${'CERTIFICATE'}-----\n${'FAKE'.repeat(16)}\n-----END CERTIFICATE-----\n`,
    );
    mkdirSync(at('sub'));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('JSON：每个字段一行「路径：类型，长度」，假的 sk-rec- 串、账号名一个都不出现', () => {
    const r = run(at('device.json'));
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toContain(`sk：字符串，长度 ${FAKE.length}`);
    expect(r.out).toContain(`org_name：字符串，长度 ${ORG.length}`);
    expect(r.out).toContain('device_id：数字');
    expect(r.out).toContain('ok：布尔');
    expect(r.out).toContain('list[1].nested：字符串');
    noValue(r.out);
    expect(r.out).not.toContain('123456');
    expect(r.out).not.toContain('true');
  });

  it('键名像数据的（带数字、点、@）不打，只打第几个、多长', () => {
    const r = run(at('device.json'));
    expect(r.out).not.toContain('team-2026');
    expect(r.out).toContain('teams[第 1 个键');
  });

  it('env：每个键一行，值不出现', () => {
    const r = run(at('api.env'));
    expect(r.code).toBe(0);
    expect(r.out).toContain(`FLEET_TOKEN：字符串，长度 ${FAKE.length}`);
    expect(r.out).toContain('EMPTY：字符串，长度 0');
    expect(r.out).toContain(`PLAIN：字符串，长度 ${ORG.length}`);
    noValue(r.out);
  });

  it('PEM：只数几块、各是什么，正文不打', () => {
    const r = run(at('ca.pem'));
    expect(r.code).toBe(0);
    expect(r.out).toContain('CERTIFICATE：1 块');
    noValue(r.out);
  });

  it('JSON 坏了：退出码 1，只报第几行第几列（JSON.parse 的报错里带原文，一个字不转述）', () => {
    const r = run(at('broken.json'));
    expect(r.code).toBe(1);
    expect(r.err).toContain('不是合法的 JSON');
    expect(r.out).toBe('');
    noValue(r.err);
  });

  it('env 里有一行认不出：退出码 1，只报第几行，不打那一行，也不打别的键', () => {
    const r = run(at('bad.env'));
    expect(r.code).toBe(1);
    expect(r.err).toContain('第 2 行认不出');
    expect(r.out).toBe('');
    noValue(r.err);
  });

  it('不是 JSON、env、PEM 的（口令文件）：不读——按 KEY=VALUE 读会把 = 前半截当键名打出来', () => {
    const r = run(at('db.pass'));
    expect(r.code).toBe(1);
    expect(r.err).toContain('认不出格式');
    expect(r.out).toBe('');
    noValue(r.err);
  });

  it('读不了的文件、目录、没有匹配的通配：明说，退出码 1，不打空', () => {
    for (const arg of [at('missing.json'), at('sub'), at('*.nothing')]) {
      const r = run(arg);
      expect([arg, r.code]).toEqual([arg, 1]);
      expect(r.err).toMatch(/读不了|是目录|没有匹配/);
      expect(r.out).toBe('');
    }
    const partly = run(at('state.json'), at('missing.json'));
    expect(partly.code).toBe(1);
    expect(partly.out).toContain('daemon.leak_report：布尔');
    expect(partly.out).not.toContain('false');
  });

  it('最后一段带 * 的自己展开（PowerShell 不替原生命令展开通配）', () => {
    const r = run(at('*.json'));
    expect(r.code).toBe(1); // broken.json 认不出
    expect(r.out).toContain('device.json（JSON）');
    expect(r.out).toContain('state.json（JSON）');
    noValue(`${r.out}\n${r.err}`);
  });

  it('没给文件：说用法、退出码 2', () => {
    const r = run();
    expect(r.code).toBe(2);
    expect(r.err).toContain('用法');
  });

  // 同步起子进程：卡死由子进程自己的上限管，不靠 vitest 的超时（#264）
  it('命令行外壳：真起一个进程，输出、退出码和上面一样', { timeout: 0 }, () => {
    const cli = (file: string) =>
      spawnSync(process.execPath, [SHAPE_SCRIPT, file], {
        encoding: 'utf8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
    const ok = cli(at('device.json'));
    expect(ok.error).toBeUndefined();
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('sk：字符串');
    noValue(ok.stdout);
    const missing = cli(at('missing.json'));
    expect(missing.error).toBeUndefined();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('读不了');
    expect(missing.stdout).toBe('');
  });
});
