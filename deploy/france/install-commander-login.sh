#!/usr/bin/env bash
# 在指挥官本机或跳板 box 上跑：对照 deploy/france/session-login.pub 的指纹，
# 把本机已有的匹配私钥链成 ~/.ssh/fleet_login，并提示 Include commander-ssh.config。
# 不生成新钥匙、不改法国机；法国侧钥匙仍由 france.sh 照 pilot / session-login.pub 写。
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PUB=${1:-"$HERE/session-login.pub"}
SSH_DIR=${SSH_DIR:-"$HOME/.ssh"}
LINK=${FLEET_LOGIN:-"$SSH_DIR/fleet_login"}

if [[ ! -s "$PUB" ]]; then
  echo "install-commander-login：没有 $PUB" >&2
  exit 2
fi
if ! command -v ssh-keygen >/dev/null; then
  echo "install-commander-login：没有 ssh-keygen" >&2
  exit 2
fi

mapfile -t WANT < <(ssh-keygen -lf "$PUB" | awk '{print $2}' | sort -u)
if ((${#WANT[@]} == 0)); then
  echo "install-commander-login：$PUB 里认不出指纹" >&2
  exit 1
fi

mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR" 2>/dev/null || true
found=""
shopt -s nullglob
for key in "$SSH_DIR"/id_ed25519 "$SSH_DIR"/id_rsa "$SSH_DIR"/fleet_login "$SSH_DIR"/*; do
  [[ -f "$key" && ! "$key" =~ \.pub$ ]] || continue
  fp=$(ssh-keygen -lf "$key" 2>/dev/null | awk '{print $2}') || continue
  for w in "${WANT[@]}"; do
    if [[ "$fp" == "$w" ]]; then
      found=$key
      break 2
    fi
  done
done

if [[ -z "$found" ]]; then
  echo "install-commander-login：本机 $SSH_DIR 没有与 session-login.pub 指纹匹配的私钥。" >&2
  echo "需要的指纹：" >&2
  ssh-keygen -lf "$PUB" >&2
  echo "从 DESKTOP-GET3DBC 拷贝对应私钥后重跑；不要用 root 登法国，用 fleet-agent-carpool。" >&2
  exit 1
fi

if [[ "$found" != "$LINK" ]]; then
  ln -sfn -- "$found" "$LINK"
  chmod 600 "$found" 2>/dev/null || true
  echo "已把 $found （$fp）链到 $LINK"
else
  echo "已有 $LINK，指纹 $fp"
fi

CFG="$HERE/commander-ssh.config"
echo "把下面一行并进 ~/.ssh/config（或复制 Host 块）："
echo "  Include $CFG"
echo "然后："
echo "  ssh -G fleet-fr-carpool-via-hk | rg 'user |identityfile '"
echo "  ssh fleet-fr-carpool-via-hk 'id; hostname'"
