# Pilingual

Pilingual is a pi extension that translates assistant responses and renders the original and translation side by side in the TUI. It defaults to English-to-Spanish, and the target language can be changed.

## Install

Install dependencies for local development:

```bash
npm install
```

Copy the extension into your global pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp extensions/pilingual.ts ~/.pi/agent/extensions/pilingual.ts
```

Then restart pi or run:

```text
/reload
```

## Usage

```text
/pilingual
/pilingual on
/pilingual off
/pilingual status
/pilingual provider
/pilingual provider <provider>
/pilingual model
/pilingual model <provider/model>
/pilingual language
/pilingual language <language>
```

`/pilingual` with no arguments prints current status plus usage.

## Configuration

Pilingual currently translates through OpenAI-compatible chat completion APIs.
It can use pi's configured model registry, so users who already have providers
configured through pi can select one interactively:

```text
/pilingual provider
/pilingual provider openai
/pilingual model
/pilingual model openai/gpt-4.1-mini
/pilingual language
/pilingual language French
```

Only available `openai-completions` models are offered, because that is the
adapter Pilingual currently knows how to call.
Running `/pilingual provider`, `/pilingual model`, or `/pilingual language` with
no argument opens a TUI selector.

For a manual fallback endpoint, set:

```bash
export PILINGUAL_ADAPTER=openai-compatible
export PILINGUAL_API_KEY=...
export PILINGUAL_BASE_URL=https://opencode.ai/zen/go/v1
export PILINGUAL_MODEL=deepseek-v4-flash
export PILINGUAL_TARGET_LANGUAGE=Spanish
export PILINGUAL_MAX_CHARS=8000
```

Optionally set `PILINGUAL_PROVIDER=<pi-provider-id>` and `PILINGUAL_MODEL=<model-id>` to pick a pi registry model at startup.

Set `PILINGUAL_MAX_CHARS=0` to disable the length limit.

The target language defaults to Spanish. Use `/pilingual language` to change it
for the current session, or set `PILINGUAL_TARGET_LANGUAGE` as the startup
default.

Do not commit API keys.
