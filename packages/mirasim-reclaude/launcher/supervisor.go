package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"time"
)

type configuration struct {
	target           string
	args, env        []string
	mirasimHome, cwd string
}
type frame map[string]json.RawMessage

func (f frame) text(key string) string  { var s string; _ = json.Unmarshal(f[key], &s); return s }
func (f frame) object(key string) frame { var s frame; _ = json.Unmarshal(f[key], &s); return s }
func (f frame) set(key, s string)       { f[key], _ = json.Marshal(s) }
func parseFrame(b []byte) (frame, error) {
	var f frame
	if json.Unmarshal(b, &f) != nil || f == nil || f.text("type") == "" {
		return nil, fmt.Errorf("stdio 协议帧格式错误")
	}
	return f, nil
}

type event struct {
	kind       string
	generation int
	data       frame
	err        error
	code       int
}
type managedChild struct {
	cmd        *exec.Cmd
	in         io.WriteCloser
	done       chan struct{}
	temps      []string
	generation int
	mode       string
	exitCode   int
}

func scanFrames(r io.Reader, generation int, kind string, events chan<- event) {
	s := bufio.NewScanner(r)
	s.Buffer(make([]byte, 4096), 64<<20)
	for s.Scan() {
		if len(strings.TrimSpace(s.Text())) == 0 {
			continue
		}
		f, err := parseFrame(s.Bytes())
		if err != nil {
			events <- event{kind: "error", generation: generation, err: err}
			return
		}
		events <- event{kind: kind, generation: generation, data: f}
	}
	if err := s.Err(); err != nil {
		events <- event{kind: "error", generation: generation, err: fmt.Errorf("stdio 协议帧读取失败或超过大小上限")}
	}
}

func writeFrame(w io.Writer, f frame) error {
	b, err := json.Marshal(f)
	if err != nil {
		return fmt.Errorf("stdio 协议帧编码失败")
	}
	_, err = w.Write(append(b, '\n'))
	if err != nil {
		return fmt.Errorf("执行体 stdio 写失败")
	}
	return nil
}

// 未标路由时，只有回环地址加上平台令牌才保留注入。
// 只写了本机代理、没有令牌，是捕获地址，不是平台身份，按自有剥掉。
// 明确的 cloud 缺令牌仍拒绝，不回落到自有。
func applyRouteSettings(mode string, args []string, env []string) ([]string, []string, []string, error) {
	if mode == "local" || mode == "default" {
		if mode == "default" {
			loopback, credential, err := gatewayFacts(args)
			if err != nil {
				return nil, nil, nil, err
			}
			if loopback && credential {
				return args, env, nil, nil
			}
		}
		out, temps, _, err := rewriteArgs(args)
		if err != nil {
			return nil, nil, nil, err
		}
		env, _ = stripEnv(env)
		return out, env, temps, nil
	}
	if mode != "gateway" {
		if err := verifyGatewaySettings(args); err != nil {
			return nil, nil, nil, err
		}
	}
	return args, env, nil, nil
}

func startManaged(cfg configuration, args []string, sel selection, generation int, events chan<- event) (*managedChild, error) {
	args, env, temps, err := applyRouteSettings(sel.mode, args, cfg.env)
	if err != nil {
		logLine("event=reject route=" + sel.mode + " " + err.Error())
		return nil, err
	}
	self, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("启动器路径读失败")
	}
	c := exec.Command(self, "--fleet-mirasim-child")
	configureGuardian(c)
	c.Stderr = os.Stderr
	in, err := c.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := c.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err = c.Start(); err != nil {
		for _, p := range temps {
			_ = os.Remove(p)
		}
		return nil, fmt.Errorf("启动监管执行体失败")
	}
	child := &managedChild{cmd: c, in: &controlWriter{pipe: in}, done: make(chan struct{}), temps: temps, generation: generation, mode: sel.mode}
	go func() {
		scanFrames(out, generation, "output", events)
		err := c.Wait()
		child.exitCode = processExitCode(err)
		close(child.done)
		for _, p := range temps {
			_ = os.Remove(p)
		}
		events <- event{kind: "exit", generation: generation, code: processExitCode(err)}
	}()
	header, _ := json.Marshal(childSpec{Target: cfg.target, Args: args, Env: env})
	if _, err = in.Write(append(header, '\n')); err != nil {
		stopManaged(child)
		return nil, fmt.Errorf("启动控制帧发送失败")
	}
	logLine("event=launch route=" + sel.mode + " sid=" + sel.sessionID + " generation=" + strconv.Itoa(generation))
	return child, nil
}

