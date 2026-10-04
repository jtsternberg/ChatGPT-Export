# Agents

Instructions for AI agents working on this codebase.

## Project overview

Chrome extension (Manifest V3) that exports ChatGPT conversations to Markdown. Pure vanilla JS, no build step, no dependencies.

## Architecture

```
manifest.json      - Extension config (Manifest V3)
content.js         - Content script injected on chatgpt.com
content.css        - Styles for injected button and toast
background.js      - Service worker for chrome.downloads API
icons/             - Extension icons (16/48/128px)
```

### content.js structure

- **IIFE wrapper** - everything runs in an immediately-invoked function
- **SELECTORS object** - all DOM selectors in one place at the top
- **Button injection** - `injectButton()` places the export button in `#conversation-header-actions` next to the share button
- **Export handler** - `handleExport()` tries the conversation API first, falls back to DOM scraping (toast says the export is partial), then downloads
- **Conversation API** - `fetchConversation()` gets a token from `/api/auth/session`, then `GET /backend-api/conversation/<id>` (undocumented; what ChatGPT's UI uses). `conversationToMarkdown()` walks `mapping` from `current_node` up to the root. Only user `text`/`multimodal_text`, assistant `text` with `recipient: "all"`, and DALL·E tool images are emitted; tool calls and reasoning are skipped. Citations are U+E200…U+E201 markers in the text, replaced via `metadata.content_references[].matched_text` → `alt`
- **Image export** - image asset pointers become tokens, then `exportImages()` resolves each `file_…` id via `/backend-api/files/download/<id>` (falls back to `/backend-api/files/<id>/download`) → `download_url`, compresses (max 1600px, WebP q0.7, kept only if smaller; GIF/SVG untouched), and saves `<title>/images/<id>.<ext>` with `conflictAction: overwrite`. If any image saves, the `.md` goes to `<title>/<title>.md`; failed images stay `*[label]*` placeholders
- **Rate limits** - `/backend-api/conversation` returns 429 after a burst of requests (ChatGPT's own UI then fails to load the chat too). 429s have no `Retry-After`/rate-limit headers. `fetchConversationWithRetry()` retries when a `PerformanceObserver` sees the page's own `/backend-api/conversation(s)` request return 200, else after 30/60/120/240s backoff, then falls back to the DOM scrape. Never poll it
- **DOM scrape (fallback)** - `scrapeConversation()` only sees rendered turns; long conversations lazy-load, so it can be incomplete
- **HTML-to-Markdown converter** - `convertNode()` recursive converter handles all HTML elements ChatGPT uses (DOM fallback only)
- **MutationObserver** - watches for SPA navigation, debounced at 300ms
- **Selector health check** - `scheduleHealthCheck()` runs on each `/c/` page, retries for 10s, then shows a dismissible banner naming the `SELECTORS` that matched nothing (details in console). Add any new required selector to `findBrokenSelectors()`

### background.js

Receives `{ action: 'download', markdown, filename }` messages from the content script. Creates a Blob, converts to data URL, calls `chrome.downloads.download()`.

## ChatGPT DOM selectors

Current DOM (2026-10). Each `SELECTORS` entry in content.js also keeps the older selector as a fallback.

- `[data-turn-key]` - one turn = a user message AND its reply (was `[data-testid^="conversation-turn-"]`, one speaker per turn)
- `[data-chatgpt-search-unit-key$=":user"|":assistant"]` - one message; role is the key suffix (was `[data-message-author-role]`). User attachments (`img`) sit inside this unit, outside the nested `[data-content-search-unit-key]`
- `[data-markdown-text-style="assistant-message"]` - assistant rich HTML (was `.markdown.prose`)
- `.whitespace-pre-wrap` - user message text
- `a[data-testid="chatgpt-citation"]` - citation chip, no `href`; source name + URL are in `aria-label`
- `[data-app-shell-main-titlebar] .ms-auto` - header actions (was `#conversation-header-actions`)
- `button[aria-label="Share"]` - share button; export is inserted before it and copies its classes
- `button[data-testid="stop-button"]` - present only while streaming

CSS classes change often. `data-*` attributes are stable.

## Key conventions

- No external dependencies - everything is vanilla JS
- No build step - files are loaded directly by the browser
- All DOM selectors are defined in the `SELECTORS` constant at the top of content.js
- The HTML-to-Markdown converter only handles the subset of HTML that ChatGPT actually produces
- 100% client-side - no data leaves the browser, no telemetry (API calls go only to chatgpt.com with the user's own session)
- Domain is `chatgpt.com` (not `chat.openai.com`)

## Testing

To test conversion quality, compare output against the reference file produced by the `html-to-markdown` PHP CLI tool (`~/.dotfiles/bin/html-to-markdown`). Usage: `html-to-markdown input.html output.md --yes`

To test the extension:
1. Load unpacked at `chrome://extensions/`
2. Navigate to any ChatGPT conversation
3. Click the Export button in the header
4. Verify the downloaded `.md` file has correct formatting
