import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeUrl, parseMarkdown, renderMarkdown } from '../web/markdown.js';

const para = (source) => parseMarkdown(source)[0].children;
const types = (nodes) => nodes.map((n) => n.type);

test('paragraphs and line breaks', () => {
  const blocks = parseMarkdown('one\ntwo\n\nthree');
  assert.deepEqual(blocks.map((b) => b.type), ['p', 'p']);
  assert.deepEqual(types(blocks[0].children), ['text', 'br', 'text']);
  assert.deepEqual(parseMarkdown('  \n\n'), []);
});

test('bold, italic and inline code', () => {
  assert.deepEqual(para('a **b** *c* _d_ `e`'), [
    { type: 'text', value: 'a ' }, { type: 'strong', children: [{ type: 'text', value: 'b' }] },
    { type: 'text', value: ' ' }, { type: 'em', children: [{ type: 'text', value: 'c' }] },
    { type: 'text', value: ' ' }, { type: 'em', children: [{ type: 'text', value: 'd' }] },
    { type: 'text', value: ' ' }, { type: 'code', value: 'e' },
  ]);
  assert.equal(para('snake_case_name')[0].value, 'snake_case_name');
  assert.equal(para('2 * 3 * 4')[0].value, '2 * 3 * 4');
  assert.equal(para('**unclosed')[0].value, '**unclosed');
});

test('code content is literal', () => {
  assert.deepEqual(para('`**x** <b>`'), [{ type: 'code', value: '**x** <b>' }]);
});

test('safe links become link nodes', () => {
  const [link] = para('[docs](https://example.com/a?b=1)');
  assert.deepEqual(link, { type: 'link', href: 'https://example.com/a?b=1', children: [{ type: 'text', value: 'docs' }] });
  assert.equal(para('[m](mailto:a@b.co)')[0].href, 'mailto:a@b.co');
  assert.equal(para('[h](http://x.org)')[0].type, 'link');
});

test('unsafe link targets stay plain text', () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hi', 'vbscript:x', '//evil.com', 'ftp://x.org']) {
    const nodes = para(`[x](${url})`);
    assert.deepEqual(types(nodes), ['text'], url);
    assert.equal(nodes[0].value, `[x](${url})`);
  }
  assert.equal(isSafeUrl('java\tscript:alert(1)'), false);
});

test('attribute injection through quotes or angle brackets is not a link', () => {
  const nodes = para('[a](https://e.com/"onmouseover="alert(1))');
  assert.ok(!nodes.some((n) => n.type === 'link'));
  assert.ok(!para('https://e.com/"onfocus=1')[0].href?.includes('"'));
});

test('bare http(s) urls are autolinked without trailing punctuation', () => {
  const nodes = para('see https://example.com/x. then (http://a.b/c), ok');
  const links = nodes.filter((n) => n.type === 'link');
  assert.deepEqual(links.map((l) => l.href), ['https://example.com/x', 'http://a.b/c']);
  assert.deepEqual(types(para('javascript:alert(1) and ftp://x.org')), ['text']);
  assert.deepEqual(types(para('xhttps://a.b')), ['text']);
});

test('lists', () => {
  const blocks = parseMarkdown('- a\n* **b**\n\n1. x\n2. y');
  assert.equal(blocks[0].type, 'ul');
  assert.equal(blocks[0].items.length, 2);
  assert.equal(blocks[0].items[1][0].type, 'strong');
  assert.equal(blocks[1].type, 'ol');
  assert.equal(blocks[1].items.length, 2);
  assert.deepEqual(parseMarkdown('- a\n1. b').map((b) => b.type), ['ul', 'ol']);
});

test('headings, images and html are plain text', () => {
  assert.deepEqual(para('# title'), [{ type: 'text', value: '# title' }]);
  assert.deepEqual(types(para('![alt](https://x.org/i.png)')), ['text', 'link']);
  const nodes = para('<script>alert(1)</script><img src=x onerror=alert(1)>');
  assert.deepEqual(nodes, [{ type: 'text', value: '<script>alert(1)</script><img src=x onerror=alert(1)>' }]);
});

// A minimal document stand-in that records what the renderer creates.
function fakeDocument() {
  const make = (tag) => ({
    tag, attrs: {}, children: [], className: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...kids) { this.children.push(...kids); },
    set textContent(v) { this.children = [{ text: v }]; },
  });
  return { createElement: make, createTextNode: (text) => ({ text }) };
}

test('renderMarkdown builds elements and sets text only as text nodes', () => {
  const doc = fakeDocument();
  const root = renderMarkdown('**b** <script>x</script> [l](https://e.com)', doc);
  assert.equal(root.tag, 'div');
  const [p] = root.children;
  assert.equal(p.tag, 'p');
  const [strong, text, link] = p.children;
  assert.equal(strong.tag, 'strong');
  assert.deepEqual(text, { text: ' <script>x</script> ' });
  assert.equal(link.tag, 'a');
  assert.deepEqual(link.attrs, { href: 'https://e.com', target: '_blank', rel: 'noopener noreferrer' });
  assert.ok(!JSON.stringify(root).includes('innerHTML'));
});
