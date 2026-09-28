#!/usr/bin/env bash
# 自建代理用的 sing-box（创始人 2026-09-28 拍：香港进，香港或经隧道从法国出，给他自己的设备用；docs/ops.md「自建代理」）。
# 香港 hk.sh、法国 france.sh 都 source 本文件：两台装同一个钉死的版本，单元同一份模板。
# 改这里之前必须知道：升版本时 SING_BOX_SHA256 照 GitHub 发布页 linux-amd64.tar.gz 的 digest 一起改；
# 两台的配置（deploy/hk/proxy.json、deploy/france/proxy-exit.json）都要先用新版本 `sing-box check` 过一遍。

SING_BOX_VERSION=1.14.2
SING_BOX_SHA256=a684484d7477d1437282ee411f4d131d0340aaad60a7868841ebd5d87dd8a0c6
SING_BOX_HOME=/opt/fleet-dao/sing-box-$SING_BOX_VERSION
SING_BOX_LINK=/opt/fleet-dao/sing-box
SING_BOX_BIN=$SING_BOX_LINK/sing-box

# 装钉死版本的 sing-box 到 SING_BOX_HOME（核 sha256），SING_BOX_LINK 指过去。WROTE=1 表示这次换了二进制
ensure_sing_box() {
  local tmp url=https://github.com/SagerNet/sing-box/releases/download/v$SING_BOX_VERSION/sing-box-$SING_BOX_VERSION-linux-amd64.tar.gz
  local swapped=0
  if [[ "$(uname -m)" != x86_64 ]]; then
    red "装的是 linux-amd64 的 sing-box，这台是 $(uname -m)"
    return 1
  fi
  ensure_dir /opt/fleet-dao root:root 755
  # 标记文件最后才写：半截的安装下次重来
  if [[ -f "$SING_BOX_HOME/.fleet-dao-sha256" && "$("$SING_BOX_HOME/sing-box" version 2>/dev/null | head -1)" == "sing-box version $SING_BOX_VERSION" ]]; then
    ok "sing-box $SING_BOX_VERSION 已装"
  else
    tmp=$(mktemp -d /opt/fleet-dao/.sing-box-new.XXXXXX)
    if ! curl -fsSL --retry 3 --max-time 300 -o "$tmp/sb.tgz" "$url"; then
      rm -rf -- "$tmp"
      red "下载失败：$url"
      return 1
    fi
    if ! printf '%s  %s\n' "$SING_BOX_SHA256" "$tmp/sb.tgz" | sha256sum --quiet --status -c -; then
      rm -rf -- "$tmp"
      red "sha256 对不上，不装：$url"
      return 1
    fi
    mkdir -- "$tmp/tree"
    tar -xzf "$tmp/sb.tgz" -C "$tmp/tree" --strip-components=1 --no-same-owner
    chown -R -h root:root -- "$tmp/tree"
    chmod -R go-w -- "$tmp/tree"
    printf '%s\n' "$SING_BOX_SHA256" >"$tmp/tree/.fleet-dao-sha256"
    rm -rf -- "$SING_BOX_HOME"
    mv -T -- "$tmp/tree" "$SING_BOX_HOME"
    rm -rf -- "$tmp"
    changed "装 sing-box $SING_BOX_VERSION（sha256 已核对）到 $SING_BOX_HOME"
    swapped=1
  fi
  ensure_symlink "$SING_BOX_LINK" "sing-box-$SING_BOX_VERSION"
  WROTE=$((swapped || WROTE))
}

# 渲染好的 sing-box 配置先验过再放：验不过判红、不写（机器上那份照旧）。WROTE=1 表示配置变了
put_sing_box_config() { # 目标 内容
  local target=$1 content=$2 tmp why
  tmp=$(mktemp)
  printf '%s\n' "$content" >"$tmp"
  if ! why=$("$SING_BOX_BIN" check -c "$tmp" 2>&1); then
    rm -f -- "$tmp"
    red "sing-box 配置验不过，没换上：$(tail -3 <<<"$why" | tr '\n' ' ')"
    return 1
  fi
  rm -f -- "$tmp"
  # 配置里有私钥和用户号：只给 root 读，单元用 LoadCredential 交给以临时用户跑的 sing-box
  put_file "$target" root:root 600 "$content"
}

