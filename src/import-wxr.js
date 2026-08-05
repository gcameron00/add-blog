/**
 * WordPress WXR (eXtended RSS) parser — Phase 7's import feature. Not a
 * general XML parser: WXR's `<item>` elements are always siblings, never
 * nested, so this splits on them directly rather than pulling in a DOM
 * (Workers has no `DOMParser`, and this project ships zero runtime deps —
 * same reasoning as assets/js/markdown.js's hand-rolled renderer). Targeted
 * at what real WordPress exports contain, verified against two real
 * exports' structure, not spec-complete against the WXR 1.2 schema.
 */

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlEntities(str) {
  return String(str).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, ent) => {
    if (ent[0] === '#') {
      const isHex = ent[1] === 'x' || ent[1] === 'X';
      const code = isHex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return XML_ENTITIES[ent] ?? whole;
  });
}

/**
 * Extracts a tag's inner text. CDATA-wrapped content (used for anything
 * that might contain markup or `&` — content:encoded, post_name, category
 * names, …) is returned verbatim, since CDATA's whole point is "don't
 * entity-decode this"; plain text content (title, most wp: fields) gets
 * entity-decoded. Namespaced tag names (`content:encoded`, `dc:creator`,
 * `wp:post_id`) work as-is — colons aren't special in a regex.
 */
function extractText(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`);
  const match = block.match(re);
  if (!match) return null;
  const raw = match[1];
  const cdata = raw.trim().match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) return cdata[1];
  return decodeXmlEntities(raw).trim();
}

/** `<category domain="category|post_tag" nicename="...">Name</category>` — repeated per item. */
function extractTerms(block) {
  const terms = [];
  const re = /<category\s+([^>]*)>([\s\S]*?)<\/category>/g;
  let m;
  while ((m = re.exec(block))) {
    const domainMatch = m[1].match(/domain="([^"]*)"/);
    const taxonomy = domainMatch ? domainMatch[1] : null;
    const cdata = m[2].trim().match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
    const name = (cdata ? cdata[1] : decodeXmlEntities(m[2])).trim();
    if (taxonomy && name) terms.push({ taxonomy, name });
  }
  return terms;
}

/** Repeated `<wp:postmeta><wp:meta_key>…</wp:meta_key><wp:meta_value>…</wp:meta_value></wp:postmeta>` blocks, flattened to one object. */
function extractPostmeta(block) {
  const meta = {};
  const re = /<wp:postmeta>([\s\S]*?)<\/wp:postmeta>/g;
  let m;
  while ((m = re.exec(block))) {
    const key = extractText(m[1], 'wp:meta_key');
    if (key) meta[key] = extractText(m[1], 'wp:meta_value');
  }
  return meta;
}

function parseItem(block) {
  return {
    postType: extractText(block, 'wp:post_type') || 'post',
    status: extractText(block, 'wp:status') || 'draft',
    title: extractText(block, 'title') || '',
    link: extractText(block, 'link') || '',
    slug: extractText(block, 'wp:post_name') || '',
    dateGmt: extractText(block, 'wp:post_date_gmt') || extractText(block, 'wp:post_date') || '',
    modifiedGmt: extractText(block, 'wp:post_modified_gmt') || extractText(block, 'wp:post_modified') || '',
    author: extractText(block, 'dc:creator') || '',
    contentHtml: extractText(block, 'content:encoded') || '',
    excerptHtml: extractText(block, 'excerpt:encoded') || '',
    postId: extractText(block, 'wp:post_id') || '',
    postParent: extractText(block, 'wp:post_parent') || '',
    attachmentUrl: extractText(block, 'wp:attachment_url') || '',
    terms: extractTerms(block),
    postmeta: extractPostmeta(block),
  };
}

/**
 * Parses a WXR document into `{ site: { title, url }, items }`. `site.url`
 * comes from the channel header (before the first `<item>`, so it can't be
 * confused with an item's own `<link>` permalink) — the importer uses it to
 * recognise which links inside content point at the old site itself.
 */
export function parseWxr(xmlText) {
  const text = String(xmlText);
  const firstItemIdx = text.indexOf('<item>');
  const headerText = firstItemIdx === -1 ? text : text.slice(0, firstItemIdx);

  const site = {
    title: extractText(headerText, 'title') || '',
    url: (extractText(headerText, 'wp:base_site_url') || extractText(headerText, 'link') || '').replace(/\/+$/, ''),
  };

  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(text))) items.push(parseItem(m[1]));

  return { site, items };
}
