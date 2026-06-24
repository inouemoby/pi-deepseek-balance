# deepseek-usage

DeepSeek API 余额监控插件，用于 [pi 编码助手](https://github.com/earendil-works/pi-coding-agent)。

在 footer 实时显示 DeepSeek 账户剩余余额，支持 `/ds` 命令和 `deepseek_usage` 工具查询。

## 功能

- **Footer 显示**：使用 DeepSeek 模型时，footer 自动显示剩余余额（如 `DS:9.44CNY`）
- **`/ds` 命令**：快速查看完整余额明细（总额 / 赠送 / 充值 / 可用状态）
- **`deepseek_usage` 工具**：供 AI agent 调用查询余额
- **自动刷新**：每 60 秒缓存，agent 结束后自动更新
- **多币种**：优先显示 CNY，回退到 USD

## 安装

```bash
pi install git:github.com/inouemoby/deepseek-usage
```

## 配置

API key 从 `~/.pi/agent/auth.json` 读取：

```json
{
  "deepseek": {
    "type": "api_key",
    "key": "sk-your-key-here"
  }
}
```

或通过环境变量 `DEEPSEEK_API_KEY`。

## 使用

| 方式 | 说明 |
|------|------|
| Footer | 使用 deepseek 模型时自动显示 |
| `/ds` | 查看完整余额明细 |
| `deepseek_usage` 工具 | AI agent 调用 |

余额低于 1 时显示 `⚠`，余额不足时显示 `⚠⚠`。
