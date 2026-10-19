#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034 # 摘出的 hk.sh 函数读取这些装机变量；静态分析看不到运行时 source
# 真文件权限、www-data/runuser；只将进程表换成夹具，不运行 nginx，不碰真实临时目录。
# 要 root；所有夹具在 /run 的 root 私有测试根下，父路径安全合同照真检查。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
HK=${FLEET_TEST_HK_SOURCE:-$HERE/../hk.sh}
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/nginx-body.sh
source "$HERE/../lib/nginx-body.sh"
if ((EUID != 0)) || ! id www-data >/dev/null 2>&1 || ! command -v runuser >/dev/null; then
  echo 'nginx-body：没跑成：需要 root、www-data 和 runuser'
  exit 2
fi
T=$(mktemp -d /run/fleet-nginx-body.XXXXXX)
trap 'rm -rf -- "$T"' EXIT
mkdir -p "$T/var/lib/nginx"
BODY=$T/var/lib/nginx/body
UID_WWW=$(id -u www-data)
nginx_body_dir() { printf '%s' "$BODY"; }
PS_ROWS="0 nginx: master process /usr/sbin/nginx
$UID_WWW nginx: worker process"
PS_FAIL=0 CHOWN_FAIL=0 CHMOD_FAIL=0 ACCESS_FAIL=0 CHOWN_NOOP=0
CHOWNS=0 CHMODS=0
ps() { if ((PS_FAIL)); then return 1; fi; printf '%s\n' "$PS_ROWS"; }
chown() {
  CHOWNS=$((CHOWNS + 1))
  if ((CHOWN_FAIL)); then return 1; fi
  if ((CHOWN_NOOP)); then return 0; fi
  command chown "$@"
}
chmod() {
  CHMODS=$((CHMODS + 1))
  if ((CHMOD_FAIL)); then return 1; fi
  command chmod "$@"
}
runuser() { if ((ACCESS_FAIL)); then return 1; fi; command runuser "$@"; }
command chmod 755 "$T" "$T/var" "$T/var/lib" "$T/var/lib/nginx"
fail=0
check() {
  if [[ "$2" == "$3" ]]; then printf '  ✓ %s\n' "$1"; else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
reset() { REDS=(); CHANGES=(); CHOWNS=0; CHMODS=0; }
meta() { stat -c '%u:%g %a %d:%i' -- "$BODY"; }
call() { RC=0; "$@" >"$T/result" 2>&1 || RC=$?; }

echo '== owner 漂移 0700：读回明确失败且一个字节不写，原位修复，第二遍零改动'
mkdir -m 700 "$BODY"
command chown 65534:0 "$BODY"
printf 'keep\n' >"$BODY/existing"
command chown 61234:61235 "$BODY/existing"
BEFORE=$(meta)
INODE=$(stat -c '%d:%i' "$BODY")
reset
call readback_nginx_body
check '读回非0' "$RC" 1
check '读回判红' "${#REDS[@]}" 1
check '读回 metadata 不变' "$(meta)" "$BEFORE"
check '没有 chown/chmod' "$CHOWNS:$CHMODS" '0:0'
reset
call ensure_nginx_body
check '修复退出0' "$RC" 0
check '只改owner，保留组/inode/700' "$(meta)" "$UID_WWW:0 700 $INODE"
check '改属主一次，无chmod' "$CHOWNS:$CHMODS" '1:0'
check '一笔改动' "${#CHANGES[@]}" 1
check '内容和子文件属主原样保留' "$(cat "$BODY/existing"):$(stat -c '%u:%g' "$BODY/existing")" 'keep:61234:61235'
reset
call ensure_nginx_body
check '第二遍退出0且零改动' "$RC:${#CHANGES[@]}:$CHOWNS:$CHMODS" '0:0:0:0'
call readback_nginx_body
check '修后读回退出0' "$RC" 0
check '不写探针' "$(find "$BODY" -mindepth 1 | wc -l | tr -d ' ')" 1

echo '== 错mode原位修、缺失仅创建最后一层'
command chmod 755 "$BODY"
reset
call readback_nginx_body
check '宽权限读回红且不修' "$RC:$(stat -c '%a' "$BODY"):$CHMODS" '1:755:0'
call ensure_nginx_body
check 'mode修为700且不动owner' "$RC:$(stat -c '%a' "$BODY"):$CHOWNS:$CHMODS" '0:700:0:1'
SAVED_BODY=$BODY
BODY=$T/var/lib/nginx/fresh
reset
call readback_nginx_body
check '缺失读回失败不创建' "$RC:$([[ -e "$BODY" ]] && echo yes || echo no)" '1:no'
call ensure_nginx_body
check '缺失创建成功' "$RC:$(stat -c '%u:%g %a' "$BODY")" "0:$UID_WWW:0 700"
BODY=$SAVED_BODY

echo '== 路径/父目录不安全，一律拒绝修复'
for kind in link dangling file parent-link parent-write parent-owner parent-missing; do
  BAD=$T/bad-$kind
  mkdir -p "$BAD/parent"
  case "$kind" in
  link) ln -s "$BODY" "$BAD/parent/body" ;;
  dangling) ln -s "$BAD/missing" "$BAD/parent/body" ;;
  file) printf 'keep' >"$BAD/parent/body" ;;
  parent-link) rmdir "$BAD/parent"; ln -s "$T/var/lib/nginx" "$BAD/parent" ;;
  parent-write) command chmod 777 "$BAD/parent" ;;
  parent-owner) command chown 65534 "$BAD/parent" ;;
  parent-missing) rmdir "$BAD/parent" ;;
  esac
  BODY=$BAD/parent/body
  reset
  call readback_nginx_body
  check "$kind：读回拒绝" "$RC" 1
  call ensure_nginx_body
  check "$kind：修复拒绝且没动metadata" "$RC:$CHOWNS:$CHMODS" '1:0:0'
