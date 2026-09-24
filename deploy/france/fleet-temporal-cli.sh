#!/bin/sh
# fleet-temporal：连 fleet-dao 这套 Temporal（127.0.0.1:@@FRONTEND_PORT@@，默认命名空间 fleet）的运维命令行。
# deploy/france.sh 装到 /usr/local/bin/fleet-temporal。旧系统的 temporal 命令默认连 7233 那套，不受影响。
# 地址写死、不读调用者的 TEMPORAL_ADDRESS：免得环境里残留的旧地址把命令悄悄指到旧系统上。
TEMPORAL_ADDRESS=127.0.0.1:@@FRONTEND_PORT@@
export TEMPORAL_ADDRESS
# 命名空间子命令自己带名字（operator namespace describe fleet）；这时再给默认命名空间，命令行会报「名字给了两遍」
case "$1 $2" in
"operator namespace") ;;
*)
  TEMPORAL_NAMESPACE=fleet
  export TEMPORAL_NAMESPACE
  ;;
esac
exec /opt/fleet-dao/temporal/bin/temporal "$@"
