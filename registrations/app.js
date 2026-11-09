/* NC voter registration by county.
 * Static page, no dependencies. Two data files:
 *   data/registrations.json[.gz] — weekly snapshots, delta-encoded (see decode)
 *   data/counties.geojson        — simplified NC county polygons
 *
 * The map is ALWAYS the fixed monthly comparison (latest snapshot vs. the
 * snapshot four weeks earlier). Only the county card and the table take custom
 * dates. Map metric: change in the Democratic-minus-Republican share of the
 * county's registered voters, in percentage points.
 */
(function () {
  'use strict';

  var FIELDS = ['dem', 'rep', 'unaff', 'other', 'white', 'black', 'otherRace', 'total'];
  var COLORS = { dem: '#2563eb', rep: '#dc2626' };
  var PARTY_ROWS = [
    { key: 'dem', label: 'Democratic' },
    { key: 'rep', label: 'Republican' },
    { key: 'unaff', label: 'Unaffiliated' },
    { key: 'other', label: 'Other parties' },
  ];
  var RACE_ROWS = [
    { key: 'white', label: 'White' },
    { key: 'black', label: 'Black' },
    { key: 'otherRace', label: 'Other' },
  ];

  var state = {
    data: null,        // decoded payload
    counties: [],      // [{id,name,series:{field:Int32Array}}]
    byId: {},          // id -> county
    latest: 0,         // latest week index
    baseline: 0,       // index ~4 weeks before latest (map comparison)
    selectedId: 1,     // statewide totals by default
    cardFrom: 0, cardTo: 0,
    cardView: 'party', // 'party' | 'race'
    tableFrom: 0, tableTo: 0,
    sortKey: 'name', sortDir: 1,
    search: '',
    domain: 1,         // colour scale extent in percentage points
    paths: {},         // county name (normalised) -> svg path element
  };

  // ---------- data ----------

  function loadData() {
    function plain() {
      return fetch('data/registrations.json').then(function (r) {
        if (!r.ok) throw new Error('registrations.json ' + r.status);
        return r.json();
      });
    }
    if ('DecompressionStream' in window) {
      return fetch('data/registrations.json.gz').then(function (r) {
        if (!r.ok) return plain();
        var ds = new DecompressionStream('gzip');
        return new Response(r.body.pipeThrough(ds)).text();
      }).then(function (text) {
        return typeof text === 'string' ? JSON.parse(text) : text;
      }).catch(plain);
    }
    return plain();
  }

  // Delta encoding: first value absolute, each later value the difference from
  // the previous week. null means "no snapshot that week" and stays null.
  function decode(arr) {
    var out = new Int32Array(arr.length);
    var prev = 0;
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (v === null) { out[i] = prev; continue; } // hold last known value
      out[i] = i === 0 ? v : prev + v;
      prev = out[i];
    }
    return out;
  }

  function val(county, field, weekIdx) {
    return county.series[field][weekIdx];
  }

  // Democratic-minus-Republican share of registered voters, in percent.
  function margin(county, weekIdx) {
    var total = val(county, 'total', weekIdx);
    if (!total) return 0;
    return (val(county, 'dem', weekIdx) - val(county, 'rep', weekIdx)) / total * 100;
  }

  function monthlyChange(county) {
    return margin(county, state.latest) - margin(county, state.baseline);
  }

  // ---------- helpers ----------

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(iso) {
    var p = iso.split('-');
    return MONTHS[Number(p[1]) - 1] + ' ' + Number(p[2]) + ', ' + p[0];
  }
  function fmt(n) { return n.toLocaleString('en-US'); }
  function fmtSigned(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n)); }
  function fmtPp(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2) + ' pp'; }
  function normName(s) { return s.toLowerCase().replace(/[^a-z]/g, ''); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---------- colour scale ----------

  function hexToRgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  function lerpColor(a, b, t) {
    var ca = hexToRgb(a), cb = hexToRgb(b);
    return 'rgb(' + ca.map(function (v, i) { return Math.round(v + (cb[i] - v) * t); }).join(',') + ')';
  }
  var NEUTRAL = '#eef2f7';
  function colorFor(v) {
    var t = Math.max(-1, Math.min(1, v / state.domain));
    var m = Math.abs(t);
    var dark = t >= 0 ? COLORS.dem : COLORS.rep;
    var light = t >= 0 ? '#93c5fd' : '#fca5a5';
    return m <= 0.5 ? lerpColor(NEUTRAL, light, m * 2) : lerpColor(light, dark, (m - 0.5) * 2);
  }

  // ---------- map ----------

  function buildMap(geo) {
    var pts = [];
    geo.features.forEach(function (f) {
      f.geometry.coordinates.forEach(function (poly) {
        poly.forEach(function (ring) {
          ring.forEach(function (p) { pts.push(p); });
        });
      });
    });
    var midLat = (Math.min.apply(null, pts.map(function (p) { return p[1]; }))
      + Math.max.apply(null, pts.map(function (p) { return p[1]; }))) / 2;
    var kx = Math.cos(midLat * Math.PI / 180);
    var xs = pts.map(function (p) { return p[0] * kx; });
    var ys = pts.map(function (p) { return p[1]; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var W = 1000, pad = 8;
    var scale = (W - pad * 2) / (maxX - minX);
    var H = (maxY - minY) * scale + pad * 2;
    function proj(p) {
      return [(p[0] * kx - minX) * scale + pad, (maxY - p[1]) * scale + pad];
    }

    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H.toFixed(1));

    geo.features.forEach(function (f) {
      var d = '';
      f.geometry.coordinates.forEach(function (poly) {
        poly.forEach(function (ring) {
          ring.forEach(function (p, i) {
            var q = proj(p);
            d += (i === 0 ? 'M' : 'L') + q[0].toFixed(1) + ',' + q[1].toFixed(1);
          });
          d += 'Z';
        });
      });
      var path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', 'county-path');
      var county = state.counties.filter(function (c) {
        return c.id !== 1 && normName(c.name) === normName(f.properties.name);
      })[0];
      if (!county) return;
      path.dataset.countyId = county.id;
      state.paths[county.id] = path;
      path.addEventListener('click', function () { selectCounty(county.id); });
      path.addEventListener('mousemove', function (e) { showTooltip(e, county); });
      path.addEventListener('mouseleave', hideTooltip);
      var title = document.createElementNS(svgNS, 'title');
      title.textContent = county.name;
      path.appendChild(title);
      svg.appendChild(path);
    });

    var mapEl = document.getElementById('map');
    mapEl.innerHTML = '';
    mapEl.appendChild(svg);
    var tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.id = 'map-tooltip';
    mapEl.parentNode.appendChild(tip);
    paintMap();
  }

  function paintMap() {
    Object.keys(state.paths).forEach(function (id) {
      var county = state.byId[id];
      state.paths[id].style.fill = colorFor(monthlyChange(county));
      state.paths[id].classList.toggle('selected', Number(id) === state.selectedId);
    });
    document.getElementById('map').classList.toggle('has-selection', state.selectedId !== 1);
  }

  function showTooltip(e, county) {
    var tip = document.getElementById('map-tooltip');
    var wrap = document.querySelector('.map-wrap').getBoundingClientRect();
    var change = monthlyChange(county);
    tip.innerHTML = '<strong>' + esc(county.name) + '</strong>'
      + 'D−R share, four weeks: <b>' + fmtPp(change) + '</b><br>'
      + 'Registered: ' + fmt(val(county, 'total', state.latest));
    tip.style.display = 'block';
    var x = e.clientX - wrap.left + 14;
    var y = e.clientY - wrap.top + 10;
    tip.style.left = Math.min(x, wrap.width - 250) + 'px';
    tip.style.top = y + 'px';
  }
  function hideTooltip() {
    var tip = document.getElementById('map-tooltip');
    if (tip) tip.style.display = 'none';
  }

  function buildLegend() {
    var el = document.getElementById('legend');
    var swatches = [COLORS.rep, '#fca5a5', NEUTRAL, '#93c5fd', COLORS.dem]
      .map(function (c) { return '<span style="background:' + c + '"></span>'; }).join('');
    el.innerHTML = '<span>−' + state.domain.toFixed(1) + '</span>'
      + '<div class="swatches">' + swatches + '</div>'
      + '<span>+' + state.domain.toFixed(1) + '</span>'
      + '<span class="legend-caption">Republican shift ← &nbsp; Democratic-minus-Republican share, percentage points &nbsp; → Democratic shift</span>';
  }

  // ---------- date selectors ----------

  function fillDateSelect(sel, selected) {
    sel.innerHTML = state.data.weeks.map(function (w, i) {
      return '<option value="' + i + '"' + (i === selected ? ' selected' : '') + '>' + fmtDate(w) + '</option>';
    }).join('');
  }

  // ---------- county card ----------

  function renderCard() {
    var county = state.byId[state.selectedId];
    var from = state.cardFrom, to = state.cardTo;
    var card = document.getElementById('county-card');

    var isParty = state.cardView === 'party';
    var rowDefs = isParty ? PARTY_ROWS : RACE_ROWS;
    var rows = rowDefs.map(function (r) {
      var a = val(county, r.key, from), b = val(county, r.key, to);
      return '<tr><td>' + r.label + '</td><td>' + fmt(a) + '</td><td>' + fmt(b) + '</td><td>'
        + fmtSigned(b - a) + '</td></tr>';
    }).join('');
    var totalA = val(county, 'total', from), totalB = val(county, 'total', to);
    rows += '<tr class="total-row"><td>Total registered</td><td>' + fmt(totalA) + '</td><td>'
      + fmt(totalB) + '</td><td>' + fmtSigned(totalB - totalA) + '</td></tr>';

    var mA = margin(county, from), mB = margin(county, to);
    var dm = mB - mA;

    var toggle = '<div class="toggle-bar" role="tablist">'
      + '<button type="button" class="toggle' + (isParty ? ' active' : '') + '" data-view="party" role="tab" aria-selected="' + isParty + '">Partisan split</button>'
      + '<button type="button" class="toggle' + (!isParty ? ' active' : '') + '" data-view="race" role="tab" aria-selected="' + !isParty + '">Racial demographics</button>'
      + '</div>';

    // Both views are the From/To/Change table; the partisan view adds the
    // D−R share line. Pie charts were dropped from the card entirely.
    var below = isParty
      ? '<p class="margin-line">Democratic−Republican share: <strong>' + mA.toFixed(1) + '%</strong> → '
        + '<strong>' + mB.toFixed(1) + '%</strong> '
        + '(<span class="' + (dm >= 0 ? 'pos' : 'neg') + '">' + fmtPp(dm) + '</span>)</p>'
      : '';

    card.innerHTML = '<h3 id="card-county-name">' + esc(county.name) + '</h3>'
      + '<div class="card-dates">'
      + '<label>From <select id="card-from"></select></label>'
      + '<label>To <select id="card-to"></select></label>'
      + '</div>'
      + toggle
      + '<table class="stat-rows"><thead><tr><th>' + (isParty ? 'Registration' : 'Racial group')
      + '</th><th>From</th><th>To</th><th>Change</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table>'
      + below;

    Array.prototype.forEach.call(card.querySelectorAll('.toggle'), function (b) {
      b.addEventListener('click', function () {
        state.cardView = b.dataset.view;
        renderCard();
      });
    });

    var fromSel = card.querySelector('#card-from');
    var toSel = card.querySelector('#card-to');
    fillDateSelect(fromSel, from);
    fillDateSelect(toSel, to);
    fromSel.addEventListener('change', function () {
      state.cardFrom = Number(fromSel.value);
      if (state.cardFrom > state.cardTo) state.cardTo = state.cardFrom;
      renderCard();
    });
    toSel.addEventListener('change', function () {
      state.cardTo = Number(toSel.value);
      if (state.cardTo < state.cardFrom) state.cardFrom = state.cardTo;
      renderCard();
    });
  }

  // ---------- table ----------

  var COLUMNS = [
    { key: 'name', label: 'County', text: true },
    { key: 'total', label: 'Registered' },
    { key: 'dTotal', label: 'Δ reg.', delta: true },
    { key: 'dem', label: 'Dem' },
    { key: 'dDem', label: 'Δ Dem', delta: true },
    { key: 'rep', label: 'Rep' },
    { key: 'dRep', label: 'Δ Rep', delta: true },
    { key: 'unaff', label: 'Unaff.' },
    { key: 'dUnaff', label: 'Δ Unaff.', delta: true },
    { key: 'dMargin', label: 'D−R Δ pp' },
  ];

  function tableRow(county) {
    var from = state.tableFrom, to = state.tableTo;
    var row = { id: county.id, name: county.name };
    ['total', 'dem', 'rep', 'unaff'].forEach(function (f) {
      row[f] = val(county, f, to);
      row['d' + f.charAt(0).toUpperCase() + f.slice(1)] = val(county, f, to) - val(county, f, from);
    });
    row.dMargin = margin(county, to) - margin(county, from);
    return row;
  }

  function renderTable() {
    var thead = document.querySelector('#county-table thead');
    var tbody = document.querySelector('#county-table tbody');
    thead.innerHTML = '<tr>' + COLUMNS.map(function (c) {
      var arrow = state.sortKey === c.key ? (state.sortDir === 1 ? ' ▲' : ' ▼') : '';
      return '<th data-key="' + c.key + '" scope="col">' + c.label + arrow + '</th>';
    }).join('') + '</tr>';

    var query = state.search.trim().toLowerCase();
    var rows = state.counties.map(tableRow);
    var statewide = rows.filter(function (r) { return r.id === 1; });
    var rest = rows.filter(function (r) { return r.id !== 1; });
    if (query) {
      rest = rest.filter(function (r) { return r.name.toLowerCase().indexOf(query) !== -1; });
      statewide = statewide.filter(function (r) { return r.name.toLowerCase().indexOf(query) !== -1; });
    }
    rest.sort(function (a, b) {
      var k = state.sortKey;
      if (k === 'name') return a.name.localeCompare(b.name) * state.sortDir;
      return (a[k] - b[k]) * state.sortDir || a.name.localeCompare(b.name);
    });
    var ordered = query ? rest.concat(statewide) : statewide.concat(rest);

    tbody.innerHTML = ordered.map(function (r) {
      var cells = COLUMNS.map(function (c) {
        var v = r[c.key];
        if (c.key === 'name') return '<td>' + esc(v) + '</td>';
        if (c.key === 'dMargin') {
          return '<td class="' + (v >= 0 ? 'pos' : 'neg') + '">' + fmtPp(v) + '</td>';
        }
        if (c.delta) return '<td>' + fmtSigned(v) + '</td>';
        return '<td>' + fmt(v) + '</td>';
      }).join('');
      return '<tr data-id="' + r.id + '" class="'
        + (r.id === 1 ? 'statewide ' : '') + (r.id === state.selectedId ? 'selected' : '') + '">'
        + cells + '</tr>';
    }).join('');

    Array.prototype.forEach.call(thead.querySelectorAll('th'), function (th) {
      th.addEventListener('click', function () {
        var key = th.dataset.key;
        if (state.sortKey === key) { state.sortDir = -state.sortDir; }
        else { state.sortKey = key; state.sortDir = key === 'name' ? 1 : -1; }
        renderTable();
      });
    });
    Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function (tr) {
      tr.addEventListener('click', function () { selectCounty(Number(tr.dataset.id)); });
    });
  }

  // ---------- date-range presets ----------

  var PRESETS = [
    { label: '2024 General → 2026 Midterms', from: '2024-11-05', to: 'latest' },
    { label: '2020 General → 2024 General', from: '2020-11-03', to: '2024-11-05' },
    { label: '2018 Midterms → 2022 Midterms', from: '2018-11-06', to: '2022-11-08' },
    { label: '2016 General → 2020 General', from: '2016-11-08', to: '2020-11-03' },
    { label: '2008 General → 2016 General', from: '2008-11-04', to: '2016-11-08' },
  ];

  // Snapshots are weekly, so an election-day preset resolves to the last
  // snapshot on or before that date. 'latest' means the newest snapshot.
  function weekOnOrBefore(iso) {
    if (iso === 'latest') return state.latest;
    for (var i = state.latest; i >= 0; i--) {
      if (state.data.weeks[i] <= iso) return i;
    }
    return 0;
  }

  function markPresets() {
    var bar = document.getElementById('preset-bar');
    Array.prototype.forEach.call(bar.children, function (b, i) {
      var p = PRESETS[i];
      b.classList.toggle('active',
        state.tableFrom === weekOnOrBefore(p.from) && state.tableTo === weekOnOrBefore(p.to));
    });
  }

  function renderPresets() {
    var bar = document.getElementById('preset-bar');
    PRESETS.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset';
      b.textContent = p.label;
      b.addEventListener('click', function () {
        state.tableFrom = weekOnOrBefore(p.from);
        state.tableTo = weekOnOrBefore(p.to);
        document.getElementById('table-from').value = state.tableFrom;
        document.getElementById('table-to').value = state.tableTo;
        renderTable();
        markPresets();
      });
      bar.appendChild(b);
    });
    markPresets();
  }

  // ---------- selection ----------

  function selectCounty(id) {
    state.selectedId = id;
    paintMap();
    renderCard();
    var tbody = document.querySelector('#county-table tbody');
    Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function (tr) {
      tr.classList.toggle('selected', Number(tr.dataset.id) === id);
    });
  }

  // ---------- init ----------

  Promise.all([loadData(), fetch('data/counties.geojson').then(function (r) { return r.json(); })])
    .then(function (results) {
      var payload = results[0], geo = results[1];
      state.data = payload;
      state.counties = payload.counties.map(function (c) {
        var series = {};
        FIELDS.forEach(function (f) { series[f] = decode(c.series[f]); });
        return { id: c.id, name: c.name, series: series };
      });
      state.counties.forEach(function (c) { state.byId[c.id] = c; });
      state.latest = payload.weeks.length - 1;

      // Baseline: the snapshot four weeks before the latest (or the closest
      // earlier one if a week is missing).
      var latestDate = new Date(payload.weeks[state.latest] + 'T00:00:00Z').getTime();
      var target = latestDate - 28 * 24 * 3600 * 1000;
      var base = 0;
      for (var i = state.latest; i >= 0; i--) {
        if (new Date(payload.weeks[i] + 'T00:00:00Z').getTime() <= target) { base = i; break; }
      }
      state.baseline = base;
      state.cardFrom = base; state.cardTo = state.latest;
      state.tableFrom = base; state.tableTo = state.latest;

      // Colour scale: 95th percentile of |change|, so one outlier county does
      // not flatten the rest of the map. Floor of 0.2 pp keeps noise readable.
      var changes = state.counties.filter(function (c) { return c.id !== 1; })
        .map(function (c) { return Math.abs(monthlyChange(c)); })
        .sort(function (a, b) { return a - b; });
      var p95 = changes[Math.floor(changes.length * 0.95)] || 0.2;
      state.domain = Math.max(0.2, Math.ceil(p95 * 10) / 10);

      document.getElementById('updated-line').textContent =
        'Latest weekly snapshot: ' + fmtDate(payload.latestWeek) + ' · Source: Carolina Elections';
      document.getElementById('map-sub').textContent =
        'Change in the Democratic-minus-Republican share of registered voters, '
        + fmtDate(payload.weeks[base]) + ' → ' + fmtDate(payload.latestWeek)
        + ' (percentage points). The map stays on this monthly view; dates below change only the card and table.';

      buildMap(geo);
      buildLegend();
      renderCard();
      renderTable();

      ['table-from', 'table-to'].forEach(function (id) {
        var sel = document.getElementById(id);
        fillDateSelect(sel, id === 'table-from' ? state.tableFrom : state.tableTo);
        sel.addEventListener('change', function () {
          state.tableFrom = Number(document.getElementById('table-from').value);
          state.tableTo = Number(document.getElementById('table-to').value);
          if (state.tableFrom > state.tableTo) {
            if (id === 'table-from') { state.tableTo = state.tableFrom; document.getElementById('table-to').value = state.tableTo; }
            else { state.tableFrom = state.tableTo; document.getElementById('table-from').value = state.tableFrom; }
          }
          renderTable();
          markPresets();
        });
      });
      renderPresets();
      document.getElementById('table-search').addEventListener('input', function (e) {
        state.search = e.target.value;
        renderTable();
      });

      document.getElementById('app').hidden = false;
      document.getElementById('loading').hidden = true;
    })
    .catch(function (err) {
      document.getElementById('loading').textContent = 'Could not load the data: ' + err.message;
    });
})();
