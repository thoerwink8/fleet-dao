#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# deploy/lib/cursor-agent.sh（给会话用户装、查 cursor-agent）的判据，每条失败路径都故意造出来：
#   1. 没装：判红、说清没装；装：以那个用户自己的身份、在他家里、环境清干净地跑官方安装脚本，先下成文件再跑、跑完删掉，
#      装出来的都归他，装完核得上；第二遍不再跑安装脚本、一处不改
#   2. 挑的是引擎会跑的那一个：current 优先，没有就挑版本号最新、能跑的；安装时的临时目录、不是版本号的不认
#      （和引擎的找法逐条对照在 packages/engine/test/real/hosts.test.ts）
#   3. 装着却跑不成（退出非 0、解释器没了）、输出认不出、卡住、不理叫停：判红，不重装、不删
#   4. 装的时候出错（安装脚本失败、下不到、退出 0 却什么都没装、卡住）：只记红、不中断，不算装了
#   5. 没查成（读不到找的那段、临时目录建不了、查不到这个用户、起不来）：不当成没装、不装
#   6. 会话代理（#731）：只带期望里登记的——法国登记的是空，一个代理变量都不带（root 环境里的 http(s)_proxy、
#      FLEET_SESSION_PROXY 都带不进去）；登记成 http://127.0.0.1:7890 就带上它；登记的读不出：不装，装着了也判红、不报绿
# 不出网：官方安装脚本换成假的（照官方的样子先解到 versions/.tmp-…、再挪成 versions/<版本>，~/.local/bin 下链上），
# 经 file:// 下；$T 下放开关文件让它故意出错。
# 要 root：得建临时用户、以他的身份跑；要 node（照期望读会话代理）。用法：sudo bash deploy/test/cursor-agent.test.sh。
# 退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/cli-tools.sh
source "$HERE/../lib/cli-tools.sh"
# shellcheck source=../lib/session-proxy.sh
source "$HERE/../lib/session-proxy.sh"
# shellcheck source=../lib/cursor-agent.sh
source "$HERE/../lib/cursor-agent.sh"

if ((EUID != 0)); then
  echo "cursor-agent：没跑成：要 root（得建临时用户、以他的身份跑）"
  exit 2
