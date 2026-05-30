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
```

## Configuration

Pilingual currently supports OpenAI-compatible chat completion APIs.

```bash
export PILINGUAL_PROVIDER=openai-compatible
export PILINGUAL_API_KEY=...
export PILINGUAL_BASE_URL=https://opencode.ai/zen/go/v1
export PILINGUAL_MODEL=deepseek-v4-flash
export PILINGUAL_MAX_CHARS=8000
```

Set `PILINGUAL_MAX_CHARS=0` to disable the length limit.

Do not commit API keys.
