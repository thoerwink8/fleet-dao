#!/usr/bin/env bash
# 同步脚本（packages/agents-sync）以 root 替一个用户写：先换成那个用户再动手，写出来的东西都归他（家里不许留 root
# 属主的文件）；原件在换身份之前读好；第二遍零改动；--check 全绿；属主不对的文件 --check 判红；root 不带 --user
# 直接写别人的家要被拦下。vitest 以普通用户跑，换身份这条路只有这里测得到。
# 要 root：得建临时用户、换身份。临时用户和沙盒跑完就删，不碰任何真用户的家。
# 用法：sudo bash deploy/test/agents-sync.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd -- "$HERE/../.." && pwd)
SYNC=$REPO/packages/agents-sync/bin/agents-sync

if ((EUID != 0)); then
  echo "agents-sync：没跑成：要 root（得建临时用户、换身份）"
  exit 2
fi

# 要能直接跑 TypeScript 的 node（22.18 起）。sudo 会换掉 PATH，CI 里 setup-node 装的那个不在上面，去它的缓存目录找
NODE=""
for n in "$(command -v node 2>/dev/null || true)" /opt/hostedtoolcache/node/*/x64/bin/node /usr/bin/node /usr/local/bin/node; do
  if [[ -x "$n" ]] && "$n" -e 'process.exit(process.features.typescript ? 0 : 1)' 2>/dev/null; then
    NODE=$n
    break
  fi
done
if [[ -z "$NODE" ]]; then
  echo "agents-sync：没跑成：这台找不到能直接跑 TypeScript 的 node（要 22.18 或更高）"
  exit 2
fi

U=fleet-sync-test-$$
T=$(mktemp -d /var/tmp/agents-sync-test.XXXXXX)
cleanup() {
  userdel "$U" >/dev/null 2>&1
  rm -rf -- "$T"
}
trap cleanup EXIT
chmod 755 "$T"
H=$T/home
if ! useradd --system --user-group --home-dir "$H" --create-home --shell /usr/sbin/nologin "$U" >/dev/null 2>&1; then
  echo "agents-sync：没跑成：建不了临时用户 $U"
  exit 2
fi

# 假的 claude、codex 放进他家的 .local/bin：同步脚本按它判这台装了哪几家
install -d -o "$U" -g "$U" -m 755 "$H/.local" "$H/.local/bin" "$H/.codex"
for b in claude codex; do
  printf '#!/bin/sh\n' >"$H/.local/bin/$b"
  chmod 755 "$H/.local/bin/$b"
  chown "$U:$U" "$H/.local/bin/$b"
done
# 他家里原来就有一份另一套内容的 codex 规矩：第一次接管要先备份
ORIGINAL=$'# 原来的规矩\n- 一条\n'
printf '%s' "$ORIGINAL" >"$H/.codex/AGENTS.md"
chown "$U:$U" "$H/.codex/AGENTS.md"
# 假仓：真的 AGENTS.md 加一个 skill、三个假钩子脚本（和 HOOK_TARGETS 登记的名字对上，缺一个就会被 missingScript
# 拦下、settings.json 整份不写——只有 root 读得到，换身份之后才读原件的话，这里就读不到
R=$T/repo
mkdir -p "$R/agents/skills/demo" "$R/agents/hooks"
cp "$REPO/AGENTS.md" "$R/AGENTS.md"
printf -- '---\nname: demo\n---\n演示用的 skill\n' >"$R/agents/skills/demo/SKILL.md"
printf '// 假的调工具前钩子\n' >"$R/agents/hooks/pretool.mjs"
printf '// 假的开会话钩子\n' >"$R/agents/hooks/session-start.mjs"
printf '// 假的收尾提醒钩子\n' >"$R/agents/hooks/stop.mjs"
chmod -R go-rwx "$R"

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
run_sync() { # 参数…；输出进 OUT，退出码进 RC
  RC=0
  OUT=$("$NODE" "$SYNC" "$@" --repo "$R" 2>&1) || RC=$?
}

echo "== 以 root 带 --user 写：东西都归那个用户"
run_sync --apply --user "$U"
check "第一遍退出 0" "$RC" 0
check "家里没有不归 $U 的文件" "$(find "$H" ! -user "$U" -printf '%p\n' | head -5)" ""
check "Claude 的全局文件写上了通用段" "$(grep -c 'fleet-dao:通用段 开始' "$H/.claude/CLAUDE.md")" 1
check "codex 原来那份整份备份了" "$(cat "$H"/.fleet-dao/backups/*/.codex/AGENTS.md)" "${ORIGINAL%$'\n'}"
check "输出写明原文件几行、备份在哪" "$(grep -c '接管——原文件 2 行，已备份到' <<<"$OUT")" 1
check "skill 拷进了 ~/.claude/skills 和 ~/.agents/skills" \
  "$(cat "$H/.claude/skills/demo/SKILL.md" "$H/.agents/skills/demo/SKILL.md" | grep -c '演示用的 skill')" 2
