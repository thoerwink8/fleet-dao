#!/usr/bin/env bash
# fleet-agent-scope 的 probe 子命令（#1969：只读命令行工具版本）。不要 root、不要真的会话用户：
# AGENT_SCOPE_TEST_AS_USER=direct 不降权，AGENT_SCOPE_TEST_HOME 给一个临时家目录。
# 钉住：拒任意命令、拒白名单外的用户、run --user pilot 仍拒、pilot 的 probe 允许、假二进制只收到 --version、
# Mirasim 读目录名、缺命令非 0 且不把输出当成成功。npm 这台有就跑只读的 npm ls -g，没有就断言「找不到 npm」。
# 用法：bash deploy/test/agent-scope-probe.test.sh。退出码：0 通过，1 不通过。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
BIN=$HERE/../france/fleet-agent-scope.sh
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
fail=0
pass() { echo "  ✓ $*"; }
flunk() {
  echo "  ✗ $*"
  fail=1
}

HOME_DIR=$TMP/home
mkdir -p "$HOME_DIR/.local/bin" "$HOME_DIR/.grok/bin" "$HOME_DIR/.local/share/cursor-agent/versions/2026.09.23-86fc751"

cat >"$HOME_DIR/.local/bin/claude" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >"$HOME/claude-args"
echo "2.1.282 (Claude Code)"
SH
cat >"$HOME_DIR/.grok/bin/grok" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >"$HOME/grok-args"
echo "grok 1.0.41 (abcdef1)"
SH
cat >"$HOME_DIR/.local/bin/reclaude" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >"$HOME/reclaude-args"
echo "reclaude 1.3.0"
SH
cat >"$HOME_DIR/.local/share/cursor-agent/versions/2026.09.23-86fc751/cursor-agent" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >"$HOME/cursor-args"
echo "2026.09.23-86fc751"
SH
chmod +x "$HOME_DIR/.local/bin/claude" "$HOME_DIR/.grok/bin/grok" "$HOME_DIR/.local/bin/reclaude" \
  "$HOME_DIR/.local/share/cursor-agent/versions/2026.09.23-86fc751/cursor-agent"
ln -s "2026.09.23-86fc751" "$HOME_DIR/.local/share/cursor-agent/versions/current"
mkdir -p "$HOME_DIR/.mirasim-remote/servers/0.0.355"
ln -s "servers/0.0.355" "$HOME_DIR/.mirasim-remote/current"

export AGENT_SCOPE_TEST_AS_USER=direct
export AGENT_SCOPE_TEST_HOME=$HOME_DIR
export AGENT_SCOPE_TEST_DEPLOY=$HERE/..

run_scope() {
  bash "$BIN" "$@"
}

echo "拒任意命令、拒白名单外的用户"
out=$(run_scope probe --user pilot -- /bin/true 2>&1) && rc=0 || rc=$?
if [[ $rc -eq 64 && "$out" == *只认* ]]; then pass "pilot 不能跑 /bin/true（$rc）"; else flunk "任意命令该 64，得到 $rc：$out"; fi

out=$(run_scope probe --user pilot -- claude --version 2>&1) && rc=0 || rc=$?
if [[ $rc -eq 64 ]]; then pass "工具名后面多出来的参数不收"; else flunk "多参数该 64，得到 $rc：$out"; fi

out=$(run_scope probe --user nobody -- claude 2>&1) && rc=0 || rc=$?
if [[ $rc -eq 64 && "$out" == *pilot* && "$out" != *ok* ]]; then pass "nobody 不在 probe 白名单"; else flunk "nobody 该拒，得到 $rc：$out"; fi

out=$(run_scope run t01 --user pilot -- /bin/true 2>&1) && rc=0 || rc=$?
if [[ $rc -eq 64 && "$out" == *fleet-agent-carpool* && "$out" != *pilot\ 也能* ]]; then pass "run --user pilot 仍拒"; else flunk "run pilot 该拒，得到 $rc：$out"; fi

out=$(run_scope probe --npm -- claude 2>&1) && rc=0 || rc=$?
if [[ $rc -eq 64 ]]; then pass "npm 白名单不收 claude"; else flunk "npm claude 该 64，得到 $rc：$out"; fi

echo "假二进制只收到 --version，两个用户的身份分开"
out=$(run_scope probe --user pilot -- claude 2>&1) && rc=0 || rc=$?
args=$(cat "$HOME_DIR/claude-args" 2>/dev/null || true)
if [[ $rc -eq 0 && "$out" == *"2.1.282"* && "$args" == "--version" && "$out" != *update* && "$out" != *upgrade* && "$out" != *install* ]]; then
  pass "pilot 的 claude 读到 2.1.282，参数只有 --version"
else
  flunk "claude 该读出版本，得到 $rc args=[$args] out=[$out]"
fi

out=$(run_scope probe --user fleet-agent-carpool -- grok 2>&1) && rc=0 || rc=$?
args=$(cat "$HOME_DIR/grok-args" 2>/dev/null || true)
if [[ $rc -eq 0 && "$out" == *"1.0.41"* && "$args" == "--version" ]]; then pass "fleet-agent-carpool 的 grok 读到 1.0.41"; else flunk "grok 得到 $rc args=[$args] out=[$out]"; fi

