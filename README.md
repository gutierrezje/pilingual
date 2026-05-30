# Pilingual

Pilingual is a pi extension that translates assistant responses from English to Spanish and renders the original and translation side by side in the TUI.

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
/pilingual on
/pilingual off
/pilingual status
/pilingual provider
/pilingual provider <provider>
/pilingual provider <number>
/pilingual model
/pilingual model <provider/model>
/pilingual model <number>
```

## Configuration

Pilingual currently translates through OpenAI-compatible chat completion APIs.
It can use pi's configured model registry, so users who already have providers
configured through pi can select one interactively:

```text
/pilingual provider
/pilingual provider openai
/pilingual provider 1
/pilingual model
/pilingual model openai/gpt-4.1-mini
/pilingual model 2
```

Only available `openai-completions` models are offered, because that is the
adapter Pilingual currently knows how to call.
Running `/pilingual provider` or `/pilingual model` with no argument opens a
TUI selector. Numbered arguments select from the same filtered list shown in
the selector.

For a manual fallback endpoint, set:

```bash
export PILINGUAL_ADAPTER=openai-compatible
export PILINGUAL_API_KEY=...
export PILINGUAL_BASE_URL=https://opencode.ai/zen/go/v1
export PILINGUAL_MODEL=deepseek-v4-flash
export PILINGUAL_MAX_CHARS=8000
```

Optionally set `PILINGUAL_PROVIDER=<pi-provider-id>` and `PILINGUAL_MODEL=<model-id>` to pick a pi registry model at startup.

Set `PILINGUAL_MAX_CHARS=0` to disable the length limit.

Do not commit API keys.
