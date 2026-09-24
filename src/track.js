/**
 * GPX tracks for the `{{gpx: …}}` embed shortcode (see assets/js/markdown.js).
 *
 * renderMarkdown() is synchronous and shared with the browser, so for a GPX
 * shortcode it only emits a placeholder naming the raw file. At save time,
 * resolveTrackEmbeds() (via renderPostBody) reads that file from R2 and
 * swaps the placeholder for the finished map element:
 *
 *   parse → trim both ends (privacy: hides where a track starts/ends, e.g.
 *   home) → simplify to ≤ MAX_POINTS → encode as a polyline string
 *
 * The encoded track (a few KB) is stored inline in body_html, so the raw GPX
 * path never reaches published HTML, there are no derived files to store or
 * clean up, and drawing the map costs no extra request. src/media.js
 * separately refuses to serve GPX on the public /media/ route, so the
 * untrimmed original isn't downloadable either.
 *
 * Everything here is pure except resolveTrackEmbeds/renderPostBody, which
 * take `env` for R2.
 */

import { escapeHtml, renderMarkdown } from '../assets/js/markdown.js';
import { FALLBACK_PUBLISHER, resolveStyle } from '../assets/js/track-publishers.js';

export const GPX_CONTENT_TYPE = 'application/gpx+xml';

// Enough to look right at any zoom on a ~700px-wide map, and small enough
// (a few KB encoded) to live inline in body_html and the feeds.
const MAX_POINTS = 1500;

// A GPX file is XML — but Workers have no DOMParser, and all this needs is
// the lat/lon attributes of each track point (or route point, for a planned
// route exported with no recorded track), in document order. Optional
// namespace prefix, either attribute order.
const POINT_RE = /<(?:[\w-]+:)?(trkpt|rtept)\b([^>]*)>/g;
const ATTR_RE = /\b(lat|lon)\s*=\s*(["'])\s*(-?\d+(?:\.\d+)?)\s*\2/g;

/** A cheap check that bytes are a GPX document — used to accept `.gpx` uploads that browsers label with no or a generic type. */
export function looksLikeGpx(bytes) {
  const head = new TextDecoder().decode(bytes.subarray(0, 4096));
  return /<(?:[\w-]+:)?gpx[\s>]/.test(head);
}

/** GPX text → [[lat, lon], …]. Track points win over route points when a file has both. */
export function parseGpx(text) {
  const byKind = { trkpt: [], rtept: [] };
  for (const [, kind, attrs] of String(text).matchAll(POINT_RE)) {
    let lat;
    let lon;
    for (const [, name, , value] of attrs.matchAll(ATTR_RE)) {
      if (name === 'lat') lat = Number(value);
      else lon = Number(value);
    }
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      byKind[kind].push([lat, lon]);
    }
  }
  return byKind.trkpt.length ? byKind.trkpt : byKind.rtept;
}

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;

export function distanceMetres([lat1, lon1], [lat2, lon2]) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The point `metres` along the track from its start, and the index of the first original point after it. */
function cutFromStart(points, metres) {
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const step = distanceMetres(points[i - 1], points[i]);
    if (travelled + step >= metres) {
      const t = step ? (metres - travelled) / step : 0;
      const [a, b] = [points[i - 1], points[i]];
      return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], next: i };
    }
    travelled += step;
  }
  return null;
}

/**
 * Hides the first and last `metres` of a track, cutting at the exact
 * distance (interpolating between points) rather than at the nearest
 * recorded point. Returns [] when the track is too short to leave anything.
 */
export function trimTrack(points, metres) {
  if (!metres) return points.slice();
  if (points.length < 2) return [];
  const head = cutFromStart(points, metres);
  const reversed = points.slice().reverse();
  const tail = cutFromStart(reversed, metres);
  if (!head || !tail) return [];
  // reversed[tail.next] is points[length - 1 - tail.next]: the last original point before the tail cut, in forward order.
  const lastIndex = points.length - 1 - tail.next;
  if (lastIndex < head.next) {
    // Both cuts fall between the same two points (or cross) — only valid if
    // the head cut is still before the tail cut along that one segment.
    const total = points.slice(1).reduce((sum, p, i) => sum + distanceMetres(points[i], p), 0);
    return total > 2 * metres ? [head.point, tail.point] : [];
  }
  return [head.point, ...points.slice(head.next, lastIndex + 1), tail.point];
}

/**
 * Douglas–Peucker on a local equirectangular projection (metres) — accurate
 * enough at the scale of one track. The tolerance doubles until the result
 * fits MAX_POINTS, starting at 2 m — invisible at any zoom, but it still
 * drops the redundant points a GPS logs along every straight.
 */
export function simplifyTrack(points, maxPoints = MAX_POINTS) {
  if (points.length <= 2) return points.slice();
  const lat0 = toRad(points.reduce((sum, [lat]) => sum + lat, 0) / points.length);
  const xy = points.map(([lat, lon]) => [toRad(lon) * Math.cos(lat0) * EARTH_RADIUS_M, toRad(lat) * EARTH_RADIUS_M]);

  for (let tolerance = 2; ; tolerance *= 2) {
    const keep = douglasPeucker(xy, tolerance);
    const kept = points.filter((_, i) => keep[i]);
    if (kept.length <= maxPoints) return kept;
  }
}

