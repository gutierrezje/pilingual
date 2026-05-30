/**
 * Pilingual Extension — side-by-side translation rendering
 *
 * Intercepts every assistant response, translates the text content
 * via a pi-registered OpenAI-compatible provider, and renders
 * both versions in a side-by-side layout inside the TUI.
 *
 * Environment variables:
 *   PILINGUAL_PROVIDER        – Initial pi provider ID (overridden by /pilingual provider)
 *   PILINGUAL_MODEL           – Initial pi model ID (overridden by /pilingual model)
 *   PILINGUAL_TARGET_LANGUAGE – Target language (default: Spanish)
 *   PILINGUAL_MAX_CHARS       – Skip translation above this length; 0 means no limit (default: 8000)
 *
 * Commands:
 *   /pilingual on|off|status|provider|model|language
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Markdown,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ─── Configuration ───────────────────────────────────────────────────────────

const PILINGUAL_PROVIDER = process.env.PILINGUAL_PROVIDER;
const PILINGUAL_MODEL =
  process.env.PILINGUAL_MODEL ?? "deepseek-v4-flash";
const PILINGUAL_TARGET_LANGUAGE =
  process.env.PILINGUAL_TARGET_LANGUAGE ?? "Spanish";
const PILINGUAL_MAX_CHARS = parseInt(
  process.env.PILINGUAL_MAX_CHARS ?? "8000",
  10,
);

type PilingualState = {
  enabled: boolean;
  provider?: string;
  model?: string;
  targetLanguage: string;
};

// ─── File-based persistence ──────────────────────────────────────────────────

const CONFIG_FILE = join(getAgentDir(), "pilingual.json");

function loadStateFromFile(): Partial<PilingualState> {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as Partial<PilingualState>;
  } catch {
    return {};
  }
}

function saveStateToFile(state: PilingualState): void {
  try {
    mkdirSync(getAgentDir(), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(state, null, 2) + "\n", "utf-8");
  } catch {
    // Best-effort — don't crash the extension if write fails.
  }
}

function languageCode(lang: string): string {
  const map: Record<string, string> = {
    "Spanish (Spain)": "ES-ES",
    "Spanish (LatAm)": "ES-LATAM",
    French: "FR",
    German: "DE",
    Italian: "IT",
    "Portuguese (Portugal)": "PT-PT",
    "Portuguese (Brazil)": "PT-BR",
    Japanese: "JA",
    Korean: "KO",
    "Chinese (Simplified)": "ZH",
  };
  return map[lang] ?? lang.slice(0, 2).toUpperCase();
}

// ─── Translation cache (session-scoped) ──────────────────────────────────────

const translationCache = new Map<string, string>();
const COMMON_TARGET_LANGUAGES = [
  "Spanish (Spain)",
  "Spanish (LatAm)",
  "French",
  "German",
  "Italian",
  "Portuguese (Portugal)",
  "Portuguese (Brazil)",
  "Japanese",
  "Korean",
  "Chinese (Simplified)",
  "Custom...",
];
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

async function selectTargetLanguage(
  ctx: ExtensionContext,
): Promise<string | undefined> {
  const choice = await ctx.ui.select(
    "Pilingual target language",
    numberedOptions(COMMON_TARGET_LANGUAGES),
  );
  if (!choice) return undefined;

  const language = stripNumberedPrefix(choice);
  if (language !== "Custom...") return language;

  const customLanguage = await ctx.ui.input(
    "Target language",
    "e.g. Catalan, Arabic, Brazilian Portuguese",
  );
  return customLanguage?.trim() || undefined;
}

function saveState(state: PilingualState): void {
  saveStateToFile(state);
}

function getUsageText(): string {
  return [
    "Usage:",
    "  /pilingual on",
    "  /pilingual off",
    "  /pilingual status",
    "  /pilingual provider",
    "  /pilingual provider <provider>",
    "  /pilingual model",
    "  /pilingual model <provider/model|model>",
    "  /pilingual language",
    "  /pilingual language <language>",
  ].join("\n");
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

// ─── Translation via pi-registered OpenAI-compatible provider ────────────────

async function translateText(
  english: string,
  ctx: ExtensionContext,
  state: PilingualState,
): Promise<string | null> {
  if (PILINGUAL_MAX_CHARS > 0 && english.length > PILINGUAL_MAX_CHARS) {
    return null;
  }

  const provider = state.provider;
  const modelId = state.model;
  const registryModel = findTranslationModel(ctx, provider, modelId);

  if (!registryModel) return null;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(registryModel);
  if (!auth.ok) return null;

  const key = cacheKey(
    `${provider}/${modelId}/${state.targetLanguage}:${english}`,
  );
  const cached = translationCache.get(key);
  if (cached) return cached;

  try {
    const response = await fetch(
      `${registryModel.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          ...auth.headers,
          "Content-Type": "application/json",
          ...(auth.apiKey ? { Authorization: `Bearer ${auth.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: modelId,
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content:
                `You are a precise technical translator. Translate the following text from English to ${state.targetLanguage}. ` +
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
  // ── Load persisted state from file, with env-var defaults ────────────────

  const saved = loadStateFromFile();
  const state: PilingualState = {
    enabled: saved.enabled ?? true,
    provider: saved.provider ?? PILINGUAL_PROVIDER,
    model: saved.model ?? (saved.provider ?? PILINGUAL_PROVIDER ? PILINGUAL_MODEL : undefined),
    targetLanguage: saved.targetLanguage ?? PILINGUAL_TARGET_LANGUAGE,
  };
  void loadPiMarkdownTheme();

  // ── Update status bar on session start ───────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    translationCache.clear();

    const langCode = languageCode(state.targetLanguage);
    ctx.ui.setStatus(
      "pilingual",
      state.enabled
        ? ctx.ui.theme.fg("success", `🌐 EN→${langCode}`)
        : ctx.ui.theme.fg("dim", "🌐 off"),
    );
    ctx.ui.notify(`Pilingual: ${state.enabled ? "on" : "off"}`, "info");
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
    const translatedText = await translateText(englishText, ctx, state);
    if (!translatedText) return;

    const sendRenderedMessage = () => {
      pi.sendMessage(
        {
          customType: "pilingual",
          content: "",
          display: true,
          details: {
            english: englishText,
            translated: translatedText,
            targetLanguage: state.targetLanguage,
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
        | {
            english: string;
            translated?: string;
            spanish?: string;
            targetLanguage?: string;
          }
        | undefined;
      if (!details) {
        return new Text(
          theme.fg("dim", "[pilingual: no translation data]"),
          0,
          0,
        );
      }

      const translatedText = details.translated ?? details.spanish;
      if (!translatedText) {
        return new Text(
          theme.fg("dim", "[pilingual: no translation text]"),
          0,
          0,
        );
      }
      const targetLanguage = details.targetLanguage ?? "Spanish";
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
            lines.push(theme.fg("accent", `── ${targetLanguage} ──`));
            lines.push(...new Markdown(translatedText, 0, 0, markdownTheme).render(width));
          } else {
            const gutter = theme.fg("dim", " │ ");
            const gutterWidth = visibleWidth(gutter);
            const colWidth = Math.floor((width - gutterWidth) / 2);
            const enMarkdown = new Markdown(details.english, 0, 0, markdownTheme);
            const esMarkdown = new Markdown(translatedText, 0, 0, markdownTheme);
            const enLines = enMarkdown.render(colWidth);
            const esLines = esMarkdown.render(colWidth);
            const maxLines = Math.max(enLines.length, esLines.length);

            lines.push(
                truncateToWidth(theme.fg("accent", theme.bold("English")), colWidth, "", true) +
                gutter +
                truncateToWidth(theme.fg("accent", theme.bold(targetLanguage)), colWidth, "", true),
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
      "Configure pilingual mode: /pilingual on|off|status|provider|model|language",
    getArgumentCompletions: (prefix: string) => {
      const options = ["on", "off", "status", "provider", "model", "language"];
      const filtered = options
        .filter((o) => o.startsWith(prefix))
        .map((o) => ({ value: o, label: o }));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const rawArg = args.trim();
      const isBareCommand = rawArg === "";
      const [command = "status", ...rest] = rawArg.split(/\s+/);
      const arg = command.toLowerCase();
      const value = rest.join(" ");

      if (arg === "on") {
        state.enabled = true;
        saveState(state);
        ctx.ui.setStatus(
          "pilingual",
          ctx.ui.theme.fg("success", `🌐 EN→${languageCode(state.targetLanguage)}`),
        );
        ctx.ui.notify("Pilingual mode: ON", "info");
      } else if (arg === "off") {
        state.enabled = false;
        saveState(state);
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
            saveState(state);
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

        const providerName = value;
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
        saveState(state);
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
            saveState(state);
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
        const model = findModelFromArg(ctx, value, state.provider);
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
        saveState(state);
        translationCache.clear();
        ctx.ui.notify(
          `Pilingual model: ${formatModelId(state.provider, state.model)}`,
          "info",
        );
      } else if (arg === "language" || arg === "lang") {
        let language = value;
        if (!language) {
          const selectedLanguage = await selectTargetLanguage(ctx);
          if (!selectedLanguage) return;
          language = selectedLanguage;
        }

        state.targetLanguage = language.replace(
          /\b\w/g,
          (c) => c.toUpperCase(),
        );
        saveState(state);
        translationCache.clear();
        ctx.ui.setStatus(
          "pilingual",
          state.enabled
            ? ctx.ui.theme.fg("success", `🌐 EN→${languageCode(state.targetLanguage)}`)
            : ctx.ui.theme.fg("dim", "🌐 off"),
        );
        ctx.ui.notify(`Pilingual target language: ${state.targetLanguage}`, "info");
      } else if (arg === "status" || arg === "") {
        const provider = state.provider ?? "none";
        const modelId = state.model ?? "none";
        const registryModel = findTranslationModel(ctx, state.provider, state.model);
        const hasAuth = registryModel
          ? (await ctx.modelRegistry.getApiKeyAndHeaders(registryModel)).ok
          : false;

        ctx.ui.notify(
          `Pilingual: ${state.enabled ? "ON" : "OFF"}\n` +
            `Target language: ${state.targetLanguage}\n` +
            `Model: ${formatModelId(provider, modelId)}\n` +
            (registryModel ? `Endpoint: ${registryModel.baseUrl}\n` : "") +
            `Auth: ${hasAuth ? "ok" : "missing"}\n` +
            `Max chars: ${PILINGUAL_MAX_CHARS}\n` +
            `Cache entries: ${translationCache.size}` +
            (isBareCommand ? `\n\n${getUsageText()}` : ""),
          "info",
        );
      } else {
        ctx.ui.notify(
          getUsageText(),
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
