import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../assets/js/markdown.js';
import { htmlToMarkdown } from './import-html-to-md.js';

describe('htmlToMarkdown', () => {
  it('converts a paragraph with bold, italic and a link', () => {
    const md = htmlToMarkdown('<p>Some <strong>bold</strong> and <em>italic</em> text with a <a href="https://example.com">link</a>.</p>');
    expect(md).toBe('Some **bold** and *italic* text with a [link](https://example.com).');
  });

  it('converts headings to ATX style', () => {
    expect(htmlToMarkdown('<h2>A heading</h2>')).toBe('## A heading');
  });

  it('converts an unordered list', () => {
    const md = htmlToMarkdown('<ul><li>First</li><li>Second</li></ul>');
    expect(md).toBe('- First\n- Second');
  });

  it('converts an ordered list with numbering', () => {
    const md = htmlToMarkdown('<ol><li>First</li><li>Second</li></ol>');
    expect(md).toBe('1. First\n2. Second');
  });

  it('converts a nested list to indented continuation lines', () => {
    const md = htmlToMarkdown('<ul><li>Outer<ul><li>Inner</li></ul></li></ul>');
    expect(md).toBe('- Outer\n  - Inner');
    // Round-trips through the actual renderer without throwing or losing the nested bullet text.
    expect(renderMarkdown(md)).toContain('Inner');
  });

  it('converts an image, passing the src through rewriteUrl', () => {
    const md = htmlToMarkdown('<p><img src="https://old.example.com/photo.jpg" alt="A photo"></p>', {
      rewriteUrl: (url) => url.replace('https://old.example.com', ''),
    });
    expect(md).toBe('![A photo](/photo.jpg)');
  });

  it('rewrites a link href but leaves an unmatched url untouched', () => {
    const md = htmlToMarkdown(
      '<p><a href="https://old.example.com/other-post">internal</a> and <a href="https://unsplash.com/x">external</a></p>',
      { rewriteUrl: (url) => (url.startsWith('https://old.example.com') ? '/posts/other-post' : url) }
    );
    expect(md).toBe('[internal](/posts/other-post) and [external](https://unsplash.com/x)');
  });

  it('converts a fenced code block, preserving the language class', () => {
    const md = htmlToMarkdown('<pre><code class="language-js">const x = 1;</code></pre>');
    expect(md).toBe('```js\nconst x = 1;\n```');
  });

  it('converts a blockquote, including a multi-paragraph one', () => {
    const md = htmlToMarkdown('<blockquote><p>First.</p><p>Second.</p></blockquote>');
    expect(md).toBe('> First.\n>\n> Second.');
  });

  it('converts a table with a header row', () => {
    const md = htmlToMarkdown('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
    expect(md).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(renderMarkdown(md)).toContain('<table>');
  });

  it('strips Gutenberg block comments entirely', () => {
    const md = htmlToMarkdown('<!-- wp:paragraph --><p>Hello.</p><!-- /wp:paragraph -->');
    expect(md).toBe('Hello.');
  });

  it('unwraps an unrecognised wrapper tag (page-builder div) but keeps its content', () => {
    const md = htmlToMarkdown('<div class="elementor-widget"><p>Still here.</p></div>');
    expect(md).toBe('Still here.');
  });

  it('unwraps a figure/figcaption pair into an image paragraph plus a caption paragraph', () => {
    const md = htmlToMarkdown('<figure><img src="/x.jpg" alt="alt text"><figcaption>A caption</figcaption></figure>');
    expect(md).toBe('![alt text](/x.jpg)\n\nA caption');
  });

  it('decodes HTML entities in text', () => {
    expect(htmlToMarkdown('<p>Tea &amp; biscuits &mdash; lovely.</p>')).toBe('Tea & biscuits — lovely.');
  });

  it('returns an empty string for empty or whitespace-only input', () => {
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToMarkdown('   ')).toBe('');
  });

  it('produces output the real renderer round-trips back into the expected HTML shape', () => {
    const md = htmlToMarkdown('<h1>Title</h1><p>A <strong>bold</strong> paragraph.</p><ul><li>One</li><li>Two</li></ul>');
    const html = renderMarkdown(md);
    expect(html).toContain('<h1 id="title">Title</h1>');
    expect(html).toContain('<p>A <strong>bold</strong> paragraph.</p>');
    expect(html).toContain('<ul><li>One</li><li>Two</li></ul>');
  });
});
