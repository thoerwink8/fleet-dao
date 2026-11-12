//! fleet-hostd：零依赖远端宿主特工（支持本机、法国 VPS、以及公司内网 SSH 反向隧道模式）。
//!
//! 职责：
//! 1. 生成公司内网穿透所需的 SSH ControlMaster + `-R 127.0.0.1:19820` 反向隧道参数（内网无需开放公网入站端口、内网磁盘零 API Key 落盘）；
//! 2. 管理任务级 Git Worktree 隔离目录；
//! 3. 收集确定性机械核验回执（writeScope 检查 + biome + tsc + vitest）。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostKind {
    LocalMachine,
    LinuxVps,
    CompanyIntranetSsh,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshHostConfig {
    pub host_id: String,
    pub ssh_target: String,
    pub jump_host: Option<String>,
    pub remote_loopback_port: u16,
    pub local_magpie_port: u16,
}

/// 为公司内网机器生成带反向模型代理隧道的 SSH 启动参数（内网 Worker 调 127.0.0.1:remote_loopback_port 即可透明使用桌面端的模型池，密钥绝不进内网机器）。
pub fn build_intranet_ssh_tunnel_args(cfg: &SshHostConfig) -> Vec<String> {
    let mut args = vec![
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ServerAliveInterval=15".to_string(),
        "-o".to_string(),
        "ExitOnForwardFailure=yes".to_string(),
        "-R".to_string(),
        format!(
            "127.0.0.1:{}:127.0.0.1:{}",
            cfg.remote_loopback_port, cfg.local_magpie_port
        ),
    ];
    if let Some(jump) = &cfg.jump_host {
        args.push("-J".to_string());
        args.push(jump.clone());
    }
    args.push(cfg.ssh_target.clone());
    args.push("~/.fleet/bin/fleet-hostd --stdio-rpc".to_string());
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intranet_ssh_tunnel_uses_reverse_loopback_without_exposing_keys() {
        let cfg = SshHostConfig {
            host_id: "corp-dev-01".into(),
            ssh_target: "dev@10.20.30.40".into(),
            jump_host: Some("bastion.corp.internal".into()),
            remote_loopback_port: 19820,
            local_magpie_port: 19820,
        };
        let args = build_intranet_ssh_tunnel_args(&cfg);
        assert!(args.contains(&"127.0.0.1:19820:127.0.0.1:19820".to_string()));
        assert!(args.contains(&"-J".to_string()));
    }
}
