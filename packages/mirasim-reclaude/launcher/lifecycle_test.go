package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

var testLauncher string

func TestMain(m *testing.M) {
	if os.Getenv("MIRASIM_LAUNCHER_TEST_CHILD") == "1" {
		fakeClaude()
		return
	}
	wd, _ := os.Getwd()
	base := filepath.Join(wd, "..", "..", "..", "_tmp")
	if err := os.MkdirAll(base, 0700); err != nil {
		panic(err)
	}
	dir, err := os.MkdirTemp(base, "mirasim-launcher-tests-")
	if err != nil {
		panic(err)
	}
	testLauncher = filepath.Join(dir, "launcher")
	if runtime.GOOS == "windows" {
		testLauncher += ".exe"
	}
	c := exec.Command("go", "build", "-o", testLauncher, ".")
	if out, err := c.CombinedOutput(); err != nil {
		fmt.Fprintln(os.Stderr, string(out), err)
		os.Exit(2)
	}
	os.Exit(m.Run())
}

func argValue(args []string, name string) string {
	for i, a := range args {
		if a == name && i+1 < len(args) {
			return args[i+1]
		}
		if strings.HasPrefix(a, name+"=") {
			return strings.TrimPrefix(a, name+"=")
		}
	}
	return ""
}

// 独立的假执行体按真实 stdio 协议回应，不调用任何模型。
func fakeClaude() {
	if os.Getenv("MIRASIM_TEST_ROLE") == "once" {
		_, _ = io.ReadAll(os.Stdin)
		time.Sleep(50 * time.Millisecond)
		fmt.Print("version-probe-output")
		os.Exit(23)
	}
	if os.Getenv("MIRASIM_TEST_ROLE") == "argv" {
		_ = json.NewEncoder(os.Stdout).Encode(os.Args[1:])
		os.Exit(0)
	}
	if os.Getenv("MIRASIM_TEST_ROLE") == "grandchild" {
		for {
			time.Sleep(time.Hour)
		}
	}
	args := os.Args[1:]
	if p := os.Getenv("MIRASIM_TEST_INVOKED"); p != "" {
		_ = os.WriteFile(p, []byte("invoked"), 0600)
	}
	env := map[string]any{}
	for i := 0; i < len(args); i++ {
		var v string
		if args[i] == "--settings" && i+1 < len(args) {
			i++
			v = args[i]
		} else if strings.HasPrefix(args[i], "--settings=") {
			v = strings.TrimPrefix(args[i], "--settings=")
		}
		if v == "" {
			continue
		}
		b := []byte(v)
		if !strings.HasPrefix(strings.TrimSpace(v), "{") {
			var err error
			b, err = os.ReadFile(v)
			if err != nil {
				os.Exit(7)
			}
		}
		var d struct {
			Env map[string]any `json:"env"`
		}
		if json.Unmarshal(b, &d) != nil {
			os.Exit(8)
		}
		for k, x := range d.Env {
			env[k] = x
		}
	}
	mode := "local"
	if env["ANTHROPIC_BASE_URL"] != nil || os.Getenv("ANTHROPIC_BASE_URL") != "" {
		mode = "cloud"
	}
	sid := argValue(args, "--resume")
	if sid == "" {
		sid = argValue(args, "--session-id")
	}
	if sid == "" {
		sid = "native-created"
	}
	if p := os.Getenv("MIRASIM_TEST_GRANDCHILD_PID"); p != "" {
		self, _ := os.Executable()
		c := exec.Command(self)
		c.Env = append(os.Environ(), "MIRASIM_TEST_ROLE=grandchild")
		if c.Start() != nil {
			os.Exit(13)
		}
		_ = os.WriteFile(p, []byte(fmt.Sprint(c.Process.Pid)), 0600)
	}
	initialized := false
	enc := json.NewEncoder(os.Stdout)
	dec := json.NewDecoder(os.Stdin)
	for {
		var f map[string]any
		if err := dec.Decode(&f); err != nil {
			if err != io.EOF {
				os.Exit(9)
			}
			return
		}
		if f["type"] == "control_request" {
			r, _ := f["request"].(map[string]any)
			if r["subtype"] != "initialize" && os.Getenv("MIRASIM_TEST_REQUIRE_INIT") == "1" && !initialized {
				os.Exit(10)
			}
			if r["subtype"] == "initialize" {
				initialized = true
			}
			_ = enc.Encode(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": f["request_id"], "response": map[string]any{}}})
			continue
		}
		if f["type"] != "user" {
			continue
		}
		if os.Getenv("MIRASIM_TEST_REQUIRE_INIT") == "1" && !initialized {
			os.Exit(10)
		}
		_ = enc.Encode(map[string]any{"type": "system", "subtype": "init", "session_id": sid})
		msg, _ := f["message"].(map[string]any)
		content, _ := msg["content"].(string)
		if content == "permission" {
			_ = enc.Encode(map[string]any{"type": "control_request", "request_id": "permission-1", "request": map[string]any{"subtype": "can_use_tool", "tool_name": "Read", "input": map[string]any{"file_path": "test.md"}}})
			var reply map[string]any
			if dec.Decode(&reply) != nil {
				os.Exit(11)
			}
			r, _ := reply["response"].(map[string]any)
			if reply["type"] != "control_response" || r["request_id"] != "permission-1" {
				os.Exit(12)
			}
		}
		if strings.HasPrefix(content, "wait:") {
			p := strings.TrimPrefix(content, "wait:")
			for n := 0; n < 200; n++ {
				if _, err := os.Stat(p); err == nil {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
		}
		_ = enc.Encode(map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": []any{}}, "observed": map[string]any{"route": mode, "pid": os.Getpid(), "session_id": sid, "resume": argValue(args, "--resume"), "content": content, "initialized": initialized}})
		_ = enc.Encode(map[string]any{"type": "result", "subtype": "success", "session_id": sid, "is_error": false})
		if os.Getenv("MIRASIM_TEST_EXIT_AFTER_RESULT") == "1" {
			return
		}
	}
}

type fixture struct{ home, index, sid, cwd string }

func newFixture(t *testing.T, route string) fixture {
	t.Helper()
	h := t.TempDir()
	f := fixture{home: h, cwd: filepath.Join(h, "work"), sid: "12345678-1234-4234-8234-123456789abc", index: filepath.Join(h, ".mirasim", "plugin-index", "workspace.json")}
	if err := os.MkdirAll(f.cwd, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(f.index), 0700); err != nil {
		t.Fatal(err)
	}
	f.route(t, route)
	r := filepath.Join(h, ".mirasim", "sessions", "claude", f.sid, "record.json")
	if err := os.MkdirAll(filepath.Dir(r), 0700); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(map[string]any{"agent": "claude", "sessionId": f.sid, "nativeSessionId": f.sid, "workdir": f.cwd, "workspacePath": f.cwd, "runState": "completed"})
	if err := os.WriteFile(r, b, 0600); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f fixture) route(t *testing.T, route string) {
	t.Helper()
	r := map[string]string{}
	if route != "" {
		r["claude:"+f.sid] = route
	}
	b, _ := json.Marshal(map[string]any{"routes": r, "keys": []string{"claude:" + f.sid}})
	if err := os.WriteFile(f.index, b, 0600); err != nil {
		t.Fatal(err)
	}
}

type app struct {
	cmd      *exec.Cmd
	in       io.WriteCloser
	frames   chan map[string]any
	ended    chan error
	errFile  *os.File
	received []map[string]any
}

func startApp(t *testing.T, f fixture, extraEnv ...string) *app {
	return startAppSettings(t, f, `{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:12345/synthetic","ANTHROPIC_AUTH_TOKEN":"synthetic-only","KEEP_ME":"yes"}}`, extraEnv...)
}

func startAppSettings(t *testing.T, f fixture, settings string, extraEnv ...string) *app {
	t.Helper()
	self, _ := os.Executable()
	c := exec.Command(testLauncher, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--model", "claude-sonnet-5", "--session-id", f.sid, "--settings", settings)
	c.Dir = f.cwd
	c.Env = append(os.Environ(), "HOME="+f.home, "USERPROFILE="+f.home, "LOCALAPPDATA="+filepath.Join(f.home, "cache"), "RECLAUDE_MIRASIM_TARGET="+self, "MIRASIM_LAUNCHER_TEST_CHILD=1", "ANTHROPIC_BASE_URL=http://127.0.0.1:12345/synthetic", "ANTHROPIC_AUTH_TOKEN=synthetic-only")
	c.Env = append(c.Env, extraEnv...)
	in, err := c.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := c.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	ef, err := os.Create(filepath.Join(f.home, "stderr"))
	if err != nil {
		t.Fatal(err)
	}
	c.Stderr = ef
	a := &app{cmd: c, in: in, frames: make(chan map[string]any, 32), ended: make(chan error, 1), errFile: ef}
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		scan := bufio.NewScanner(out)
		scan.Buffer(make([]byte, 4096), 8<<20)
		for scan.Scan() {
			var x map[string]any
			if json.Unmarshal(scan.Bytes(), &x) == nil {
				a.frames <- x
			}
		}
		close(a.frames)
		a.ended <- c.Wait()
		close(a.ended)
	}()
	t.Cleanup(func() {
		_ = in.Close()
		select {
		case <-a.ended:
		case <-time.After(3 * time.Second):
			_ = c.Process.Kill()
		}
		_ = ef.Close()
	})
	return a
}

func TestCloudMissingInjectionNeverStartsReclaude(t *testing.T) {
	for _, settings := range []string{`{}`, `{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com","ANTHROPIC_AUTH_TOKEN":"custom"}}`, `{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:12345/synthetic"}}`, `null`} {
		t.Run(settings, func(t *testing.T) {
			f := newFixture(t, "cloud")
			p := filepath.Join(f.home, "invoked")
			a := startAppSettings(t, f, settings, "MIRASIM_TEST_INVOKED="+p)
			a.user(t, "must-not-send")
			_ = a.in.Close()
			select {
			case err := <-a.ended:
				if err == nil {
					t.Fatal("缺少平台注入仍报告成功")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("缺少平台注入未明确失败")
			}
			if _, err := os.Stat(p); !os.IsNotExist(err) {
				t.Fatal("平台注入不成立仍启动了 reclaude")
			}
		})
	}
}

func (a *app) send(t *testing.T, f map[string]any) {
	t.Helper()
	b, _ := json.Marshal(f)
	if _, err := a.in.Write(append(b, '\n')); err != nil {
		t.Fatal(err)
	}
}
func (a *app) user(t *testing.T, content string) {
	a.send(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": content}})
}
func (a *app) until(t *testing.T, typ string) map[string]any {
	t.Helper()
	for {
		select {
		case f, ok := <-a.frames:
			if !ok {
				b, _ := os.ReadFile(a.errFile.Name())
				t.Fatalf("执行体提前退出：%s", b)
			}
			a.received = append(a.received, f)
			if f["type"] == typ {
				return f
			}
		case <-time.After(5 * time.Second):
			t.Fatal("等协议帧超时")
		}
	}
}
func (a *app) turn(t *testing.T, text string) map[string]any {
	a.user(t, text)
	x := a.until(t, "assistant")
	a.until(t, "result")
	return x["observed"].(map[string]any)
}

func TestSwitchBothDirectionsKeepsNativeSession(t *testing.T) {
	f := newFixture(t, "local")
	a := startApp(t, f)
	x := a.turn(t, "first")
	if x["route"] != "local" {
		t.Fatal(x)
	}
	f.route(t, "cloud")
	y := a.turn(t, "second")
	if y["route"] != "cloud" || y["pid"] == x["pid"] || y["session_id"] != f.sid || y["resume"] != f.sid {
		t.Fatalf("切平台须恢复同一会话的新进程：%v", y)
	}
	f.route(t, "local")
	z := a.turn(t, "third")
	if z["route"] != "local" || z["pid"] == y["pid"] || z["session_id"] != f.sid {
		t.Fatal(z)
	}
}

// 会话是以自有额度起的（Mirasim 没给平台网关）：当场切平台做不到，必须明说，
// 不能悄悄仍走自有、也不能把整个会话杀掉；切回自有后同一个进程继续用。
func TestSwitchToPlatformWithoutLiveGatewayRefusesLoudlyAndKeepsSession(t *testing.T) {
	f := newFixture(t, "local")
	p := filepath.Join(f.home, "invoked")
	a := startAppSettings(t, f, `{"env":{"KEEP_ME":"yes"}}`, "MIRASIM_TEST_INVOKED="+p)
	x := a.turn(t, "first")
	if x["route"] != "local" {
		t.Fatal(x)
	}
	if err := os.Remove(p); err != nil {
		t.Fatal(err)
	}
	f.route(t, "cloud")
	a.user(t, "must-not-send")
	r := a.until(t, "result")
	text, _ := r["result"].(string)
	if r["is_error"] != true || !strings.Contains(text, "平台") || !strings.Contains(text, "办法") {
		t.Fatalf("切不过去必须明确报错并说办法：%v", r)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("切平台被拒后仍启动了新进程")
	}
	f.route(t, "local")
	z := a.turn(t, "third")
	if z["route"] != "local" || z["pid"] != x["pid"] {
		t.Fatalf("被拒后会话进程应原样保留：%v", z)
	}
}

func TestRouteReadFailureNeverStartsTarget(t *testing.T) {
	for _, kind := range []string{"corrupt", "missing", "unknown"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t, "local")
			switch kind {
			case "corrupt":
				_ = os.WriteFile(f.index, []byte("{broken"), 0600)
			case "missing":
				_ = os.Remove(f.index)
			case "unknown":
				f.route(t, "nonsense")
			}
			p := filepath.Join(f.home, "invoked")
			a := startApp(t, f, "MIRASIM_TEST_INVOKED="+p)
			a.user(t, "must-not-send")
			_ = a.in.Close()
			select {
			case err := <-a.ended:
				if err == nil {
					t.Fatal("读取失败却返回成功")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("读取失败没退出")
			}
			if _, err := os.Stat(p); !os.IsNotExist(err) {
				t.Fatal("选路没查成仍启动了目标")
			}
		})
	}
}

func TestNoOverridePreservesMirasimDefault(t *testing.T) {
	f := newFixture(t, "")
	a := startApp(t, f)
	if x := a.turn(t, "default"); x["route"] != "cloud" {
		t.Fatalf("未指定不能擅自剥网关：%v", x)
	}
}

func TestUnmarkedProxyWithoutCredentialStripsToOwn(t *testing.T) {
	f := newFixture(t, "")
	a := startAppSettings(t, f, `{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:12345/synthetic","KEEP_ME":"yes"}}`)
	x := a.turn(t, "own")
	if x["route"] != "local" {
		t.Fatalf("未标且没有平台令牌应剥掉本机代理、走自有：%v", x)
	}
}

func TestInitializationReplayedWithoutDuplicateHostReply(t *testing.T) {
	f := newFixture(t, "local")
	a := startApp(t, f, "MIRASIM_TEST_REQUIRE_INIT=1")
	a.send(t, map[string]any{"type": "control_request", "request_id": "host-init", "request": map[string]any{"subtype": "initialize", "hooks": map[string]any{}}})
	a.until(t, "control_response")
	_ = a.turn(t, "first")
	f.route(t, "cloud")
	x := a.turn(t, "second")
	if x["initialized"] != true || x["route"] != "cloud" {
		t.Fatal(x)
	}
	n := 0
	for _, f := range a.received {
		if f["type"] == "control_response" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("初始化响应重复泄漏给宿主：%d", n)
	}
}

func TestBusySwitchWaitsForResultBeforeForwardingNextUser(t *testing.T) {
	f := newFixture(t, "local")
	release := filepath.Join(f.home, "release")
	a := startApp(t, f)
	a.user(t, "wait:"+release)
	a.until(t, "system")
	f.route(t, "cloud")
	a.user(t, "next")
	select {
	case x := <-a.frames:
		t.Fatalf("在途回合被提前推进：%v", x)
	case <-time.After(100 * time.Millisecond):
	}
	_ = os.WriteFile(release, []byte("go"), 0600)
	x := a.until(t, "assistant")["observed"].(map[string]any)
	a.until(t, "result")
	y := a.until(t, "assistant")["observed"].(map[string]any)
	a.until(t, "result")
	if x["route"] != "local" || y["route"] != "cloud" || x["pid"] == y["pid"] {
		t.Fatalf("来源与回合边界不符：%v %v", x, y)
	}
}

func TestHardKilledSupervisorLeavesNoTargetOrGrandchild(t *testing.T) {
	f := newFixture(t, "local")
	p := filepath.Join(f.home, "grandchild.pid")
	a := startApp(t, f, "MIRASIM_TEST_GRANDCHILD_PID="+p)
	x := a.turn(t, "first")
	target := int(x["pid"].(float64))
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var grandchild int
	if _, err := fmt.Sscan(string(b), &grandchild); err != nil {
		t.Fatal(err)
	}
	if !testProcessAlive(target) || !testProcessAlive(grandchild) {
		t.Fatal("测试前子进程没有真的活着")
	}
	if err := a.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !testProcessAlive(target) && !testProcessAlive(grandchild) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("父进程被强杀后仍留下执行体或子孙")
}

func TestVersionIdentifiesPlatformWithoutStartingReclaude(t *testing.T) {
	f := newFixture(t, "local")
	p := filepath.Join(f.home, "invoked")
	self, _ := os.Executable()
	c := exec.Command(testLauncher, "--fleet-version")
	c.Env = append(os.Environ(), "RECLAUDE_MIRASIM_TARGET="+self, "MIRASIM_LAUNCHER_TEST_CHILD=1", "MIRASIM_TEST_INVOKED="+p)
	b, err := c.Output()
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	if json.Unmarshal(b, &v) != nil {
		t.Fatal("版本输出不是 JSON")
	}
	if v["platform"] != runtime.GOOS || v["arch"] != runtime.GOARCH || v["name"] != "fleet-mirasim-reclaude" {
		t.Fatalf("迁移器无法确认产物架构：%v", v)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("查启动器版本却启动了 reclaude")
	}
}

func TestDoctorChecksTargetWithoutLaunchingIt(t *testing.T) {
	f := newFixture(t, "local")
	self, _ := os.Executable()
	p := filepath.Join(f.home, "invoked")
	c := exec.Command(testLauncher, "--fleet-doctor")
	c.Env = append(os.Environ(), "RECLAUDE_MIRASIM_TARGET="+self, "MIRASIM_LAUNCHER_TEST_CHILD=1", "MIRASIM_TEST_INVOKED="+p)
	b, err := c.Output()
	if err != nil {
		t.Fatal(err)
	}
	var d map[string]any
	if json.Unmarshal(b, &d) != nil || d["status"] != "ready" {
		t.Fatalf("只读诊断未返回明确状态：%q", b)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("诊断时启动了目标")
	}
	c = exec.Command(testLauncher, "--fleet-doctor")
	c.Env = append(os.Environ(), "RECLAUDE_MIRASIM_TARGET="+filepath.Join(f.home, "missing-target"))
	if c.Run() == nil {
		t.Fatal("目标不存在却报诊断成功")
	}
}

func TestNormalTargetExitNextTurnResumesInsteadOfRecreating(t *testing.T) {
	f := newFixture(t, "local")
	a := startApp(t, f, "MIRASIM_TEST_EXIT_AFTER_RESULT=1")
	_ = a.turn(t, "first")
	time.Sleep(100 * time.Millisecond)
	x := a.turn(t, "second")
	if x["resume"] != f.sid {
		t.Fatalf("正常退出后的下一回合没有 resume：%v", x)
	}
}

func TestControlAfterTargetExitRestoresInitializationAndNativeSession(t *testing.T) {
	f := newFixture(t, "local")
	a := startApp(t, f, "MIRASIM_TEST_EXIT_AFTER_RESULT=1", "MIRASIM_TEST_REQUIRE_INIT=1")
	a.send(t, map[string]any{"type": "control_request", "request_id": "host-init", "request": map[string]any{"subtype": "initialize"}})
	a.until(t, "control_response")
	_ = a.turn(t, "first")
	time.Sleep(150 * time.Millisecond)
	a.send(t, map[string]any{"type": "control_request", "request_id": "host-model", "request": map[string]any{"subtype": "set_model", "model": "claude-sonnet-5"}})
	a.until(t, "control_response")
	if x := a.turn(t, "second"); x["resume"] != f.sid || x["initialized"] != true {
		t.Fatal(x)
	}
}

func TestOneShotInputEOFPreservesOutputAndExitCode(t *testing.T) {
	self, _ := os.Executable()
	c := exec.Command(testLauncher, "--version")
	c.Env = append(os.Environ(), "RECLAUDE_MIRASIM_TARGET="+self, "MIRASIM_LAUNCHER_TEST_CHILD=1", "MIRASIM_TEST_ROLE=once")
	out, err := c.Output()
	ee, ok := err.(*exec.ExitError)
	if !ok || ee.ExitCode() != 23 || string(out) != "version-probe-output" {
		t.Fatalf("stdin EOF 被误当成要杀目标：out=%q err=%v", out, err)
	}
}

// Mirasim 把启动命令当 claude 本体：探版本跑「启动命令 --version」，升级跑「启动命令 update」。
// 两条都得原样交给 reclaude，版本才是 reclaude 背后那份 claude 的，升级才走 reclaude 自己的命令。
func TestMirasimVersionProbeAndSelfUpdateReachReclaudeUnchanged(t *testing.T) {
	self, _ := os.Executable()
	for _, args := range [][]string{{"--version"}, {"update"}} {
		c := exec.Command(testLauncher, args...)
		c.Env = append(os.Environ(), "RECLAUDE_MIRASIM_TARGET="+self, "MIRASIM_LAUNCHER_TEST_CHILD=1", "MIRASIM_TEST_ROLE=argv")
		out, err := c.Output()
		if err != nil {
			t.Fatalf("%v：启动器没把命令交给 reclaude：%v", args, err)
		}
		var got []string
		if json.Unmarshal(out, &got) != nil || strings.Join(got, " ") != strings.Join(args, " ") {
			t.Fatalf("%v 到 reclaude 时变成了 %q", args, out)
		}
	}
}

func TestPermissionRequestsRoundTripAcrossRestart(t *testing.T) {
	f := newFixture(t, "local")
	a := startApp(t, f)
	for _, route := range []string{"local", "cloud"} {
		f.route(t, route)
		a.user(t, "permission")
		q := a.until(t, "control_request")
		a.send(t, map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": q["request_id"], "response": map[string]any{"behavior": "allow", "updatedInput": map[string]any{}}}})
		x := a.until(t, "assistant")["observed"].(map[string]any)
		a.until(t, "result")
		if x["route"] != route {
			t.Fatal(x)
		}
	}
}
