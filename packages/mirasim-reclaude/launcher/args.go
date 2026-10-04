package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"strings"
)

func workspaceIndexName(workspace string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(workspace)) + ".json"
}

func gatewayFacts(args []string) (loopback bool, credential bool, err error) {
	env := map[string]any{}
	for i := 0; i < len(args); i++ {
		val := ""
		if args[i] == "--settings" {
			if i+1 >= len(args) {
				return false, false, fmt.Errorf("--settings 缺参数")
			}
			i++
			val = args[i]
		} else if strings.HasPrefix(args[i], "--settings=") {
			val = strings.TrimPrefix(args[i], "--settings=")
		} else {
			continue
		}
		raw := []byte(val)
		if !strings.HasPrefix(strings.TrimSpace(val), "{") {
			var readErr error
			raw, readErr = os.ReadFile(val)
			if readErr != nil {
				return false, false, fmt.Errorf("网关 settings 文件读失败，未发送请求")
			}
		}
		_, values, docErr := settingsDocument(raw)
		if docErr != nil {
			return false, false, docErr
		}
		for k, v := range values {
			env[k] = v
		}
	}
	base, _ := env["ANTHROPIC_BASE_URL"].(string)
	auth, _ := env["ANTHROPIC_AUTH_TOKEN"].(string)
	key, _ := env["ANTHROPIC_API_KEY"].(string)
	return isLoopbackURL(base), strings.TrimSpace(auth) != "" || strings.TrimSpace(key) != "", nil
}

func verifyGatewaySettings(args []string) error {
	loopback, credential, err := gatewayFacts(args)
	if err != nil {
		return err
	}
	if !loopback || !credential {
		return fmt.Errorf("平台网关注入缺失或不完整，拒绝回落到自有，未发送请求")
	}
	return nil
}

// 会话进程是以自有额度起的时候，Mirasim 没把平台网关地址和令牌交给启动器；
// 启动器自己编不出来，所以「当场切平台」做不到。必须明说原因和办法，不能让会话悄悄死掉或悄悄仍走自有。
const platformSwitchRefusal = "这个会话的进程是以自有额度启动的，启动参数里没有平台网关，当场切不到平台额度，这条消息没有发出，仍在用自有额度。办法：在 Mirasim 里确认该会话已选「平台」，然后重新发送这条消息；还不行就新开一个会话，或重启这个会话的进程。"

func rewriteArgs(in []string) (out []string, temps []string, changed bool, err error) {
	out = append([]string(nil), in...)
	defer func() {
		if err != nil {
			for _, p := range temps {
				_ = os.Remove(p)
			}
			temps = nil
		}
	}()
	for i := 0; i < len(out); i++ {
		val, j, equal := "", i, false
		if out[i] == "--settings" {
			if i+1 >= len(out) {
				return nil, temps, false, fmt.Errorf("--settings 缺参数")
			}
			i++
			j = i
			val = out[i]
		} else if strings.HasPrefix(out[i], "--settings=") {
			equal = true
			val = strings.TrimPrefix(out[i], "--settings=")
		} else {
			continue
		}
		raw := []byte(val)
		inline := strings.HasPrefix(strings.TrimSpace(val), "{")
		if !inline {
			raw, err = os.ReadFile(val)
			if err != nil {
				return nil, temps, false, fmt.Errorf("settings 文件读失败，未启动执行体")
			}
		}
		data, did, e := stripSettings(raw)
		if e != nil {
			return nil, temps, false, fmt.Errorf("settings JSON 格式错误，未启动执行体")
		}
		if !did {
			continue
		}
		next := string(data)
		if !inline {
			f, e := os.CreateTemp("", "fleet-mirasim-settings-*.json")
			if e != nil {
				return nil, temps, false, fmt.Errorf("创建临时 settings 失败")
			}
			temps = append(temps, f.Name())
			if _, e = f.Write(data); e != nil {
				_ = f.Close()
				return nil, temps, false, fmt.Errorf("写临时 settings 失败")
			}
			if e = f.Close(); e != nil {
				return nil, temps, false, fmt.Errorf("关闭临时 settings 失败")
			}
			next = f.Name()
		}
		if equal {
			out[j] = "--settings=" + next
		} else {
			out[j] = next
		}
		changed = true
	}
	return out, temps, changed, nil
}

func resumeArgs(in []string, native string) ([]string, error) {
	if !safeID(native) {
		return nil, fmt.Errorf("没有确认原生会话 ID，不能切换执行进程")
	}
	out := []string{}
	for i := 0; i < len(in); i++ {
		a := in[i]
		if a == "--session-id" || a == "--resume" || a == "-r" || a == "--resume-session-at" {
			if i+1 >= len(in) {
				return nil, fmt.Errorf("会话参数缺值")
			}
			i++
			continue
		}
		if a == "--continue" || a == "-c" || a == "--fork-session" {
			continue
		}
		if strings.HasPrefix(a, "--session-id=") || strings.HasPrefix(a, "--resume=") || strings.HasPrefix(a, "--resume-session-at=") {
			continue
		}
		out = append(out, a)
	}
	return append(out, "--resume", native), nil
}