func stopManaged(c *managedChild) {
	if c == nil {
		return
	}
	_ = c.in.Close()
	select {
	case <-c.done:
	case <-time.After(5 * time.Second):
		_ = c.cmd.Process.Kill()
		select {
		case <-c.done:
		case <-time.After(2 * time.Second):
		}
	}
}

func supervise(cfg configuration) error {
	events := make(chan event, 256)
	go func() { scanFrames(os.Stdin, 0, "input", events); events <- event{kind: "eof"} }()
	sigs := make(chan os.Signal, 2)
	signal.Notify(sigs, terminationSignals()...)
	defer signal.Stop(sigs)
	resolver := routeResolver{home: cfg.mirasimHome, cwd: cfg.cwd}
	native := sessionArgument(cfg.args)
	child := (*managedChild)(nil)
	defer func() { stopManaged(child) }()
	generation := 0
	started := false
	busy, closed := false, false
	queue := []frame{}
	hostQueue := []frame{}
	permissions := map[string]string{}
	requestAliases := map[string]string{}
	pendingHost := map[string]frame{}
	initialization := frame(nil)
	configurationFrames := map[string]frame{}
	replay := []frame{}
	waitingReplay := ""
	var replayDeadline time.Time
	background := map[string]bool{}
	model := flagValue(cfg.args, "--model")
	selectRoute := func() (selection, error) {
		if !isClaudeModel(model) {
			return selection{mode: "gateway"}, nil
		}
		return resolver.resolve(native)
	}
	start := func(sel selection, restarting bool) error {
		args := cfg.args
		if restarting {
			var err error
			args, err = resumeArgs(args, native)
			if err != nil {
				return err
			}
		}
		generation++
		var err error
		child, err = startManaged(cfg, args, sel, generation, events)
		if err == nil {
			started = true
		}
		return err
	}
	queueReplay := func() {
		if initialization != nil {
			replay = append(replay, initialization)
		}
		for _, key := range []string{"set_permission_mode", "set_model", "set_max_thinking_tokens", "mcp_set_servers"} {
			if f := configurationFrames[key]; f != nil {
				replay = append(replay, f)
			}
		}
	}
	ready := func() bool {
		return !busy && len(permissions) == 0 && len(pendingHost) == 0 && len(background) == 0 && waitingReplay == "" && len(replay) == 0 && len(hostQueue) == 0
	}
	sendToChild := func(f frame) error {
		if f.text("type") == "control_response" {
			r := f.object("response")
			if r == nil {
				return fmt.Errorf("权限回复格式错误")
			}
			id := r.text("request_id")
			original, ok := permissions[id]
			if !ok {
				return fmt.Errorf("权限回复没有对应的当前执行体请求")
			}
			r.set("request_id", original)
			f["response"], _ = json.Marshal(r)
			delete(permissions, id)
			delete(requestAliases, original)
		}
		if f.text("type") == "control_request" {
			id := f.text("request_id")
			if id == "" || f.object("request") == nil {
				return fmt.Errorf("控制请求缺少 ID 或请求对象")
			}
			if pendingHost[id] != nil {
				return fmt.Errorf("控制请求 ID 重复")
			}
			pendingHost[id] = f
		}
		if f.text("type") == "control_cancel_request" {
			delete(pendingHost, f.text("request_id"))
		}
		return writeFrame(child.in, f)
	}
	for {
		if child != nil && len(replay) == 0 && waitingReplay == "" && len(hostQueue) > 0 {
			for _, f := range hostQueue {
				if err := sendToChild(f); err != nil {
					return err
				}
			}
			hostQueue = nil
		}
		if len(queue) > 0 && ready() {
			if child != nil {
				select {
				case <-child.done:
					if child.exitCode != 0 {
						return fmt.Errorf("执行体退出失败，状态 %d", child.exitCode)
					}
					child = nil
				default:
				}
			}
			sel, err := selectRoute()
			if err != nil {
				return err
			}
			// 已经跑过的会话切 cloud 而活着的参数里没有平台网关：不杀会话，把这一条用户消息
			// 以报错结果退回给 Mirasim，进程和当前额度原样保留（首次启动仍按原规矩硬失败）。
			if started && sel.mode == "cloud" && verifyGatewaySettings(cfg.args) != nil {
				logLine("event=refuse-switch route=cloud sid=" + sel.sessionID + " reason=no-gateway-in-live-args")
				queue = queue[1:]
				refusal := frame{}
				refusal.set("type", "result")
				refusal.set("subtype", "error_during_execution")
				refusal.set("session_id", native)
				refusal.set("result", platformSwitchRefusal)
				refusal["is_error"] = json.RawMessage("true")
				if err := writeFrame(os.Stdout, refusal); err != nil {
					return err
				}
				fmt.Fprintln(os.Stderr, "mirasim-reclaude: switch_refused", platformSwitchRefusal)
				continue
			}
			if child == nil {
				recovering := started
				if err = start(sel, recovering); err != nil {
					return err
				}
				if recovering {
					queueReplay()
				}
			}
			if child.mode != sel.mode {
				stopManaged(child)
				if err = start(sel, true); err != nil {
					return err
				}
				queueReplay()
				logLine("event=switch route=" + sel.mode + " sid=" + sel.sessionID)
			}
			if len(replay) == 0 {
				f := queue[0]
				queue = queue[1:]
				if err := writeFrame(child.in, f); err != nil {
					return err
				}
				busy = true
			}
		}
		if len(replay) > 0 && waitingReplay == "" {
			b, _ := json.Marshal(replay[0])
			var f frame
			_ = json.Unmarshal(b, &f)
			replay = replay[1:]
			waitingReplay = "fleet-replay-" + strconv.Itoa(generation) + "-" + strconv.FormatInt(time.Now().UnixNano(), 10)
			replayDeadline = time.Now().Add(10 * time.Second)
			f.set("request_id", waitingReplay)
			if err := writeFrame(child.in, f); err != nil {
				return err
			}
		}
		if closed && ready() && len(queue) == 0 {
			return nil
		}
		var timeout <-chan time.Time
		if waitingReplay != "" {
			timeout = time.After(time.Until(replayDeadline))
		}
		select {
		case <-sigs:
			return fmt.Errorf("会话收到停止信号，已停止执行体")
		case <-timeout:
			return fmt.Errorf("恢复 SDK 初始化超时，未发送下一回合")
		case e := <-events:
			if e.generation != 0 && e.generation != generation {
				continue
			}
			switch e.kind {
			case "error":
				return e.err
			case "eof":
				closed = true
			case "exit":
				if busy || waitingReplay != "" || len(pendingHost) > 0 || len(permissions) > 0 || len(background) > 0 {
					return fmt.Errorf("执行体提前退出，状态 %d", e.code)
				}
				if e.code != 0 {
					return fmt.Errorf("执行体退出失败，状态 %d", e.code)
				}
				child = nil
				if closed {
					return nil
				}
			case "input":
				f := e.data
				if f.text("type") == "user" {
					if len(queue) >= 64 {
						return fmt.Errorf("待处理回合过多，未继续发送")
					}
					queue = append(queue, f)
					continue
				}
				if child == nil {
					sel, err := selectRoute()
					if err != nil {
						return err
					}
					recovering := started
					if err = start(sel, recovering); err != nil {
						return err
					}
					if recovering {
						queueReplay()
					}
				}
				if (len(replay) > 0 || waitingReplay != "") && f.text("type") != "control_response" {
					if len(hostQueue) >= 64 {
						return fmt.Errorf("待恢复控制帧过多")
					}
					hostQueue = append(hostQueue, f)
					continue
				}
				if err := sendToChild(f); err != nil {
					return err
				}
			case "output":
				f := e.data
				typ := f.text("type")
				if typ == "control_response" {
					r := f.object("response")
					if r == nil || r.text("request_id") == "" {
						return fmt.Errorf("执行体控制回复格式错误")
					}
					id := r.text("request_id")
					if id == waitingReplay && waitingReplay != "" {
						if r.text("subtype") != "success" {
							return fmt.Errorf("恢复 SDK 控制状态失败，未发送下一回合")
						}
						waitingReplay = ""
						continue
					}
					if original, ok := pendingHost[id]; ok {
						delete(pendingHost, id)
						if r.text("subtype") == "success" {
							req := original.object("request")
							sub := req.text("subtype")
							if sub == "initialize" {
								initialization = original
							} else if sub == "set_permission_mode" || sub == "set_model" || sub == "set_max_thinking_tokens" || sub == "mcp_set_servers" {
								configurationFrames[sub] = original
								if sub == "set_model" {
									model = req.text("model")
								}
							}
						}
					}
				}
				if typ == "control_request" {
					id := f.text("request_id")
					if id == "" {
						return fmt.Errorf("执行体控制请求缺少 ID")
					}
					external := "fleet-child-" + strconv.Itoa(generation) + "-" + id
					permissions[external] = id
					requestAliases[id] = external
					f.set("request_id", external)
				}
				if typ == "control_cancel_request" {
					id := f.text("request_id")
					if alias, ok := requestAliases[id]; ok {
						f.set("request_id", alias)
						delete(permissions, alias)
						delete(requestAliases, id)
					}
				}
				parent := f.text("parent_tool_use_id")
				if (typ == "system" || typ == "result") && parent == "" {
					if sid := f.text("session_id"); sid != "" {
						if !safeID(sid) {
							return fmt.Errorf("执行体会话 ID 格式错误")
						}
						native = sid
					}
				}
				if typ == "system" {
					sub := f.text("subtype")
					id := f.text("task_id")
					if sub == "task_started" && id != "" {
						background[id] = true
					}
					if sub == "task_notification" && id != "" {
						delete(background, id)
					}
				}
				if typ == "result" && parent == "" {
					busy = false
				}
				if err := writeFrame(os.Stdout, f); err != nil {
					return err
				}
			}
		}
	}
}

