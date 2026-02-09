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
- **Export handler** - `handleExport()` orchestrates scraping and download
- **HTML-to-Markdown converter** - `convertNode()` recursive converter handles all HTML elements ChatGPT uses
- **MutationObserver** - watches for SPA navigation, debounced at 300ms

### background.js

Receives `{ action: 'download', markdown, filename }` messages from the content script. Creates a Blob, converts to data URL, calls `chrome.downloads.download()`.

## ChatGPT DOM selectors

These are the stable selectors (prefer `data-*` attributes over CSS classes):

- `article[data-testid^="conversation-turn-"]` - each conversation turn
- `[data-message-author-role="user"|"assistant"]` - speaker identification
- `[data-turn="user"|"assistant"]` - alternative turn ID on the article
- `.markdown.prose` - assistant message rich HTML content
- `.whitespace-pre-wrap` - user message text
- `[data-writing-block]` - present when assistant is streaming
- `#conversation-header-actions` - header area where export button is injected
- `[data-testid="share-chat-button"]` - share button (export is inserted before this)

CSS classes change often. `data-*` attributes are stable.

## Key conventions

- No external dependencies - everything is vanilla JS
- No build step - files are loaded directly by the browser
- All DOM selectors are defined in the `SELECTORS` constant at the top of content.js
- The HTML-to-Markdown converter only handles the subset of HTML that ChatGPT actually produces
- 100% client-side - no data leaves the browser, no telemetry
- Domain is `chatgpt.com` (not `chat.openai.com`)

## Testing

To test conversion quality, compare output against the reference file produced by the `html-to-markdown` PHP CLI tool (`~/.dotfiles/bin/html-to-markdown`). Usage: `html-to-markdown input.html output.md --yes`

To test the extension:
1. Load unpacked at `chrome://extensions/`
2. Navigate to any ChatGPT conversation
3. Click the Export button in the header
4. Verify the downloaded `.md` file has correct formatting