out=$(run_scope probe --user pilot -- reclaude 2>&1) && rc=0 || rc=$?
args=$(cat "$HOME_DIR/reclaude-args" 2>/dev/null || true)
if [[ $rc -eq 0 && "$out" == *"1.3.0"* && "$args" == "--version" ]]; then pass "reclaude 只跑 --version"; else flunk "reclaude 得到 $rc args=[$args] out=[$out]"; fi

out=$(run_scope probe --user pilot -- cursor-agent 2>&1) && rc=0 || rc=$?
args=$(cat "$HOME_DIR/cursor-args" 2>/dev/null || true)
if [[ $rc -eq 0 && "$out" == *"2026.09.23-86fc751"* && "$args" == "--version" ]]; then pass "cursor-agent 读到目录版本"; else flunk "cursor 得到 $rc args=[$args] out=[$out]"; fi

out=$(run_scope probe --user pilot -- mirasim-server 2>&1) && rc=0 || rc=$?
if [[ $rc -eq 0 && "$out" == "0.0.355" ]]; then pass "Mirasim 读目录名 0.0.355"; else flunk "mirasim 得到 $rc [$out]"; fi

echo "reclaude：只认自己的版本行，Claude Code 版本、无版本、非零退出、设备解绑都不当成功"
write_reclaude() { printf '#!/bin/sh\nprintf "%%s\\n" "$*" >"$HOME/reclaude-args"\n%s\n' "$1" >"$HOME_DIR/.local/bin/reclaude"; }
write_reclaude 'printf "Syncing config...\nreclaude 1.5.0\n2.1.308 (Claude Code)\n"'
out=$(run_scope probe --user pilot -- reclaude 2>&1) && rc=0 || rc=$?
args=$(cat "$HOME_DIR/reclaude-args" 2>/dev/null || true)
if [[ $rc -eq 0 && "$out" == "reclaude 1.5.0" && "$args" == "--version" ]]; then pass "混合输出只取 reclaude 自己的行"; else flunk "混合输出得到 $rc args=[$args] [$out]"; fi

write_reclaude 'printf "Syncing config...\n2.1.308 (Claude Code)\n"'
out=$(run_scope probe --user pilot -- reclaude 2>&1) && rc=0 || rc=$?
if [[ $rc -ne 0 && "$out" == *来源不明* && "$out" != "2.1.308"* ]]; then pass "只有 Claude Code 版本：来源不明、非 0"; else flunk "Claude Code 版本该失败，得到 $rc [$out]"; fi

write_reclaude 'printf "Syncing config...\n"'
out=$(run_scope probe --user pilot -- reclaude 2>&1) && rc=0 || rc=$?
if [[ $rc -ne 0 && "$out" == *来源不明* ]]; then pass "没有版本：来源不明、非 0"; else flunk "无版本该失败，得到 $rc [$out]"; fi

write_reclaude 'printf "Syncing config...\nlogin no longer valid: 此设备已被解绑\n" >&2; exit 3'
out=$(run_scope probe --user pilot -- reclaude 2>&1) && rc=0 || rc=$?
if [[ $rc -eq 3 && "$out" == *此设备已被解绑* && "$out" != *来源不明* ]]; then pass "设备解绑：保留退出码和原话"; else flunk "设备解绑该原样失败，得到 $rc [$out]"; fi

write_reclaude 'printf "reclaude 1.3.0\n"'
chmod +x "$HOME_DIR/.local/bin/reclaude"

echo "缺命令、指错目录：非 0，不写成成功"
rm -f "$HOME_DIR/.local/bin/codex"
out=$(run_scope probe --user pilot -- codex 2>&1) && rc=0 || rc=$?
if [[ $rc -ne 0 && "$out" != "0" && "$out" != "ok" && -n "$out" ]]; then pass "没有 codex 时非 0：$out"; else flunk "缺 codex 该失败，得到 $rc [$out]"; fi

rm -rf "$HOME_DIR/.mirasim-remote"
mkdir -p "$HOME_DIR/.mirasim-remote/elsewhere"
ln -s "elsewhere" "$HOME_DIR/.mirasim-remote/current"
out=$(run_scope probe --user fleet-agent-carpool -- mirasim-server 2>&1) && rc=0 || rc=$?
if [[ $rc -ne 0 && "$out" == *不在\ servers* ]]; then pass "current 不在 servers 下就失败"; else flunk "指错目录该失败，得到 $rc [$out]"; fi

rm -rf "$HOME_DIR/.mirasim-remote"
out=$(run_scope probe --user pilot -- mirasim-server 2>&1) && rc=0 || rc=$?
if [[ $rc -ne 0 && "$out" == *读不到* ]]; then pass "没有 current 就读不到"; else flunk "没有 current 该失败，得到 $rc [$out]"; fi

echo "全局 npm"
if [[ -x /usr/local/bin/npm || -x /usr/bin/npm ]]; then
  out=$(run_scope probe --npm -- pi 2>&1) && rc=0 || rc=$?
  if [[ $rc -eq 0 && "$out" == "{"* ]]; then pass "npm ls -g 读到 JSON"; else flunk "npm 该给出 JSON，得到 $rc [${out:0:200}]"; fi
else
  out=$(run_scope probe --npm -- pi 2>&1) && rc=0 || rc=$?
  if [[ $rc -ne 0 && "$out" == *找不到\ npm* ]]; then pass "这台没有 npm，记找不到"; else flunk "没有 npm 该说明找不到，得到 $rc [$out]"; fi
fi

if ((fail)); then
  echo "失败"
  exit 1
fi
echo "通过"
exit 0
