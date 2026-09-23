import { describe, expect, it } from 'vitest';
import { embedFrameSrcOrigins, embedShortcodeReference, renderMarkdown } from '../assets/js/markdown.js';

describe('embed shortcodes', () => {
  it('renders {{apple-music: <url>}} as a sandboxed embed iframe', () => {
    const html = renderMarkdown('{{apple-music: https://music.apple.com/us/album/some-album/1440921045}}');
    expect(html).toContain('<iframe');
    expect(html).toContain('src="https://embed.music.apple.com/us/album/some-album/1440921045"');
    expect(html).toContain('sandbox=');
  });

  it('also rewrites an open.music.apple.com share link', () => {
    const html = renderMarkdown('{{apple-music: https://open.music.apple.com/us/album/x/1}}');
    expect(html).toContain('src="https://embed.music.apple.com/us/album/x/1"');
  });

  it('tolerates loose spacing inside the braces', () => {
    const html = renderMarkdown('{{ apple-music :   https://music.apple.com/us/album/x/1  }}');
    expect(html).toContain('src="https://embed.music.apple.com/us/album/x/1"');
  });

  it('leaves an unknown provider as plain escaped text, like today', () => {
    const html = renderMarkdown('{{spotify: https://open.spotify.com/album/123}}');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('{{spotify: https://open.spotify.com/album/123}}');
  });

  it('leaves a known provider with a non-matching URL as plain text', () => {
    const html = renderMarkdown('{{apple-music: https://evil.example.com/}}');
    expect(html).not.toContain('<iframe');
  });

  it('rejects a URL that would break out of the src attribute', () => {
    const html = renderMarkdown('{{apple-music: https://music.apple.com/x"><script>alert(1)</script>}}');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<script>');
  });

  it('does not treat an inline mid-paragraph token as a shortcode', () => {
    const html = renderMarkdown('See {{apple-music: https://music.apple.com/us/album/x/1}} in the body.');
    expect(html).not.toContain('<iframe');
  });

  it('leaves raw HTML untouched, escaped, exactly as before', () => {
    const html = renderMarkdown('<iframe src="https://embed.music.apple.com/x"></iframe>');
    expect(html).toContain('&lt;iframe');
    expect(html).not.toContain('<iframe src="https://embed.music.apple.com/x">');
  });

  it('exposes a reference string covering every registered provider', () => {
    const ref = embedShortcodeReference();
    expect(ref).toContain('{{apple-music: <url>}}');
    expect(ref).toContain('music.apple.com');
  });
});

describe('gpx shortcode', () => {
  const PATH = '/media/2026/09/0123456789abcdef-ride.gpx';

  it('renders a placeholder with the defaults when no options are given', () => {
    const html = renderMarkdown(`{{gpx: ${PATH}}}`);
    expect(html).toContain('<figure class="track-map"');
    expect(html).toContain(`data-track-src="${PATH}"`);
    expect(html).toContain('data-publisher="auto"');
    expect(html).toContain('data-style=""');
    expect(html).toContain('data-trim="200"');
  });

  it('parses options in any order, case-insensitively, with loose spacing', () => {
    const html = renderMarkdown(`{{gpx: ${PATH} |TRIM=100|  style = Winter | publisher=swisstopo }}`);
    expect(html).toContain('data-publisher="swisstopo"');
    expect(html).toContain('data-style="winter"');
    expect(html).toContain('data-trim="100"');
  });

  it('keeps an unknown style for the server to fall back from', () => {
    expect(renderMarkdown(`{{gpx: ${PATH} | style=sepia}}`)).toContain('data-style="sepia"');
  });

  it.each([
    ['an unknown publisher', `{{gpx: ${PATH} | publisher=google}}`],
    ['an unknown option', `{{gpx: ${PATH} | colour=red}}`],
    ['a trim over the maximum', `{{gpx: ${PATH} | trim=5000}}`],
    ['a non-numeric trim', `{{gpx: ${PATH} | trim=-5}}`],
    ['a repeated option', `{{gpx: ${PATH} | trim=0 | trim=1}}`],
    ['an option with no value', `{{gpx: ${PATH} | trim}}`],
    ['an off-site URL', '{{gpx: https://example.com/ride.gpx}}'],
    ['a path outside /media/', '{{gpx: /admin/ride.gpx}}'],
    ['a parent-directory segment', '{{gpx: /media/../ride.gpx}}'],
    ['a non-GPX file', '{{gpx: /media/2026/09/photo.png}}'],
    ['an attribute breakout', '{{gpx: /media/x".gpx}}'],
  ])('leaves %s as plain text', (_, line) => {
    const html = renderMarkdown(line);
    expect(html).not.toContain('<figure');
    expect(html).toMatch(/^<p>/);
  });

  it('is listed, with its options, in the MCP reference', () => {
    const ref = embedShortcodeReference();
    expect(ref).toContain('{{gpx: <path>}}');
    expect(ref).toContain('publisher=auto|swisstopo|opentopomap');
    expect(ref).toContain('trim=');
  });

  it('does not add an iframe origin', () => {
    expect(embedFrameSrcOrigins()).toEqual(['https://embed.music.apple.com']);
  });
});
