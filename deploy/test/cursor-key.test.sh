#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# deploy/lib/cursor-key.sh（会话用户的 Cursor API 密钥：放、查、撤）的判据，每条失败路径都故意造出来：
#   1. 还没放：读回记待配、写清怎么放
#   2. 放：以那个用户自己的身份写，属他、600、内容就是那一把（剪贴板补的换行、Windows 的回车去掉）；再放一把就换成新的
#   3. 收到空的、只有换行、带空格、两行、带控制字符的：不换，原来那份原样留着，临时名不留下；放的地方是个目录也不换
#   4. 读回：权限太松、属主不对、空的、符号链接、目录都判红；好的判绿
#   5. 撤：以他的身份删掉，再读回记待配；本来就不在也算撤好
#   6. 哪里都没有值：放、查、撤的全部输出（标准输出、标准错误）里都搜不到那一把
#   7. 入口 deploy/cursor-key.sh：用法不对退出 64，不碰任何人的文件
# 假的密钥运行时现拼（整段写在源码里，卫生检查会当成真的）。
# 要 root：得建临时用户、以他的身份跑。用法：sudo bash deploy/test/cursor-key.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/cursor-key.sh
source "$HERE/../lib/cursor-key.sh"

if ((EUID != 0)); then
  echo "cursor-key：没跑成：要 root（得建临时用户、以他的身份跑）"
  exit 2
fi

U=fleet-key-test-$$
T=$(mktemp -d /var/tmp/cursor-key-test.XXXXXX)
cleanup() {
  pkill -KILL -u "$U" >/dev/null 2>&1
  userdel "$U" >/dev/null 2>&1
  rm -rf -- "$T"
}
trap cleanup EXIT
chmod 755 "$T"
H=$T/home
if ! useradd --system --user-group --home-dir "$H" --create-home --shell /bin/bash "$U" >/dev/null 2>&1; then
  echo "cursor-key：没跑成：建不了临时用户 $U"
  exit 2
