import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { decodePolyline } from '../assets/js/track-map.js';
import {
  distanceMetres,
  encodePolyline,
  isMostlyInSwitzerland,
  looksLikeGpx,
  parseGpx,
  renderPostBody,
  resolveTrackEmbeds,
  simplifyTrack,
  trimTrack,
} from './track.js';

// ~10 km due north from Laax in ~10 m steps.
const LAAX_LINE = Array.from({ length: 1001 }, (_, i) => [46.8 + i * 0.00009, 9.26]);

const trackLength = (points) => points.slice(1).reduce((sum, p, i) => sum + distanceMetres(points[i], p), 0);

function gpxOf(points, { kind = 'trkpt' } = {}) {
  const pts = points.map(([lat, lon]) => `<${kind} lat="${lat}" lon="${lon}"><ele>1000</ele></${kind}>`).join('');
  const body = kind === 'trkpt' ? `<trk><trkseg>${pts}</trkseg></trk>` : `<rte>${pts}</rte>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">${body}</gpx>`;
}

describe('parseGpx', () => {
  it('reads track points in order, with either attribute order and quote style', () => {
    const text = `<gpx><trk><trkseg><trkpt lon="9.1" lat='46.1'><ele>1</ele></trkpt><trkpt lat="46.2" lon="9.2"/></trkseg></trk></gpx>`;
    expect(parseGpx(text)).toEqual([[46.1, 9.1], [46.2, 9.2]]);
  });

  it('prefers track points over route points, and falls back to route points', () => {
    const both = `<gpx><rte><rtept lat="1" lon="1"/></rte><trk><trkseg><trkpt lat="2" lon="2"/></trkseg></trk></gpx>`;
    expect(parseGpx(both)).toEqual([[2, 2]]);
    expect(parseGpx(gpxOf([[1, 2], [3, 4]], { kind: 'rtept' }))).toEqual([[1, 2], [3, 4]]);
  });

  it('accepts a namespace prefix and skips out-of-range or malformed points', () => {
    const text = `<gpx:gpx><gpx:trkpt lat="1.5" lon="-2"/><gpx:trkpt lat="91" lon="0"/><gpx:trkpt lat="x" lon="0"/></gpx:gpx>`;
    expect(parseGpx(text)).toEqual([[1.5, -2]]);
  });

  it('recognises GPX content by its root element', () => {
    const encode = (s) => new TextEncoder().encode(s);
    expect(looksLikeGpx(encode(gpxOf([[1, 2]])))).toBe(true);
    expect(looksLikeGpx(encode('<svg></svg>'))).toBe(false);
  });
});

describe('trimTrack', () => {
  it('hides exactly the requested distance at each end', () => {
    const trimmed = trimTrack(LAAX_LINE, 200);
    expect(distanceMetres(LAAX_LINE[0], trimmed[0])).toBeCloseTo(200, 0);
    expect(distanceMetres(LAAX_LINE.at(-1), trimmed.at(-1))).toBeCloseTo(200, 0);
    expect(trackLength(trimmed)).toBeCloseTo(trackLength(LAAX_LINE) - 400, 0);
  });

  it('leaves the track alone for trim=0', () => {
    expect(trimTrack(LAAX_LINE, 0)).toEqual(LAAX_LINE);
  });

  it('returns nothing when the track is shorter than both trims together', () => {
    expect(trimTrack([[46, 9], [46.001, 9]], 200)).toEqual([]); // ~111 m
    expect(trimTrack([[46, 9]], 200)).toEqual([]);
  });

  it('keeps the middle of a single long segment', () => {
    expect(trimTrack([[46, 9], [46.01, 9]], 200)).toHaveLength(2); // ~1.1 km
  });
});

describe('simplifyTrack', () => {
  it('caps the point count and keeps both ends', () => {
    const wiggly = Array.from({ length: 20000 }, (_, i) => [46.8 + Math.sin(i / 300) * 0.05, 9.2 + i * 0.00002]);
    const simplified = simplifyTrack(wiggly);
    expect(simplified.length).toBeLessThanOrEqual(1500);
    expect(simplified[0]).toEqual(wiggly[0]);
    expect(simplified.at(-1)).toEqual(wiggly.at(-1));
  });

  it('drops redundant points along a straight line', () => {
    expect(simplifyTrack(LAAX_LINE)).toEqual([LAAX_LINE[0], LAAX_LINE.at(-1)]);
  });
});

describe('encodePolyline', () => {
  it("matches Google's reference example", () => {
    expect(encodePolyline([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]])).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });

  it('round-trips through the browser decoder', () => {
    const points = [[46.81234, 9.26345], [46.8, 9.2], [-33.9, 151.2]];
    expect(decodePolyline(encodePolyline(points))).toEqual(points);
  });
});