func runOnce(cfg configuration) int {
	args := cfg.args
	sel := selection{mode: "gateway"}
	if isClaudeModel(flagValue(args, "--model")) && sessionArgument(args) != "" {
		r := routeResolver{home: cfg.mirasimHome, cwd: cfg.cwd}
		var err error
		sel, err = r.resolve(sessionArgument(args))
		if err != nil {
			return fail("route_unreadable", err)
		}
	}
	args, env, temps, err := applyRouteSettings(sel.mode, args, cfg.env)
	if err != nil {
		code := "settings_unreadable"
		if sel.mode == "cloud" {
			code = "gateway_missing"
		}
		return fail(code, err)
	}
	defer func() {
		for _, p := range temps {
			_ = os.Remove(p)
		}
	}()
	self, err := os.Executable()
	if err != nil {
		return 1
	}
	c := exec.Command(self, "--fleet-mirasim-child")
	configureGuardian(c)
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	in, err := c.StdinPipe()
	if err != nil {
		return 1
	}
	if c.Start() != nil {
		return 1
	}
	b, _ := json.Marshal(childSpec{Target: cfg.target, Args: args, Env: env})
	if _, err = in.Write(append(b, '\n')); err != nil {
		_ = c.Process.Kill()
		return 1
	}
	writer := &controlWriter{pipe: in}
	defer writer.Close()
	go func() { _, _ = io.Copy(writer, os.Stdin); _ = writer.endInput() }()
	return processExitCode(c.Wait())
}
