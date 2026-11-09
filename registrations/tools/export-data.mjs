#!/usr/bin/env node
// Export weekly voter-registration snapshots from the Carolina Elections MySQL
// database to a compact static JSON file for the /registrations page.
//
//   MYSQL_PASSWORD=... node tools/export-data.mjs
//
// Env: MYSQL_PASSWORD required. MYSQL_HOST, MYSQL_USER, MYSQL_DATABASE,
// MYSQL_CLIENT default to the read-only cluster and the mysql binary.
// Output: data/registrations.json (delta-encoded; see decode() in app.js).
//
// The source table VoterRegistrations is weekly per county: party counts
// (Dem/Rep/Unaff plus six minor parties) and racial counts (White/Black/Other).
// CountyId 1 is the statewide "Totals" row; 2..101 are the 100 counties.
// Every county carries every week, so a single shared weeks array indexes all
// series. Series are delta-encoded (first value absolute, rest differences)
// because week-over-week changes are small, which keeps the file compact.

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(join(HERE, '..', 'data', 'registrations.json'));

const ENV = {
  host: process.env.MYSQL_HOST
    || 'carolinaelections-3.cluster-ro-cdq9qw5jzol8.us-east-1.rds.amazonaws.com',
  user: process.env.MYSQL_USER || 'MihirKale',
  database: process.env.MYSQL_DATABASE || 'carolinaelections',
  client: process.env.MYSQL_CLIENT || 'mysql',
  password: process.env.MYSQL_PASSWORD,
};
if (!ENV.password) {
  console.error('MYSQL_PASSWORD is required.');
  process.exit(1);
}

function query(sql) {
  const r = spawnSync(ENV.client, ['-h', ENV.host, '-u', ENV.user, '-B', '-N', ENV.database, '-e', sql], {
    encoding: 'utf8',
    env: { ...process.env, MYSQL_PWD: ENV.password },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(`mysql failed:\n${r.stderr || r.stdout}`);
    process.exit(1);
  }
  return r.stdout.trim().split('\n').filter(Boolean).map((line) => line.split('\t'));
}

const counties = query('select Id, Name from Counties order by Id')
  .map(([id, name]) => ({ id: Number(id), name }));

const rows = query(`
  select CountyId, date(Week) as w,
         DemocratsCount, RepublicanCount, UnaffiliatedCount,
         GreenCount + ConstitutionCount + LibertarianCount
           + NoLabelsCount + JusticeForAllCount + WeThePeopleCount as other_party,
         WhiteCount, BlackCount, OtherCount, TotalCount
  from VoterRegistrations
  order by CountyId, Week
`);

const weeks = [...new Set(rows.map((r) => r[1]))].sort();
const weekIndex = new Map(weeks.map((w, i) => [w, i]));

// column order in the query result
const FIELDS = ['dem', 'rep', 'unaff', 'other', 'white', 'black', 'otherRace', 'total'];

const byCounty = new Map();
for (const c of counties) {
  byCounty.set(c.id, {
    id: c.id,
    name: c.id === 1 ? 'North Carolina' : c.name,
    series: Object.fromEntries(FIELDS.map((f) => [f, new Array(weeks.length).fill(null)])),
  });
}
for (const r of rows) {
  const countyId = Number(r[0]);
  const entry = byCounty.get(countyId);
  if (!entry) continue;
  const wi = weekIndex.get(r[1]);
  FIELDS.forEach((f, i) => { entry.series[f][wi] = Number(r[2 + i]); });
}

function deltaEncode(arr) {
  const out = new Array(arr.length);
  let prev = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v === null) { out[i] = null; continue; }
    out[i] = i === 0 || prev === null ? v : v - prev;
    prev = v;
  }
  return out;
}

const payload = {
  generatedAt: new Date().toISOString(),
  source: 'Carolina Elections (carolinaelections.com) VoterRegistrations, weekly snapshots',
  latestWeek: weeks[weeks.length - 1],
  weeks,
  fields: FIELDS,
  counties: [...byCounty.values()].map((c) => ({
    id: c.id,
    name: c.name,
    series: Object.fromEntries(FIELDS.map((f) => [f, deltaEncode(c.series[f])])),
  })),
};

mkdirSync(dirname(OUT), { recursive: true });
const json = JSON.stringify(payload);
writeFileSync(OUT, json);
// Pre-compressed twin; app.js fetches this when the browser supports
// DecompressionStream, and falls back to the plain JSON otherwise.
writeFileSync(`${OUT}.gz`, gzipSync(Buffer.from(json), { level: 9 }));
const mb = (json.length / 1024 / 1024).toFixed(2);
console.log(`Wrote ${OUT} (${mb} MB) and ${OUT}.gz`);
console.log(`  weeks: ${weeks.length} (${weeks[0]} .. ${payload.latestWeek})`);
console.log(`  counties: ${payload.counties.length} (incl. statewide totals)`);
