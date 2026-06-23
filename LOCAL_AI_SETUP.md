# Local AI Setup

The bot is configured for LM Studio.

## Recommended Model

Best pick from your installed models for this bot:

```text
C:\Users\jonar\.lmstudio\models\mradermacher\TildeOpen-30b-ENLV-Unsloth-instruct-GGUF\TildeOpen-30b-ENLV-Unsloth-instruct.IQ4_XS.gguf
```

Why this one:

- it is the 30B instruct model you mentioned
- better fit for reasoning/planning than the tiny models
- smaller and more practical than the 19 GB Mixtral file
- less chaotic for a teammate bot than the aggressive uncensored models

Fast fallback if the 30B feels too slow:

```text
C:\Users\jonar\.lmstudio\models\DavidAU\Qwen3-18B-A3B-Stranger-Thoughts-Abliterated-Uncensored-GGUF\Qwen3-18B-A3B-Stranger-Thoughts-Abliterated-Uncensored-D_AU-Q4_k_s.gguf
```

## Start LM Studio

Fastest way on Windows:

```cmd
cd /d C:\Users\jonar\Desktop\mc-ai-bot
npm run llm:smart
```

That unloads the tiny 1B model and loads:

```text
tildeopen-30b-enlv-unsloth-instruct
```

with 4096 context, 1 parallel request, and a 1 hour idle timeout.

Manual way:

1. Open LM Studio.
2. Load the recommended 30B model.
3. Use 4096 context if the default fails.
4. Set parallel to 1.
5. Open the local server / developer tab.
6. Start the OpenAI-compatible server.
7. Make sure it runs at:

```text
http://127.0.0.1:1234
```

## Bot Config

`config.json` is already set to:

```json
"ai": {
  "enabled": true,
  "provider": "lmstudio",
  "endpoint": "http://127.0.0.1:1234/v1/chat/completions",
  "model": "tildeopen-30b-enlv-unsloth-instruct"
}
```

The bot is pinned to the 30B model so it does not silently use `gemma-3-1b-it-qat`.

The 30B is slow. `config.json` uses a 90 second timeout so the bot waits long enough for real answers.

## Test In Minecraft

```text
!llmStatus
!chat what should we do next?
bot should I mine or build first?
!remember diamonds should be mined with !prospect diamond 3 250
```

If LM Studio is closed, the bot still starts. It falls back to simple built-in replies.
