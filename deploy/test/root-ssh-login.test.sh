#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# #2138：发版把会话口子里已有的公钥补进 root 的 authorized_keys（deploy/lib/root-ssh-login.sh）。
# 不要 root、不要 sshd：钥匙在临时目录里现生成，只看补、不重复、原行不改、权限、符号链接。
#   1. 空的目标：两把公钥都补上，.ssh 700、authorized_keys 600，属主仍是当前用户
#   2. 再跑一遍：不重复，输出「没新补」，字节不变
#   3. 目标里已有另一把、还有一行带选项的：原字节还在，新钥匙另起一行
#   4. 目标文件不以换行结尾：补上去不粘到上一行；已有换行时不多插空行
#   5. 口子没有、是符号链接：不建目标。权限 000：普通用户读不了就不建；root（CI 用 sudo 跑）无视权限位，照样补
#   6. 口子里认不出的行跳过；注释不同、指纹相同的不重复补
#   7. 目标 644 收成 600。目标 000：普通用户读不了就不动；root 读得了就补上并收成 600
#   8. .ssh 或 authorized_keys 是符号链接：不跟着写
#   9. release.sh 只在 --check 之后、mode 不是 check 时调用，并清掉测试用的路径覆盖
# 用法：bash deploy/test/root-ssh-login.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/root-ssh-login.sh
source "$HERE/../lib/root-ssh-login.sh"

if ! command -v ssh-keygen >/dev/null; then
  echo "root-ssh-login：没跑成：没有 ssh-keygen"
  exit 2
fi

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
has() { # 说明 文本 要有的
  if grep -qF -- "$3" <<<"$2"; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：输出里没有「%s」\n' "$1" "$3"
    fail=1
  fi
}
lacks() { # 说明 文本 不该有的
  if grep -qF -- "$3" <<<"$2"; then
    printf '  ✗ %s：输出里有「%s」\n' "$1" "$3"
    fail=1
  else
    printf '  ✓ %s\n' "$1"
  fi
}
same() { # 说明 文件a 文件b
  if cmp -s -- "$2" "$3"; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：两边字节不一样\n' "$1"
    fail=1
  fi
}
no_key_text() { # 说明 文本
  if grep -qE 'ssh-|ecdsa-sha2-|sk-' <<<"$2"; then
    printf '  ✗ %s：输出里有公钥正文\n' "$1"
    fail=1
  else
    printf '  ✓ %s\n' "$1"
  fi
}

TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT

mkkey() { # 目录 名字（也是注释）
  ssh-keygen -q -t ed25519 -N '' -C "$2" -f "$1/$2"
  cat -- "$1/$2.pub"
}
fp_of() { # 一行公钥
  printf '%s\n' "$1" | ssh-keygen -lf - | awk 'NR==1 { print $2 }'
}
run() { # 口子文件 家目录
  ROOT_SSH_LOGIN_SRC=$1 ROOT_SSH_HOME=$2 ensure_root_login_keys
}

pub_a=$(mkkey "$TMP" a)
pub_b=$(mkkey "$TMP" b)
pub_c=$(mkkey "$TMP" c)
pub_d=$(mkkey "$TMP" d)
fp_a=$(fp_of "$pub_a")
fp_b=$(fp_of "$pub_b")
me=$(id -un)

echo "== 1. 空目标补两把"
home=$(mktemp -d "$TMP/home.XXXXXX")
src=$home/src
printf '%s\n%s' "$pub_a" "$pub_b" >"$src"
out=$(run "$src" "$home")
rc=$?
check "退出码" "$rc" "0"
check ".ssh 700" "$(stat -c '%a' -- "$home/.ssh")" "700"
check "authorized_keys 600" "$(stat -c '%a' -- "$home/.ssh/authorized_keys")" "600"
check "属主仍是当前用户" "$(stat -c '%U' -- "$home/.ssh/authorized_keys")" "$me"
check "两把" "$(grep -cE '^(ssh-|ecdsa-sha2-|sk-)' -- "$home/.ssh/authorized_keys" || true)" "2"
has "补进 a" "$out" "$fp_a"
has "补进 b" "$out" "$fp_b"
has "原行没删" "$out" "原有的行没删"
no_key_text "日志不打公钥" "$out"
if [[ ! -e "$home/.ssh/authorized_keys2" ]]; then
  printf '  ✓ 没碰 authorized_keys2\n'
