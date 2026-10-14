package main

import (
	"os"
	"testing"
)

// 对账靠 event=launch 里的 gateway 词判断这次实际走哪份额度，三种取值都要钉住。
func TestApplyRouteSettingsReportsGatewayWord(t *testing.T) {
	gw := `{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:12345/synthetic","ANTHROPIC_AUTH_TOKEN":"synthetic-only"}}`
	gwEnv := []string{"ANTHROPIC_BASE_URL=http://127.0.0.1:12345/synthetic", "ANTHROPIC_AUTH_TOKEN=synthetic-only"}
	cases := []struct {
		name, mode string
		args, env  []string
		want       string
	}{
		{"自有剥掉 settings 里的回环网关", "local", []string{"--settings", gw}, nil, "stripped"},
		{"自有只在环境里有网关也算剥掉", "local", nil, gwEnv, "stripped"},
		{"自有本来就没有网关", "local", []string{"--model", "x"}, []string{"PATH=/bin"}, "none"},
		{"平台保留网关", "cloud", []string{"--settings", gw}, nil, "kept"},
		{"未标路由且有平台令牌：保留", "default", []string{"--settings", gw}, nil, "kept"},
		{"非模型调用没有网关", "gateway", []string{"--version"}, nil, "none"},
		{"非模型调用带着网关原样交出", "gateway", nil, gwEnv, "kept"},
	}
	for _, c := range cases {
		_, _, temps, word, err := applyRouteSettings(c.mode, c.args, c.env)
		for _, p := range temps {
			_ = os.Remove(p)
		}
		if err != nil {
			t.Fatalf("%s：%v", c.name, err)
		}
		if word != c.want {
			t.Fatalf("%s：gateway=%s，应为 %s", c.name, word, c.want)
		}
	}
}
