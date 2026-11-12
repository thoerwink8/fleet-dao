use fleet_core::{
    compile_agent_prompt, evaluate_trust_funnel, evaluate_ysk_diff, select_best_route,
    select_cluster_host_for_task, verify_anti_ban, wilson_lower_bound, AccountSnapshot, AgentRole,
    ChannelSpec, ClusterHostSpec, EngineRunner, FunnelEvalInput, HostNodeStatus, ModelFamily,
    ModelSpec, ModelTier, PromptCompileSpec, RouteCandidate,
};
use fleet_daemon::{build_stream_process_spec, plan_single_pr_for_wave};
use std::env;

fn default_candidates() -> Vec<RouteCandidate> {
    vec![
        RouteCandidate {
            channel: ChannelSpec {
                id: "reclaude".into(),
                name: "Reclaude (官方本体直通)".into(),
                runner: EngineRunner::NativeReclaudeStream,
                strict_native_client: true,
            },
            model: ModelSpec {
                id: "claude-opus-5-5".into(),
                display_name: "Claude Opus 5.5".into(),
                family: ModelFamily::Claude,
                tier: ModelTier::Flagship,
                forbidden_roles: vec![],
            },
            account: AccountSnapshot {
                account_id: "reclaude-carpool-a".into(),
                channel_id: "reclaude".into(),
                isolated_host_user: Some("vps-france:fleet-agent-carpool".into()),
                enabled: true,
                remaining_ratio: 0.45,
                minutes_until_reset: Some(42),
            },
            wilson_lower_bound: 0.94,
        },
        RouteCandidate {
            channel: ChannelSpec {
                id: "kiro".into(),
                name: "Kiro 编码主力池".into(),
                runner: EngineRunner::PiApiStream,
                strict_native_client: false,
            },
            model: ModelSpec {
                id: "kiro-claude-sonnet".into(),
                display_name: "Kiro Claude Sonnet".into(),
                family: ModelFamily::Claude,
                tier: ModelTier::Workhorse,
                forbidden_roles: vec![],
            },
            account: AccountSnapshot {
                account_id: "kiro-pool-01".into(),
                channel_id: "kiro".into(),
                isolated_host_user: None,
                enabled: true,
                remaining_ratio: 0.90,
                minutes_until_reset: None,
            },
            wilson_lower_bound: 0.92,
        },
        RouteCandidate {
            channel: ChannelSpec {
                id: "commoncode".into(),
                name: "CommonCode / OpenCode".into(),
                runner: EngineRunner::PiApiStream,
                strict_native_client: false,
            },
            model: ModelSpec {
                id: "deepseek-v4-pro".into(),
                display_name: "DeepSeek V4 Pro".into(),
                family: ModelFamily::Deepseek,
                tier: ModelTier::Workhorse,
                forbidden_roles: vec![],
            },
            account: AccountSnapshot {
                account_id: "cc-deepseek-02".into(),
                channel_id: "commoncode".into(),
                isolated_host_user: None,
                enabled: true,
                remaining_ratio: 0.88,
                minutes_until_reset: None,
            },
            wilson_lower_bound: 0.928,
        },
        RouteCandidate {
            channel: ChannelSpec {
                id: "recodex".into(),
                name: "Recodex API".into(),
                runner: EngineRunner::PiApiStream,
                strict_native_client: false,
            },
            model: ModelSpec {
                id: "gpt-5.3-codex".into(),
                display_name: "GPT-5.3 Codex".into(),
                family: ModelFamily::Gpt,
                tier: ModelTier::Flagship,
                forbidden_roles: vec![AgentRole::WorkerUi],
            },
            account: AccountSnapshot {
                account_id: "recodex-01".into(),
                channel_id: "recodex".into(),
                isolated_host_user: None,
                enabled: true,
                remaining_ratio: 0.95,
                minutes_until_reset: None,
            },
            wilson_lower_bound: 0.935,
        },
        RouteCandidate {
            channel: ChannelSpec {
                id: "devin".into(),
                name: "Devin (Free SWE-2)".into(),
                runner: EngineRunner::PiApiStream,
                strict_native_client: false,
            },
            model: ModelSpec {
                id: "devin-swe-2".into(),
                display_name: "Devin SWE-2 (Free)".into(),
                family: ModelFamily::Swe,
                tier: ModelTier::Free,
                forbidden_roles: vec![AgentRole::Commander, AgentRole::WorkerUi],
            },
            account: AccountSnapshot {
                account_id: "devin-free".into(),
                channel_id: "devin".into(),
                isolated_host_user: None,
                enabled: true,
                remaining_ratio: 1.0,
                minutes_until_reset: None,
            },
            wilson_lower_bound: 0.96,
        },
    ]
}