fi
# sudo 会换掉 PATH，CI 里 setup-node 装的那个不在上面，去它的缓存目录找
SESSION_PROXY_NODE=""
for n in "$(command -v node 2>/dev/null || true)" /opt/hostedtoolcache/node/*/x64/bin/node /usr/bin/node /usr/local/bin/node; do
  if [[ -x "$n" ]]; then
    SESSION_PROXY_NODE=$n
    break
  fi
done
if [[ -z "$SESSION_PROXY_NODE" ]]; then
  echo "cursor-agent：没跑成：这台找不到 node（照期望读会话代理要它）"
  exit 2
fi

U=fleet-cursor-test-$$
T=$(mktemp -d /var/tmp/cursor-agent-test.XXXXXX)
cleanup() {
  pkill -KILL -u "$U" >/dev/null 2>&1
  # 卡住被强杀的那次，下下来的安装脚本删不掉；不清掉，下一回 useradd 拿到同一个号，第 1 节「跑完删了」就读红
  find /tmp -maxdepth 1 -user "$U" -exec rm -rf -- {} + >/dev/null 2>&1
  userdel "$U" >/dev/null 2>&1
  rm -rf -- "$T"
}
trap cleanup EXIT
chmod 755 "$T"
H=$T/home
if ! useradd --system --user-group --home-dir "$H" --create-home --shell /bin/bash "$U" >/dev/null 2>&1; then
  echo "cursor-agent：没跑成：建不了临时用户 $U"
  exit 2
fi
V=$H/.local/share/cursor-agent/versions
VER=2026.09.26-dd393fe
as_u() { runuser -u "$U" -- "$@"; }
# root 这边的环境变量：安装脚本和 --version 都不该看得到
export CURSOR_TEST_LEAK=1

# 假的官方安装脚本：一行记下以谁、在哪、带没带进 root 的变量、自己是从哪跑的；照官方的样子装。
# 开关：install-fail 像下载 404 那样退出 1；install-noop 什么都不装、照样退出 0（官方的不查每一步）；install-hang 卡住
install -o "$U" -g "$U" -m 644 /dev/null "$T/install.log"
cat >"$T/install.sh" <<EOF
#!/usr/bin/env bash
echo "\$(id -un) \$HOME \$PWD \${CURSOR_TEST_LEAK-unset} \$0" >>"$T/install.log"
echo "\${http_proxy-unset} \${https_proxy-unset} \${HTTP_PROXY-unset} \${HTTPS_PROXY-unset} \${no_proxy-unset} \${NO_PROXY-unset}" >>"$T/proxy.log"
if [ -e "$T/install-fail" ]; then
  echo "curl: (22) The requested URL returned error: 404" >&2
  printf '\033[0;31m✗\033[0m Download failed.\n'
  exit 1
fi
if [ -e "$T/install-hang" ]; then sleep 60; fi
if [ -e "$T/install-noop" ]; then exit 0; fi
d=\$HOME/.local/share/cursor-agent/versions
mkdir -p "\$d/.tmp-$VER-1" "\$HOME/.local/bin"
printf '#!/bin/sh\n[ "\$1" = --version ] && echo %s\n' "$VER" >"\$d/.tmp-$VER-1/cursor-agent"
chmod 755 "\$d/.tmp-$VER-1/cursor-agent"
rm -rf "\$d/$VER"
mv "\$d/.tmp-$VER-1" "\$d/$VER"
ln -sf "\$d/$VER/cursor-agent" "\$HOME/.local/bin/cursor-agent"
ln -sf "\$d/$VER/cursor-agent" "\$HOME/.local/bin/agent"
EOF
chmod 644 "$T/install.sh"
install -o "$U" -g "$U" -m 644 /dev/null "$T/proxy.log"
URL=file://$T/install.sh
runs() { wc -l <"$T/install.log"; }
# root 自己环境里的代理（root 的登录 shell 里碰巧有）、碰巧有的 FLEET_SESSION_PROXY：安装脚本只该看到期望里
# 登记的，这几个一个都看不到
export https_proxy=http://root-only.invalid:1 HTTPS_PROXY=http://root-only.invalid:1
export FLEET_SESSION_PROXY=http://root-only.invalid:1
# 在版本目录里放一个假 cursor-agent（以他的身份），正文是 sh；第三个参数给 644 就是不能跑
put_agent() { # 目录名 正文 [权限]
  as_u mkdir -p "$V/$1"
  printf '#!/bin/sh\n%s\n' "$2" >"$T/agent.tmp"
  install -o "$U" -g "$U" -m "${3:-755}" "$T/agent.tmp" "$V/$1/cursor-agent"
}
# shellcheck disable=SC2016 # 单引号里的 $1 是假 cursor-agent 自己的参数
says() { printf '[ "$1" = --version ] && echo %s' "$1"; } # 假 cursor-agent 的正文：--version 打这个

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
has() { # 说明 文本 要有的（grep -E）
  if grep -qE -- "$3" <<<"$2"; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：「%s」里没有「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
last_red() { if ((${#REDS[@]})); then printf '%s' "${REDS[-1]}"; fi; }

echo "== 1. 没装：判红、说清没装"
cursor_agent_version "$U" "$V"
check "读不成（返回 1）" "$?" 1
check "认成没装" "$CURSOR_AGENT_ABSENT" 1
has "原因写没装、在哪找的" "$CURSOR_AGENT_BAD" "没装 cursor-agent（$V 下既没有 current"
REDS=()
check_cursor_agent "$U" "$V" >/dev/null
check "读回记一笔红" "${#REDS[@]}" 1
has "读回说引擎起不了、怎么补" "$(last_red)" '引擎起不了 Cursor 会话：重跑 bash deploy/france.sh'

echo "== 1. 装：以他自己的身份、在他家里、环境清干净地跑官方安装脚本；装完核得上；第二遍不动"
CHANGES=() REDS=()
ensure_cursor_agent "$U" "$V" "$URL" >/dev/null
check "记一笔改动" "${#CHANGES[@]}" 1
check "没有红" "${#REDS[@]}" 0
has "改动写清装了哪一版、装在哪" "${CHANGES[0]-}" "装 cursor-agent $VER（官方安装脚本 $URL，以他自己的身份装在 $V/$VER）"
check "安装脚本跑了一次" "$(runs)" 1
read -r who home pwd leak self <"$T/install.log"
check "以他的身份、家目录和当前目录都是他家" "$who $home $pwd" "$U $H $H"
check "root 这边的环境变量带不进去" "$leak" unset
check "法国（期望登记的会话代理是空）：一个代理变量都不带，root 环境里的代理、FLEET_SESSION_PROXY 都带不进去" \
  "$(tail -1 "$T/proxy.log")" "unset unset unset unset unset unset"
has "安装脚本先下成文件再跑（不是 curl | bash）" "$self" '^/tmp/'
check "下下来的安装脚本跑完删了" "$(find /tmp -maxdepth 1 -user "$U" -printf '%p\n' | head -3)" ""
cursor_agent_version "$U" "$V"
check "装完读得到版本" "$CURSOR_AGENT_HAVE" "$VER"
check "挑的是版本目录里那一个" "$CURSOR_AGENT_BIN" "$V/$VER/cursor-agent"
check "他家里没有不归他的文件" "$(find "$H" ! -user "$U" -printf '%p\n' | head -3)" ""
CHANGES=() REDS=()
ensure_cursor_agent "$U" "$V" "$URL" >/dev/null
check "第二遍一处没改" "${#CHANGES[@]}" 0
check "第二遍没有红" "${#REDS[@]}" 0
check "第二遍没再跑安装脚本" "$(runs)" 1
REDS=()
check_cursor_agent "$U" "$V" >/dev/null
check "读回没有红" "${#REDS[@]}" 0

echo "== 2. 挑的是引擎会跑的那一个"
put_agent 2026.10.1-ccc3333 "$(says 2026.10.1-ccc3333)"
cursor_agent_version "$U" "$V"
check "有更新的版本目录：挑最新的" "$CURSOR_AGENT_HAVE $CURSOR_AGENT_BIN" "2026.10.1-ccc3333 $V/2026.10.1-ccc3333/cursor-agent"
chmod 644 "$V/2026.10.1-ccc3333/cursor-agent"
cursor_agent_version "$U" "$V"
check "最新的不能跑：跳过，用下一个" "$CURSOR_AGENT_HAVE" "$VER"
put_agent .tmp-2026.10.2-ddd4444-1 "$(says 2026.10.2-ddd4444)"
put_agent 80975bde-8b97-4c7b-bdcb-00741e363c13 "$(says 2026.10.3-eee5555)"
put_agent latest "$(says 2026.10.4-fff6666)"
cursor_agent_version "$U" "$V"
check "临时目录、UUID、latest 不认" "$CURSOR_AGENT_HAVE" "$VER"
put_agent current "$(says 2026.10.5-aaa7777)"
cursor_agent_version "$U" "$V"
check "有 current 就用 current" "$CURSOR_AGENT_HAVE $CURSOR_AGENT_BIN" "2026.10.5-aaa7777 $V/current/cursor-agent"
chmod 644 "$V/current/cursor-agent"
cursor_agent_version "$U" "$V"
check "current 不能跑：照版本号挑" "$CURSOR_AGENT_HAVE" "$VER"
rm -rf -- "$V/current" "$V/2026.10.1-ccc3333" "$V/.tmp-2026.10.2-ddd4444-1" "$V/80975bde-8b97-4c7b-bdcb-00741e363c13" "$V/latest"

echo "== 3. 装着却跑不成、输出认不出、卡住：判红，不重装、不删"
cp -- "$V/$VER/cursor-agent" "$T/good-agent"
expect_bad() { # 说明 正文 原因里要有的（grep -E）
  put_agent "$VER" "$2"
  cursor_agent_version "$U" "$V"
  check "$1：读不成" "$?" 1
  check "$1：不认成没装" "$CURSOR_AGENT_ABSENT" 0
  has "$1：原因" "$CURSOR_AGENT_BAD" "$3"
}
expect_bad "退出非 0" 'echo "boom: 坏了" >&2; exit 3' "$V/$VER/cursor-agent --version 退出 3：boom: 坏了"
CHANGES=() REDS=()
ensure_cursor_agent "$U" "$V" "$URL" >/dev/null
check "跑不成：不重装（没再跑安装脚本）" "$(runs)" 1
check "跑不成：一处没改" "${#CHANGES[@]}" 0
has "跑不成：记红，说不重装、不删" "$(last_red)" '退出 3：boom: 坏了；不重装、不删'
check "跑不成：文件还在" "$(test -e "$V/$VER/cursor-agent" && echo 在)" 在
REDS=()
check_cursor_agent "$U" "$V" >/dev/null
has "跑不成：读回记红" "$(last_red)" "$V/$VER/cursor-agent --version 退出 3"
printf '#!/nonexistent/sh\necho %s\n' "$VER" >"$T/agent.tmp"
install -o "$U" -g "$U" -m 755 "$T/agent.tmp" "$V/$VER/cursor-agent"
cursor_agent_version "$U" "$V"
check "解释器没了（起不来也退出 127）：不认成没装" "$CURSOR_AGENT_ABSENT" 0
has "解释器没了：原因是那一个跑 --version 没成" "$CURSOR_AGENT_BAD" "$V/$VER/cursor-agent --version 退出 (126|127)"
expect_bad "输出认不出" 'echo "Cursor Agent v1"' '--version 的输出认不出（该是一行版本号）：「Cursor Agent v1」'
expect_bad "多打了一行" "echo $VER; echo 'update available'" "输出认不出（该是一行版本号）：「$VER update available」"
expect_bad "什么都不打" 'exit 0' '输出认不出（该是一行版本号）：「」'
CURSOR_AGENT_TIMEOUT=1
t0=$SECONDS
expect_bad "卡住" 'sleep 60' "$V/$VER/cursor-agent --version 卡住，被 timeout 叫停（退出码 124"
check "卡住：几秒就返回" "$((SECONDS - t0 <= 5))" 1
t0=$SECONDS
expect_bad "不理叫停" "trap '' TERM; sleep 60" '退出码 137'
check "不理叫停：再过 5 秒被强杀就返回" "$((SECONDS - t0 <= 10))" 1
pkill -KILL -u "$U" >/dev/null 2>&1
CURSOR_AGENT_TIMEOUT=20
install -o "$U" -g "$U" -m 755 "$T/good-agent" "$V/$VER/cursor-agent"
cursor_agent_version "$U" "$V"
check "换回好的：读得到" "$CURSOR_AGENT_HAVE" "$VER"

echo "== 4. 装的时候出错：只记红、不中断，不算装了"
rm -rf -- "$V" "$H/.local/bin/cursor-agent" "$H/.local/bin/agent"
expect_install_red() { # 说明 地址 红里要有的（grep -E）
  local before
  before=$(runs)
  CHANGES=() REDS=()
  ensure_cursor_agent "$U" "$V" "$2" >/dev/null
  check "$1：返回 0（不中断装机）" "$?" 0
  check "$1：一处没改" "${#CHANGES[@]}" 0
  check "$1：记一笔红" "${#REDS[@]}" 1
  has "$1：红里写清" "$(last_red)" "$3"
  RUNS_DELTA=$(($(runs) - before))
}
touch "$T/install-fail"
expect_install_red "安装脚本失败" "$URL" "没装上（官方安装脚本 $URL 退出 1）：.*404.*Download failed\."
has "安装脚本失败：终端控制符去掉了" "$(last_red)" '^[^'$'\033'']*$'
rm -f "$T/install-fail"
expect_install_red "下不到安装脚本" "file://$T/nope.sh" '没装上.*退出 1）：.*下不到安装脚本'
check "下不到：没跑安装脚本" "$RUNS_DELTA" 0
touch "$T/install-noop"
expect_install_red "退出 0 却什么都没装" "$URL" "跑完官方安装脚本（$URL），cursor-agent 还是用不了：没装 cursor-agent"
rm -f "$T/install-noop"
touch "$T/install-hang"
CURSOR_AGENT_INSTALL_TIMEOUT=2
t0=$SECONDS
expect_install_red "安装卡住" "$URL" '装 cursor-agent 卡住，被 timeout 叫停（退出码 124'
check "安装卡住：几秒就返回" "$((SECONDS - t0 <= 6))" 1
pkill -KILL -u "$U" >/dev/null 2>&1
rm -f "$T/install-hang"
CURSOR_AGENT_INSTALL_TIMEOUT=900
check "上面几次都没留下能跑的" "$(cursor_agent_version "$U" "$V"; echo "$CURSOR_AGENT_ABSENT")" 1
CHANGES=() REDS=()
ensure_cursor_agent "$U" "$V" "$URL" >/dev/null
check "好了再装：装上" "${#CHANGES[@]} ${#REDS[@]}" "1 0"
check "他家里没有不归他的文件" "$(find "$H" ! -user "$U" -printf '%p\n' | head -3)" ""

echo "== 5. 没查成：不当成没装、不装"
before=$(runs)
rm -rf -- "$V"
probe_was=$CURSOR_AGENT_PROBE
CURSOR_AGENT_PROBE=$T/没有这个.sh
cursor_agent_version "$U" "$V"
check "读不到找的那段：读不成" "$?" 1
check "读不到找的那段：不认成没装" "$CURSOR_AGENT_ABSENT" 0
has "读不到找的那段：原因说没查成" "$CURSOR_AGENT_BAD" "读不到 $T/没有这个.sh，cursor-agent 没查成"
CHANGES=() REDS=()
ensure_cursor_agent "$U" "$V" "$URL" >/dev/null
check "读不到找的那段：不装" "$(($(runs) - before)) ${#CHANGES[@]} ${#REDS[@]}" "0 0 1"
CURSOR_AGENT_PROBE=$probe_was
TMPDIR=$T/没有这个目录 cursor_agent_version "$U" "$V"
check "临时目录建不了：读不成" "$?" 1
check "临时目录建不了：不认成没装" "$CURSOR_AGENT_ABSENT" 0
has "临时目录建不了：原因说没查成" "$CURSOR_AGENT_BAD" '建不了放 cursor-agent --version 输出的临时目录.*没查成'
cursor_agent_version "fleet-no-such-$$" "$V"
check "查不到这个用户：不认成没装" "$?:$CURSOR_AGENT_ABSENT" 1:0
has "查不到这个用户：原因" "$CURSOR_AGENT_BAD" "getent 查不到 fleet-no-such-$$ 的家目录"
# nobody 的家目录（/nonexistent）不在：进不去、起不来，标准错误里有话
cursor_agent_version nobody /nonexistent/versions
check "起不来：不认成没装" "$?:$CURSOR_AGENT_ABSENT" 1:0
has "起不来：原因说没跑成、带着报错" "$CURSOR_AGENT_BAD" '以 nobody 的身份找 cursor-agent 没跑成（退出 1）：.+'
check "没查成的几次都没跑安装脚本" "$(($(runs) - before))" 0

echo "== 6. 会话代理（#731：只认期望里登记的；法国登记成空＝直连，登记了就带上）"
rm -rf -- "$V"
before=$(runs)
SESSION_PROXY_DESIRED=$T/没有这份.json SESSION_PROXY_STATE=""
CHANGES=() REDS=()
ensure_cursor_agent "$U" "$V" "$URL" >/dev/null
check "【故意造出的失败】登记的会话代理读不出：不装、记红（不拿直连顶）" "$(($(runs) - before)) ${#CHANGES[@]} ${#REDS[@]}" "0 0 1"
has "读不出：红里写清是会话代理没读成" "$(last_red)" '这一档登记的会话代理没读成（照期望 .*没有这份\.json 出不了 engine\.env'
# 照 deploy/france/desired-config.json 改写出一份，把会话代理登记成 http://127.0.0.1:7890（值从仓里那份现取、不写死别的）
"$SESSION_PROXY_NODE" -e '
  const fs = require("node:fs");
  const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  j.files["engine.env"].FLEET_SESSION_PROXY.value = "http://127.0.0.1:7890";
  fs.writeFileSync(process.argv[2], JSON.stringify(j));' "$HERE/../france/desired-config.json" "$T/proxied.json"
SESSION_PROXY_DESIRED=$T/proxied.json SESSION_PROXY_STATE=""
CHANGES=() REDS=()
ensure_cursor_agent "$U" "$V" "$URL" >/dev/null
check "登记了代理：装上" "${#CHANGES[@]} ${#REDS[@]}" "1 0"
# 【故意造出的失败】的另一面：登记了代理、安装脚本的环境里却没有，这里就红
check "登记了代理：安装脚本的环境里带上它（大小写各一份、no_proxy 只放本机回环），root 环境里的没带进去" \
  "$(tail -1 "$T/proxy.log")" \
  "http://127.0.0.1:7890 http://127.0.0.1:7890 http://127.0.0.1:7890 http://127.0.0.1:7890 localhost,127.0.0.1,::1 localhost,127.0.0.1,::1"
read -r who home pwd leak self < <(tail -1 "$T/install.log")
check "别的照旧清干净：root 的变量带不进去" "$leak" unset
SESSION_PROXY_DESIRED=$T/没有这份.json SESSION_PROXY_STATE=""
CHANGES=() REDS=()
ensure_cursor_agent "$U" "$V" "$URL" >/dev/null
check "【故意造出的失败】装着了、登记的会话代理读不出：照样判红，不拿没经代理查的报绿" "${#CHANGES[@]} ${#REDS[@]}" "0 1"
SESSION_PROXY_DESIRED="" SESSION_PROXY_STATE=""

if ((fail)); then
  echo "cursor-agent：不通过"
  exit 1
fi
echo "cursor-agent：通过"
