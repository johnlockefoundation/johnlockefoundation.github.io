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
  var COLORS = {
    dem: '#2166ac', rep: '#b2182b', unaff: '#7d7666', other: '#b08968',
    white: '#6d9dc5', black: '#2f3e46', otherRace: '#c9a227',
  };
  var PARTY_ROWS = [
    { key: 'dem', label: 'Democratic' },
    { key: 'rep', label: 'Republican' },
    { key: 'unaff', label: 'Unaffiliated' },
    { key: 'other', label: 'Other parties' },
  ];

  var state = {
    data: null,        // decoded payload
    counties: [],      // [{id,name,series:{field:Int32Array}}]
    byId: {},          // id -> county
    latest: 0,         // latest week index
    baseline: 0,       // index ~4 weeks before latest (map comparison)
    selectedId: 1,     // statewide totals by default
    cardFrom: 0, cardTo: 0,
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
  var NEUTRAL = '#eee5d0';
  function colorFor(v) {
    var t = Math.max(-1, Math.min(1, v / state.domain));
    var m = Math.abs(t);
    var dark = t >= 0 ? COLORS.dem : COLORS.rep;
    var light = t >= 0 ? '#92c5de' : '#e8a08c';
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
    var swatches = [COLORS.rep, '#e8a08c', NEUTRAL, '#92c5de', COLORS.dem]
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

    var rows = PARTY_ROWS.map(function (r) {
      var a = val(county, r.key, from), b = val(county, r.key, to);
      return '<tr><td>' + r.label + '</td><td>' + fmt(a) + '</td><td>' + fmt(b) + '</td><td>'
        + fmtSigned(b - a) + '</td></tr>';
    }).join('');
    var totalA = val(county, 'total', from), totalB = val(county, 'total', to);
    rows += '<tr class="total-row"><td>Total registered</td><td>' + fmt(totalA) + '</td><td>'
      + fmt(totalB) + '</td><td>' + fmtSigned(totalB - totalA) + '</td></tr>';

    var mA = margin(county, from), mB = margin(county, to);
    var dm = mB - mA;

    card.innerHTML = '<h3 id="card-county-name">' + esc(county.name) + '</h3>'
      + '<div class="card-dates">'
      + '<label>From <select id="card-from"></select></label>'
      + '<label>To <select id="card-to"></select></label>'
      + '</div>'
      + '<table class="stat-rows"><thead><tr><th>Registration</th><th>From</th><th>To</th><th>Change</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table>'
      + '<p class="margin-line">Democratic−Republican share: <strong>' + mA.toFixed(1) + '%</strong> → '
      + '<strong>' + mB.toFixed(1) + '%</strong> '
      + '(<span class="' + (dm >= 0 ? 'pos' : 'neg') + '">' + fmtPp(dm) + '</span>)</p>'
      + '<div class="pies">'
      + pieBlock('Partisan split', [
        { key: 'dem', label: 'Democratic' }, { key: 'rep', label: 'Republican' },
        { key: 'unaff', label: 'Unaffiliated' }, { key: 'other', label: 'Other parties' },
      ], county, to)
      + pieBlock('Racial split', [
        { key: 'white', label: 'White' }, { key: 'black', label: 'Black' }, { key: 'otherRace', label: 'Other' },
      ], county, to)
      + '</div>'
      + '<p class="pie-note">Breakdowns as of ' + fmtDate(state.data.weeks[to]) + '</p>';

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

  function pieBlock(title, slices, county, weekIdx) {
    var values = slices.map(function (s) { return val(county, s.key, weekIdx); });
    var sum = values.reduce(function (a, b) { return a + b; }, 0);
    var svg = donut(slices.map(function (s, i) {
      return { label: s.label, value: values[i], color: COLORS[s.key] };
    }));
    var legend = slices.map(function (s, i) {
      var pct = sum ? (values[i] / sum * 100).toFixed(1) + '%' : '—';
      return '<li><span class="dot" style="background:' + COLORS[s.key] + '"></span>'
        + esc(s.label) + '<span class="pct">' + pct + '</span></li>';
    }).join('');
    return '<div class="pie"><h4>' + title + '</h4>' + svg
      + '<ul class="pie-legend">' + legend + '</ul></div>';
  }

  function donut(slices) {
    var total = slices.reduce(function (a, s) { return a + s.value; }, 0);
    if (!total) return '<svg viewBox="0 0 42 42"></svg>';
    var angle = -Math.PI / 2;
    var paths = slices.map(function (s) {
      var frac = s.value / total;
      if (frac <= 0) return '';
      var a0 = angle, a1 = angle + frac * Math.PI * 2;
      angle = a1;
      // Full-circle slice needs two arcs; SVG cannot draw 360° in one command.
      if (frac >= 0.99999) {
        return '<circle cx="21" cy="21" r="15.915" fill="none" stroke="' + s.color + '" stroke-width="8"></circle>';
      }
      var large = frac > 0.5 ? 1 : 0;
      var r = 15.915;
      var x0 = 21 + r * Math.cos(a0), y0 = 21 + r * Math.sin(a0);
      var x1 = 21 + r * Math.cos(a1), y1 = 21 + r * Math.sin(a1);
      return '<path d="M ' + x0.toFixed(3) + ' ' + y0.toFixed(3)
        + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x1.toFixed(3) + ' ' + y1.toFixed(3)
        + '" fill="none" stroke="' + s.color + '" stroke-width="8"></path>';
    }).join('');
    return '<svg viewBox="0 0 42 42" role="img">' + paths + '</svg>';
  }

  // ---------- table ----------

  var COLUMNS = [
    { key: 'name', label: 'County', text: true },
    { key: 'total', label: 'Registered' },
    { key: 'dTotal', label: 'Δ reg.' },
    { key: 'dem', label: 'Dem' },
    { key: 'dDem', label: 'Δ Dem' },
    { key: 'rep', label: 'Rep' },
    { key: 'dRep', label: 'Δ Rep' },
    { key: 'unaff', label: 'Unaff.' },
    { key: 'dUnaff', label: 'Δ Unaff.' },
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
        if (c.key.charAt(0) === 'd') return '<td>' + fmtSigned(v) + '</td>';
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
        });
      });
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
