//! fleet-daemon：方案 2 双常驻流进程监管器 + 本地波次合流 + 单 PR 出站闸。
//!
//! - 左臂（Claude 套餐池）：拉起官方 `reclaude` 本体双向流（`--input-format stream-json --output-format stream-json`），
//!   不改 TLS 指纹、不拆 HTTP 请求头，从根源杜绝 `400 non_cc_client` 封号；
//! - 右臂（开放 API 与多模型池）：拉起 `pi --mode rpc` 常驻流，对接 `recodex`、`kiro`、`commoncode`、`devin`、`grok`、`antigravity` 与中转站；
//! - 告别「把 GitHub Issues/Labels 当数据库」：所有子任务在本地波次分支合流，四道漏斗全绿后只推 1 个整洁 PR。

use fleet_core::{EngineRunner, SelectedRoute};
use serde::{Deserialize, Serialize};

/// 常驻流启动命令规格（由守护进程生成并交由本机或远端 fleet-hostd 拉起）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamProcessSpec {
    pub session_id: String,
    pub runner: EngineRunner,
    pub program: String,
    pub args: Vec<String>,
    /// 隔离执行的目标宿主与系统用户（如 "vps-france:fleet-agent-carpool" 或 "local"）。
    pub host_user: String,
    pub worktree_dir: String,
    /// 注入给子进程的环境变量（严禁包含明文长效密钥，pi 流只注入本地回环网关地址）。
    pub env: Vec<(String, String)>,
}

/// 根据方案 2 选路结果构造对应的常驻流进程启动规格。
pub fn build_stream_process_spec(
    session_id: &str,
    route: &SelectedRoute,
    isolated_host_user: Option<&str>,
    worktree_dir: &str,
    loopback_gateway_port: u16,
) -> Result<StreamProcessSpec, String> {
    match route.runner {
        EngineRunner::NativeReclaudeStream => {
            let host_user = isolated_host_user.ok_or_else(|| {
                format!(
                    "reclaude 账号 {} 缺少 isolated_host_user，拒绝启动常驻流",
                    route.account_id
                )
            })?;
            Ok(StreamProcessSpec {
                session_id: session_id.to_string(),
                runner: EngineRunner::NativeReclaudeStream,
                program: "reclaude".to_string(),
                args: vec![
                    "--print".to_string(),
                    "--verbose".to_string(),
                    "--input-format".to_string(),
                    "stream-json".to_string(),
                    "--output-format".to_string(),
                    "stream-json".to_string(),
                    "--model".to_string(),
                    route.model_id.clone(),
                ],
                host_user: host_user.to_string(),
                worktree_dir: worktree_dir.to_string(),
                env: vec![("FLEET_SESSION_ID".to_string(), session_id.to_string())],
            })
        }
        EngineRunner::PiApiStream => Ok(StreamProcessSpec {
            session_id: session_id.to_string(),
            runner: EngineRunner::PiApiStream,
            program: "pi".to_string(),
            args: vec![
                "--mode".to_string(),
                "rpc".to_string(),
                "--provider".to_string(),
                route.channel_id.clone(),
                "--model".to_string(),
                route.model_id.clone(),
            ],
            host_user: isolated_host_user.unwrap_or("local").to_string(),
            worktree_dir: worktree_dir.to_string(),
            env: vec![
                ("FLEET_SESSION_ID".to_string(), session_id.to_string()),
                (
                    "FLEET_MAGPIE_LOOPBACK".to_string(),
                    format!("http://127.0.0.1:{}/v1", loopback_gateway_port),
                ),
            ],
        }),
        EngineRunner::NativeCliStream => Ok(StreamProcessSpec {
            session_id: session_id.to_string(),
            runner: EngineRunner::NativeCliStream,
            program: route.channel_id.clone(),
            args: vec!["--model".to_string(), route.model_id.clone()],
            host_user: isolated_host_user.unwrap_or("local").to_string(),
            worktree_dir: worktree_dir.to_string(),
            env: vec![("FLEET_SESSION_ID".to_string(), session_id.to_string())],
        }),
    }
}

/// 单 PR 波次合流闸（取代旧引擎「每个子任务开 PR、轮询 GitHub Label」的高延迟模式）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaveSinglePrPlan {
    pub task_id: String,
    pub integration_branch: String,
    pub merged_subtasks: Vec<String>,
    pub target_branch: String,
    pub pr_title: String,
}

pub fn plan_single_pr_for_wave(
    task_id: &str,
    task_title: &str,
    verified_subtask_branches: &[String],
) -> Result<WaveSinglePrPlan, String> {
    if verified_subtask_branches.is_empty() {
        return Err("没有任何已通过四道漏斗的子任务分支，拒绝生成空 PR".to_string());
    }
    Ok(WaveSinglePrPlan {
        task_id: task_id.to_string(),
        integration_branch: format!("wave/{}", task_id),
        merged_subtasks: verified_subtask_branches.to_vec(),
        target_branch: "main".to_string(),
        pr_title: format!("feat({}): {}", task_id, task_title),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleet_core::AgentRole;

    #[test]
    fn builds_native_reclaude_stream_and_pi_rpc_specs() {
        let reclaude_route = SelectedRoute {
            role: AgentRole::WorkerCode,
            channel_id: "reclaude".into(),
            model_id: "claude-opus-5-5".into(),
            account_id: "carpool-a".into(),
            runner: EngineRunner::NativeReclaudeStream,
            score: 1.4,
        };
        let spec = build_stream_process_spec(
            "sess-1",
            &reclaude_route,
            Some("vps-france:fleet-agent-carpool"),
            "/worktrees/sess-1",
            19820,
        )
        .unwrap();
        assert_eq!(spec.program, "reclaude");
        assert!(spec.args.contains(&"stream-json".to_string()));
        assert_eq!(spec.host_user, "vps-france:fleet-agent-carpool");

        let pi_route = SelectedRoute {
            role: AgentRole::WorkerCode,
            channel_id: "commoncode".into(),
            model_id: "deepseek-v4-pro".into(),
            account_id: "cc-1".into(),
            runner: EngineRunner::PiApiStream,
            score: 1.3,
        };
        let pi_spec =
            build_stream_process_spec("sess-2", &pi_route, None, "/worktrees/sess-2", 19820)
                .unwrap();
        assert_eq!(pi_spec.program, "pi");
        assert!(pi_spec
            .env
            .iter()
            .any(|(k, v)| k == "FLEET_MAGPIE_LOOPBACK" && v == "http://127.0.0.1:19820/v1"));
    }
}
