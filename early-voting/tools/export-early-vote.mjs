#!/usr/bin/env node
// Export early/absentee ballot data from the Carolina Elections MySQL database
// for the /early-voting page.
//
//   MYSQL_PASSWORD=... node tools/export-early-vote.mjs
//
// Env: MYSQL_PASSWORD required; MYSQL_HOST, MYSQL_USER, MYSQL_DATABASE,
// MYSQL_CLIENT default to the read-only cluster and the mysql binary.
// Output: data/early-vote.json
//
// Two payloads per general election:
//   - daily ballot counts by party (for the cumulative trajectory chart),
//     aligned client-side by days before the election;
//   - per-district party totals for the CURRENT election (for the map).
//
// Each absentee_YYYYMMDD table carries a per-row ElectionDate, which is the
// ballot's activity date, not the election day. Party codes: 1 Republican,
// 2 Democratic, 6 Unaffiliated; everything else is "other".
// The 2024 file contains at least one row dated 2204, so every election is
// windowed to [election day - 120d, election day + 45d] to drop bad dates.

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(join(HERE, '..', 'data', 'early-vote.json'));

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

const ELECTIONS = [
  { id: '2026', name: '2026 General', table: 'absentee_20261103', date: '2026-11-03' },
  { id: '2024', name: '2024 General', table: 'absentee_20241105', date: '2024-11-05' },
  { id: '2022', name: '2022 General', table: 'absentee_20221108', date: '2022-11-08' },
  { id: '2020', name: '2020 General', table: 'absentee_20201103', date: '2020-11-03' },
  { id: '2018', name: '2018 General', table: 'absentee_20181106', date: '2018-11-06' },
  // 2016 (absentee_20161108) exists but is empty, so it is not offered.
];
const CURRENT = '2026';
const pad2 = (n) => String(n).padStart(2, '0');

function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const PARTY_SUMS = `sum(case when Party = 2 then 1 else 0 end) as dem,
         sum(case when Party = 1 then 1 else 0 end) as rep,
         sum(case when Party = 6 then 1 else 0 end) as unaff,
         sum(case when Party not in (1, 2, 6) then 1 else 0 end) as other`;

const elections = ELECTIONS.map((e) => {
  const from = addDays(e.date, -120);
  const to = addDays(e.date, 46); // exclusive
  const days = query(`
    select date(ElectionDate) as d, ${PARTY_SUMS}
    from ${e.table}
    where ElectionDate >= '${from}' and ElectionDate < '${to}'
    group by d order by d
  `).map(([d, dem, rep, unaff, other]) => ({
    date: d, dem: +dem, rep: +rep, unaff: +unaff, other: +other,
  }));
  console.log(`${e.name}: ${days.length} days, ${days.reduce((a, r) => a + r.dem + r.rep + r.unaff + r.other, 0).toLocaleString('en-US')} ballots`);
  return { id: e.id, name: e.name, date: e.date, days };
});

const current = ELECTIONS.find((e) => e.id === CURRENT);
function byDistrict(column) {
  return query(`
    select ${column} as d, ${PARTY_SUMS}
    from ${current.table}
    where ${column} > 0
    group by ${column} order by ${column}
  `).map(([d, dem, rep, unaff, other]) => ({
    d: Number(d), dem: +dem, rep: +rep, unaff: +unaff, other: +other,
  }));
}
const statewide = query(`select ${PARTY_SUMS} from ${current.table}`)[0].map(Number);

// Civitas partisan lean (invariant reference data) for state (and federal)
// races, from the carolina_elections SQLite database. Bucket + party + margin,
// e.g. { bucket: 'Safe', party: 'R', margin: 'R+13' }.
const civitasDbPath = process.env.CIVITAS_DB
  || resolve(join(HERE, '..', '..', '..', 'carolina_elections', 'backend', 'db', 'nc28.sqlite'));
