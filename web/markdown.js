// Tiny markdown subset for milestone notes. parseMarkdown() returns a plain tree and never
// produces HTML; renderMarkdown() turns that tree into DOM nodes using only textContent.
//
// Block nodes:  { type: 'p', children } | { type: 'ul' | 'ol', items: [children, ...] }
// Inline nodes: { type: 'text', value } | { type: 'br' } | { type: 'code', value }
//               | { type: 'strong' | 'em', children } | { type: 'link', href, children }

const SAFE_URL_RE = /^(https?:\/\/|mailto:)[^\s\u0000-\u001f\"<>]+$/i;
const LINK_RE = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;
const BARE_URL_RE = /^https?:\/\/[^\s<>"'`]+/i;
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]]+$/;
const BULLET_RE = /^[-*] +(.*)$/;
const NUMBERED_RE = /^\d+\. +(.*)$/;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

export function isSafeUrl(href) {
  if (!SAFE_URL_RE.test(href)) return false;
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(href).protocol);
  } catch {
    return false;
  }
}

const textNode = (value) => ({ type: 'text', value });

// Index of the closing `marker` after `from`, with a non-empty, non-space-padded span; else -1.
function findClosing(text, marker, from) {
  const end = text.indexOf(marker, from + marker.length);
  if (end === -1) return -1;
  const inner = text.slice(from + marker.length, end);
  return inner.trim() === inner && inner !== '' ? end : -1;
}

function parseInline(text, allowLinks = true) {
  const nodes = [];
  let plain = '';
  const flush = () => {
    if (plain) nodes.push(textNode(plain));
    plain = '';
  };
  const push = (node) => {
    flush();
    nodes.push(node);
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : '';

    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        push({ type: 'code', value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (rest.startsWith('**')) {
      const end = findClosing(text, '**', i);
      if (end !== -1) {
        push({ type: 'strong', children: parseInline(text.slice(i + 2, end), allowLinks) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === '*' || (ch === '_' && !WORD_CHAR_RE.test(prev))) && !rest.startsWith('**')) {
      const end = findClosing(text, ch, i);
      if (end !== -1 && (ch === '*' || !WORD_CHAR_RE.test(text[end + 1] ?? ''))) {
        push({ type: 'em', children: parseInline(text.slice(i + 1, end), allowLinks) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[' && allowLinks) {
      const m = LINK_RE.exec(rest);
      if (m) {
        if (isSafeUrl(m[2])) push({ type: 'link', href: m[2], children: parseInline(m[1], false) });
        else plain += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (ch === 'h' && allowLinks && !WORD_CHAR_RE.test(prev)) {
      const m = BARE_URL_RE.exec(rest);
      if (m) {
        const url = m[0].replace(TRAILING_PUNCTUATION_RE, '');
        if (isSafeUrl(url)) {
          push({ type: 'link', href: url, children: [textNode(url)] });
          i += url.length;
          continue;
        }
      }
    }
    plain += ch;
    i += 1;
  }
  flush();
  return nodes;
}

function inlineWithBreaks(lines) {
  const out = [];
  lines.forEach((line, index) => {
    if (index > 0) out.push({ type: 'br' });
    out.push(...parseInline(line));
  });
  return out;
}

export function parseMarkdown(source) {
  const blocks = [];
  let paragraph = [];
  let list = null;
  const closeParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'p', children: inlineWithBreaks(paragraph) });
    paragraph = [];
  };
  const closeList = () => { list = null; };

  for (const raw of String(source).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeParagraph();
      closeList();
      continue;
    }
    const bullet = BULLET_RE.exec(line.trim());
    const numbered = bullet ? null : NUMBERED_RE.exec(line.trim());
    const item = bullet ?? numbered;
    if (item) {
      closeParagraph();
      const type = bullet ? 'ul' : 'ol';
      if (!list || list.type !== type) {
        list = { type, items: [] };
        blocks.push(list);
      }
      list.items.push(parseInline(item[1]));
    } else {
      closeList();
      paragraph.push(line);
    }
  }
  closeParagraph();
  return blocks;
}

function renderInline(node, doc) {
  switch (node.type) {
    case 'text': return doc.createTextNode(node.value);
    case 'br': return doc.createElement('br');
    case 'link': {
      const a = doc.createElement('a');
      a.setAttribute('href', node.href);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      a.append(...node.children.map((c) => renderInline(c, doc)));
      return a;
    }
    default: {
      const el = doc.createElement(node.type === 'code' ? 'code' : node.type);
      if (node.type === 'code') el.textContent = node.value;
      else el.append(...node.children.map((c) => renderInline(c, doc)));
      return el;
    }
  }
}

function renderBlock(block, doc) {
  if (block.type === 'p') {
    const p = doc.createElement('p');
    p.append(...block.children.map((c) => renderInline(c, doc)));
    return p;
  }
  const list = doc.createElement(block.type);
  for (const children of block.items) {
    const li = doc.createElement('li');
    li.append(...children.map((c) => renderInline(c, doc)));
    list.append(li);
  }
  return list;
}

export function renderMarkdown(source, doc = document) {
  const root = doc.createElement('div');
  root.className = 'notes-md';
  root.append(...parseMarkdown(source).map((b) => renderBlock(b, doc)));
  return root;
}
