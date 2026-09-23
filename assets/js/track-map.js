/**
 * Draws `{{gpx: …}}` route maps — the browser half of the GPX shortcode.
 *
 * By the time a post is published, src/track.js has already turned each
 * shortcode into `<figure class="track-map" data-publisher data-style
 * data-track>` with the privacy-trimmed, simplified track encoded inline;
 * this only has to decode it and hand it to Leaflet. Leaflet itself is
 * loaded on demand, only on a page that actually has a map — pinned, from
 * the same jsdelivr origin the CSP already allows for the editor's EasyMDE.
 *
 * If Leaflet can't load, the figure's own fallback text stays in place.
 */

import { TRACK_PUBLISHERS, resolveStyle } from './track-publishers.js';

const LEAFLET_BASE = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist';

let leafletPromise;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  leafletPromise ||= new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${LEAFLET_BASE}/leaflet.css`;
    document.head.append(css);

    const script = document.createElement('script');
    script.src = `${LEAFLET_BASE}/leaflet.js`;
    script.onload = () => resolve(window.L);
    script.onerror = () => {
      leafletPromise = null; // let a later call retry
      reject(new Error('Leaflet failed to load'));
    };
    document.head.append(script);
  });
  return leafletPromise;
}

/** Inverse of src/track.js's encodePolyline — Google's encoded polyline format, 5 decimal places. */
export function decodePolyline(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lon += next();
    points.push([lat / 1e5, lon / 1e5]);
  }
  return points;
}

function drawTrackMap(L, figure) {
  const publisherName = figure.dataset.publisher;
  const publisher = Object.hasOwn(TRACK_PUBLISHERS, publisherName) ? TRACK_PUBLISHERS[publisherName] : null;
  const points = decodePolyline(figure.dataset.track || '');
  if (!publisher || points.length < 2) return;
  const tiles = publisher.styles[resolveStyle(publisherName, figure.dataset.style)];

  const canvas = document.createElement('div');
  canvas.className = 'track-map__canvas';
  canvas.setAttribute('role', 'region');
  canvas.setAttribute('aria-label', `Route map (${publisher.label})`);
  figure.replaceChildren(canvas);
  figure.dataset.hydrated = '';

  // Scroll-wheel zoom stays off until the reader engages with the map, so
  // scrolling down the post never gets captured by it mid-page.
  const map = L.map(canvas, { scrollWheelZoom: false });
  map.once('click focus', () => map.scrollWheelZoom.enable());

  L.tileLayer(tiles.url, {
    maxZoom: tiles.maxZoom,
    subdomains: tiles.subdomains || 'abc',
    attribution: publisher.attribution,
  }).addTo(map);

  const accent = getComputedStyle(figure).getPropertyValue('--accent').trim() || '#2563eb';
  const route = L.polyline(points, { color: accent, weight: 4, opacity: 0.9 }).addTo(map);
  const endpoint = (point, fill, label) =>
    L.circleMarker(point, { radius: 6, color: '#ffffff', weight: 2, fillColor: fill, fillOpacity: 1 })
      .bindTooltip(label)
      .addTo(map);
  endpoint(points[0], '#15803d', 'Start');
  endpoint(points[points.length - 1], '#b91c1c', 'Finish');

  map.fitBounds(route.getBounds(), { padding: [24, 24] });
  figure.trackMap = map;
}

const UNDRAWN = 'figure.track-map[data-track]:not([data-hydrated])';

/** Draws every not-yet-drawn route map at or under `root`. */
export async function hydrateTrackMaps(root = document) {
  const figures = root.matches?.(UNDRAWN) ? [root] : [...root.querySelectorAll(UNDRAWN)];
  if (!figures.length) return;
  let L;
  try {
    L = await loadLeaflet();
  } catch {
    return;
  }
  for (const figure of figures) drawTrackMap(L, figure);
}
