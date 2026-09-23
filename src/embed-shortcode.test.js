import { describe, expect, it } from 'vitest';
import { embedShortcodeReference, embedSrcWithTheme, renderMarkdown } from '../assets/js/markdown.js';

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

  it('sizes an album embed at 450px', () => {
    const html = renderMarkdown('{{apple-music: https://music.apple.com/us/album/some-album/1440921045}}');
    expect(html).toContain('height="450"');
  });

  it('sizes a single-track (?i=) embed at 175px, keeping the query string', () => {
    const html = renderMarkdown('{{apple-music: https://music.apple.com/ch/album/prayer-in-c-robin-schulz-radio-edit/907493575?i=907493609&l=en-GB}}');
    expect(html).toContain('height="175"');
    expect(html).toContain('src="https://embed.music.apple.com/ch/album/prayer-in-c-robin-schulz-radio-edit/907493575?i=907493609&amp;l=en-GB"');
  });

  it('sizes a /song/ embed at 175px', () => {
    const html = renderMarkdown('{{apple-music: https://music.apple.com/us/song/some-song/907493609}}');
    expect(html).toContain('height="175"');
  });

  it('marks the Apple Music iframe as themable via its theme parameter', () => {
    const html = renderMarkdown('{{apple-music: https://music.apple.com/us/album/x/1}}');
    expect(html).toContain('data-embed-theme-param="theme"');
  });
});

describe('embedSrcWithTheme', () => {
  it('adds the theme parameter', () => {
    expect(embedSrcWithTheme('https://embed.music.apple.com/us/album/x/1', 'theme', 'dark'))
      .toBe('https://embed.music.apple.com/us/album/x/1?theme=dark');
  });

  it('replaces an existing theme and preserves other parameters', () => {
    expect(embedSrcWithTheme('https://embed.music.apple.com/ch/album/x/1?i=2&l=en-GB&theme=light', 'theme', 'dark'))
      .toBe('https://embed.music.apple.com/ch/album/x/1?i=2&l=en-GB&theme=dark');
  });

  it('returns null when the theme already matches, so the iframe is not reloaded', () => {
    expect(embedSrcWithTheme('https://embed.music.apple.com/us/album/x/1?theme=dark', 'theme', 'dark')).toBeNull();
  });

  it('returns null for an unparseable src', () => {
    expect(embedSrcWithTheme('not a url', 'theme', 'dark')).toBeNull();
  });
});
