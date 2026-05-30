/**
 * Pilingual Extension — English → Spanish side-by-side rendering
 *
 * Intercepts every assistant response, translates the text content to Spanish
 * via the OpenCode GO subscription (OpenAI-compatible endpoint), and renders
 * both versions in a side-by-side layout inside the TUI.
 *
 * Environment variables:
 *   PILINGUAL_ADAPTER    – API adapter (default: openai-compatible)
 *   PILINGUAL_PROVIDER   – pi provider ID to use, or manual fallback provider name
 *   PILINGUAL_API_KEY    – Manual fallback API key
 *   PILINGUAL_BASE_URL   – Manual fallback base URL (default: https://opencode.ai/zen/go/v1)
 *   PILINGUAL_MODEL      – pi model ID or manual fallback model ID (default: deepseek-v4-flash)
 *   PILINGUAL_MAX_CHARS  – Skip translation above this length; 0 means no limit (default: 8000)
 *
 * Commands:
 *   /pilingual on|off|status|provider|model
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Markdown,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

// ─── Configuration ───────────────────────────────────────────────────────────

const PILINGUAL_ADAPTER =
  process.env.PILINGUAL_ADAPTER ?? "openai-compatible";
const PILINGUAL_PROVIDER = process.env.PILINGUAL_PROVIDER;
const PILINGUAL_BASE_URL =
  process.env.PILINGUAL_BASE_URL ?? "https://opencode.ai/zen/go/v1";
const PILINGUAL_MODEL =
  process.env.PILINGUAL_MODEL ?? "deepseek-v4-flash";
const PILINGUAL_MAX_CHARS = parseInt(
  process.env.PILINGUAL_MAX_CHARS ?? "8000",
  10,
);

function getApiKey(): string | undefined {
  return process.env.PILINGUAL_API_KEY;
}

type PilingualState = {
  enabled: boolean;
  provider?: string;
  model?: string;
};

type TranslationTarget = {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

// ─── Translation cache (session-scoped) ──────────────────────────────────────

const translationCache = new Map<string, string>();
let getPiMarkdownTheme:
  | typeof import("@earendil-works/pi-coding-agent").getMarkdownTheme
  | undefined;

async function loadPiMarkdownTheme(): Promise<void> {
  try {
    const mod = await import("@earendil-works/pi-coding-agent");
    getPiMarkdownTheme = mod.getMarkdownTheme;
  } catch {
    getPiMarkdownTheme = undefined;
  }
}

/** Hash a string to a short key for the cache. */
function cacheKey(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function getTranslationModels(ctx: ExtensionContext) {
  return ctx.modelRegistry
    .getAvailable()
    .filter((model) => model.api === "openai-completions");
}

function getTranslationProviders(ctx: ExtensionContext): string[] {
  return Array.from(new Set(getTranslationModels(ctx).map((model) => model.provider))).sort();
}

function formatModelId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function findTranslationModel(
  ctx: ExtensionContext,
  provider: string | undefined,
  modelId: string | undefined,
) {
  if (!provider || !modelId) return undefined;

  const model = ctx.modelRegistry.find(provider, modelId);
  return model && model.api === "openai-completions" ? model : undefined;
}

function findModelFromArg(
  ctx: ExtensionContext,
  arg: string,
  fallbackProvider: string | undefined,
) {
  const slashIndex = arg.indexOf("/");
  if (slashIndex > 0) {
    return findTranslationModel(
      ctx,
      arg.slice(0, slashIndex),
      arg.slice(slashIndex + 1),
    );
  }

  const models = getTranslationModels(ctx).filter((model) =>
    fallbackProvider ? model.provider === fallbackProvider : true,
  );
  return models.find((model) => model.id === arg);
}

function parseNumberedSelection(value: string, max: number): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;

  const index = Number(value) - 1;
  return index >= 0 && index < max ? index : undefined;
}

function numberedOptions(values: string[]): string[] {
  return values.map((value, index) => `${index + 1}. ${value}`);
}

