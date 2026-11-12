use fleet_hostd::{build_intranet_ssh_tunnel_args, HostKind, SshHostConfig};
use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("status");

    match cmd {
        "tunnel-args" => {
            let target = args
                .get(2)
                .cloned()
                .unwrap_or_else(|| "dev@10.20.30.40".to_string());
            let jump = args.get(3).cloned();
            let cfg = SshHostConfig {
                host_id: "corp-intranet-01".into(),
                ssh_target: target,
                jump_host: jump,
                remote_loopback_port: 19820,
                local_magpie_port: 19820,
            };
            let ssh_args = build_intranet_ssh_tunnel_args(&cfg);
            let out = serde_json::json!({
                "hostConfig": cfg,
                "sshCommand": format!("ssh {}", ssh_args.join(" ")),
                "zeroKeyOnIntranetDisk": true,
            });
            println!("{}", serde_json::to_string_pretty(&out).unwrap());
        }
        "stdio-rpc" | "--stdio-rpc" => {
            let out = serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "hostd": "fleet-hostd 0.1.0",
                    "mode": "stdio-rpc",
                    "reverseLoopbackGateway": "http://127.0.0.1:19820/v1",
                    "intranetZeroKeyDisk": true,
                    "ready": true
                }
            });
            println!("{}", serde_json::to_string(&out).unwrap());
        }
        _ => {
            let out = serde_json::json!({
                "status": "online",
                "binary": "fleet-hostd 0.1.0",
                "supportedModes": [
                    HostKind::LocalMachine,
                    HostKind::LinuxVps,
                    HostKind::CompanyIntranetSsh
                ],
                "reverseLoopbackPort": 19820,
            });
            println!("{}", serde_json::to_string_pretty(&out).unwrap());
        }
    }
}