# 单元：deploy/lib/sing-box.service 渲染。WROTE=1 表示单元文件变了（已 daemon-reload）
put_sing_box_unit() { # 单元名 说明 配置文件 要等的单元（可空）
  # 单元里的配置路径是 /etc/fleet-dao/%p.json（按单元名定），调用方的常量得和它是同一个
  if [[ "$3" != "/etc/fleet-dao/${1%.service}.json" ]]; then
    red "sing-box 单元 $1 的配置应为 /etc/fleet-dao/${1%.service}.json（单元模板里按单元名定），调用方给的是 $3"
    return 1
  fi
  render "$DEPLOY_DIR/lib/sing-box.service" DESCRIPTION="$2" BIN="$SING_BOX_BIN" AFTER="${4:-}" || return 1
  put_file "/etc/systemd/system/$1" root:root 644 "$RENDERED"
  if ((WROTE)); then systemctl daemon-reload; fi
}

# 读回：二进制是钉死的版本、单元在跑、在听该听的端口
readback_sing_box() { # 单元名 端口（TCP）
  local have
  have=$("$SING_BOX_BIN" version 2>/dev/null | head -1) || have=""
  if [[ "$have" == "sing-box version $SING_BOX_VERSION" ]]; then ok "$have（$SING_BOX_LINK）"; else red "$SING_BOX_BIN 是「${have:-没有}」，应为 $SING_BOX_VERSION"; fi
  if [[ "$(systemctl is-active "$1" 2>/dev/null)" != active ]]; then
    red "$1 没在跑：journalctl -u $1 -n 50"
    return 0
  fi
  if [[ -n "$(ss -Hlnt "sport = :$2" 2>/dev/null)" ]]; then
    ok "$1 在跑，听着 TCP $2"
  else
    red "$1 在跑，但没在听 TCP $2：journalctl -u $1 -n 50"
  fi
}

# proxy.env 里一项的值像不像该有的样子（值不打印）
proxy_value_ok() { # 键 值
  local re
  case $1 in
  *_UUID_*) re='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ;;
  *_KEY) re='^[A-Za-z0-9_-]{43}$' ;;
  *_SHORT_ID) re='^[0-9a-f]{16}$' ;;
  *_SUB_TOKEN) re='^[0-9a-f]{48}$' ;;
  *_SERVER) re='^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$' ;;
  *) return 1 ;;
  esac
  [[ "$2" =~ $re ]]
}

# 这台对外的 IPv4（订阅里填它，不填域名：域名被污染也不影响连代理）。取不到、是内网地址就失败
proxy_server_ip() {
  local ip
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')
  if [[ ! "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || [[ "$ip" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|127\.) ]]; then
    return 1
  fi
  printf '%s' "$ip"
}

# 真走一遍：本机起一个临时客户端，经 VLESS + Reality 入口问公网「我的出口地址是什么」，出口地址放进 PROXY_EGRESS。
# 打不开网页返回 1（PROXY_EGRESS 里是拿到的东西，截断后给人看）
PROXY_EGRESS=""
proxy_egress_ip() { # 服务器 端口 用户号 握手站 公钥 short_id
  local tmp port pid i
  for ((i = 0; i < 20; i++)); do
    port=$((40000 + RANDOM % 10000))
    port_in_use tcp "$port" || break
  done
  tmp=$(mktemp -d)
  cat >"$tmp/c.json" <<EOF
{"log":{"level":"error"},"inbounds":[{"type":"mixed","listen":"127.0.0.1","listen_port":$port}],
 "outbounds":[{"type":"vless","server":"$1","server_port":$2,"uuid":"$3","flow":"xtls-rprx-vision",
  "tls":{"enabled":true,"server_name":"$4","utls":{"enabled":true,"fingerprint":"chrome"},
   "reality":{"enabled":true,"public_key":"$5","short_id":"$6"}}}]}
EOF
  "$SING_BOX_BIN" run -c "$tmp/c.json" -D "$tmp" >/dev/null 2>&1 &
  pid=$!
  for ((i = 0; i < 25; i++)); do
    port_in_use tcp "$port" && break
    sleep 0.2
  done
  PROXY_EGRESS=$(curl -s --max-time 15 -x "socks5h://127.0.0.1:$port" https://api.ipify.org || true)
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -rf -- "$tmp"
  if [[ ! "$PROXY_EGRESS" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    PROXY_EGRESS=${PROXY_EGRESS:0:60}
    return 1
  fi
}

# Reality 借的握手站：从这台连得上、是 TLS 1.3 + h2，客户端握手才对得上
readback_reality_sni() { # 握手站 改哪个常量
  local out
  out=$(timeout 10 openssl s_client -tls1_3 -alpn h2 -connect "$1:443" -servername "$1" </dev/null 2>/dev/null) || true
  if [[ "$out" == *"TLSv1.3"* && "$out" == *"ALPN protocol: h2"* ]]; then
    ok "借用的握手站 $1 连得上（TLS 1.3 + h2）"
  else
    red "借用的握手站 $1 从这台连不上、或不是 TLS 1.3 + h2：换 $2"
  fi
}
