#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 自建代理（docs/ops.md 第十四节）：香港 hk.sh 和法国 france.sh 各写一半、靠几个常量对上——端口、握手站、快照认的口；
# 钥匙和口令的样子校验（proxy_value_ok）拦得下坏值；订阅模板有没有「法国-直连」两种都渲染得干净、节点和组对得上。
# 每一项都配一个故意造的错，看它真红。本机装了 sing-box 时顺带 `sing-box check` 三份服务端配置，没装就跳过那一段。
# 不要 root、不碰任何文件或系统状态。用法：bash deploy/test/proxy.test.sh。退出码：0 通过，1 不通过。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd -- "$HERE/.." && pwd)
# shellcheck source=../lib/common.sh
source "$DEPLOY/lib/common.sh"
# shellcheck source=../lib/sing-box.sh
source "$DEPLOY/lib/sing-box.sh"
fail=0
pass() { echo "  ✓ $*"; }
flunk() {
  echo "  ✗ $*"
  fail=1
}

const() { # 文件 常量名：取脚本顶层 NAME=值 那一行的值
  sed -n -E "s/^$2=//p" "$1" | head -1
}

# ── 两台对得上的常量 ──
same() { # 说明 值1 值2
  if [[ -n "$2" && "$2" == "$3" ]]; then pass "$1（$2）"; else flunk "$1：「$2」≠「$3」"; fi
}
HK=$DEPLOY/hk.sh
FR=$DEPLOY/france.sh
same "香港入口端口 = 法国读回连的端口" "$(const "$HK" PROXY_PORT)" "$(const "$FR" HK_PROXY_PORT)"
same "法国出口端口 = 香港转过去的端口" "$(const "$FR" PROXY_EXIT_PORT)" "$(const "$HK" PROXY_FR_PORT)"
same "法国直连端口 = 香港订阅里填的端口" "$(const "$FR" PROXY_DIRECT_PORT)" "$(const "$HK" PROXY_FRD_PORT)"
same "法国直连握手站 = 香港订阅里填的握手站" "$(const "$FR" PROXY_DIRECT_SNI)" "$(const "$HK" PROXY_FRD_SNI)"
# 故意造的错：拿两个不同的值，same 必须判不通过
before=$fail
same "故意造的错" 8443 8444 >/dev/null
if ((fail)) && ((before == 0)); then
  fail=0
  pass "故意造的错：两个端口不一样判得出来"
elif ((fail == 0)); then
  flunk "same 对不同的值没判不通过"
fi

# 快照里认的 fleet-dao 公网口：香港默认那份要有 WG_PORT 和 PROXY_PORT，法国自己那份要写 PROXY_DIRECT_PORT
snap_hk=$(sed -n -E "s/^SNAPSHOT_OURS_DPORTS_RE='(.*)'$/\1/p" "$DEPLOY/lib/snapshot.sh")
for name in WG_PORT PROXY_PORT; do
  port=$(const "$HK" "$name")
  if [[ "--dport $port " =~ $snap_hk ]]; then pass "快照认得香港的 $name（$port）"; else flunk "lib/snapshot.sh 的 SNAPSHOT_OURS_DPORTS_RE 认不得香港 $name=$port"; fi
done
if [[ ! "--dport 9999 " =~ $snap_hk ]]; then pass "故意造的错：快照不认 9999"; else flunk "SNAPSHOT_OURS_DPORTS_RE 连 9999 都认，太宽"; fi
# shellcheck disable=SC2016 # 要的就是字面上的 $PROXY_DIRECT_PORT
if grep -q '^SNAPSHOT_OURS_DPORTS_RE="--dport ($PROXY_DIRECT_PORT) "$' "$FR"; then
  pass "法国快照认它自己的 PROXY_DIRECT_PORT"
else
  flunk "france.sh 没把 SNAPSHOT_OURS_DPORTS_RE 换成它自己的 PROXY_DIRECT_PORT：放行 443 会被当成旧系统变了"
fi

# ── 钥匙、口令、地址的样子 ──
good() { if proxy_value_ok "$1" "$2"; then pass "$1 收「$2」"; else flunk "$1 该收「$2」"; fi; }
bad() { if proxy_value_ok "$1" "$2"; then flunk "$1 不该收「$2」"; else pass "$1 拒「$2」"; fi; }
good FLEET_PROXY_UUID_HK 0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b
bad FLEET_PROXY_UUID_HK 0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5
bad FLEET_PROXY_UUID_FRD "0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b x"
good FLEET_PROXY_FRD_REALITY_PUBLIC_KEY abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456
bad FLEET_PROXY_FRD_REALITY_PUBLIC_KEY abcdefghijklmnopqrstuvwxyzABCDEFGHIJ012345=
good FLEET_PROXY_SHORT_ID 0123456789abcdef
bad FLEET_PROXY_FRD_SHORT_ID 0123456789ABCDEF
good FLEET_PROXY_SUB_TOKEN "$(printf 'a%.0s' {1..48})"
bad FLEET_PROXY_SUB_TOKEN "$(printf 'a%.0s' {1..47})"
good FLEET_PROXY_FRD_SERVER 203.0.113.7
bad FLEET_PROXY_FRD_SERVER "203.0.113.7:443"
bad FLEET_PROXY_UNKNOWN whatever

