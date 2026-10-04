(() => {
  'use strict';

  const BUTTON_ID = 'chatgpt-export-btn';
  const SELECTORS = {
    thread: '#thread',
    // Each list keeps the pre-2026-10 selector as a fallback: ChatGPT rolls
    // DOM changes out gradually, so both shapes can be live at once.
    turn: '[data-turn-key], [data-testid^="conversation-turn-"]',
    message: '[data-chatgpt-search-unit-key], [data-message-author-role]',
    userText: '.whitespace-pre-wrap',
    assistantContent: '[data-markdown-text-style="assistant-message"], .markdown.prose',
    citation: 'a[data-testid="chatgpt-citation"]',
    headerActions: '[data-app-shell-main-titlebar] .ms-auto, #conversation-header-actions',
    shareButton: 'button[aria-label="Share"], [data-testid="share-chat-button"]',
    streamingIndicator: 'button[data-testid="stop-button"]',
  };

  let debounceTimer = null;
  let lastUrl = location.href;

  // ── Button injection ──────────────────────────────────────────────────

  function isConversationPage() {
    return /^\/c\//.test(location.pathname) || !!document.querySelector(SELECTORS.thread);
  }

  function getConversationTitle() {
    // Try the page <title> first — ChatGPT sets it to the conversation title
    const title = document.title.replace(/\s*[-–|]\s*ChatGPT\s*$/i, '').trim();
    if (title && title !== 'ChatGPT') return title;
    return 'conversation';
  }

  function sanitizeFilename(name) {
    return name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 200) || 'conversation';
  }

  function isStreaming() {
    return !!document.querySelector(SELECTORS.streamingIndicator);
  }

  function injectButton() {
    const existing = document.getElementById(BUTTON_ID);
    // A body-fallback button is retried each pass so it moves into the
    // header once ChatGPT renders it.
    if (existing && existing.parentElement !== document.body) return;
    if (!isConversationPage()) return;

    const headerActions = document.querySelector(SELECTORS.headerActions);
    const shareBtn = headerActions && headerActions.querySelector(SELECTORS.shareButton);
    if (existing) {
      if (!headerActions) return;
      existing.remove();
    }

    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.className = 'btn relative btn-ghost text-token-text-primary hover:bg-token-surface-hover keyboard-focused:bg-token-surface-hover rounded-lg max-sm:hidden';
    btn.title = 'Export conversation to Markdown';
    btn.innerHTML = `<div class="flex w-full items-center justify-center gap-1.5"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="-ms-0.5 icon"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Export</div>`;
    btn.addEventListener('click', handleExport);

    if (shareBtn) {
      // Borrow Share's classes so the button tracks ChatGPT's current styling.
      btn.className = shareBtn.className;
      shareBtn.parentElement.insertBefore(btn, shareBtn);
    } else if (headerActions) {
      headerActions.prepend(btn);
    } else {
      // Fallback: fixed position via CSS
      document.body.appendChild(btn);
    }
  }

  function removeButton() {
    const btn = document.getElementById(BUTTON_ID);
    if (btn) btn.remove();
  }

  // ── Export handler ────────────────────────────────────────────────────

  async function handleExport() {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn || btn.disabled) return;

    if (isStreaming()) {
      showToast('Wait for the response to finish before exporting.');
      return;
    }

    btn.disabled = true;
    btn.classList.add('exporting');

    try {
      let markdown = null;
      let title = getConversationTitle();
      let conversationId = null;
      let partialReason = null;
      const images = [];
      try {
        const data = await fetchConversationWithRetry(() => {
          showToast('ChatGPT is rate-limiting requests. Export will retry automatically once it recovers…', { sticky: true });
        });
        markdown = conversationToMarkdown(data, images);
        if (data.title) title = data.title;
        conversationId = data.conversation_id || getConversationId();
      } catch (err) {
        // The DOM only holds the turns ChatGPT has rendered, so a scrape of
        // a long conversation can be incomplete. Say so rather than fail.
        console.warn('[ChatGPT Export] API export failed; scraping the page instead.', err);
        markdown = scrapeConversation();
        partialReason = err && err.status === 429
          ? 'ChatGPT is rate-limiting requests'
          : 'couldn\'t load the full conversation';
      }
      if (!markdown) {
        showToast('No conversation content found.');
        return;
      }

      const baseName = sanitizeFilename(title);
      let filename = baseName + '.md';
      let missingImages = 0;
      if (images.length) {
        // Images need relative paths that survive moving the export, so a
        // conversation with images becomes a folder: <title>/<title>.md + images/.
        showToast('Downloading ' + images.length + ' image' + (images.length === 1 ? '' : 's') + '…');
        const result = await exportImages(markdown, images, conversationId, baseName);
        markdown = result.markdown;
        missingImages = result.missing;
        if (result.saved) filename = baseName + '/' + baseName + '.md';
      }

      const response = await downloadBlob(new Blob([markdown], { type: 'application/octet-stream' }), filename);
      if (response && response.success) {
        let message = 'Exported!';
        if (partialReason) message = 'Exported visible messages only — ' + partialReason + '.';
        else if (missingImages) message = 'Exported, but ' + missingImages + ' image' + (missingImages === 1 ? '' : 's') + ' couldn\'t be downloaded.';
        showToast(message);
      } else {
        showToast('Export failed — check downloads permissions.');
      }
    } catch (err) {
      console.error('[ChatGPT Export]', err);
      showToast('Export failed.');
    } finally {
      btn.disabled = false;
      btn.classList.remove('exporting');
    }
  }

  // ── Conversation API ──────────────────────────────────────────────────
  // The same undocumented endpoint ChatGPT's own UI loads conversations
  // from. Unlike the DOM it always holds every turn. Requests stay on
  // chatgpt.com with the user's existing session.

  let accessTokenPromise = null;

  function getConversationId() {
    const match = location.pathname.match(/\/c\/([^/]+)/);
    return match ? match[1] : null;
  }

  function getAccessToken() {
    if (!accessTokenPromise) {
      accessTokenPromise = fetch('/api/auth/session')
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error('session HTTP ' + res.status))))
        .then((session) => session.accessToken || Promise.reject(new Error('no accessToken in session')))
        .catch((err) => {
          accessTokenPromise = null;
          throw err;
        });
    }
    return accessTokenPromise;
  }

  async function fetchConversation() {
    const id = getConversationId();
    if (!id) throw new Error('no conversation id in URL');

    let token = await getAccessToken();
    let res = await fetchConversationWith(id, token);
    if (res.status === 401) {
      // Cached token expired; fetch a fresh one once.
      accessTokenPromise = null;
      token = await getAccessToken();
      res = await fetchConversationWith(id, token);
    }
    if (!res.ok) throw httpError('conversation', res.status);

    const data = await res.json();
    if (!data || !data.mapping || !data.current_node) throw new Error('unexpected conversation shape');
    return data;
  }

  // 429s carry no Retry-After or rate-limit headers, so recovery is detected
  // by watching ChatGPT's own conversation requests succeed (zero extra
  // requests from us), with a fixed backoff in case the page stays idle.
  const RATE_LIMIT_BACKOFF_MS = [30000, 60000, 120000, 240000];

  async function fetchConversationWithRetry(onRateLimited) {
    const startId = getConversationId();
    let lastError = null;
    for (let attempt = 0; attempt <= RATE_LIMIT_BACKOFF_MS.length; attempt++) {
      if (attempt > 0) {
        if (attempt === 1) onRateLimited();
        await waitForRateLimitRecovery(RATE_LIMIT_BACKOFF_MS[attempt - 1]);
        if (getConversationId() !== startId) throw new Error('navigated away while rate-limited');
      }
      try {
        return await fetchConversation();
      } catch (err) {
        if (err.status !== 429) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  // Resolves when the page's own /backend-api/conversation(s) request
  // returns 200, or after timeoutMs, whichever comes first.
  function waitForRateLimitRecovery(timeoutMs) {
    return new Promise((resolve) => {
      let observer = null;
      const done = () => {
        clearTimeout(timer);
        if (observer) observer.disconnect();
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      try {
        observer = new PerformanceObserver((list) => {
          const recovered = list.getEntries().some((entry) =>
            entry.responseStatus === 200 && /\/backend-api\/conversations?[/?]/.test(entry.name));
          if (recovered) done();
        });
        observer.observe({ type: 'resource' });
      } catch (err) {
        observer = null; // No PerformanceObserver/responseStatus: backoff only.
      }
    });
  }

  function httpError(what, status) {
    const err = new Error(what + ' HTTP ' + status);
    err.status = status;
    return err;
  }

  function fetchConversationWith(id, token) {
    return fetch('/backend-api/conversation/' + encodeURIComponent(id), {
      headers: { Authorization: 'Bearer ' + token },
    });
  }

  function conversationToMarkdown(data, images) {
    // mapping is a tree (edits/regenerations branch it); current_node is the
    // leaf of the branch on screen, so walk up from it.
    const path = [];
    const seen = new Set();
    for (let id = data.current_node; id && data.mapping[id] && !seen.has(id); id = data.mapping[id].parent) {
      seen.add(id);
      path.unshift(data.mapping[id]);
    }

    const parts = [];
    if (data.title) {
      parts.push('# ' + data.title);
      parts.push('');
    }

    let lastRole = null;
    path.forEach((node) => {
      const message = node.message;
      if (!message) return;
      const rendered = renderApiMessage(message, images);
      if (!rendered) return;

      if (rendered.role !== lastRole) {
        parts.push(rendered.role === 'user' ? '##### You said:' : '###### ChatGPT said:');
        parts.push('');
        lastRole = rendered.role;
      }
      parts.push(rendered.text.trim());
      parts.push('');
    });

    if (!lastRole) return null;
    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  // Returns { role, text } for messages the ChatGPT UI shows, else null.
  // Tool calls, tool results, and reasoning ("thoughts") are hidden in the
  // UI and skipped here too.
  function renderApiMessage(message, images) {
    const metadata = message.metadata || {};
    if (metadata.is_visually_hidden_from_conversation) return null;

    const role = message.author && message.author.role;
    const content = message.content || {};
    const contentParts = Array.isArray(content.parts) ? content.parts : [];

    if (role === 'user') {
      if (content.content_type !== 'text' && content.content_type !== 'multimodal_text') return null;
      const text = contentParts
        .map((part) => (typeof part === 'string' ? part : renderAssetPart(part, 'Image attachment', images)))
        .filter(Boolean)
        .join('\n\n');
      return text.trim() ? { role, text } : null;
    }

    if (role === 'assistant') {
      if (message.recipient !== 'all' || content.content_type !== 'text') return null;
      const raw = contentParts.filter((part) => typeof part === 'string').join('\n\n');
      const text = applyContentReferences(raw, metadata.content_references);
      return text.trim() ? { role, text } : null;
    }

    // Image generation results arrive as tool messages but render as part of
    // the assistant's reply.
    if (role === 'tool' && content.content_type === 'multimodal_text') {
      const generated = contentParts
        .filter((part) => part && part.content_type === 'image_asset_pointer' && part.metadata && part.metadata.dalle)
        .map((part) => renderAssetPart(part, 'Generated image', images));
      return generated.length ? { role: 'assistant', text: generated.join('\n\n') } : null;
    }

    return null;
  }

  // Asset pointers (sediment://, file-service://) only resolve inside
  // ChatGPT. Emit a token that exportImages() swaps for a local image link,
  // or for a placeholder if the image can't be fetched.
  function renderAssetPart(part, label, images) {
    if (!part || part.content_type !== 'image_asset_pointer') return '';
    const fileId = String(part.asset_pointer || '').split('://')[1];
    if (!fileId) return '*[' + label + ']*';
    images.push({ fileId, label });
    return imageToken(images.length - 1);
  }

  function imageToken(index) {
    return '\u0000IMG' + index + '\u0000';
  }

  // ── Image export ──────────────────────────────────────────────────────

  const IMAGE_MAX_DIMENSION = 1600;
  const IMAGE_WEBP_QUALITY = 0.7;
  const IMAGE_CONCURRENCY = 2;

  async function exportImages(markdown, images, conversationId, baseName) {
    const saved = new Map(); // fileId -> relative path, so repeats download once
    let missing = 0;

    const unique = [...new Set(images.map((image) => image.fileId))];
    let next = 0;
    async function worker() {
      while (next < unique.length) {
        const fileId = unique[next++];
        try {
          const original = await fetchImageBlob(fileId, conversationId);
          const blob = await compressImage(original);
          const relative = 'images/' + sanitizeFilename(fileId) + '.' + extensionFor(blob.type);
          // Re-exports reuse the folder; the same fileId is the same image,
          // so overwriting keeps the .md's relative links valid.
          const response = await downloadBlob(blob, baseName + '/' + relative, 'overwrite');
          if (!response || !response.success) throw new Error((response && response.error) || 'download failed');
          saved.set(fileId, relative);
        } catch (err) {
          console.warn('[ChatGPT Export] Image ' + fileId + ' not exported:', err);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, unique.length) }, worker));

    const result = markdown.replace(/\u0000IMG(\d+)\u0000/g, (match, index) => {
      const image = images[Number(index)];
      const relative = saved.get(image.fileId);
      if (relative) return '![' + image.label + '](' + relative + ')';
      missing++;
      return '*[' + image.label + ']*';
    });
    return { markdown: result, missing, saved: saved.size };
  }

  // Both endpoint shapes are tried: ChatGPT has served file downloads from
  // each, and they return { download_url } pointing at the bytes.
  async function fetchImageBlob(fileId, conversationId) {
    const token = await getAccessToken();
    const query = conversationId ? '?conversation_id=' + encodeURIComponent(conversationId) + '&inline=false' : '';
    const endpoints = [
      '/backend-api/files/download/' + encodeURIComponent(fileId) + query,
      '/backend-api/files/' + encodeURIComponent(fileId) + '/download',
    ];

    let lastError = null;
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) throw httpError('file lookup', res.status);
        const info = await res.json();
        if (!info.download_url) throw new Error('no download_url');
        const file = await fetch(new URL(info.download_url, location.origin).href);
        if (!file.ok) throw httpError('file', file.status);
        return await file.blob();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  async function compressImage(blob) {
    // GIFs may be animated and SVGs are already small vectors; keep both.
    if (!/^image\/(png|jpeg|webp|bmp)$/.test(blob.type)) return blob;
    try {
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
      const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const compressed = await canvas.convertToBlob({ type: 'image/webp', quality: IMAGE_WEBP_QUALITY });
      return compressed.size < blob.size ? compressed : blob;
    } catch (err) {
      console.warn('[ChatGPT Export] Image compression failed; keeping original.', err);
      return blob;
    }
  }

  function extensionFor(mimeType) {
    const map = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp' };
    return map[mimeType] || 'bin';
  }

  function downloadBlob(blob, filename, conflictAction) {
    const url = URL.createObjectURL(blob);
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'download', url, filename, conflictAction }, (response) => {
        URL.revokeObjectURL(url);
        resolve(response);
      });
    });
  }

  // Assistant text carries private-use markers (U+E200 … U+E201) where the
  // UI shows citations and inline links. Each content_reference names its
  // marker in matched_text and, for web sources, ready-made Markdown in alt.
  function applyContentReferences(text, references) {
    let result = '';
    let cursor = 0;
    const ordered = (references || [])
      .filter((ref) => ref && ref.matched_text && ref.matched_text.trim())
      .sort((a, b) => (a.start_idx || 0) - (b.start_idx || 0));

    ordered.forEach((ref) => {
      // start_idx may not count UTF-16 units, so locate the marker by text.
      const index = text.indexOf(ref.matched_text, cursor);
      if (index === -1) return;
      result += text.slice(cursor, index) + renderContentReference(ref);
      cursor = index + ref.matched_text.length;
    });
    result += text.slice(cursor);

    // Drop any markers no reference explained.
    return result.replace(/\ue200[^\ue201]*\ue201/g, '');
  }

  function renderContentReference(ref) {
    // Markers sit where the UI shows the chip, already spaced from the text.
    if (typeof ref.alt === 'string') return ref.alt;
    if (ref.type === 'file' && ref.name) {
      return ref.cloud_doc_url
        ? '([' + ref.name + '](' + ref.cloud_doc_url + '))'
        : '(' + ref.name + ')';
    }
    return '';
  }

  // ── Selector health check ─────────────────────────────────────────────

  const WARNING_ID = 'chatgpt-export-warning';
  const WARNING_DISMISSED_KEY = 'chatgpt-export-warning-dismissed';
  // Turns render progressively after navigation; only warn once they've had
  // this long to appear.
  const HEALTH_CHECK_TIMEOUT_MS = 10000;
  const HEALTH_CHECK_LABELS = {
    turn: 'conversation turns',
    message: 'messages',
    userText: 'your message text',
    assistantContent: 'ChatGPT reply content',
    shareButton: 'header Share button',
  };
  let healthCheckTimer = null;

  function isSingleChatPage() {
    // Also matches project chats: /g/<project>/c/<id>
    return /\/c\/[^/]+/.test(location.pathname);
  }

  function findBrokenSelectors() {
    // Without turns nothing else can be checked meaningfully.
    if (!document.querySelector(SELECTORS.turn)) return ['turn'];

    const broken = [];
    const roles = Array.from(document.querySelectorAll(SELECTORS.message), getMessageRole);
    if (!roles.includes('user') && !roles.includes('assistant')) broken.push('message');
    if (roles.includes('user') && !document.querySelector(SELECTORS.userText)) broken.push('userText');
    if (roles.includes('assistant') && !document.querySelector(SELECTORS.assistantContent)) {
      broken.push('assistantContent');
    }

    const headerActions = document.querySelector(SELECTORS.headerActions);
    if (!headerActions || !headerActions.querySelector(SELECTORS.shareButton)) broken.push('shareButton');

    return broken;
  }

  function scheduleHealthCheck() {
    clearTimeout(healthCheckTimer);
    removeWarning();
    if (!isSingleChatPage()) return;

    const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;
    const run = () => {
      if (!isSingleChatPage()) return;
      const broken = findBrokenSelectors();
      if (!broken.length) return;
      if (Date.now() < deadline) {
        healthCheckTimer = setTimeout(run, 1000);
        return;
      }
      console.warn('[ChatGPT Export] Selectors not matching:', broken.map((key) => key + ': ' + SELECTORS[key]));
      showWarning(broken);
    };
    healthCheckTimer = setTimeout(run, 1000);
  }

  function showWarning(broken) {
    // Keyed on the failing set so a new breakage still surfaces after a dismiss.
    const signature = broken.join(',');
    try {
      if (sessionStorage.getItem(WARNING_DISMISSED_KEY) === signature) return;
    } catch (e) { /* storage blocked; show anyway */ }

    removeWarning();
    const warning = document.createElement('div');
    warning.id = WARNING_ID;
    warning.setAttribute('role', 'alert');

    const text = document.createElement('span');
    const headerOnly = signature === 'shareButton';
    text.textContent = 'ChatGPT Export can\'t find ' +
      broken.map((key) => HEALTH_CHECK_LABELS[key]).join(', ') +
      ' on this page. ChatGPT may have changed its layout' +
      (headerOnly
        ? ', so the Export button is in the bottom-right corner instead.'
        : ', so exports may be incomplete.');

    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => {
      try {
        sessionStorage.setItem(WARNING_DISMISSED_KEY, signature);
      } catch (e) { /* storage blocked; dismiss for this page only */ }
      removeWarning();
    });

    warning.append(text, close);
    document.body.appendChild(warning);
  }

  function removeWarning() {
    const warning = document.getElementById(WARNING_ID);
    if (warning) warning.remove();
  }

  // ── Toast notification ────────────────────────────────────────────────

  function showToast(message, { sticky = false } = {}) {
    const existing = document.getElementById('chatgpt-export-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'chatgpt-export-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    if (!sticky) setTimeout(() => toast.remove(), 2500);
  }

  // ── Conversation scraping ─────────────────────────────────────────────

  function scrapeConversation() {
    const turns = document.querySelectorAll(SELECTORS.turn);
    if (!turns.length) return null;

    const parts = [];
    const title = getConversationTitle();
    if (title && title !== 'conversation') {
      parts.push('# ' + title);
      parts.push('');
    }

    turns.forEach((article) => {
      // A single turn can contain multiple message blocks (preamble,
      // collapsed thinking, final response), each with its own
      // [data-message-author-role] and .markdown.prose. Process each.
      // Since 2026-10 one turn holds a user message AND its reply, so the
      // speaker header is emitted whenever the role changes.
      const messages = article.querySelectorAll(SELECTORS.message);
      if (!messages.length) return;

      let lastRole = null;

      messages.forEach((messageEl) => {
        const authorRole = getMessageRole(messageEl);
        if (authorRole !== 'user' && authorRole !== 'assistant') return;

        if (authorRole !== lastRole) {
          parts.push(authorRole === 'user' ? '##### You said:' : '###### ChatGPT said:');
          parts.push('');
          lastRole = authorRole;
        }

        if (authorRole === 'user') {
          const images = messageEl.querySelectorAll('img');
          images.forEach((img) => {
            const alt = img.getAttribute('alt') || 'Image';
            const src = img.getAttribute('src') || '';
            parts.push('![' + alt + '](' + src + ')');
            parts.push('');
          });

          const textEl = messageEl.querySelector(SELECTORS.userText);
          if (textEl) {
            parts.push(textEl.textContent.trim());
            parts.push('');
          }
        } else {
          const contentEl = messageEl.querySelector(SELECTORS.assistantContent);
          if (contentEl) {
            const md = htmlToMarkdown(contentEl);
            if (md) {
              parts.push(md.trim());
              parts.push('');
            }
          }
        }
      });
    });

    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  function getMessageRole(messageEl) {
    const role = messageEl.getAttribute('data-message-author-role');
    if (role) return role;
    // e.g. data-chatgpt-search-unit-key="fallback-turn-0:2:assistant"
    const key = messageEl.getAttribute('data-chatgpt-search-unit-key') || '';
    const match = key.match(/:(user|assistant)$/);
    return match ? match[1] : null;
  }

  // ── HTML-to-Markdown converter ────────────────────────────────────────

  function htmlToMarkdown(el) {
    return convertNode(el).replace(/\n{3,}/g, '\n\n').trim();
  }

  function convertNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const tag = node.tagName.toLowerCase();

    // Skip non-content elements
    if (tag === 'button' || tag === 'svg' || tag === 'style' || tag === 'script') {
      return '';
    }

    switch (tag) {
      case 'p':
        return convertChildren(node) + '\n\n';

      case 'br':
        return '\n';

      case 'strong':
      case 'b':
        return '**' + convertChildren(node) + '**';

      case 'em':
      case 'i':
        return '*' + convertChildren(node) + '*';

      case 'del':
      case 's':
        return '~~' + convertChildren(node) + '~~';

      case 'code': {
        // Inline code (not inside <pre>)
        if (!node.parentElement || node.parentElement.tagName.toLowerCase() !== 'pre') {
          return '`' + node.textContent + '`';
        }
        // Code block inside <pre> — handled by the 'pre' case
        return node.textContent;
      }

      case 'pre': {
        const codeEl = node.querySelector('code');
        const code = codeEl ? codeEl.textContent : node.textContent;
        let lang = '';
        if (codeEl) {
          const className = codeEl.className || '';
          const match = className.match(/language-(\S+)/);
          if (match) lang = match[1];
        }
        return '\n```' + lang + '\n' + code.replace(/\n$/, '') + '\n```\n\n';
      }

      case 'h1':
        return '# ' + convertChildren(node) + '\n\n';
      case 'h2':
        return '## ' + convertChildren(node) + '\n\n';
      case 'h3':
        return '### ' + convertChildren(node) + '\n\n';
      case 'h4':
        return '#### ' + convertChildren(node) + '\n\n';
      case 'h5':
        return '##### ' + convertChildren(node) + '\n\n';
      case 'h6':
        return '###### ' + convertChildren(node) + '\n\n';

      case 'ul':
        return convertList(node, false) + '\n\n';
      case 'ol':
        return convertList(node, true) + '\n\n';

      case 'li': {
        // Handled by convertList
        return convertChildren(node).replace(/\n+$/, '');
      }

      case 'blockquote':
        return convertChildren(node)
          .trim()
          .split('\n')
          .map((line) => '> ' + line)
          .join('\n') + '\n\n';

      case 'a': {
        if (node.matches(SELECTORS.citation)) return convertCitation(node);
        const href = node.getAttribute('href') || '';
        const text = convertChildren(node);
        if (!href || href === text) return text;
        return '[' + text + '](' + href + ')';
      }

      case 'img': {
        const alt = node.getAttribute('alt') || 'Image';
        const src = node.getAttribute('src') || '';
        return '![' + alt + '](' + src + ')';
      }

      case 'hr':
        return '\n---\n\n';

      case 'table':
        return convertTable(node) + '\n';

      case 'sup':
        return '<sup>' + convertChildren(node) + '</sup>';
      case 'sub':
        return '<sub>' + convertChildren(node) + '</sub>';

      default:
        return convertChildren(node);
    }
  }

  // Citation chips have no href; the source name and URL live in aria-label:
  // "Realtor: <page title>, https://…, 1 additional source".
  function convertCitation(node) {
    const label = node.getAttribute('aria-label') || '';
    const url = (label.match(/https?:\/\/[^\s,]+/) || [])[0];
    const name = (label.split(':')[0] || node.textContent).trim();
    if (!url) return name ? ' (' + name + ')' : '';
    return ' ([' + name + '](' + url + '))';
  }

  function convertChildren(node) {
    let result = '';
    node.childNodes.forEach((child) => {
      result += convertNode(child);
    });
    return result;
  }

  function convertList(listEl, ordered, depth = 0) {
    const items = [];
    const indent = '  '.repeat(depth);
    let counter = 1;

    for (const child of listEl.children) {
      if (child.tagName.toLowerCase() !== 'li') continue;

      let content = '';
      const subParts = [];

      for (const liChild of child.childNodes) {
        if (liChild.nodeType === Node.ELEMENT_NODE) {
          const childTag = liChild.tagName.toLowerCase();
          if (childTag === 'ul') {
            subParts.push(convertList(liChild, false, depth + 1));
          } else if (childTag === 'ol') {
            subParts.push(convertList(liChild, true, depth + 1));
          } else {
            content += convertNode(liChild);
          }
        } else {
          content += convertNode(liChild);
        }
      }

      content = content.replace(/\n+$/, '').replace(/^\n+/, '');
      const bullet = ordered ? counter + '. ' : '- ';
      items.push(indent + bullet + content);

      if (subParts.length) {
        items.push(subParts.join('\n'));
      }

      counter++;
    }

    return items.join('\n');
  }

  function convertTable(tableEl) {
    const rows = [];
    const headerCells = [];
    const bodyRows = [];

    // Extract header
    const thead = tableEl.querySelector('thead');
    if (thead) {
      const tr = thead.querySelector('tr');
      if (tr) {
        for (const th of tr.querySelectorAll('th, td')) {
          headerCells.push(convertChildren(th).trim());
        }
      }
    }

    // Extract body
    const tbody = tableEl.querySelector('tbody') || tableEl;
    for (const tr of tbody.querySelectorAll('tr')) {
      // Skip header row if already captured
      if (thead && tr.parentElement === thead) continue;

      const cells = [];
      for (const td of tr.querySelectorAll('td, th')) {
        cells.push(convertChildren(td).trim());
      }

      // If no explicit thead, use first row as header
      if (!headerCells.length && !bodyRows.length) {
        headerCells.push(...cells);
      } else {
        bodyRows.push(cells);
      }
    }

    if (!headerCells.length) return '';

    rows.push('| ' + headerCells.join(' | ') + ' |');
    rows.push('| ' + headerCells.map(() => '---').join(' | ') + ' |');
    bodyRows.forEach((cells) => {
      // Pad cells to match header length
      while (cells.length < headerCells.length) cells.push('');
      rows.push('| ' + cells.join(' | ') + ' |');
    });

    return rows.join('\n') + '\n';
  }

  // ── MutationObserver for SPA navigation ───────────────────────────────

  function onPageChange() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const currentUrl = location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        removeButton();
        scheduleHealthCheck();
      }
      if (isConversationPage()) {
        injectButton();
      } else {
        removeButton();
      }
    }, 300);
  }

  const observer = new MutationObserver(onPageChange);
  observer.observe(document.body, { childList: true, subtree: true });

  // Also listen for History API navigation
  const origPushState = history.pushState;
  history.pushState = function () {
    origPushState.apply(this, arguments);
    onPageChange();
  };
  const origReplaceState = history.replaceState;
  history.replaceState = function () {
    origReplaceState.apply(this, arguments);
    onPageChange();
  };
  window.addEventListener('popstate', onPageChange);

  // ── Initial injection ─────────────────────────────────────────────────

  if (isConversationPage()) {
    injectButton();
  }
  scheduleHealthCheck();
})();