else
  printf '  ✗ 写出了 authorized_keys2\n'
  fail=1
fi
{
  printf '%s\n%s\n' "$pub_a" "$pub_b"
} >"$TMP/expect-two"
same "两把各一行且以换行结尾" "$home/.ssh/authorized_keys" "$TMP/expect-two"

echo "== 2. 再跑一遍不重复、字节不变"
cp -a -- "$home/.ssh/authorized_keys" "$TMP/before-second"
out=$(run "$src" "$home")
rc=$?
check "退出码" "$rc" "0"
has "没新补" "$out" "没新补"
lacks "不再说补进" "$out" "补进"
same "字节不变" "$home/.ssh/authorized_keys" "$TMP/before-second"
check "仍是两把" "$(grep -cE '^(ssh-|ecdsa-sha2-|sk-)' -- "$home/.ssh/authorized_keys" || true)" "2"

echo "== 3. 带选项的行和已有的钥匙原样留着，新钥匙另起一行"
home=$(mktemp -d "$TMP/home.XXXXXX")
src=$home/src
optline="restrict,command=\"/bin/true\" $pub_c"
printf '%s\n%s' "$optline" "$pub_d" >"$home/dest-body"
mkdir -p -- "$home/.ssh"
cp -- "$home/dest-body" "$home/.ssh/authorized_keys"
printf '%s\n' "$pub_a" >"$src"
out=$(run "$src" "$home")
{
  printf '%s\n%s\n%s\n' "$optline" "$pub_d" "$pub_a"
} >"$TMP/expect-keep"
same "原行还在且新钥匙另起一行" "$home/.ssh/authorized_keys" "$TMP/expect-keep"
has "只补了新的" "$out" "$(fp_of "$pub_a")"
lacks "没把带选项的当新钥匙报出来" "$out" "$(fp_of "$pub_c")"

echo "== 4. 已有换行时不多插空行"
home=$(mktemp -d "$TMP/home.XXXXXX")
src=$home/src
mkdir -p -- "$home/.ssh"
printf '%s\n' "$pub_d" >"$home/.ssh/authorized_keys"
printf '%s\n' "$pub_a" >"$src"
run "$src" "$home" >/dev/null
{
  printf '%s\n%s\n' "$pub_d" "$pub_a"
} >"$TMP/expect-nl"
same "没有多出来的空行" "$home/.ssh/authorized_keys" "$TMP/expect-nl"

echo "== 5. 口子没有、是符号链接、读不了，都不建目标"
home=$(mktemp -d "$TMP/home.XXXXXX")
out=$(run "$home/missing" "$home")
rc=$?
check "没有口子也返回 0" "$rc" "0"
has "没有口子" "$out" "没有会话口子"
if [[ ! -e "$home/.ssh" ]]; then
  printf '  ✓ 没建 .ssh\n'
else
  printf '  ✗ 口子没有却建了 .ssh\n'
  fail=1
fi

home=$(mktemp -d "$TMP/home.XXXXXX")
printf '%s\n' "$pub_a" >"$home/real-src"
ln -s real-src "$home/link-src"
out=$(run "$home/link-src" "$home")
has "口子是符号链接" "$out" "符号链接"
if [[ ! -e "$home/.ssh" ]]; then
  printf '  ✓ 符号链接口子没建 .ssh\n'
else
  printf '  ✗ 跟着符号链接口子建了 .ssh\n'
  fail=1
fi

