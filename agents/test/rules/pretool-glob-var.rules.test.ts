// 钉住调工具前钩子（agents/hooks/pretool.mjs）的一条规矩（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）：
// bash 命令里值带通配符的变量（NAME=… 赋值、for NAME in 列表里写在引号内的通配）在引号外展开就拦。
// 为什么（单 #3515）：2026-10-22 指挥官会话跑 for via in "-x …" "--noproxy *"; do curl … $via …; done，工作目录是会话记录目录，
// * 被换成全部会话记录文件名，curl 把它们当成 http://<文件名>/ 经代理发到了国外节点。
// 加引号、用数组、set -f、引号外的通配（for f in *.ts）这些正常写法放行。
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PretoolLib {
  decide(raw: string, fallbackCwd?: string): { code: number; message?: string };
  unquotedGlobVar(cmd: string): { name: string; value: string } | null;
}

const HOOK = join(fileURLToPath(new URL('../../hooks/', import.meta.url)), 'pretool.mjs');
const lib = (await import(pathToFileURL(HOOK).href)) as PretoolLib;

const O = '/work/other';
const run = (command: string, tool = 'Bash') =>
  lib.decide(JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: O }));

// 2026-10-22 那两条的原样
const incident = [
  'for via in "-x http://127.0.0.1:7890" "--noproxy *"; do echo "=== via: $via"; for u in https://claude.ai/ https://claude.ai/api/bootstrap https://bridge.claudeusercontent.com/; do curl -s -o /dev/null $via -m 15 -w "%{http_code} t=%{time_total}s ip=%{remote_ip} $u\\n" "$u" || echo "FAIL $u"; done; done',
  'H=\'-H Connection:Upgrade -H Upgrade:websocket -H Sec-WebSocket-Version:13 -H Sec-WebSocket-Key:dGhlIHNhbXBsZSBub25jZQ==\'; for via in "-x http://127.0.0.1:7890" "--noproxy *"; do echo "=== $via"; for u in https://bridge.claudeusercontent.com/ https://claude.ai/api/frame/sync; do curl -s --http1.1 -o /dev/null $via -m 12 $H -H "Origin: https://claude.ai" -w "%{http_code} t=%{time_total}s $u\\n" "$u" || echo "FAIL $u"; done; done',
];

const blocked: [string, string][] = [
  [incident[0] ?? '', 'via'],
  [incident[1] ?? '', 'via'],
  ["x='*'; ls $x", 'x'],
  ['pat="--noproxy *"; curl $pat https://example.com/', 'pat'],
  ["export F='a b *.log'; cp $F /tmp/x", 'F'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 样例是 bash 命令，不是模板串
  ["x='*.log'; cat ${x}", 'x'],
  ['x=\'*\'; echo "$(ls $x)"', 'x'],
  ['for o in "-H a" "--noproxy *"\ndo\n  curl $o https://example.com/\ndone', 'o'],
  ["n='file[12]'; cat $n", 'n'],
  ['x=\\*; ls $x', 'x'],
];

const allowed: string[] = [
  'for via in "-x http://127.0.0.1:7890" "--noproxy *"; do curl -s "$via" https://example.com/; done',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 样例是 bash 命令，不是模板串
  'args=(--noproxy \'*\'); curl "${args[@]}" https://example.com/',
  "set -f; x='*'; ls $x",
  'for f in *.ts; do wc -l $f; done',
  "u='https://example.com/x?y=1'; curl $u",
  'x=\'*\'; echo "$x"',
  'x=\'*\'; y=$x; echo "$y"',
  "x='*'; case $x in a) echo a ;; esac",
  "x='*'; [[ $x == a ]] && echo ok",
  "H='-H Connection:Upgrade'; curl $H https://example.com/",
  "cat > a.sh <<'EOF'\nx='*'; ls $x\nEOF",
  "echo '$x *'",
  // 本机近两周真跑过、原先会被误拦的两类：for 列表是 $( ) 的输出；${p##*:} 里的 * 是展开时的模式，不进变量
  "for id in $(gh api repos/o/r/rulesets --jq '.[].id'); do gh api repos/o/r/rulesets/$id; done",
  "for f in $(grep -rl --include='*.jsonl' x .); do wc -l $f; done",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 样例是 bash 命令，不是模板串
  'for spec in "a.md:28" "b.md:13"; do n=${spec##*:}; f=${spec%%:*}; sed -n "${n}p" $f; done',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 样例是 bash 命令，不是模板串
  'for t in a-1 b-2; do d=runs/${t%%-*}-x; mkdir -p $d; done',
];

describe('值带通配的变量不在引号外展开', () => {
  it.each(blocked)('拦：%s', (command, name) => {
    expect(lib.unquotedGlobVar(command)?.name).toBe(name);
    const v = run(command);
    expect(v.code).toBe(2);
    expect(v.message).toContain(`$${name}`);
    expect(v.message).toContain(`"$${name}"`);
  });

  it.each(allowed)('放行：%s', (command) => {
    expect(lib.unquotedGlobVar(command)).toBeNull();
    expect(run(command).code).toBe(0);
  });

  it('PowerShell 不拆词、不展开通配，不归这条管', () => {
    expect(run("$x='*'; Get-ChildItem $x", 'PowerShell').code).toBe(0);
  });
});