function douglasPeucker(xy, tolerance) {
  const keep = new Uint8Array(xy.length);
  keep[0] = 1;
  keep[xy.length - 1] = 1;
  const stack = [[0, xy.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(xy[i], xy[first], xy[last]);
      if (d > maxDist) { maxDist = d; index = i; }
    }
    if (index !== -1 && maxDist > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return keep;
}

function perpendicularDistance([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (!lengthSq) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Google's encoded polyline format at 5 decimal places (~1 m) — decoded by assets/js/track-map.js. */
export function encodePolyline(points) {
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  for (const [lat, lon] of points) {
    const ilat = Math.round(lat * 1e5);
    const ilon = Math.round(lon * 1e5);
    out += encodeSigned(ilat - prevLat) + encodeSigned(ilon - prevLon);
    prevLat = ilat;
    prevLon = ilon;
  }
  return out;
}

function encodeSigned(value) {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>>= 5;
  }
  return out + String.fromCharCode(v + 63);
}

/*
 * A deliberately coarse outline of Switzerland ([lon, lat], ~40 vertices,
 * accurate to a few km) — only used to decide whether `publisher=auto`
 * picks swisstopo. swisstopo's maps also show a margin of the neighbouring
 * countries, so a track that strays briefly over the border still looks
 * right on them; hence the 90% rule in isMostlyInSwitzerland.
 */
const SWITZERLAND = [
  [7.58, 47.59], [7.70, 47.54], [8.23, 47.62], [8.43, 47.57], [8.56, 47.81], [8.73, 47.70],
  [8.88, 47.66], [9.03, 47.69], [9.56, 47.54], [9.67, 47.38], [9.53, 47.27], [9.47, 47.06],
  [9.61, 47.06], [9.88, 46.94], [10.10, 46.84], [10.47, 46.87], [10.49, 46.62], [10.30, 46.55],
  [10.16, 46.40], [10.14, 46.23], [9.95, 46.38], [9.72, 46.29], [9.52, 46.32], [9.30, 46.50],
  [9.26, 46.23], [9.02, 45.82], [8.91, 45.91], [8.85, 46.08], [8.71, 46.10], [8.44, 46.25],
  [8.44, 46.46], [8.08, 46.26], [7.86, 45.92], [7.66, 45.98], [7.04, 45.92], [6.80, 46.13],
  [6.80, 46.40], [6.52, 46.45], [6.25, 46.30], [6.30, 46.25], [6.20, 46.17], [6.10, 46.14],
  [5.96, 46.13], [5.97, 46.21], [6.10, 46.25], [6.13, 46.36], [6.06, 46.41], [6.13, 46.60],
  [6.43, 46.76], [6.46, 46.95], [6.70, 47.05], [6.99, 47.30], [6.94, 47.43], [7.00, 47.50],
  [7.20, 47.49], [7.45, 47.46], [7.52, 47.52],
];

function insidePolygon([lat, lon], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function isMostlyInSwitzerland(points) {
  if (!points.length) return false;
  const inside = points.filter((p) => insidePolygon(p, SWITZERLAND)).length;
  return inside / points.length >= 0.9;
}

/** Publisher/style/trim from the placeholder + the track's points → the finished map element's HTML. */
export function renderTrackFigure(points, { publisher, style, trim }) {
  const trimmed = trimTrack(points, trim);
  if (trimmed.length < 2) {
    return trackError(points.length < 2 ? 'the GPX file has no track points.' : `the track is too short to show once ${trim} m is trimmed from each end.`);
  }
  const chosen = publisher === 'auto' ? (isMostlyInSwitzerland(trimmed) ? 'swisstopo' : FALLBACK_PUBLISHER) : publisher;
  const encoded = encodePolyline(simplifyTrack(trimmed));
  return `<figure class="track-map" data-publisher="${chosen}" data-style="${resolveStyle(chosen, style)}" data-track="${escapeHtml(encoded)}">` +
    '<p class="track-map__fallback">Route map — open this post on the website to see it.</p></figure>';
}

function trackError(reason) {
  return `<figure class="track-map track-map--error"><p class="track-map__fallback">Route map unavailable: ${escapeHtml(reason)}</p></figure>`;
}

// Matches exactly what assets/js/markdown.js's gpx provider emits — and
// only renderMarkdown can emit it, since raw HTML in body_md is escaped.
const PLACEHOLDER_RE = /<figure class="track-map" data-track-src="([^"]*)" data-publisher="([^"]*)" data-style="([^"]*)" data-trim="(\d+)">[\s\S]*?<\/figure>/g;

/** Swaps every GPX placeholder in rendered HTML for its finished map element, reading each distinct GPX from R2 once. */
export async function resolveTrackEmbeds(html, env) {
  const matches = [...html.matchAll(PLACEHOLDER_RE)];
  if (!matches.length) return html;

  const tracks = new Map();
  const load = (src) => {
    if (!tracks.has(src)) tracks.set(src, loadTrack(src, env));
    return tracks.get(src);
  };

  const replacements = await Promise.all(matches.map(async ([, src, publisher, style, trim]) => {
    const track = await load(src.replace(/&amp;/g, '&'));
    if (track.error) return trackError(track.error);
    return renderTrackFigure(track.points, { publisher, style, trim: Number(trim) });
  }));

  let i = 0;
  return html.replace(PLACEHOLDER_RE, () => replacements[i++]);
}

async function loadTrack(src, env) {
  if (!env.MEDIA) return { error: 'media storage is not configured.' };
  const key = decodeURIComponent(src.slice('/media/'.length));
  const object = await env.MEDIA.get(key);
  if (!object) return { error: `no GPX file at ${src} in the media library.` };
  return { points: parseGpx(await object.text()) };
}

/** renderMarkdown plus GPX resolution — what every save path stores as body_html. */
export async function renderPostBody(bodyMd, env) {
  return resolveTrackEmbeds(renderMarkdown(bodyMd), env);
}