home=$(mktemp -d "$TMP/home.XXXXXX")
printf '%s\n' "$pub_a" >"$home/src"
chmod 000 -- "$home/src"
out=$(run "$home/src" "$home")
# root 读得了 mode 000（CI 的 deploy 检查是 sudo）。普通用户读不了，不能把这种口子当成有钥匙。
if ((EUID == 0)); then
  has "root 读得了 000 的口子" "$out" "补进 1 把"
  check "root 把 000 的口子补上" "$(grep -cE '^(ssh-|ecdsa-sha2-|sk-)' -- "$home/.ssh/authorized_keys" || true)" "1"
else
  has "读不了口子" "$out" "没有会话口子"
  if [[ ! -e "$home/.ssh" ]]; then
    printf '  ✓ 读不了的口子没建 .ssh\n'
  else
    printf '  ✗ 读不了的口子却建了 .ssh\n'
    fail=1
  fi
fi
chmod 600 -- "$home/src" || true

echo "== 6. 认不出的行跳过；注释不同不重复；口子里同一把写两遍只补一次"
home=$(mktemp -d "$TMP/home.XXXXXX")
src=$home/src
printf '%s\n%s\n%s\n%s\n' 'not-a-key' 'ssh-ed25519' '# comment' "$pub_a" >"$src"
out=$(run "$src" "$home")
check "只剩一把" "$(grep -cE '^(ssh-|ecdsa-sha2-|sk-)' -- "$home/.ssh/authorized_keys" || true)" "1"
has "补的是认得出的那把" "$out" "$fp_a"
no_key_text "坏行也不进日志" "$out"

home=$(mktemp -d "$TMP/home.XXXXXX")
src=$home/src
base=${pub_a% *}
mkdir -p -- "$home/.ssh"
printf '%s\n' "$base desk-a" >"$home/.ssh/authorized_keys"
cp -a -- "$home/.ssh/authorized_keys" "$TMP/before-comment"
printf '%s\n' "$base desk-b" >"$src"
out=$(run "$src" "$home")
has "注释不同也算已有" "$out" "没新补"
same "注释不同不另起一行" "$home/.ssh/authorized_keys" "$TMP/before-comment"

home=$(mktemp -d "$TMP/home.XXXXXX")
src=$home/src
printf '%s\n%s\n' "$pub_a" "$pub_a" >"$src"
out=$(run "$src" "$home")
check "口子里重复只补一次" "$(grep -cE '^(ssh-|ecdsa-sha2-|sk-)' -- "$home/.ssh/authorized_keys" || true)" "1"
has "报 1 把" "$out" "补进 1 把"

echo "== 7. 权限收紧；没有新钥匙时不改字节（含没有结尾换行）；读不了的目标不动"
home=$(mktemp -d "$TMP/home.XXXXXX")
src=$home/src
mkdir -p -- "$home/.ssh"
printf '%s' "$pub_a" >"$home/.ssh/authorized_keys"
cp -a -- "$home/.ssh/authorized_keys" "$TMP/before-nonewline"
chmod 755 -- "$home/.ssh"
chmod 644 -- "$home/.ssh/authorized_keys"
printf '%s\n' "$pub_a" >"$src"
out=$(run "$src" "$home")
has "没新补" "$out" "没新补"
same "没有结尾换行也原样留着" "$home/.ssh/authorized_keys" "$TMP/before-nonewline"
check "目录收成 700" "$(stat -c '%a' -- "$home/.ssh")" "700"
check "文件收成 600" "$(stat -c '%a' -- "$home/.ssh/authorized_keys")" "600"

home=$(mktemp -d "$TMP/home.XXXXXX")
src=$home/src
mkdir -p -- "$home/.ssh"
printf '%s\n' "$pub_d" >"$home/.ssh/authorized_keys"
cp -a -- "$home/.ssh/authorized_keys" "$TMP/before-unreadable"
chmod 000 -- "$home/.ssh/authorized_keys"
printf '%s\n' "$pub_a" >"$src"
out=$(run "$src" "$home")
rc=$?
check "000 的目标也返回 0" "$rc" "0"
if ((EUID == 0)); then
  has "root 读得了 000 的目标" "$out" "$(fp_of "$pub_a")"
  printf '%s\n%s\n' "$pub_d" "$pub_a" >"$TMP/expect-root-000"
  same "root 把 000 的目标补上一行" "$home/.ssh/authorized_keys" "$TMP/expect-root-000"
  check "root 把 000 收成 600" "$(stat -c '%a' -- "$home/.ssh/authorized_keys")" "600"
