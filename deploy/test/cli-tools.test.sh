#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# deploy/lib/cli-tools.sh（给会话用户和 pilot 装、查 ddgs）的判据：没装、跑不起来、卡住、输出认不出、版本不对、
# 虚拟环境里的依赖和钉住的不一样都判红，不拿空当「没问题」；装是以那个用户的身份装、依赖用 --with 写死版本一起装、
# 装出来的都归他；已经对了就不再装；uv 失败、装完核不上都只记红、不中断；读回不会被 ddgs 卡住。
# 不出网：uv 和 ddgs 都换成假的（假 uv 只会照参数在 ~/.local 下搭一个假虚拟环境、放一个打印版本号的假 ddgs；
# $T 下放开关文件让它故意装错）。
# 要 root：得建临时用户、以他的身份跑。用法：sudo bash deploy/test/cli-tools.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/cli-tools.sh
source "$HERE/../lib/cli-tools.sh"

if ((EUID != 0)); then
  echo "cli-tools：没跑成：要 root（得建临时用户、以他的身份跑）"
  exit 2
fi

U=fleet-tools-test-$$
T=$(mktemp -d /var/tmp/cli-tools-test.XXXXXX)
cleanup() {
  pkill -KILL -u "$U" >/dev/null 2>&1
  userdel "$U" >/dev/null 2>&1
  rm -rf -- "$T"
}
trap cleanup EXIT
chmod 755 "$T"
H=$T/home
if ! useradd --system --user-group --home-dir "$H" --create-home --shell /bin/bash "$U" >/dev/null 2>&1; then
  echo "cli-tools：没跑成：建不了临时用户 $U"
  exit 2
fi
install -d -o "$U" -g "$U" -m 755 "$H/.local" "$H/.local/bin"
DEPS=(click==8.5.0 lxml==6.1.3 primp==2.0.1)
SITE=$H/.local/share/uv/tools/ddgs/lib/python3.12/site-packages

