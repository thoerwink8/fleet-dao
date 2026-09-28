#!/usr/bin/env bash
# 本机档（#451）：FLEET_PROFILE=local 时，deploy/france.sh 跳过只有法国才要的步骤——往香港去的 WireGuard 对端、
# 钉香港主机钥匙、往香港传文件和发飞书网关的钥匙、pilot 经 Mirasim 远程登录。不带这个变量（默认）就是 france 档，
# 和加本机档之前一个字节都不变：现有的法国机器、CI 都不设 FLEET_PROFILE，France 分支的代码原样没动。要先 source
# common.sh（用得到 pending）。
#
# 为什么用环境变量、不用 /etc/fleet-dao/france.env 里一项：本机档要在 setup_pilot、setup_wireguard 这些步骤
# 之前就定下来，而 france.env 要到 load_config（main() 里排在它们后面）才读到，先后顺序会绕一圈；环境变量也
# 不用碰 --check 那个位置参数的解析，只新加一个分支，不碰现有分支——「不带本机档时行为一个字节都不变」因此是
# 代码结构上能看出来的（每个改过的函数，France 分支都是「照抄原文、只在前面插一段 is_local_profile 的判断」），
# 不用另外证明。日常不用记这个变量名：装本机档用 deploy/local/install.sh，它包了这一层。

resolve_profile() { # 读 FLEET_PROFILE 环境变量（不给就是 france），打印规范化后的档名
  local p=${FLEET_PROFILE:-france}
  case "$p" in
  france | local) printf '%s' "$p" ;;
  *)
    echo "认不出的 FLEET_PROFILE「$p」（只认 france、local）" >&2
    return 64
    ;;
  esac
}

is_local_profile() { [[ "${PROFILE:-france}" == local ]]; }

# 本机档跳过一步：不算红也不算绿（记进 PENDING，退出码同真的待配）。调用方先判过 is_local_profile 才叫它。
skip_local() { pending "本机档跳过：$1"; } # 为什么

# readback_config 拿哪份期望和线上比（#451）：本机档是 deploy/local/desired-config.json（本机档登记过的差别——
# 比如 FLEET_MACHINE_NAME 改成「本机」——不然会被拿法国那份比出来，当成「手改了、改回去」误判成红）；法国不传
# --desired，config.mjs 自己按「在用的那一版」找 deploy/france/desired-config.json，和加本机档之前一个字节都不
# 变。空字符串就是「不传」，调用方判 -n 再拼进 desired_args。
profile_desired_file() { # deploy 目录（DEPLOY_DIR）
  if is_local_profile; then printf '%s' "$1/local/desired-config.json"; fi
}