else
  has "读不了" "$out" "读不了"
  check "权限没改" "$(stat -c '%a' -- "$home/.ssh/authorized_keys")" "0"
  chmod 600 -- "$home/.ssh/authorized_keys"
  same "读不了的目标字节不动" "$home/.ssh/authorized_keys" "$TMP/before-unreadable"
fi

home=$(mktemp -d "$TMP/home.XXXXXX")
src=$home/src
printf '%s\n' 'hello' >"$src"
mkdir -p -- "$home/.ssh"
printf '%s' 'keep' >"$home/.ssh/authorized_keys"
cp -a -- "$home/.ssh/authorized_keys" "$TMP/before-junk"
out=$(run "$src" "$home")
has "没有认得出的公钥" "$out" "没有认得出的公钥"
same "垃圾口子不改写已有文件" "$home/.ssh/authorized_keys" "$TMP/before-junk"

echo "== 8. 符号链接不跟着写"
home=$(mktemp -d "$TMP/home.XXXXXX")
src=$home/src
printf '%s\n' "$pub_a" >"$src"
mkdir -p -- "$home/real-ssh"
ln -s real-ssh "$home/.ssh"
out=$(run "$src" "$home")
has ".ssh 不是目录" "$out" "不是目录"
if [[ ! -e "$home/real-ssh/authorized_keys" ]]; then
  printf '  ✓ 没写入符号链接指着的目录\n'
else
  printf '  ✗ 跟着 .ssh 符号链接写进去了\n'
  fail=1
fi

home=$(mktemp -d "$TMP/home.XXXXXX")
src=$home/src
printf '%s\n' "$pub_a" >"$src"
mkdir -p -- "$home/.ssh"
printf '%s\n' sentinel >"$home/target"
ln -s "$home/target" "$home/.ssh/authorized_keys"
out=$(run "$src" "$home")
has "authorized_keys 不是普通文件" "$out" "不是普通文件"
check "符号链接指着的文件还是原句" "$(cat -- "$home/target")" "sentinel"
if [[ -L "$home/.ssh/authorized_keys" ]]; then
  printf '  ✓ authorized_keys 仍是符号链接\n'
else
  printf '  ✗ authorized_keys 不再是符号链接\n'
  fail=1
fi

home=$(mktemp -d "$TMP/home.XXXXXX")
src=$home/src
printf '%s\n' "$pub_a" >"$src"
printf '%s\n' 'not-a-dir' >"$home/.ssh"
out=$(run "$src" "$home")
has "普通文件不是目录" "$out" "不是目录"
check ".ssh 还是原来的内容" "$(cat -- "$home/.ssh")" "not-a-dir"

echo "== 9. 默认路径、release.sh 的调用位置"
unset ROOT_SSH_LOGIN_SRC ROOT_SSH_HOME
check "默认口子" "$(root_ssh_login_src)" "/etc/ssh/authorized_keys/fleet-agent-carpool"
check "默认家目录" "$(root_ssh_login_home)" "/root"

REL=$HERE/../release.sh
check "只调用一次" "$(grep -c 'ensure_root_login_keys' -- "$REL" || true)" "1"
check "sshd 那段只调用一次" "$(grep -c 'ensure_root_login_sshd' -- "$REL" || true)" "1"
# 按字面匹配 release.sh 里的 $mode，不能让 shell 展开，也不能把 [[ 当成正则。
# shellcheck disable=SC2016
check_at=$(grep -nF 'if [[ "$mode" == check ]]; then' -- "$REL" | tail -1 | cut -d: -f1)
call_at=$(grep -n 'ensure_root_login_keys || true' -- "$REL" | tail -1 | cut -d: -f1)
sshd_at=$(grep -n 'ensure_root_login_sshd || true' -- "$REL" | tail -1 | cut -d: -f1)
unset_at=$(grep -n 'unset ROOT_SSH_LOGIN_SRC ROOT_SSH_HOME ROOT_SSH_LOGIN_DROPIN' -- "$REL" | tail -1 | cut -d: -f1)
if [[ "$call_at" -gt "$check_at" && "$unset_at" -gt "$check_at" && "$unset_at" -lt "$call_at" && "$sshd_at" -gt "$call_at" ]]; then
  printf '  ✓ 调用在 --check 之后，且先清掉路径覆盖；sshd 那段在补钥匙之后\n'