fn parse_role(s: &str) -> AgentRole {
    match s {
        "commander" => AgentRole::Commander,
        "planner" => AgentRole::Planner,
        "worker-ui" => AgentRole::WorkerUi,
        "scout" => AgentRole::Scout,
        "verifier" => AgentRole::Verifier,
        "ysk-watcher" => AgentRole::YskWatcher,
        _ => AgentRole::WorkerCode,
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("self-check");

    match cmd {
        "route" => {
            let role_str = args.get(2).map(String::as_str).unwrap_or("worker-code");
            let role = parse_role(role_str);
            let candidates = default_candidates();
            match select_best_route(role, &candidates, None, false) {
                Ok(route) => {
                    let host_user = candidates
                        .iter()
                        .find(|c| c.account.account_id == route.account_id)
                        .and_then(|c| c.account.isolated_host_user.as_deref());
                    let spec = build_stream_process_spec(
                        "sess-cli-01",
                        &route,
                        host_user,
                        ".claude/worktrees/sess-cli-01",
                        19820,
                    )
                    .expect("failed to build stream spec");
                    let out = serde_json::json!({
                        "selectedRoute": route,
                        "streamProcessSpec": spec,
                    });
                    println!("{}", serde_json::to_string_pretty(&out).unwrap());
                }
                Err(e) => {
                    eprintln!("{}", e);
                    std::process::exit(1);
                }
            }
        }
        "ysk" => {
            let goal = args.get(2).map(String::as_str).unwrap_or("新增页面");
            let scope = args
                .get(3)
                .map(|s| vec![s.clone()])
                .unwrap_or_else(|| vec!["packages/harness-web/src/pages".to_string()]);
            let touched = args
                .get(4)
                .cloned()
                .unwrap_or_else(|| "packages/web/src/components/shell.tsx".to_string());
            let alert = evaluate_ysk_diff(goal, &scope, &[(touched, "- 导航\n+ 新导航".to_string())]);
            println!("{}", serde_json::to_string_pretty(&alert).unwrap());
        }
        "compile-prompt" => {
            let role = parse_role(args.get(2).map(String::as_str).unwrap_or("worker-code"));
            let model_id = args
                .get(3)
                .cloned()
                .unwrap_or_else(|| "deepseek-v4-pro".to_string());
            let family = if model_id.contains("deepseek") {
                ModelFamily::Deepseek
            } else if model_id.contains("gpt") || model_id.contains("codex") {
                ModelFamily::Gpt
            } else if model_id.contains("swe") {
                ModelFamily::Swe
            } else if model_id.contains("grok") {
                ModelFamily::Grok
            } else if model_id.contains("gemini") {
                ModelFamily::Gemini
            } else {
                ModelFamily::Claude
            };
            let spec = PromptCompileSpec {
                role,
                model_id,
                family,
                task_title: args
                    .get(4)
                    .cloned()
                    .unwrap_or_else(|| "落地方案2双常驻流与四道可信验收闸".to_string()),
                write_scope: vec![
                    "crates/fleet-core".to_string(),
                    "packages/omp-bridge".to_string(),
                ],
                check_command: "cargo test --workspace && pnpm check".to_string(),
                evolved_rules: vec![
                    "严禁顺手修改 writeScope 以外或需求未点名的已上线文案、导航与导出接口".to_string(),
                ],
            };
            println!("{}", compile_agent_prompt(&spec));
        }
        "funnel-eval" => {
            let input = FunnelEvalInput {
                worker_family: ModelFamily::Deepseek,
                verifier_family: ModelFamily::Claude,
                ysk_alert_triggered: false,
                mechanical_passed: true,
                cold_verify_passed: true,
                attempt: 1,
                matured_successes: 41,
                matured_total: 42,
                recent_reverts: 0,
            };
            let verdict = evaluate_trust_funnel(&input);
            println!("{}", serde_json::to_string_pretty(&verdict).unwrap());
        }
        "cluster-dispatch" => {
            let task = args
                .get(2)
                .map(String::as_str)
                .unwrap_or("内网服务联调与 hostd 帧协议一致性套件");
            let tag = args.get(3).map(String::as_str);
            let hosts = vec![
                ClusterHostSpec {
                    host_id: "vps-france".into(),
                    display_name: "主力云节点 #1".into(),
                    endpoint: "ssh://10.99.0.2".into(),
                    tags: vec!["24x7-cloud".into(), "reclaude-slot".into()],
                    max_slots: 6,
                    running_jobs: 2,
                    status: HostNodeStatus::Online,
                    zero_key_on_disk: true,
                },
                ClusterHostSpec {
                    host_id: "desktop-win".into(),
                    display_name: "创始人桌面工作站".into(),
                    endpoint: "local://127.0.0.1:7347".into(),
                    tags: vec!["browser-gui".into(), "ego-browser".into()],
                    max_slots: 4,
                    running_jobs: 1,
                    status: HostNodeStatus::Online,
                    zero_key_on_disk: true,
                },
                ClusterHostSpec {
                    host_id: "corp-intranet-01".into(),
                    display_name: "公司内网研发机".into(),
                    endpoint: "ssh -J bastion -R 19820".into(),
                    tags: vec!["intranet-only".into(), "reverse-tunnel".into()],
                    max_slots: 4,
                    running_jobs: 1,
                    status: HostNodeStatus::Online,
                    zero_key_on_disk: true,
                },
            ];
            let decision = select_cluster_host_for_task(task, None, tag, &hosts).unwrap();
            println!("{}", serde_json::to_string_pretty(&decision).unwrap());
        }
        _ => {
            let candidates = default_candidates();
            for c in &candidates {
                verify_anti_ban(&c.channel, &c.account).expect("anti-ban check failed");
            }
            let code_route = select_best_route(AgentRole::WorkerCode, &candidates, None, false).unwrap();
            let ysk_route = select_best_route(AgentRole::YskWatcher, &candidates, None, true).unwrap();
            let pr_plan = plan_single_pr_for_wave(
                "3851",
                "方案2 双常驻流与四维路由落地",
                &["wave/3851/w1".into(), "wave/3851/w2".into()],
            )
            .unwrap();
            let summary = serde_json::json!({
                "status": "ok",
                "daemon": "fleet-daemon 0.1.0",
                "antiBanVerified": true,
                "sampleCodeRoute": code_route,
                "sampleYskRoute": ysk_route,
                "wilson98of100": wilson_lower_bound(98, 100),
                "singlePrPlan": pr_plan,
            });
            println!("{}", serde_json::to_string_pretty(&summary).unwrap());
        }
    }
}
