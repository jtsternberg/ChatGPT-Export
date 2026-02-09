---
title: ChatGPT Conversation Export Chrome Extension
type: feat
date: 2026-02-09
---

# ChatGPT Conversation Export Chrome Extension

A Chrome extension (Manifest V3) that injects an "Export to Markdown" button into the ChatGPT UI. Clicking it scrapes the current conversation from the DOM, converts it to clean Markdown (preserving code blocks with language tags), and downloads the `.md` file.

## Acceptance Criteria

- [x] Extension loads on `chatgpt.com` and injects an export button into the conversation UI
- [x] Button appears only when viewing a conversation (not on home/settings/explore pages)
- [x] Button re-injects correctly after SPA navigation between conversations
- [x] Clicking export scrapes all visible conversation turns and downloads a `.md` file
- [x] User messages are prefixed with `##### You said:` (matching reference)
- [x] Assistant messages are prefixed with `###### ChatGPT said:` (matching reference)
- [x] Code blocks preserve language tags (e.g., ` ```python `)
- [x] Inline code, bold, italic, links, lists, tables, blockquotes all convert cleanly to Markdown
- [x] Images replaced with placeholder text `![Uploaded image](url)` or `[Image]`
- [x] Downloaded filename derived from conversation title, sanitized for filesystem
- [x] Button shows brief loading state and disables during export to prevent double-clicks
- [x] Works on Chrome (and Chromium-based browsers: Edge, Brave, Arc)

## Context

### Why this exists

ChatGPT provides per-message copy buttons but no way to export or download an entire conversation. The built-in "Export Data" feature dumps *all* conversations as a single JSON blob — not useful for saving individual chats as readable documents.

### Technical approach

**DOM scraping with stable selectors.** ChatGPT's DOM uses reliable `data-*` attributes that survive UI reskins better than CSS classes:

- `article[data-testid^="conversation-turn-"]` — each conversation turn
- `[data-message-author-role="user"]` / `[data-message-author-role="assistant"]` — speaker identification
- `[data-turn="user"]` / `[data-turn="assistant"]` — alternative turn identification
- `.markdown.prose` — assistant message rich HTML content
- `.whitespace-pre-wrap` — user message text
- `<pre><code class="language-*">` — code blocks with language tags
- `<h5 class="sr-only">You said:</h5>` / `<h6 class="sr-only">ChatGPT said:</h6>` — screen reader labels

**HTML-to-Markdown conversion.** The assistant's response HTML contains rich elements (bold, italic, lists, tables, code blocks, blockquotes, links). These need client-side HTML-to-Markdown conversion. Reference quality: the `html-to-markdown` PHP CLI tool produces excellent output from ChatGPT's HTML (tested at `/tmp/chat.md`).

**Extension architecture:**

```
chatgpt-export/
├── manifest.json          # Manifest V3, permissions: downloads + host chatgpt.com
├── content.js             # Content script: button injection, DOM scraping, Markdown conversion
├── content.css            # Button styling to match ChatGPT's UI
├── background.js          # Service worker: handles chrome.downloads API calls
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

- **Content script** (`content.js`): Runs on `chatgpt.com/*`. Injects export button, scrapes conversation DOM, converts HTML to Markdown, sends download request to background.
- **Background service worker** (`background.js`): Receives Markdown string from content script, creates data URL, triggers `chrome.downloads.download()` with `saveAs: true`.
- **MutationObserver**: Watches for SPA navigation (URL changes, DOM subtree changes) to re-inject button when the user switches conversations.
- **No external dependencies**: Pure vanilla JS, no build step needed. HTML-to-Markdown conversion implemented inline (it's a focused subset: headings, bold, italic, code, lists, tables, links, blockquotes, horizontal rules).

### Key decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Export format | Markdown only | User preference; cleanest format for conversations |
| Trigger | Button injected in ChatGPT UI | More discoverable than popup |
| Browser target | Chrome (Manifest V3) | Works across all Chromium browsers |
| Conversion approach | Client-side DOM-to-Markdown | No external servers, fully private |
| Lazy-loaded messages | Export only what's in the DOM | MVP simplicity; warn if conversation appears truncated |
| Streaming responses | Disable button while assistant is typing | Prevent partial exports |
| Branching/regenerations | Export the currently visible branch only | Matches what user sees |
| Images | `![Image](url)` with ChatGPT CDN URL | Preserves reference without downloading |
| File naming | `{sanitized-title}.md` | Derived from conversation title in sidebar or `<title>` |
| Privacy | 100% client-side, zero telemetry | No data leaves the browser |

### Existing landscape

Several extensions exist ([ChatGPT Exporter](https://github.com/pionxzh/chatgpt-exporter), ExportGPT, etc.) but most are either: userscripts (not Chrome extensions), paid/freemium for PDF, or bloated with features. This targets a simple, focused, free, open-source Markdown-only export.

## MVP

### manifest.json

```json
{
  "manifest_version": 3,
  "name": "ChatGPT Export",
  "version": "1.0.0",
  "description": "Export ChatGPT conversations to Markdown",
  "permissions": ["downloads"],
  "host_permissions": ["https://chatgpt.com/*"],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["https://chatgpt.com/*"],
      "js": ["content.js"],
      "css": ["content.css"],
      "run_at": "document_idle"
    }
  ],
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

### content.js (pseudocode)

```javascript
// 1. Detect if we're in a conversation (URL matches /c/ pattern or thread element exists)
// 2. Find injection point (near the model selector / header area)
// 3. Create and inject export button styled to match ChatGPT UI
// 4. On click:
//    a. Disable button, show loading state
//    b. Query all article[data-testid^="conversation-turn-"] elements
//    c. For each turn:
//       - Read data-message-author-role to determine speaker
//       - Extract user text from .whitespace-pre-wrap
//       - Extract assistant HTML from .markdown.prose container
//       - Convert assistant HTML to Markdown (handle: headings, bold, italic,
//         code blocks with language, inline code, lists, tables, links, blockquotes, hr)
//    d. Assemble full Markdown with title as H1
//    e. Send to background.js for download
//    f. Restore button state

// 5. MutationObserver: watch for URL changes and DOM changes to re-inject button
//    - Debounce at ~300ms to avoid excessive re-injection during streaming
//    - On URL change: remove old button, check if new page is a conversation, re-inject

// 6. HTML-to-Markdown conversion (subset):
//    - <strong>/<b> → **text**
//    - <em>/<i> → *text*
//    - <code> (inline) → `code`
//    - <pre><code class="language-X"> → ```X\ncode\n```
//    - <pre><code> (no language) → ```\ncode\n```
//    - <h1>-<h6> → # through ######
//    - <ul>/<ol> + <li> → - item / 1. item (handle nesting)
//    - <blockquote> → > text
//    - <a href="url"> → [text](url)
//    - <table> → | header | ... | Markdown tables
//    - <hr> → ---
//    - <br> → newline
//    - <img> → ![alt](src)
//    - <p> → text + double newline
```

### background.js

```javascript
// Listen for messages from content script
// On "download" action:
//   - Receive { markdown, filename } from content script
//   - Create data URL: 'data:text/markdown;base64,' + btoa(unescape(encodeURIComponent(markdown)))
//   - Call chrome.downloads.download({ url: dataUrl, filename, saveAs: true })
```

## References

- [ChatGPT DOM structure analysis](/tmp/chat.html) — live HTML from chatgpt.com with `data-testid`, `data-message-author-role`, `data-turn` attributes
- [html-to-markdown output](/private/tmp/chat.md) — reference quality for Markdown conversion from ChatGPT HTML
- [pionxzh/chatgpt-exporter](https://github.com/pionxzh/chatgpt-exporter) — popular open-source userscript, uses backend API interception
- [Chrome Manifest V3 docs](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3) — content scripts, service workers, downloads API
- [chrome.downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads) — file download from extensions