function stripNumberedPrefix(value: string): string {
  return value.replace(/^\d+\.\s*/, "");
}

async function selectProvider(
  ctx: ExtensionContext,
  providers: string[],
): Promise<string | undefined> {
  const choice = await ctx.ui.select(
    "Pilingual provider",
    numberedOptions(providers),
  );
  return choice ? stripNumberedPrefix(choice) : undefined;
}

async function selectModel(
  ctx: ExtensionContext,
  models: Array<{ provider: string; id: string }>,
): Promise<{ provider: string; id: string } | undefined> {
  const choices = numberedOptions(models.map((model) => formatModelId(model.provider, model.id)));
  const choice = await ctx.ui.select("Pilingual model", choices);
  if (!choice) return undefined;

  const id = stripNumberedPrefix(choice);
  return models.find((model) => formatModelId(model.provider, model.id) === id);
}

async function resolveTranslationTarget(
  ctx: ExtensionContext,
  state: PilingualState,
): Promise<TranslationTarget | null> {
  if (PILINGUAL_ADAPTER !== "openai-compatible") return null;

  const provider = state.provider ?? PILINGUAL_PROVIDER;
  const modelId = state.model ?? PILINGUAL_MODEL;
  const registryModel = findTranslationModel(ctx, provider, modelId);

  if (registryModel) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(registryModel);
    if (!auth.ok) return null;

    return {
      provider: registryModel.provider,
      model: registryModel.id,
      baseUrl: registryModel.baseUrl,
      apiKey: auth.apiKey,
      headers: auth.headers,
    };
  }

  const apiKey = getApiKey();
  if (!apiKey) return null;

  return {
    provider: provider ?? "manual",
    model: modelId,
    baseUrl: PILINGUAL_BASE_URL,
    apiKey,
  };
}

function saveState(pi: ExtensionAPI, state: PilingualState): void {
  pi.appendEntry("pilingual-state", { ...state });
}

// ─── Side-by-side assistant rendering ────────────────────────────────────────

