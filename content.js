(() => {
  'use strict';

  const BUTTON_ID = 'chatgpt-export-btn';
  const SELECTORS = {
    thread: '#thread',
    turn: 'article[data-testid^="conversation-turn-"]',
    messageRole: '[data-message-author-role]',
    userText: '.whitespace-pre-wrap',
    assistantContent: '.markdown.prose',
    streamingIndicator: '[data-writing-block]',
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
    if (document.getElementById(BUTTON_ID)) return;
    if (!isConversationPage()) return;

    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.title = 'Export conversation to Markdown';
    btn.innerHTML = `<div class="flex w-full items-center justify-center gap-1.5"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="-ms-0.5 icon"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Export</div>`;
    btn.addEventListener('click', handleExport);

    // Inject next to the share button in #conversation-header-actions
    const headerActions = document.getElementById('conversation-header-actions');
    const shareBtn = headerActions && headerActions.querySelector('[data-testid="share-chat-button"]');
    if (shareBtn) {
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
      const markdown = scrapeConversation();
      if (!markdown) {
        showToast('No conversation content found.');
        return;
      }

      const title = getConversationTitle();
      const filename = sanitizeFilename(title) + '.md';

      chrome.runtime.sendMessage(
        { action: 'download', markdown, filename },
        (response) => {
          if (response && response.success) {
            showToast('Exported!');
          } else {
            showToast('Export failed — check downloads permissions.');
          }
        }
      );
    } catch (err) {
      console.error('[ChatGPT Export]', err);
      showToast('Export failed.');
    } finally {
      btn.disabled = false;
      btn.classList.remove('exporting');
    }
  }

  // ── Toast notification ────────────────────────────────────────────────

  function showToast(message) {
    const existing = document.getElementById('chatgpt-export-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'chatgpt-export-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 2500);
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
      const messageEl = article.querySelector(SELECTORS.messageRole);
      if (!messageEl) return;

      const authorRole = messageEl.getAttribute('data-message-author-role');

      if (authorRole === 'user') {
        parts.push('##### You said:');
      } else {
        parts.push('###### ChatGPT said:');
      }
      parts.push('');

      if (authorRole === 'user') {
        // User messages: extract images first, then text
        const images = article.querySelectorAll('img');
        images.forEach((img) => {
          const alt = img.getAttribute('alt') || 'Image';
          const src = img.getAttribute('src') || '';
          parts.push('![' + alt + '](' + src + ')');
          parts.push('');
        });

        const textEl = article.querySelector(SELECTORS.userText);
        if (textEl) {
          parts.push(textEl.textContent.trim());
          parts.push('');
        }
      } else {
        // Assistant messages: convert rich HTML to Markdown
        const contentEl = article.querySelector(SELECTORS.assistantContent);
        if (contentEl) {
          const md = htmlToMarkdown(contentEl);
          parts.push(md.trim());
          parts.push('');
        }
      }
    });

    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
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
        return convertList(node, false) + '\n';
      case 'ol':
        return convertList(node, true) + '\n';

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
})();