else
  printf '  ✗ 调用位置不对：check=%s unset=%s call=%s sshd=%s\n' "$check_at" "$unset_at" "$call_at" "$sshd_at"
  fail=1
fi
do_check_body=$(awk 'BEGIN{p=0} /^do_check\(\)/{p=1} p{print} p && /^}$/{exit}' "$REL")
if grep -qE 'ensure_root_login_keys|ensure_root_login_sshd' <<<"$do_check_body"; then
  printf '  ✗ do_check 里也调用了\n'
  fail=1
else
  printf '  ✓ do_check 不碰钥匙、不改 sshd\n'
fi
# shellcheck disable=SC2016
if grep -qF 'source "$DEPLOY_DIR/lib/root-ssh-login.sh"' -- "$REL"; then
  printf '  ✓ release.sh source 了补钥匙\n'
else
  printf '  ✗ release.sh 没有 source 补钥匙\n'
  fail=1
fi

echo "== 10. root 的 Match：带上会话口子，sshd -t 不过就撤，不漏到会话用户"
d=$(mktemp -d "$TMP/sshd.XXXXXX")
dropin=$d/52-fleet-dao-root-login.conf
mark=$d/reloaded
keys_path=/etc/ssh/authorized_keys/fleet-agent-carpool
out=$(
  ROOT_SSH_LOGIN_SRC=$keys_path \
    ROOT_SSH_LOGIN_DROPIN=$dropin \
    ROOT_SSH_LOGIN_SSHD_T='true' \
    ROOT_SSH_LOGIN_RELOAD="printf 'reloaded\n' > $(printf %q "$mark")" \
    ensure_root_login_sshd
)
rc=$?
check "退出码" "$rc" "0"
has "已重载" "$out" "已重载"
check "普通文件" "$( [[ -f $dropin && ! -L $dropin ]] && echo yes )" "yes"
check "含会话口子" "$(grep -cF -- "$keys_path" "$dropin" || true)" "1"
check "只 Match root" "$(grep -c '^Match User root$' -- "$dropin" || true)" "1"
check "仍认家里的两份" "$(grep -cF '.ssh/authorized_keys .ssh/authorized_keys2' -- "$dropin" || true)" "1"
reloads=$(wc -l <"$mark" | tr -d ' ')
check "重载了一次" "$reloads" "1"
out=$(
  ROOT_SSH_LOGIN_SRC=$keys_path \
    ROOT_SSH_LOGIN_DROPIN=$dropin \
    ROOT_SSH_LOGIN_SSHD_T='true' \
    ROOT_SSH_LOGIN_RELOAD="printf 'reloaded\n' >> $(printf %q "$mark")" \
    ensure_root_login_sshd
)
has "没改" "$out" "没改"
reloads=$(wc -l <"$mark" | tr -d ' ')
check "内容没变不再重载" "$reloads" "1"

printf 'old-line\n' >"$dropin"
out=$(
  ROOT_SSH_LOGIN_SRC=$keys_path \
    ROOT_SSH_LOGIN_DROPIN=$dropin \
    ROOT_SSH_LOGIN_SSHD_T='echo bad-option >&2; exit 1' \
    ROOT_SSH_LOGIN_RELOAD="printf 'reloaded\n' >> $(printf %q "$mark")" \
    ensure_root_login_sshd
)
has "sshd -t 不过" "$out" "sshd -t 不过"
check "还原旧内容" "$(cat -- "$dropin")" "old-line"
reloads=$(wc -l <"$mark" | tr -d ' ')
check "没重载" "$reloads" "1"
rm -f -- "$dropin"
out=$(
  ROOT_SSH_LOGIN_SRC=$keys_path \
    ROOT_SSH_LOGIN_DROPIN=$dropin \
    ROOT_SSH_LOGIN_SSHD_T='echo bad-option >&2; exit 1' \
    ROOT_SSH_LOGIN_RELOAD="printf 'reloaded\n' >> $(printf %q "$mark")" \
    ensure_root_login_sshd
)
check "头一次写、验不过：文件撤掉" "$( [[ -e $dropin ]] && echo 在 || echo 没了 )" "没了"