# 假 uv：记下每次被调的参数；$T/uv-fail 在就失败；否则照 ddgs==<版本> 和每个 --with <名>==<版本> 重搭虚拟环境
# （每个包一个 <名>-<版本>.dist-info），再放一个打印那个版本的假 ddgs。故意装错的开关：
# $T/uv-drift 把 primp 装成 2.1.0，$T/uv-badver 放一个打印 9.15.0 的 ddgs，$T/uv-noexe 不放 ddgs
install -o "$U" -g "$U" -m 644 /dev/null "$T/uv.log"
cat >"$T/uv" <<EOF
#!/bin/sh
echo "\$*" >>"$T/uv.log"
if [ -e "$T/uv-fail" ]; then echo "error: 连不上 PyPI（假的）" >&2; exit 2; fi
site=\$HOME/.local/share/uv/tools/ddgs/lib/python3.12/site-packages
rm -rf "\$HOME/.local/share/uv/tools/ddgs"
mkdir -p "\$site"
for a in "\$@"; do
  case \$a in primp==*) if [ -e "$T/uv-drift" ]; then a=primp==2.1.0; fi ;; esac
  case \$a in *==*) mkdir -p "\$site/\${a%%==*}-\${a#*==}.dist-info" ;; esac
  case \$a in ddgs==*) v=\${a#ddgs==} ;; esac
done
if [ -e "$T/uv-badver" ]; then v=9.15.0; fi
rm -f "\$HOME/.local/bin/ddgs"
if [ ! -e "$T/uv-noexe" ]; then
  printf '#!/bin/sh\n[ "\$1" = version ] && echo %s\n' "\$v" >"\$HOME/.local/bin/ddgs"
  chmod 755 "\$HOME/.local/bin/ddgs"
fi
EOF
chmod 755 "$T/uv"
put_ddgs() { # 假 ddgs 的正文（以用户的身份放进 ~/.local/bin）
  printf '#!/bin/sh\n%s\n' "$1" >"$T/ddgs.tmp"
  install -o "$U" -g "$U" -m 755 "$T/ddgs.tmp" "$H/.local/bin/ddgs"
}
uv_calls() { wc -l <"$T/uv.log"; }

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
last_red() { if ((${#REDS[@]})); then printf '%s' "${REDS[-1]}"; fi; }

echo "== 没装：判红，说清没装"
ddgs_version "$U"
check "读不成（返回 1）" "$?" 1
check "原因是没装" "$(grep -c '没装 ddgs' <<<"$CLI_TOOL_BAD")" 1
REDS=()
check_ddgs "$U" 9.16.0 "${DEPS[@]}" >/dev/null
check "读回记一笔红" "${#REDS[@]}" 1

echo "== 装：以他的身份装那一版，依赖用 --with 写死版本、不读他家里的 uv 配置；装完核得上；再装一遍不动"
CHANGES=() REDS=()
ensure_ddgs "$U" "$T/uv" 9.16.0 "${DEPS[@]}" >/dev/null
check "记一笔改动" "${#CHANGES[@]}" 1
check "没有红" "${#REDS[@]}" 0
check "uv 带着 --no-config、--force、钉住的 ddgs 和三个依赖被调了一次" \
  "$(grep -c -- '^--no-config --no-cache --python-preference only-system tool install --force ddgs==9.16.0 --with click==8.5.0 --with lxml==6.1.3 --with primp==2.0.1$' "$T/uv.log")" 1
ddgs_version "$U"
check "装完读得到版本" "$DDGS_HAVE" 9.16.0
check "虚拟环境里的包读得出来" "$(ddgs_installed "$U" | tr '\n' ' ')" "click==8.5.0 ddgs==9.16.0 lxml==6.1.3 primp==2.0.1 "
check "他家里没有不归他的文件" "$(find "$H" ! -user "$U" -printf '%p\n' | head -3)" ""
CHANGES=()
ensure_ddgs "$U" "$T/uv" 9.16.0 "${DEPS[@]}" >/dev/null
check "第二遍一处没改" "${#CHANGES[@]}" 0
check "第二遍没再调 uv" "$(uv_calls)" 1
REDS=()
check_ddgs "$U" 9.16.0 "${DEPS[@]}" >/dev/null
check "读回没有红" "${#REDS[@]}" 0

echo "== 两边照同一个写法比：名字的大小写、- 和 . 不算不一样"
ddgs_pinned "$U" 9.16.0 Click==8.5.0 LXML==6.1.3 primp==2.0.1
check "钉住的写成大写：照样对得上" "$?" 0
mv "$SITE/click-8.5.0.dist-info" "$SITE/Click-8.5.0.dist-info"
ddgs_pinned "$U" 9.16.0 "${DEPS[@]}"
check "装着的目录名是大写：照样对得上" "$?" 0
mv "$SITE/Click-8.5.0.dist-info" "$SITE/click-8.5.0.dist-info"
mkdir "$SITE/zope.interface-7.2.dist-info"
ddgs_pinned "$U" 9.16.0 "${DEPS[@]}" zope-interface==7.2
check "装着的名字带点、钉住的写成横线：照样对得上" "$?" 0
ddgs_pinned "$U" 9.16.0 "${DEPS[@]}"
check "多装了一个包：对不上" "$?" 1
rmdir "$SITE/zope.interface-7.2.dist-info"

echo "== 依赖漂了（ddgs 自己的版本号没变）：读回判红，装的时候整套重装回钉住的"
mv "$SITE/primp-2.0.1.dist-info" "$SITE/primp-2.1.0.dist-info"
REDS=()
check_ddgs "$U" 9.16.0 "${DEPS[@]}" >/dev/null
check "读回判红，说出装着的和应为的" "$(grep -c 'primp==2.1.0.*应为.*primp==2.0.1' <<<"$(last_red)")" 1
CHANGES=()
ensure_ddgs "$U" "$T/uv" 9.16.0 "${DEPS[@]}" >/dev/null
check "重装了一次" "$(uv_calls)" 2
check "重装后依赖回到钉住的" "$(ddgs_installed "$U" | tr '\n' ' ')" "click==8.5.0 ddgs==9.16.0 lxml==6.1.3 primp==2.0.1 "
rm -rf -- "$H/.local/share/uv/tools/ddgs"
REDS=()
check_ddgs "$U" 9.16.0 "${DEPS[@]}" >/dev/null
check "命令还在、虚拟环境没了：判红" "${#REDS[@]}" 1

echo "== 版本不对：读回判红，装的时候换成钉住的那一版"
# shellcheck disable=SC2016 # 单引号里是假 ddgs 的正文，$1 要留给它自己
put_ddgs '[ "$1" = version ] && echo 9.15.0'
REDS=()
check_ddgs "$U" 9.16.0 "${DEPS[@]}" >/dev/null
check "读回判红，说出现在是哪一版" "$(grep -c '是 9.15.0，应为 9.16.0' <<<"$(last_red)")" 1
ensure_ddgs "$U" "$T/uv" 9.16.0 "${DEPS[@]}" >/dev/null
check "重装了" "$(uv_calls)" 3
ddgs_version "$U"
check "重装后是钉住的那一版" "$DDGS_HAVE" 9.16.0

echo "== 装完再核：装完用不了、版本不对、依赖和钉住的不一样，各记一笔红、不记改动，说出装着的和应为的"
expect_install_red() { # 说明 开关 红里要有的（grep -E）
  local calls
  calls=$(uv_calls)
  put_ddgs 'exit 1' # 装之前的那个跑不起来：逼它去装
  touch "$T/$2"
  REDS=() CHANGES=()
  ensure_ddgs "$U" "$T/uv" 9.16.0 "${DEPS[@]}" >/dev/null
  rm -f -- "$T/$2"
  check "$1：调了一次 uv" "$(($(uv_calls) - calls))" 1
  check "$1：记一笔红" "${#REDS[@]}" 1
  check "$1：没记改动" "${#CHANGES[@]}" 0
  check "$1：红里说出装着的和应为的" "$(grep -cE "$3" <<<"$(last_red)")" 1
}
expect_install_red "装完没有 ddgs 命令" uv-noexe '装完 ddgs 还是用不了（应为 9\.16\.0）：没装 ddgs'
expect_install_red "装完 ddgs 版本不对" uv-badver '装完 ddgs 是 9\.15\.0，应为 9\.16\.0'
expect_install_red "装完依赖漂了" uv-drift '装完：.*装的是「.*primp==2\.1\.0.*」，应为「.*primp==2\.0\.1'

echo "== 跑不起来、输出认不出：判红，不当成装着"
put_ddgs 'echo "Traceback: 坏了" >&2; exit 3'
ddgs_version "$U"
check "退出码不是 0：读不成" "$?" 1
check "原因里有退出码" "$(grep -c '退出 3' <<<"$CLI_TOOL_BAD")" 1
put_ddgs 'echo "ddgs, version unknown"'
ddgs_version "$U"
check "输出不是版本号：读不成" "$?" 1
check "原因是认不出" "$(grep -c '认不出' <<<"$CLI_TOOL_BAD")" 1
put_ddgs ':'
ddgs_version "$U"
check "什么都不打：读不成" "$?" 1
put_ddgs 'echo 9.16.0'
TMPDIR=$T/没有这个目录 ddgs_version "$U"
check "放输出的临时文件建不了：读不成" "$?" 1
check "原因说没查成" "$(grep -c '建不了.*没查成' <<<"$CLI_TOOL_BAD")" 1

echo "== 读回不会被 ddgs 卡住（他家里的 ddgs 他改得动）"
# shellcheck disable=SC2016 # 单引号里是假 ddgs 的正文，$1 要留给它自己
put_ddgs '[ "$1" = version ] && { sleep 30 & echo 9.16.0; }'
t0=$SECONDS
ddgs_version "$U"
check "留个后台进程占着输出：照样读到版本" "$?:$DDGS_HAVE" 0:9.16.0
check "几秒内就返回（不等后台进程）" "$((SECONDS - t0 < 5))" 1
pkill -KILL -u "$U"
put_ddgs 'sleep 60'
t0=$SECONDS
ddgs_version "$U"
check "前台卡住：读不成" "$?" 1
check "原因里带 124（到 10 秒被叫停）" "$(grep -c '退出码 124' <<<"$CLI_TOOL_BAD")" 1
check "十来秒就返回" "$((SECONDS - t0 <= 13))" 1
put_ddgs "trap '' TERM; sleep 60"
t0=$SECONDS
REDS=()
check_ddgs "$U" 9.16.0 "${DEPS[@]}" >/dev/null
check "不理叫停：读回判红" "${#REDS[@]}" 1
check "原因里带 137（不理叫停，再过 5 秒被强杀）" "$(grep -c '退出码 137' <<<"$(last_red)")" 1
check "二十秒内返回" "$((SECONDS - t0 <= 18))" 1
for _ in 1 2 3 4 5 6 7 8 9 10; do # 被强杀的要一小会儿才收尸
  if ! pgrep -u "$U" >/dev/null; then break; fi
  sleep 0.2
done
check "卡住的都收掉了，没留下他的进程" "$(pgrep -u "$U" | head -3)" ""

echo "== uv 失败：记红、不中断，说出 uv 的报错"
rm -f -- "$H/.local/bin/ddgs"
touch "$T/uv-fail"
REDS=() CHANGES=()
ensure_ddgs "$U" "$T/uv" 9.16.0 "${DEPS[@]}" >/dev/null
check "ensure_ddgs 照样返回 0（不中断装机）" "$?" 0
check "记一笔红" "${#REDS[@]}" 1
check "红里带着 uv 的报错" "$(grep -c '连不上 PyPI' <<<"$(last_red)")" 1
check "没记改动" "${#CHANGES[@]}" 0

if ((fail)); then
  echo "cli-tools：不通过"
  exit 1
fi
echo "cli-tools：通过"