fi
F=$H/.cursor/fleet-api-key
fake_key() { printf 'fake-cursor-key-%s' "$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"; }
KEY=$(fake_key)
KEY2=$(fake_key)
OUT=$T/out # 放、查、撤的全部输出都攒在这，最后搜值
: >"$OUT"

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
last() { # 数组名：最后一条
  local -n arr=$1
  if ((${#arr[@]})); then printf '%s' "${arr[-1]}"; fi
}
fresh() { CHANGES=() REDS=() PENDING=(); }
# 放一把：标准输入是给的字节（printf 的格式串）
put() { # printf 格式 [参数…]
  local fmt=$1
  shift
  # shellcheck disable=SC2059 # 格式串就是要摆布的输入
  cursor_key_put "$U" "$F" < <(printf "$fmt" "$@") >>"$OUT" 2>&1
}
is_key() { # 期望的值：文件里正好是它（不带换行）
  if cmp -s -- "$F" <(printf '%s' "$1"); then echo 是; else echo 不是; fi
}
temps() { find "$H/.cursor" -name '.new.*' 2>/dev/null | wc -l | tr -d ' '; }
meta() { stat -c '%U %a' -- "$F"; }

echo "== 1. 还没放：读回记待配、写清怎么放"
fresh
check_cursor_key "$U" "$F" >>"$OUT" 2>&1
check "记一笔待配、没有红" "${#PENDING[@]} ${#REDS[@]}" "1 0"
has "待配里写了去哪生成、照哪一节放" "$(last PENDING)" 'cursor.com/dashboard/api.*docs/ops.md 第五节'

echo "== 2. 放：以他自己的身份写，属他、600、内容就是那一把"
fresh
put '%s\r\n' "$KEY"
check "放成了：记一笔改动、没有红" "${#CHANGES[@]} ${#REDS[@]}" "1 0"
check "属他、600" "$(meta)" "$U 600"
check "内容就是那一把（Windows 的回车、剪贴板补的换行去掉了）" "$(is_key "$KEY")" 是
check "临时名没留下" "$(temps)" 0
check "他家里没有不归他的文件" "$(find "$H" ! -user "$U" -printf '%p\n' | head -3)" ""
has "放完读回判绿、写了字节数" "$(tail -1 "$OUT")" "属 $U、600、${#KEY} 字节（值没读"
fresh
put '%s' "$KEY2"
check "再放一把（不带换行）：换成新的" "${#CHANGES[@]} ${#REDS[@]} $(is_key "$KEY2")" "1 0 是"

echo "== 3. 收到的不像一把密钥：不换，原来那份原样留着"
bad_put() { # 说明 printf 格式 [参数…]
  local what=$1
  shift
  fresh
  put "$@"
  check "$what：不换（记一笔红、没有改动）" "${#CHANGES[@]} ${#REDS[@]}" "0 1"
  check "$what：原来那份原样留着" "$(is_key "$KEY2")" 是
  check "$what：临时名没留下" "$(temps)" 0
  has "$what：说了没换" "$(cat -- "$OUT")" '没换：'
}
bad_put "空的（剪贴板里什么都没有）" ''
bad_put "只有换行" '\n\n'
bad_put "前面带空格" ' %s' "$KEY"
bad_put "中间有空格" '%s %s' "$KEY" "$KEY"
bad_put "两行" '%s\n%s\n' "$KEY" "$KEY"
bad_put "带控制字符" '%s\001' "$KEY"
bad_put "带制表符" '%s\t' "$KEY"
mv -- "$F" "$T/saved"
mkdir -p -- "$F"
chown -R "$U:$U" -- "$F"
fresh
put '%s' "$KEY"
check "放的地方是个目录：不换" "${#CHANGES[@]} ${#REDS[@]} $(find "$F" -mindepth 1 | wc -l | tr -d ' ')" "0 1 0"
rmdir -- "$F"
mv -- "$T/saved" "$F"
check "（换回好的那份）" "$(is_key "$KEY2") $(meta)" "是 $U 600"

echo "== 4. 读回：只看在不在、是不是真文件、属主、权限、大小"
expect_red() { # 说明 红里要有的（grep -E）
  fresh
  check_cursor_key "$U" "$F" >>"$OUT" 2>&1
  check "$1：判红" "${#REDS[@]} ${#PENDING[@]}" "1 0"
  has "$1：红里写清" "$(last REDS)" "$2"
}
chmod 644 -- "$F"
expect_red "权限太松（644）" '权限是 644（要 600）.*重放一次'
chmod 400 -- "$F"
expect_red "权限不是 600（400）" '权限是 400（要 600）'
chmod 600 -- "$F"
chown root:root -- "$F"
expect_red "属主不对（root）" "属主是 root（要 $U）"
chown "$U:$U" -- "$F"
cp -p -- "$F" "$T/saved"
: >"$F"
expect_red "空的" '是空的'
cp -p -- "$T/saved" "$F"
mv -- "$F" "$T/saved"
ln -s -- "$T/saved" "$F"
expect_red "符号链接" '是符号链接（引擎只认真文件）'
rm -f -- "$F"
mkdir -- "$F"
expect_red "目录" '不是普通文件'
rmdir -- "$F"
mv -- "$T/saved" "$F"
fresh
check_cursor_key "$U" "$F" >>"$OUT" 2>&1
check "好的：判绿" "${#REDS[@]} ${#PENDING[@]}" "0 0"

echo "== 5. 撤：以他的身份删掉，再读回记待配"
fresh
cursor_key_remove "$U" "$F" >>"$OUT" 2>&1
check "删了：记一笔改动、没有红" "${#CHANGES[@]} ${#REDS[@]}" "1 0"
check "文件没了" "$(test -e "$F" && echo 在 || echo 没了)" 没了
fresh
check_cursor_key "$U" "$F" >>"$OUT" 2>&1
check "再读回：待配" "${#PENDING[@]} ${#REDS[@]}" "1 0"
fresh
cursor_key_remove "$U" "$F" >>"$OUT" 2>&1
check "本来就不在：算撤好，一处没改" "${#CHANGES[@]} ${#REDS[@]}" "0 0"

echo "== 6. 哪里都没有值：放、查、撤的全部输出里都搜不到"
check "输出里有东西（真攒上了）" "$(test -s "$OUT" && echo 有 || echo 空)" 有
check "搜不到第一把" "$(grep -cF -- "$KEY" "$OUT")" 0
check "搜不到第二把" "$(grep -cF -- "$KEY2" "$OUT")" 0

echo "== 7. 入口：用法不对退出 64，不碰任何人的文件"
bash "$HERE/../cursor-key.sh" >/dev/null 2>&1
check "没给子命令" "$?" 64
bash "$HERE/../cursor-key.sh" bogus >/dev/null 2>&1
check "认不出的子命令" "$?" 64
bash "$HERE/../cursor-key.sh" check extra >/dev/null 2>&1
check "多给了参数" "$?" 64

if ((fail)); then
  echo "cursor-key：不通过"
  exit 1
fi
echo "cursor-key：通过"
