/**
 * Pilingual Extension — English → Spanish side-by-side rendering
 *
 * Intercepts every assistant response, translates the text content to Spanish
 * via the OpenCode GO subscription (OpenAI-compatible endpoint), and renders
 * both versions in a side-by-side layout inside the TUI.
 *
 * Environment variables:
 *   PILINGUAL_PROVIDER   – Provider adapter (default: openai-compatible)
 *   PILINGUAL_API_KEY    – API key for the configured provider
 *   PILINGUAL_BASE_URL   – Base URL (default: https://opencode.ai/zen/go/v1)
 *   PILINGUAL_MODEL      – Model ID (default: deepseek-v4-flash)
 *   PILINGUAL_MAX_CHARS  – Skip translation above this length; 0 means no limit (default: 8000)
 *
 * Commands:
 *   /pilingual on|off|status
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Markdown,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

// ─── Configuration ───────────────────────────────────────────────────────────

const PILINGUAL_PROVIDER =
  process.env.PILINGUAL_PROVIDER ?? "openai-compatible";
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
): Promise<string | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;
  if (PILINGUAL_PROVIDER !== "openai-compatible") return null;
  if (PILINGUAL_MAX_CHARS > 0 && english.length > PILINGUAL_MAX_CHARS) {
    return null;
  }

  const key = cacheKey(english);
  const cached = translationCache.get(key);
  if (cached) return cached;

  try {
    const response = await fetch(
      `${PILINGUAL_BASE_URL}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: PILINGUAL_MODEL,
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
  let enabled = true;
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
          enabled = data.enabled;
        }
      }
    }

    translationCache.clear();

    const status = enabled ? "on" : "off";
    ctx.ui.setStatus(
      "pilingual",
      enabled
        ? ctx.ui.theme.fg("success", "🌐 EN→ES")
        : ctx.ui.theme.fg("dim", "🌐 off"),
    );
    ctx.ui.notify(`Pilingual: ${status}`, "info");
  });

  // ── Intercept assistant messages at message_end ─────────────────────────

  pi.on("message_end", async (event, ctx) => {
    if (!enabled) return;
    if (event.message.role !== "assistant") return;

    // Extract text blocks for translation
    const textBlocks = event.message.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    if (textBlocks.length === 0) return;

    const englishText = textBlocks.map((b) => b.text).join("\n\n");
    if (!englishText.trim()) return;

    // Translate (no abort signal — message_end runs post-stream)
    const spanishText = await translateToSpanish(englishText);
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
      "Toggle pilingual mode: /pilingual on|off|status",
    getArgumentCompletions: (prefix: string) => {
      const options = ["on", "off", "status"];
      const filtered = options
        .filter((o) => o.startsWith(prefix))
        .map((o) => ({ value: o, label: o }));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "on") {
        enabled = true;
        pi.appendEntry("pilingual-state", { enabled: true });
        ctx.ui.setStatus(
          "pilingual",
          ctx.ui.theme.fg("success", "🌐 EN→ES"),
        );
        ctx.ui.notify("Pilingual mode: ON", "info");
      } else if (arg === "off") {
        enabled = false;
        pi.appendEntry("pilingual-state", { enabled: false });
        ctx.ui.setStatus(
          "pilingual",
          ctx.ui.theme.fg("dim", "🌐 off"),
        );
        ctx.ui.notify("Pilingual mode: OFF", "info");
      } else if (arg === "status" || arg === "") {
        const apiKey = getApiKey();
        const hasKey = apiKey ? "✓ configured" : "✗ missing";
        ctx.ui.notify(
          `Pilingual: ${enabled ? "ON" : "OFF"}\n` +
            `API key: ${hasKey}\n` +
            `Provider: ${PILINGUAL_PROVIDER}\n` +
            `Model: ${PILINGUAL_MODEL}\n` +
            `Endpoint: ${PILINGUAL_BASE_URL}\n` +
            `Max chars: ${PILINGUAL_MAX_CHARS}\n` +
            `Cache entries: ${translationCache.size}`,
          "info",
        );
      } else {
        ctx.ui.notify(
          "Usage: /pilingual on|off|status",
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