done
BODY=$SAVED_BODY

echo '== worker/读取/修复失败不假绿'
GOOD_PS=$PS_ROWS
for kind in no-worker foreign-worker mixed-worker ps-fail access-fail chown-fail chown-noop chmod-fail; do
  reset
  case "$kind" in
  no-worker) PS_ROWS='0 nginx: master process /usr/sbin/nginx' ;;
  foreign-worker) PS_ROWS='65534 nginx: worker process' ;;
  mixed-worker) PS_ROWS="$GOOD_PS
65534 nginx: worker process" ;;
  ps-fail) PS_FAIL=1 ;;
  access-fail) ACCESS_FAIL=1 ;;
  chown-fail) command chown 65534 "$BODY"; CHOWN_FAIL=1 ;;
  chown-noop) command chown 65534 "$BODY"; CHOWN_NOOP=1 ;;
  chmod-fail) command chmod 755 "$BODY"; CHMOD_FAIL=1 ;;
  esac
  call ensure_nginx_body
  check "$kind：失败非0，未记成功" "$RC:${#CHANGES[@]}" '1:0'
  PS_ROWS=$GOOD_PS
  PS_FAIL=0 CHOWN_FAIL=0 CHOWN_NOOP=0 CHMOD_FAIL=0 ACCESS_FAIL=0
  command chown "$UID_WWW" "$BODY"
  command chmod 700 "$BODY"
done

echo '== hk.sh 配置未变早退也修，readback_site只读核验'
extract() { awk -v name="$1" '$0 == name "() {" { on = 1 } on { print } on && /^}$/ { exit }' "$HK"; }
# shellcheck disable=SC1090 # 只摘真实入口函数，其余依赖为无副作用夹具
source <(extract setup_site; extract readback_site)
step() { :; }
ensure_pkgs() { :; }
ensure_dir() { :; }
fix_meta() { :; }
put_file() { WROTE=0; }
render() { RENDERED='unchanged'; }
ensure_symlink() { WROTE=0; }
systemctl() { printf 'active\n'; }
curl() { printf 200; }
nginx() { echo '测试禁止执行 nginx，包括 -t/-T' >&2; return 99; }
WEB_ROOT=$T/web
mkdir "$WEB_ROOT"
touch "$WEB_ROOT/index.html"
ACME_ROOT=$T/acme
FLEET_DOMAIN='' PLACEHOLDER_NAME=example.invalid
SITE_AVAILABLE=$T/site
SITE_ENABLED=$T/site-enabled
printf 'unchanged\n' >"$SITE_AVAILABLE"
ln -s "$SITE_AVAILABLE" "$SITE_ENABLED"
DEPLOY_DIR=$HERE/..
API_UPSTREAM=127.0.0.1:8787 WG_PEER_ADDR=127.0.0.2 CHECK_ONLY=1
command chown 65534 "$BODY"
reset
call readback_site
check '真实读回入口拒绝坏目录且不修改' "$RC:$(stat -c '%u' "$BODY"):$CHOWNS" '1:65534:0'
call setup_site
check '未变配置早退前已修好' "$RC:$(stat -c '%u' "$BODY"):$CHOWNS" "0:$UID_WWW:1"
reset
call setup_site
check '早退第二遍仍零改动' "$RC:$CHOWNS:$CHMODS:${#CHANGES[@]}" '0:0:0:0'
if ((fail)); then echo '不通过'; exit 1; fi
echo '通过'