# ── 订阅模板 ──
UUID=0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b
KEY=abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456
SID=0123456789abcdef
render_sub() { # 法国-直连那段 名字后缀
  render "$DEPLOY/hk/proxy-sub.yaml" SERVER=203.0.113.1 PORT=8443 UUID_HK="$UUID" UUID_FR="$UUID" REALITY_SNI=www.microsoft.com \
    REALITY_PUBLIC_KEY="$KEY" SHORT_ID="$SID" COCKPIT_DOMAIN=cockpit.example.com FRD_PROXY="$1" FRD_NAME="$2" DIRECT_RULES="  - IP-CIDR,203.0.113.9/32,DIRECT,no-resolve"
}
nodes() { grep -c -E '^  - name: (香港|法国-中转|法国-直连)$' <<<"$1"; }

if render_sub "" "" >/dev/null; then
  sub=$RENDERED
  if [[ "$(nodes "$sub")" == 2 ]] && ! grep -v '^ *#' <<<"$sub" | grep -q 法国-直连; then pass "没配法国-直连：订阅两个节点，组里也不提它"; else flunk "没配法国-直连的订阅节点数「$(nodes "$sub")」或还提到了它"; fi
else
  flunk "没配法国-直连时订阅渲染不出来"
fi

if render "$DEPLOY/hk/proxy-sub-frd.yaml" FRD_SERVER=203.0.113.2 FRD_PORT=443 UUID_FRD="$UUID" FRD_SNI=www.microsoft.com \
  FRD_PUBLIC_KEY="$KEY" FRD_SHORT_ID="$SID" >/dev/null; then
  frd=$RENDERED
  if render_sub "$frd" ", 法国-直连" >/dev/null; then
    sub=$RENDERED
    if [[ "$(nodes "$sub")" == 3 ]]; then pass "配了法国-直连：订阅三个节点"; else flunk "配了法国-直连的订阅节点数是「$(nodes "$sub")」"; fi
    # 每个组里点到的名字都得是节点、组或 DIRECT
    names=$(sed -n -E 's/^  - name: (.*)$/\1/p' <<<"$sub")
    unknown=""
    while IFS= read -r list; do
      IFS=',' read -ra items <<<"$list"
      for it in "${items[@]}"; do
        it=${it# }
        [[ "$it" == DIRECT ]] || grep -qxF -- "$it" <<<"$names" || unknown+=" $it"
      done
    done < <(sed -n -E 's/^    proxies: \[(.*)\]$/\1/p' <<<"$sub")
    if [[ -z "$unknown" ]]; then pass "组里点到的名字都有"; else flunk "组里点到了不存在的：$unknown"; fi
    stray=$(grep -E '^  - [A-Z-]+,' <<<"$sub" | grep -v -E ',(AI|Mirasim|节点选择|DIRECT)(,no-resolve)?$' | head -3)
    if [[ -z "$stray" ]]; then pass "每条规则都落到认得的组"; else flunk "有规则落到不认得的组：$stray"; fi
  else
    flunk "配了法国-直连时订阅渲染不出来"
  fi
else
  flunk "法国-直连那段渲染不出来"
fi
# 故意造的错：少给一个占位，render 必须不通过
if render "$DEPLOY/hk/proxy-sub-frd.yaml" FRD_SERVER=203.0.113.2 >/dev/null 2>&1; then
  flunk "法国-直连那段少给占位也渲染过了"
else
  pass "故意造的错：少给占位 render 拦得下"
fi

# ── 本机有 sing-box 时，三份服务端配置用钉的版本真验一遍 ──
sb=${SING_BOX_TEST_BIN:-$(command -v sing-box || true)}
if [[ -n "$sb" ]]; then
  tmp=$(mktemp -d)
  render "$DEPLOY/hk/proxy.json" PORT=8443 UUID_HK="$UUID" UUID_FR="$UUID" REALITY_SNI=www.microsoft.com REALITY_PRIVATE_KEY="$KEY" \
    SHORT_ID="$SID" FR_ADDR=10.99.0.2 FR_PORT=8790 && printf '%s\n' "$RENDERED" >"$tmp/hk.json"
  render "$DEPLOY/france/proxy-exit.json" LISTEN=10.99.0.2 PORT=8790 && printf '%s\n' "$RENDERED" >"$tmp/exit.json"
  render "$DEPLOY/france/proxy-direct.json" PORT=443 UUID="$UUID" REALITY_SNI=www.microsoft.com REALITY_PRIVATE_KEY="$KEY" \
    SHORT_ID="$SID" && printf '%s\n' "$RENDERED" >"$tmp/direct.json"
  for f in hk exit direct; do
    if out=$("$sb" check -c "$tmp/$f.json" 2>&1); then pass "sing-box check $f.json"; else flunk "sing-box check $f.json：$out"; fi
  done
  rm -rf -- "$tmp"
else
  echo "  - 本机没有 sing-box，三份服务端配置没用它验（机器上 put_sing_box_config 换上之前会验）"
fi

if ((fail)); then
  echo "proxy：不通过"
  exit 1
fi
echo "proxy：通过"
