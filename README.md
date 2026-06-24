# pi-deepseek-balance

DeepSeek API balance monitor extension for [pi coding agent](https://github.com/earendil-works/pi-mono).

Displays DeepSeek account balance in pi's footer in real time. Also provides a `/deepseek` command and `deepseek_usage` tool for balance checks.

## Features

- **Footer integration**: Replaces pi's footer with token stats + `¥9.44` balance with exclamation mark alerts for low balance
- **`/deepseek` command**: Detailed balance view (total / granted / topped-up / availability)
- **`deepseek_usage` tool**: Proactively check remaining balance before expensive operations
- **Auto-activates**: Only takes over the footer when using a deepseek provider model — doesn't affect other providers
- **No login needed**: Reads API key from `auth.json` automatically

## Install

```bash
pi install git:github.com/inouemoby/pi-deepseek-balance
```

Or via `settings.json`:

```json
{
  "packages": ["https://github.com/inouemoby/pi-deepseek-balance.git"]
}
```

## Setup

Add your DeepSeek API key to `~/.pi/agent/auth.json`:

```json
{
  "deepseek": {
    "type": "api_key",
    "key": "sk-your-key-here"
  }
}
```

Or set via environment variable:

```bash
export DEEPSEEK_API_KEY="sk-your-key-here"
```

Get your API key from [platform.deepseek.com](https://platform.deepseek.com/api_keys).

## Commands

| Command | Description |
|---------|-------------|
| `/deepseek` | Show detailed balance (total / granted / topped-up / status) |

## Footer Display

When using a DeepSeek model, the footer shows:

```
↑3.2k ↓1.1k 12.5%/128k (auto) ¥9.44    (deepseek) deepseek-chat • medium
```

- `¥9.44` — remaining balance in CNY (or `$` for USD)
- `!` = balance below 5, `!!` = balance below 1 or insufficient

## Tool: deepseek_usage

The extension also registers a `deepseek_usage` tool that the AI can call:

```
Check DeepSeek API remaining balance
```

## API

Fetches balance from `https://api.deepseek.com/user/balance` using your API key as Bearer authentication. Prefers CNY, falls back to USD.

## Related

- [pi-ollama-usage](https://github.com/inouemoby/pi-ollama-usage) — Same tool for Ollama Cloud
- [pi-zai-usage](https://github.com/inouemoby/pi-zai-usage) — Same tool for ZAI (智谱/bigmodel.cn)

## License

MIT
