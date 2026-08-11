/**
 * Shared HTML templating for the public static pages (home, post, archive,
 * tags, about, 404) — all Phase 1 static files, none originally aware of the
 * settings table. Every one repeats the literal "The add-blog Journal"
 * wherever the site's name shows up (title suffix, header wordmark, footer
 * copyright, the homepage's og:title, the RSS <link>'s title attribute) — a
 * single global string replace covers all of them at once rather than a
 * separate regex per element per page.
 *
 * Every one also links "Admin" in its footer to the literal path `/admin/`,
 * which 404s on the public host by design (src/index.js's isAdminOnlyPath —
 * the admin app only lives on env.ADMIN_HOST, e.g. blog-admin.mysite.com).
 * settings.admin_url is the owner-configured origin of that admin host
 * (admin/settings/index.html has the field); rewritten to an absolute link
 * here so "Admin" actually goes somewhere instead of always 404ing. Left as
 * the bare `/admin/` path if admin_url hasn't been set yet, same as today.
 *
 * Also regenerates the header/footer `<nav>` blocks from settings.nav_config
 * (owner-configurable per-feature enable + header/footer placement, plus
 * custom links — admin/settings/index.html's "Navigation" card) so all 6
 * pages stay in sync with one edit instead of six.
 */
import { escapeHtml } from '../assets/js/markdown.js';

const DEFAULT_TITLE = 'The add-blog Journal';

// Reproduces today's hardcoded markup exactly (verified against index.html,
// archive/, tags/, about/, post/, 404.html): header has Posts/Archive/
// Tags/About in that order; footer has About/Archive/RSS (Tags was never in
// the footer). `posts` has no `enabled`/`footer` — it's the homepage post
// list, can't be disabled, was never a footer link. A totally-missing
// `nav_config` settings row resolves to exactly this, so existing sites see
// no change until the owner edits it.
const DEFAULT_NAV_CONFIG = {
  features: {
    posts: { header: true },
    archive: { enabled: true, header: true, footer: true },
    tags: { enabled: true, header: true, footer: false },
    about: { enabled: true, header: true, footer: true },
    rss: { enabled: true, header: false, footer: true },
  },
  custom_links: [],
};

const FEATURE_ORDER = ['posts', 'archive', 'tags', 'about', 'rss'];
const FEATURE_LABEL = { posts: 'Posts', archive: 'Archive', tags: 'Tags', about: 'About', rss: 'RSS' };
const FEATURE_HREF = { posts: '/', archive: '/archive/', tags: '/tags/', about: '/about/', rss: '/feed.xml' };

/** Merges a stored (possibly partial/absent) nav_config under the defaults above. */
export function resolveNavConfig(settings) {
  const raw = settings.nav_config;
  const features = {};
  for (const key of FEATURE_ORDER) {
    features[key] = { ...DEFAULT_NAV_CONFIG.features[key], ...((raw && raw.features && raw.features[key]) || {}) };
  }
  const custom_links = Array.isArray(raw?.custom_links) ? raw.custom_links : [];
  return { features, custom_links };
}

/** Does this feature's route/content exist at all? (posts can't be disabled — always true.) */
export function isFeatureEnabled(settings, feature) {
  const nav = resolveNavConfig(settings);
  const flags = nav.features[feature];
  return !flags || flags.enabled !== false;
}

function navLink(url, name) {
  return `<a href="${escapeHtml(url)}">${escapeHtml(name)}</a>`;
}

function renderHeaderNav(nav) {
  const items = FEATURE_ORDER.filter((key) => key === 'posts' || nav.features[key].enabled !== false)
    .filter((key) => nav.features[key].header)
    .map((key) => navLink(FEATURE_HREF[key], FEATURE_LABEL[key]));
  for (const link of nav.custom_links) {
    if (link.header) items.push(navLink(link.url, link.name));
  }
  return items.join('\n          ');
}

function renderFooterNav(nav, includeAdmin) {
  const items = FEATURE_ORDER.filter((key) => key !== 'posts' && nav.features[key].enabled !== false && nav.features[key].footer)
    .map((key) => navLink(FEATURE_HREF[key], FEATURE_LABEL[key]));
  for (const link of nav.custom_links) {
    if (link.footer) items.push(navLink(link.url, link.name));
  }
  if (includeAdmin) items.push('<a href="/admin/">Admin</a>');
  return items.join('\n          ');
}

export function applySiteBranding(html, settings) {
  const title = settings.site_title || DEFAULT_TITLE;
  let out = html.split(DEFAULT_TITLE).join(escapeHtml(title));

  // #15 — settings.site_icon_key is an R2 media key (admin/settings/index.html's
  // "Brand icon" field, same picker the editor's cover image uses), swapped
  // into the favicon <link> and the header's inline checkmark mark. Left
  // alone — exactly today's static favicon.svg and inline SVG — when unset,
  // same non-regressive fallback every other settings-driven bit of
  // branding here already uses.
  if (settings.site_icon_key) {
    const iconUrl = `/media/${settings.site_icon_key}`;
    out = out.replace(
      '<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />',
      `<link rel="icon" href="${escapeHtml(iconUrl)}" />`
    );
    out = out.replace(
      /<svg viewBox="0 0 32 32" aria-hidden="true"[\s\S]*?<\/svg>/,
      `<img class="brand-mark" src="${escapeHtml(iconUrl)}" alt="" width="32" height="32">`
    );
  }

  // Regenerated from settings before the admin_url rewrite below, so a
  // freshly-emitted literal href="/admin/" still gets rewritten exactly as
  // it does today. 404.html's footer has no Admin link at all (unlike every
  // other public page) — includeAdmin is read off the *original* shell
  // markup being processed, not hardcoded per route, so that stays true.
  const nav = resolveNavConfig(settings);
  out = out.replace(
    /<nav class="site-nav" aria-label="Main">[\s\S]*?<\/nav>/,
    `<nav class="site-nav" aria-label="Main">\n          ${renderHeaderNav(nav)}\n          <button class="theme-toggle" type="button" data-theme-toggle aria-label="Toggle theme"></button>\n        </nav>`
  );
  out = out.replace(/<nav aria-label="Footer">([\s\S]*?)<\/nav>/, (_match, inner) => {
    const includeAdmin = inner.includes('href="/admin/"');
    return `<nav aria-label="Footer">\n          ${renderFooterNav(nav, includeAdmin)}\n        </nav>`;
  });

  if (settings.admin_url) {
    const adminOrigin = String(settings.admin_url).replace(/\/+$/, '');
    out = out.replace('href="/admin/"', `href="${escapeHtml(adminOrigin)}/admin/"`);
  }
  return out;
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