describe('isMostlyInSwitzerland', () => {
  it.each([
    ['Laax', [46.81, 9.26]], ['Basel', [47.56, 7.59]], ['Zürich', [47.37, 8.54]],
    ['Geneva', [46.2, 6.14]], ['Lugano', [46.0, 8.95]], ['Zermatt', [46.02, 7.75]],
  ])('%s is inside', (_, point) => {
    expect(isMostlyInSwitzerland([point])).toBe(true);
  });

  it.each([
    ['Mulhouse', [47.75, 7.34]], ['Milan', [45.46, 9.19]], ['Chamonix', [45.92, 6.87]],
    ['Konstanz', [47.66, 9.17]], ['Vaduz', [47.14, 9.52]],
  ])('%s is outside', (_, point) => {
    expect(isMostlyInSwitzerland([point])).toBe(false);
  });

  it('tolerates a brief border crossing but not a mostly-foreign track', () => {
    const swiss = Array.from({ length: 95 }, () => [46.81, 9.26]);
    const french = Array.from({ length: 5 }, () => [47.75, 7.34]);
    expect(isMostlyInSwitzerland([...swiss, ...french])).toBe(true);
    expect(isMostlyInSwitzerland([...swiss.slice(0, 50), ...Array(50).fill([47.75, 7.34])])).toBe(false);
  });
});

describe('resolveTrackEmbeds / renderPostBody', () => {
  const KEY = '2026/09/aaaaaaaaaaaaaaaa-laax.gpx';

  async function putGpx(key, text) {
    await env.MEDIA.put(key, text, { httpMetadata: { contentType: 'application/gpx+xml' } });
  }

  it('swaps the placeholder for a trimmed, encoded track and drops the raw path', async () => {
    await putGpx(KEY, gpxOf(LAAX_LINE));
    const html = await renderPostBody(`Intro\n\n{{gpx: /media/${KEY}}}\n\nOutro`, env);

    expect(html).not.toContain('data-track-src');
    expect(html).not.toContain(KEY);
    expect(html).toContain('data-publisher="swisstopo"');
    expect(html).toContain('data-style="colour"');
    const encoded = html.match(/data-track="([^"]*)"/)[1].replace(/&amp;/g, '&');
    const points = decodePolyline(encoded);
    expect(distanceMetres(LAAX_LINE[0], points[0])).toBeCloseTo(200, -1);
    expect(html).toContain('<p>Intro</p>');
    expect(html).toContain('<p>Outro</p>');
  });

  it('honours publisher, style and trim, and falls back quietly for a style the publisher lacks', async () => {
    await putGpx(KEY, gpxOf(LAAX_LINE));
    const winter = await renderPostBody(`{{gpx: /media/${KEY} | style=winter | trim=0}}`, env);
    expect(winter).toContain('data-style="winter"');
    const points = decodePolyline(winter.match(/data-track="([^"]*)"/)[1].replace(/&amp;/g, '&'));
    expect(points[0]).toEqual(LAAX_LINE[0]);

    const otm = await renderPostBody(`{{gpx: /media/${KEY} | publisher=opentopomap | style=winter}}`, env);
    expect(otm).toContain('data-publisher="opentopomap"');
    expect(otm).toContain('data-style="standard"');
  });

  it('picks OpenTopoMap automatically for a track outside Switzerland', async () => {
    const key = '2026/09/bbbbbbbbbbbbbbbb-alsace.gpx';
    await putGpx(key, gpxOf(Array.from({ length: 200 }, (_, i) => [47.75 + i * 0.0001, 7.34])));
    expect(await renderPostBody(`{{gpx: /media/${key}}}`, env)).toContain('data-publisher="opentopomap"');
  });

  it('renders a visible error for a missing file or a track too short to trim', async () => {
    const missing = await renderPostBody('{{gpx: /media/2026/09/nope.gpx}}', env);
    expect(missing).toContain('track-map--error');
    expect(missing).toContain('no GPX file');

    const key = '2026/09/cccccccccccccccc-short.gpx';
    await putGpx(key, gpxOf([[46.8, 9.26], [46.801, 9.26]]));
    expect(await renderPostBody(`{{gpx: /media/${key}}}`, env)).toContain('too short');
  });

  it('leaves HTML with no placeholders untouched', async () => {
    const html = '<p>{{gpx: nothing to see}}</p>';
    expect(await resolveTrackEmbeds(html, env)).toBe(html);
  });
});