check "清单记下了装过的 skill" "$(grep -c '"demo"' "$H/.fleet-dao/agents-sync.json")" 2
# 替别的用户写：调工具前、Stop 那两条钩子照装（他家里就有 reclaude 的设备密钥，借道读这份设置的几家起的会话也要拦；
# Stop 不需要会话、不用等自动发布），开会话那条不登记（它要在他自己能拉、能写的检出里快进、同步，法国的检出跟着自动发布走）
check "钩子脚本拷进了他家" "$(cat "$H/.fleet-dao/hooks/pretool.mjs")" "// 假的调工具前钩子"
check "Stop 钩子脚本也拷进了他家" "$(cat "$H/.fleet-dao/hooks/stop.mjs")" "// 假的收尾提醒钩子"
check "Claude 的设置里登记了调工具前、Stop 那两条" \
  "$("$NODE" -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(Object.keys(s.hooks).join(","))' "$H/.claude/settings.json")" \
  PreToolUse,Stop
check "写明开会话那条为什么不登记" "$(grep -c 'SessionStart：替别的用户写（--user）时不登记开会话钩子' <<<"$OUT")" 1
# 全局 git 忽略：换完身份之后才起的 git 子进程，cwd 还是原来那个仓目录（$U 摸不到）——踩过一次
# 「fatal: failed to stat '<仓目录>': Permission denied」，git-excludes.ts 加了 -C "$home" 才好
check "core.excludesFile 设到了 gitignore_global（原来没设过）" \
  "$(grep -c '设成了 ~/.fleet-dao/gitignore_global（原来没设过）' <<<"$OUT")" 1
check "core.excludesFile 真写进了 ~/.gitconfig" \
  "$(git config --file "$H/.gitconfig" --path --get core.excludesFile)" \
  "$H/.fleet-dao/gitignore_global"
check "gitignore_global 新建、写了 _tmp/ 那一块" "$(grep -c '新建，写入 _tmp/ 那一块' <<<"$OUT")" 1
check "gitignore_global 文件内容里真有 _tmp/" \
  "$(grep -c 'fleet-dao:全局忽略 开始' "$H/.fleet-dao/gitignore_global")" 1
check "gitignore_global 归 $U、不归 root" "$(stat -c %U "$H/.fleet-dao/gitignore_global")" "$U"

echo "== 第二遍零改动，--check 全绿"
run_sync --apply --user "$U"
check "第二遍退出 0" "$RC" 0
check "第二遍一处没改" "$(grep -c '↻' <<<"$OUT")" 0
check "第二遍全局 git 忽略读回一致" "$(grep -c 'gitignore_global：_tmp/ 在全局忽略里' <<<"$OUT")" 1
run_sync --check --user "$U"
check "--check 退出 0" "$RC" 0
check "--check 也认全局 git 忽略一致" "$(grep -c 'gitignore_global：_tmp/ 在全局忽略里' <<<"$OUT")" 1

echo "== 属主不对的文件：--check 判红"
chown root:root "$H/.claude/CLAUDE.md"
run_sync --check --user "$U"
check "--check 退出 1" "$RC" 1
check "说出属主不对" "$(grep -c '属主是 uid 0' <<<"$OUT")" 1
chown "$U:$U" "$H/.claude/CLAUDE.md"

echo "== root 不带 --user 往别人的家里写：拦下"
before=$(find "$H" -printf '%p %u\n' | sort)
run_sync --apply --home "$H"
check "退出 64" "$RC" 64
check "叫人加 --user" "$(grep -c '加 --user' <<<"$OUT")" 1
check "一个文件都没动" "$(find "$H" -printf '%p %u\n' | sort)" "$before"

if ((fail)); then
  echo "agents-sync：不通过"
  exit 1
fi
echo "agents-sync：通过"
