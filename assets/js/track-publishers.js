/**
 * Map tile publishers for the `{{gpx: …}}` shortcode — the one place a new
 * publisher or style gets added.
 *
 * Shared by every consumer, so none of them can drift from the others:
 * - assets/js/markdown.js validates a shortcode's `publisher=`/`style=`
 *   options against it;
 * - src/track.js resolves `publisher=auto` and a quietly-invalid style to a
 *   concrete entry here at save time;
 * - assets/js/track-map.js reads the tile URL/attribution to draw the map;
 * - src/index.js's CSP allows every `tileOrigins()` origin in `img-src`,
 *   since Leaflet loads tiles as plain <img> elements.
 *
 * The first style listed for a publisher is its default.
 */

export const TRACK_PUBLISHERS = {
  // Swiss Federal Office of Topography — free open data (no key) since 2021,
  // attribution required. Web Mercator (EPSG:3857) WMTS, so Leaflet's
  // default CRS works as-is. Coverage is Switzerland plus a margin of the
  // neighbouring countries; see src/track.js's auto-selection rule.
  swisstopo: {
    label: 'swisstopo',
    attribution: '&copy; <a href="https://www.swisstopo.admin.ch/" rel="noopener noreferrer">swisstopo</a>',
    styles: {
      colour: { url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg', maxZoom: 18 },
      winter: { url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe-winter/default/current/3857/{z}/{x}/{y}.jpeg', maxZoom: 18 },
      grey: { url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg', maxZoom: 18 },
      aerial: { url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg', maxZoom: 19 },
    },
  },
  // OpenStreetMap-based topographic style — free under a light-use policy
  // that a personal blog sits well within. Tiles top out at z17.
  opentopomap: {
    label: 'OpenTopoMap',
    attribution: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright" rel="noopener noreferrer">OpenStreetMap</a> contributors, SRTM | Style &copy; <a href="https://opentopomap.org" rel="noopener noreferrer">OpenTopoMap</a> (CC-BY-SA)',
    styles: {
      standard: { url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', subdomains: 'abc', maxZoom: 17 },
    },
  },
};

// The publisher `auto` falls back to when a track isn't (mostly) in Switzerland.
export const FALLBACK_PUBLISHER = 'opentopomap';

export const DEFAULT_TRIM_METRES = 200;
export const MAX_TRIM_METRES = 2000;

export function defaultStyle(publisher) {
  return Object.keys(TRACK_PUBLISHERS[publisher].styles)[0];
}

/** The concrete style to draw with — the requested one if this publisher has it, otherwise its default (a quiet fallback, per the shortcode's contract). */
export function resolveStyle(publisher, style) {
  return style && Object.hasOwn(TRACK_PUBLISHERS[publisher].styles, style) ? style : defaultStyle(publisher);
}

/** Every origin a tile can load from — for src/index.js's CSP `img-src`. */
export function tileOrigins() {
  const origins = new Set();
  for (const { styles } of Object.values(TRACK_PUBLISHERS)) {
    for (const { url, subdomains } of Object.values(styles)) {
      const hosts = url.includes('{s}') ? [...(subdomains || '')].map((s) => url.replace('{s}', s)) : [url];
      for (const host of hosts) origins.add(new URL(host.replace(/\{[a-z]\}/g, '0')).origin);
    }
  }
  return [...origins];
}
