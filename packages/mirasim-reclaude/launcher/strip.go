package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"
)

// Mirasim 把平台网关 ANTHROPIC_BASE_URL=http://127.0.0.1:<端口>/<会话令牌> 交给 claude，
// 注入平台网关时写进 `--settings` 的 env 块（0.0.354 起），也可能经进程 env 传，两处都要看、都要剥。
// reclaude 只清进程 env，清不到 settings ⇒ claude 把请求交给 Mirasim 本地网关，
// 网关再以 Mirasim.exe 身份转发，reclaude 服务端判 non_cc_client 拒掉（还会上报，有设备解绑风险）。
// 剥掉这三个键，claude 就回落到 ~/.claude/settings.json 的 reclaude 代理 + OAuth 占位令牌。
var injectedKeys = []string{"ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"}

// 只剥指向本机回环的 BASE_URL（= Mirasim 网关）；指向别处的是人有意配的上游，不碰。
func isLoopbackURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "127.0.0.1", "localhost", "::1":
		return true
	}
	return false
}

// stripSettings 返回剥过的 settings JSON；changed=false 时原样返回 in。
func settingsDocument(in []byte) (map[string]any, map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(in))
	dec.UseNumber()
	var doc map[string]any
	if err := dec.Decode(&doc); err != nil {
		return nil, nil, fmt.Errorf("settings 不是 JSON 对象")
	}
	if doc == nil {
		return nil, nil, fmt.Errorf("settings 不能为空")
	}
	var tail any
	if dec.Decode(&tail) != io.EOF {
		return nil, nil, fmt.Errorf("settings 有额外内容")
	}
	if _, found := doc["env"]; !found {
		return doc, nil, nil
	}
	env, ok := doc["env"].(map[string]any)
	if !ok {
		return nil, nil, fmt.Errorf("settings env 不是对象")
	}
	for _, value := range env {
		if _, ok := value.(string); !ok {
			return nil, nil, fmt.Errorf("settings env 值不是字符串")
		}
	}
	return doc, env, nil
}

func stripSettings(in []byte) (out []byte, changed bool, err error) {
	return stripSettingsWhen(in, false)
}

// stripSettingsKeys 不再看 settings 自己的 BASE_URL：要不要剥由 gatewayFacts 合并进程环境和 settings 后判定，
// 判定要剥就把注入键全剥（地址和令牌可能分处两地，只剥一处会把 Mirasim 令牌留给 reclaude）。
func stripSettingsKeys(in []byte) (out []byte, changed bool, err error) {
	return stripSettingsWhen(in, true)
}

func stripSettingsWhen(in []byte, all bool) (out []byte, changed bool, err error) {
	doc, env, err := settingsDocument(in)
	if err != nil {
		return in, false, err
	}
	if env == nil {
		return in, false, nil
	}
	if !all {
		base, _ := env["ANTHROPIC_BASE_URL"].(string)
		if !isLoopbackURL(base) {
			return in, false, nil
		}
	}
	for _, k := range injectedKeys {
		if _, ok := env[k]; ok {
			delete(env, k)
			changed = true
		}
	}
	if !changed {
		return in, false, nil
	}
	out, err = json.Marshal(doc)
	if err != nil {
		return in, false, err
	}
	return out, true, nil
}

// stripEnv 按同一判据清进程 env（Windows 上变量名不分大小写）。
func stripEnv(environ []string) (out []string, changed bool) {
	for _, kv := range environ {
		if i := strings.IndexByte(kv, '='); i > 0 && strings.EqualFold(kv[:i], "ANTHROPIC_BASE_URL") && isLoopbackURL(kv[i+1:]) {
			return stripEnvKeys(environ)
		}
	}
	return environ, false
}

// stripEnvKeys 无条件剥掉注入键，判定见 stripSettingsKeys。
func stripEnvKeys(environ []string) (out []string, changed bool) {
	for _, kv := range environ {
		i := strings.IndexByte(kv, '=')
		drop := false
		if i > 0 {
			for _, k := range injectedKeys {
				if strings.EqualFold(kv[:i], k) {
					drop = true
				}
			}
		}
		if drop {
			changed = true
		} else {
			out = append(out, kv)
		}
	}
	if !changed {
		return environ, false
	}
	return out, true
}
