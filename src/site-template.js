/**
 * Shared HTML templating for the public static pages (home, post, archive,
 * tags, about, 404) — all Phase 1 static files, none originally aware of the
 * settings table. Every one repeats the literal "The add-blog Journal"
 * wherever the site's name shows up (title suffix, header wordmark, footer
 * copyright, the homepage's og:title, the RSS <link>'s title attribute) — a
 * single global string replace covers all of them at once rather than a
 * separate regex per element per page.
 */
import { escapeHtml } from '../assets/js/markdown.js';

const DEFAULT_TITLE = 'The add-blog Journal';

export function applySiteBranding(html, settings) {
  const title = settings.site_title || DEFAULT_TITLE;
  return html.split(DEFAULT_TITLE).join(escapeHtml(title));
}

// Homepage only — the one page whose meta description/og:description and
// visible hero tagline are meant to mirror settings.site_description
// (src/feeds.js's channel <description> reads the same key). archive/
// tags/about keep their own fixed copy and must not be touched by this.
export function applyHomeMeta(html, settings) {
  const description = escapeHtml(settings.site_description || '');
  return html
    .replace(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${description}" />`)
    .replace(/<meta property="og:description" content="[^"]*"\s*\/>/, `<meta property="og:description" content="${description}" />`)
    // The hero <p> under the homepage's <h1> — the one piece of visible page
    // *body* copy that's this same site description, not just its meta tags.
    .replace(/(<div class="hero">[\s\S]*?<p>)[\s\S]*?(<\/p>)/, `$1${description}$2`);
}
