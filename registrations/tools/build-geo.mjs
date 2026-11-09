#!/usr/bin/env node
// Build data/counties.geojson: North Carolina's 100 counties, simplified for
// a small static map. Source is the public-domain U.S. Census county boundary
// dataset as redistributed by Plotly (geojson-counties-fips.json).
//
//   node tools/build-geo.mjs
//
// Downloads once, filters to FIPS state 37, Douglas-Peucker simplifies each
// ring, rounds coordinates to 4 decimals (~11 m), and keeps only the county
// name. Names are checked against data/registrations.json so a naming
// mismatch (e.g. "McDowell") surfaces immediately instead of as a grey county.

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(join(HERE, '..', 'data', 'counties.geojson'));
const SRC = 'https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json';
const TOLERANCE = 0.004; // degrees, ~400 m; plenty at state-map scale

const res = await fetch(SRC);
if (!res.ok) { console.error(`download failed: ${res.status}`); process.exit(1); }
const all = await res.json();

function perpendicularDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  const cx = a[0] + Math.max(0, Math.min(1, t)) * dx;
  const cy = a[1] + Math.max(0, Math.min(1, t)) * dy;
  return Math.hypot(p[0] - cx, p[1] - cy);
}

function simplify(points, tol) {
  if (points.length <= 4) return points;
  let maxDist = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (d > maxDist) { maxDist = d; index = i; }
  }
  if (maxDist <= tol) return [points[0], points[points.length - 1]];
  const left = simplify(points.slice(0, index + 1), tol);
  const right = simplify(points.slice(index), tol);
  return left.slice(0, -1).concat(right);
}

const round = (n) => Math.round(n * 10000) / 10000;

const features = all.features
  .filter((f) => f.properties.STATE === '37')
  .map((f) => {
    const geom = f.geometry;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    const simplified = polys.map((rings) => rings.map((ring) => {
      const s = simplify(ring, TOLERANCE);
      return s.map(([x, y]) => [round(x), round(y)]);
    }));
    return {
      type: 'Feature',
      properties: { name: f.properties.NAME },
      geometry: { type: 'MultiPolygon', coordinates: simplified },
    };
  })
  .sort((a, b) => a.properties.name.localeCompare(b.properties.name));

// Name check against the registration data.
const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
try {
  const reg = JSON.parse(readFileSync(resolve(join(HERE, '..', 'data', 'registrations.json')), 'utf8'));
  const names = new Set(reg.counties.filter((c) => c.id !== 1).map((c) => norm(c.name)));
  const missing = features.filter((f) => !names.has(norm(f.properties.name)));
  if (missing.length) {
    console.error(`Unmatched county names: ${missing.map((f) => f.properties.name).join(', ')}`);
    process.exit(1);
  }
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  console.warn('registrations.json not found; run export-data.mjs first to validate names.');
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));
console.log(`Wrote ${OUT}: ${features.length} counties, ${(readFileSync(OUT).length / 1024).toFixed(0)} KB`);