out=$(
  ROOT_SSH_LOGIN_SRC='/tmp/not a path' \
    ROOT_SSH_LOGIN_DROPIN=$dropin \
    ROOT_SSH_LOGIN_SSHD_T='true' \
    ROOT_SSH_LOGIN_RELOAD='true' \
    ensure_root_login_sshd
)
has "路径不能写进配置" "$out" "不能写进"
check "坏路径没写出文件" "$( [[ -e $dropin ]] && echo 在 || echo 没了 )" "没了"

ln -s "$mark" "$dropin"
out=$(
  ROOT_SSH_LOGIN_SRC=$keys_path \
    ROOT_SSH_LOGIN_DROPIN=$dropin \
    ROOT_SSH_LOGIN_SSHD_T='true' \
    ROOT_SSH_LOGIN_RELOAD='true' \
    ensure_root_login_sshd
)
has "符号链接不动" "$out" "不是普通文件"
check "符号链接还在" "$( [[ -L $dropin ]] && echo yes )" "yes"
rm -f -- "$dropin"

if ! command -v sshd >/dev/null; then
  echo "  - 这台没有 sshd，Match 是否生效没核对"
else
  hk=$(mktemp -d "$d/host.XXXXXX")
  ssh-keygen -q -t ed25519 -N '' -f "$hk/host"
  mkdir -p "$d/conf.d"
  cat >"$d/sshd_config" <<EOF
Include $d/conf.d/*.conf
HostKey $hk/host
EOF
  cat >"$d/conf.d/51-session.conf" <<'EOF'
Match User fleet-agent-carpool
	AuthorizedKeysFile /etc/ssh/authorized_keys/%u
EOF
  ROOT_SSH_LOGIN_SRC=$keys_path \
    ROOT_SSH_LOGIN_DROPIN=$d/conf.d/52-fleet-dao-root-login.conf \
    ROOT_SSH_LOGIN_SSHD_T='true' \
    ROOT_SSH_LOGIN_RELOAD='true' \
    ensure_root_login_sshd >/dev/null
  root_cfg=$(sshd -T -f "$d/sshd_config" -C 'user=root,host=localhost,addr=127.0.0.1' 2>"$d/sshd.err") || root_cfg=""
  sess_cfg=$(sshd -T -f "$d/sshd_config" -C 'user=fleet-agent-carpool,host=localhost,addr=127.0.0.1' 2>>"$d/sshd.err") || sess_cfg=""
  root_ak=$(awk '$1 == "authorizedkeysfile" { $1 = ""; sub(/^ /, ""); print; exit }' <<<"$root_cfg")
  sess_ak=$(awk '$1 == "authorizedkeysfile" { $1 = ""; sub(/^ /, ""); print; exit }' <<<"$sess_cfg")
  check "root 认家里的钥匙和会话口子" "$root_ak" ".ssh/authorized_keys .ssh/authorized_keys2 $keys_path"
  check "会话用户仍只认自己的口子" "$sess_ak" "/etc/ssh/authorized_keys/%u"
  if [[ ! -s "$d/sshd.err" ]]; then
    printf '  ✓ sshd -T 没报错\n'
  else
    printf '  ✗ sshd -T 报了：%s\n' "$(head -c 200 "$d/sshd.err")"
    fail=1
  fi
fi

if ((fail)); then
  echo "root-ssh-login：不通过"
  exit 1
fi
echo "root-ssh-login：通过"