function getRendererMarkdownTheme(theme: {
  fg(color: any, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
  strikethrough(text: string): string;
}) {
  try {
    if (getPiMarkdownTheme) {
      const markdownTheme = getPiMarkdownTheme();
      markdownTheme.heading("");
      markdownTheme.underline("");
      return markdownTheme;
    }
  } catch {
    getPiMarkdownTheme = undefined;
  }

  return {
    heading: (s: string) => theme.fg("mdHeading", s),
    link: (s: string) => theme.fg("mdLink", s),
    linkUrl: (s: string) => theme.fg("mdLinkUrl", s),
    code: (s: string) => theme.fg("mdCode", s),
    codeBlock: (s: string) => theme.fg("mdCodeBlock", s),
    codeBlockBorder: (s: string) => theme.fg("mdCodeBlockBorder", s),
    quote: (s: string) => theme.fg("mdQuote", s),
    quoteBorder: (s: string) => theme.fg("mdQuoteBorder", s),
    hr: (s: string) => theme.fg("mdHr", s),
    listBullet: (s: string) => theme.fg("mdListBullet", s),
    bold: (s: string) => theme.bold(s),
    italic: (s: string) => theme.italic(s),
    strikethrough: (s: string) => theme.strikethrough(s),
    underline: (s: string) => theme.underline(s),
    codeBlockIndent: "  ",
  };
}

// ─── Translation via OpenAI-compatible chat endpoint ─────────────────────────

async function translateToSpanish(
  english: string,
  ctx: ExtensionContext,
  state: PilingualState,
): Promise<string | null> {
  if (PILINGUAL_MAX_CHARS > 0 && english.length > PILINGUAL_MAX_CHARS) {
    return null;
  }

  const target = await resolveTranslationTarget(ctx, state);
  if (!target) return null;

  const key = cacheKey(`${target.provider}/${target.model}:${english}`);
  const cached = translationCache.get(key);
  if (cached) return cached;

  try {
    const response = await fetch(
      `${target.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          ...target.headers,
          "Content-Type": "application/json",
          ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: target.model,
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content:
                "You are a precise technical translator. Translate the following text from English to Spanish. " +
                "Preserve all code blocks, inline code, markdown formatting, links, and technical terms. " +
                "Use a technical register appropriate for software engineering documentation. " +
                "Output ONLY the translated text, no preamble.",
            },
            { role: "user", content: english },
          ],
        }),
      },
    );

    if (!response.ok) return null;

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const translated = data.choices?.[0]?.message?.content?.trim();
    if (!translated) return null;

    translationCache.set(key, translated);
    return translated;
  } catch {
    return null;
  }
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const state: PilingualState = {
    enabled: true,
    provider: PILINGUAL_PROVIDER,
    model: PILINGUAL_PROVIDER ? PILINGUAL_MODEL : undefined,
  };
  void loadPiMarkdownTheme();

  // ── Restore state from session ──────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        entry.customType === "pilingual-state"
      ) {
        const data = entry.data as { enabled?: boolean } | undefined;
        if (data && typeof data.enabled === "boolean") {
          state.enabled = data.enabled;
        }
        if (data && typeof (data as PilingualState).provider === "string") {
          state.provider = (data as PilingualState).provider;
        }
        if (data && typeof (data as PilingualState).model === "string") {
          state.model = (data as PilingualState).model;
        }
      }
    }

    translationCache.clear();

    const status = state.enabled ? "on" : "off";
    ctx.ui.setStatus(
      "pilingual",
      state.enabled
        ? ctx.ui.theme.fg("success", "🌐 EN→ES")
        : ctx.ui.theme.fg("dim", "🌐 off"),
    );
    ctx.ui.notify(`Pilingual: ${status}`, "info");
  });

  // ── Intercept assistant messages at message_end ─────────────────────────

  pi.on("message_end", async (event, ctx) => {
    if (!state.enabled) return;
    if (event.message.role !== "assistant") return;

    // Extract text blocks for translation
    const textBlocks = event.message.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    if (textBlocks.length === 0) return;

    const englishText = textBlocks.map((b) => b.text).join("\n\n");
    if (!englishText.trim()) return;

    // Translate (no abort signal — message_end runs post-stream)
    const spanishText = await translateToSpanish(englishText, ctx, state);
    if (!spanishText) return;

    const sendRenderedMessage = () => {
      pi.sendMessage(
        {
          customType: "pilingual",
          content: "",
          display: true,
          details: {
            english: englishText,
            spanish: spanishText,
          },
        },
      );
    };

    const sendWhenIdle = () => {
      if (ctx.isIdle()) {
        sendRenderedMessage();
        return;
      }

      setTimeout(sendWhenIdle, 50);
    };

    setTimeout(sendWhenIdle, 0);

    let insertedPilingualText = false;
    const content: typeof event.message.content = [];
    for (const block of event.message.content) {
      if (block.type !== "text") {
        content.push(block);
        continue;
      }

      if (!insertedPilingualText) {
        insertedPilingualText = true;
      }
    }

    // registerMessageRenderer only applies to custom messages. Replace visible
    // assistant text with the custom rendered message emitted above, while
    // preserving non-text blocks such as thinking and tool calls.
    return {
      message: {
        ...event.message,
        content,
      },
    };
  });

  // ── Custom renderer for pilingual messages ──────────────────────────────

  pi.registerMessageRenderer(
    "pilingual",
    (message, _options, theme) => {
      const details = message.details as
        | { english: string; spanish: string }
        | undefined;
      if (!details) {
        return new Text(
          theme.fg("dim", "[pilingual: no translation data]"),
          0,
          0,
        );
      }

      const markdownTheme = getRendererMarkdownTheme(theme);

      const container = new Container();

      const pilingualContent = {
        cachedWidth: undefined as number | undefined,
        cachedLines: undefined as string[] | undefined,

        render(width: number): string[] {
          if (this.cachedLines && this.cachedWidth === width) {
            return this.cachedLines;
          }

          const lines: string[] = [];

          if (width < 96) {
            lines.push(theme.fg("accent", "── English ──"));
            lines.push(...new Markdown(details.english, 0, 0, markdownTheme).render(width));
            lines.push("");
            lines.push(theme.fg("accent", "── Español ──"));
            lines.push(...new Markdown(details.spanish, 0, 0, markdownTheme).render(width));
          } else {
            const gutter = theme.fg("dim", " │ ");
            const gutterWidth = visibleWidth(gutter);
            const colWidth = Math.floor((width - gutterWidth) / 2);
            const enMarkdown = new Markdown(details.english, 0, 0, markdownTheme);
            const esMarkdown = new Markdown(details.spanish, 0, 0, markdownTheme);
            const enLines = enMarkdown.render(colWidth);
            const esLines = esMarkdown.render(colWidth);
            const maxLines = Math.max(enLines.length, esLines.length);

            lines.push(
              truncateToWidth(theme.fg("accent", theme.bold("English")), colWidth, "", true) +
                gutter +
                truncateToWidth(theme.fg("accent", theme.bold("Español")), colWidth, "", true),
            );
            lines.push(
              theme.fg("dim", `${"─".repeat(colWidth)}─┼─${"─".repeat(colWidth)}`),
            );

            for (let i = 0; i < maxLines; i++) {
              const left = truncateToWidth(enLines[i] ?? "", colWidth, "", true);
              const right = truncateToWidth(esLines[i] ?? "", colWidth, "", true);
              lines.push(truncateToWidth(left + gutter + right, width, ""));
            }
          }

          this.cachedWidth = width;
          this.cachedLines = lines;
          return lines;
        },

        invalidate(): void {
          this.cachedWidth = undefined;
          this.cachedLines = undefined;
        },
      };

      // Wrap pilingual content with light horizontal padding.
      const contentBox = new Box(1, 0);
      contentBox.addChild(pilingualContent as any);
      container.addChild(contentBox);

      return container;
    },
  );

  // ── /pilingual command ──────────────────────────────────────────────────

  pi.registerCommand("pilingual", {
    description:
      "Configure pilingual mode: /pilingual on|off|status|provider|model",
    getArgumentCompletions: (prefix: string) => {
      const options = ["on", "off", "status", "provider", "model"];
      const filtered = options
        .filter((o) => o.startsWith(prefix))
        .map((o) => ({ value: o, label: o }));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const rawArg = args.trim();
      const [command = "status", ...rest] = rawArg.split(/\s+/);
      const arg = command.toLowerCase();
      const value = rest.join(" ");

      if (arg === "on") {
        state.enabled = true;
        saveState(pi, state);
        ctx.ui.setStatus(
          "pilingual",
          ctx.ui.theme.fg("success", "🌐 EN→ES"),
        );
        ctx.ui.notify("Pilingual mode: ON", "info");
      } else if (arg === "off") {
        state.enabled = false;
        saveState(pi, state);
        ctx.ui.setStatus(
          "pilingual",
          ctx.ui.theme.fg("dim", "🌐 off"),
        );
        ctx.ui.notify("Pilingual mode: OFF", "info");
      } else if (arg === "provider" || arg === "providers") {
        const providers = getTranslationProviders(ctx);
        if (!value) {
          if (providers.length > 0) {
            const selectedProvider = await selectProvider(ctx, providers);
            if (!selectedProvider) return;

            const providerModels = getTranslationModels(ctx).filter(
              (model) => model.provider === selectedProvider,
            );
            state.provider = selectedProvider;
            state.model = providerModels.some((model) => model.id === state.model)
              ? state.model
              : providerModels[0]?.id;
            saveState(pi, state);
            translationCache.clear();
            ctx.ui.notify(
              `Pilingual provider: ${state.provider}\nPilingual model: ${state.model}`,
              "info",
            );
            return;
          }

          ctx.ui.notify(
            "No available OpenAI-compatible providers. Use /login or configure models.json, or set PILINGUAL_API_KEY/PILINGUAL_BASE_URL/PILINGUAL_MODEL.",
            "warning",
          );
          return;
        }

        const providerIndex = parseNumberedSelection(value, providers.length);
        const providerName = providerIndex === undefined ? value : providers[providerIndex];
        const providerModels = getTranslationModels(ctx).filter(
          (model) => model.provider === providerName,
        );
        if (providerModels.length === 0) {
          ctx.ui.notify(
            `No available OpenAI-compatible models for provider "${providerName}".\n\nAvailable providers:\n${numberedOptions(providers).join("\n")}`,
            "warning",
          );
          return;
        }

        state.provider = providerName;
        state.model = providerModels.some((model) => model.id === state.model)
          ? state.model
          : providerModels[0].id;
        saveState(pi, state);
        translationCache.clear();
        ctx.ui.notify(
          `Pilingual provider: ${state.provider}\nPilingual model: ${state.model}`,
          "info",
        );
      } else if (arg === "model" || arg === "models") {
        if (!value) {
          const models = getTranslationModels(ctx).filter((model) =>
            state.provider ? model.provider === state.provider : true,
          );
          if (models.length > 0) {
            const selectedModel = await selectModel(ctx, models);
            if (!selectedModel) return;

            state.provider = selectedModel.provider;
            state.model = selectedModel.id;
            saveState(pi, state);
            translationCache.clear();
            ctx.ui.notify(
              `Pilingual model: ${formatModelId(state.provider, state.model)}`,
              "info",
            );
            return;
          }

          ctx.ui.notify(
            "No available OpenAI-compatible models. Use /login or configure models.json, or set manual PILINGUAL_* env vars.",
            "warning",
          );
          return;
        }

        const candidateModels = getTranslationModels(ctx).filter((model) =>
          state.provider ? model.provider === state.provider : true,
        );
        const modelIndex = parseNumberedSelection(value, candidateModels.length);
        const model =
          modelIndex === undefined
            ? findModelFromArg(ctx, value, state.provider)
            : candidateModels[modelIndex];
        if (!model) {
          ctx.ui.notify(
            `No available OpenAI-compatible model matching "${value}".\n\nAvailable models${
              state.provider ? ` for ${state.provider}` : ""
            }:\n${numberedOptions(
              candidateModels.map((candidate) =>
                formatModelId(candidate.provider, candidate.id),
              ),
            ).join("\n")}`,
            "warning",
          );
          return;
        }

        state.provider = model.provider;
        state.model = model.id;
        saveState(pi, state);
        translationCache.clear();
        ctx.ui.notify(
          `Pilingual model: ${formatModelId(state.provider, state.model)}`,
          "info",
        );
      } else if (arg === "status" || arg === "") {
        const target = await resolveTranslationTarget(ctx, state);
        const selected =
          state.provider && state.model
            ? formatModelId(state.provider, state.model)
            : "manual env fallback";
        ctx.ui.notify(
          `Pilingual: ${state.enabled ? "ON" : "OFF"}\n` +
            `Adapter: ${PILINGUAL_ADAPTER}\n` +
            `Selected: ${selected}\n` +
            `Translation target: ${
              target
                ? `${formatModelId(target.provider, target.model)} @ ${target.baseUrl}`
                : "not configured"
            }\n` +
            `Max chars: ${PILINGUAL_MAX_CHARS}\n` +
            `Cache entries: ${translationCache.size}`,
          "info",
        );
      } else {
        ctx.ui.notify(
          "Usage: /pilingual on|off|status|provider|model",
          "warning",
        );
      }
    },
  });

  // ── Cleanup on session shutdown ─────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    translationCache.clear();
  });
}