const civitas = {};
if (existsSync(civitasDbPath)) {
  const db = new DatabaseSync(civitasDbPath, { readOnly: true });
  for (const r of db.prepare(
    "SELECT district_id, partisan_lean, partisan_party, cpi_value FROM districts WHERE partisan_lean IS NOT NULL"
  ).all()) {
    civitas[r.district_id] = {
      bucket: r.partisan_lean,
      party: r.partisan_party,
      margin: r.cpi_value,
    };
  }
  db.close();
  console.log(`Civitas lean: ${Object.keys(civitas).length} districts from ${civitasDbPath}`);
} else {
  console.warn(`Civitas db not found at ${civitasDbPath}; skipping civitas lean.`);
}

// Per-district, per-day ballot counts for the current election, for the
// district trajectory chart. Windowed the same way as the daily aggregates.
const from = addDays(current.date, -120);
const to = addDays(current.date, 46);
const electionDay = Date.parse(current.date + 'T00:00:00Z');
const CHAMBER_COLUMNS = { us_house: 'CongDist', state_house: 'HouseDist', state_senate: 'SenDist', us_senate: null };
const districtDaily = {};
for (const [chamber, column] of Object.entries(CHAMBER_COLUMNS)) {
  districtDaily[chamber] = {};
  if (!column) {
    // Statewide single district: aggregate the whole table by day.
    const rows = query(`
      select date(ElectionDate) as d, ${PARTY_SUMS}
      from ${current.table}
      where ElectionDate >= '${from}' and ElectionDate < '${to}'
      group by d order by d
    `);
    const arr = rows.map(([d, dem, rep, unaff, other]) => ({
      o: Math.round((Date.parse(d + 'T00:00:00Z') - electionDay) / 86400000),
      d: +dem, r: +rep, u: +unaff, x: +other,
    }));
    districtDaily[chamber]['NC-SEN'] = arr;
    continue;
  }
  const rows = query(`
    select ${column} as dist, date(ElectionDate) as d, ${PARTY_SUMS}
    from ${current.table}
    where ${column} > 0
      and ElectionDate >= '${from}' and ElectionDate < '${to}'
    group by dist, d order by dist, d
  `);
  const pad2 = (n) => String(n).padStart(2, '0');
  for (const [dist, d, dem, rep, unaff, other] of rows) {
    const id = chamber === 'us_house' ? `NC-${pad2(Number(dist))}`
      : chamber === 'state_house' ? `HD-${Number(dist)}`
      : `SD-${pad2(Number(dist))}`;
    if (!districtDaily[chamber][id]) districtDaily[chamber][id] = [];
    districtDaily[chamber][id].push({
      o: Math.round((Date.parse(d + 'T00:00:00Z') - electionDay) / 86400000),
      d: +dem, r: +rep, u: +unaff, x: +other,
    });
  }
}

const payload = {
  generatedAt: new Date().toISOString(),
  source: 'Carolina Elections (carolinaelections.com) absentee files',
  currentId: CURRENT,
  elections,
  districtDaily,
  civitas,
  chambers: {
    us_house: {
      label: 'U.S. House',
      districts: byDistrict('CongDist').map((r) => ({ id: `NC-${pad2(r.d)}`, ...r })),
    },
    state_house: {
      label: 'NC House',
      districts: byDistrict('HouseDist').map((r) => ({ id: `HD-${r.d}`, ...r })),
    },
    state_senate: {
      label: 'NC Senate',
      districts: byDistrict('SenDist').map((r) => ({ id: `SD-${pad2(r.d)}`, ...r })),
    },
    us_senate: {
      label: 'U.S. Senate',
      districts: [{ id: 'NC-SEN', d: null, dem: statewide[0], rep: statewide[1], unaff: statewide[2], other: statewide[3] }],
    },
  },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload));
console.log(`Wrote ${OUT} (${(JSON.stringify(payload).length / 1024).toFixed(0)} KB)`);
