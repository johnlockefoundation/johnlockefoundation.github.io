/* NC early voting: district map + cumulative trajectory chart.
 * Static page, no dependencies. data/early-vote.json holds daily party counts
 * per general election and per-district totals for the current election;
 * data/geo/<chamber>.json holds district polygons keyed by district_id.
 *
 * Map metric: Democratic-minus-Republican share of ballots per district, pp.
 * Chart: cumulative ballots by days-before-election; the current election is
 * split by party, comparison elections are dashed totals (incl. minor parties).
 */
(function () {
  'use strict';

  var CHAMBERS = ['us_house', 'state_house', 'state_senate', 'us_senate'];
  var COLORS = { dem: '#2563eb', rep: '#dc2626', unaff: '#94a3b8' };
  var COMPARE_COLORS = ['#0f172a', '#64748b'];
  var NEUTRAL = '#eef2f7';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var state = {
    data: null,
    geo: {},             // chamber -> geojson
    chamber: 'us_house',
    compareA: '2024',
    compareB: 'none',
    domain: 40,
    selectedDistrict: null,
  };

  function fmt(n) { return n.toLocaleString('en-US'); }
  function fmtDate(iso) {
    var p = iso.split('-');
    return MONTHS[Number(p[1]) - 1] + ' ' + Number(p[2]) + ', ' + p[0];
  }
  function fmtPp(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(1) + ' pp'; }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function total(d) { return d.dem + d.rep + d.unaff + d.other; }
  function margin(d) { var t = total(d); return t ? (d.dem - d.rep) / t * 100 : 0; }

  // ---------- colour scale ----------

  function hexToRgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  function lerpColor(a, b, t) {
    var ca = hexToRgb(a), cb = hexToRgb(b);
    return 'rgb(' + ca.map(function (v, i) { return Math.round(v + (cb[i] - v) * t); }).join(',') + ')';
  }
  function colorFor(v) {
    var t = Math.max(-1, Math.min(1, v / state.domain));
    var m = Math.abs(t);
    var dark = t >= 0 ? COLORS.dem : COLORS.rep;
    var light = t >= 0 ? '#93c5fd' : '#fca5a5';
    return m <= 0.5 ? lerpColor(NEUTRAL, light, m * 2) : lerpColor(light, dark, (m - 0.5) * 2);
  }

  // ---------- map ----------

  function projectAll(features) {
    var pts = [];
    features.forEach(function (f) {
      f.geometry.coordinates.forEach(function (ring) {
        ring.forEach(function (p) { pts.push(p); });
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
    return {
      height: H,
      proj: function (p) {
        return [(p[0] * kx - minX) * scale + pad, (maxY - p[1]) * scale + pad];
      },
    };
  }

  function renderMap() {
    var chamber = state.chamber;
    var geo = state.geo[chamber];
    var districts = {};
    state.data.chambers[chamber].districts.forEach(function (d) { districts[d.id] = d; });

    // Colour domain: the widest district lead, rounded up to 10 pp, so each
    // chamber's scale spans its actual range. Fixed per chamber render.
    var maxAbs = Math.max.apply(null, state.data.chambers[chamber].districts.map(function (d) {
      return Math.abs(margin(d));
    }));
    state.domain = Math.max(10, Math.ceil(maxAbs / 10) * 10);

    var projection = projectAll(geo.features);
    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 1000 ' + projection.height.toFixed(1));

    geo.features.forEach(function (f) {
      var d = districts[f.district_id];
      if (!d) return;
      var pathData = '';
      f.geometry.coordinates.forEach(function (ring) {
        ring.forEach(function (p, i) {
          var q = projection.proj(p);
          pathData += (i === 0 ? 'M' : 'L') + q[0].toFixed(1) + ',' + q[1].toFixed(1);
        });
        pathData += 'Z';
      });
      var path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', pathData);
      path.setAttribute('class', 'county-path');
      path.dataset.districtId = f.district_id;
      path.style.fill = colorFor(margin(d));
      path.tabIndex = 0;
      path.setAttribute('role', 'button');
      path.setAttribute('aria-label', f.district_id);
      path.addEventListener('click', function () { selectDistrict(f.district_id, d); });
      path.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectDistrict(f.district_id, d); }
      });
      path.addEventListener('mousemove', function (e) { showTooltip(e, f.district_id, d); });
      path.addEventListener('mouseleave', hideTooltip);
      path.classList.toggle('selected', f.district_id === state.selectedDistrict);
      var title = document.createElementNS(svgNS, 'title');
      title.textContent = f.district_id;
      path.appendChild(title);
      svg.appendChild(path);
    });

    var mapEl = document.getElementById('map');
    mapEl.innerHTML = '';
    mapEl.appendChild(svg);

    document.getElementById('map-sub').textContent =
      'Democratic-minus-Republican share of ballots recorded so far, by district (percentage points). '
      + state.data.chambers[chamber].districts.length + ' districts.';

    var swatches = [COLORS.rep, '#fca5a5', NEUTRAL, '#93c5fd', COLORS.dem]
      .map(function (c) { return '<span style="background:' + c + '"></span>'; }).join('');
    document.getElementById('legend').innerHTML = '<span>−' + state.domain + '</span>'
      + '<div class="swatches">' + swatches + '</div>'
      + '<span>+' + state.domain + '</span>'
      + '<span class="legend-caption">Republican lead ← &nbsp; D−R share of ballots, pp &nbsp; → Democratic lead</span>';
  }

  function selectDistrict(id, d) {
    state.selectedDistrict = (state.selectedDistrict === id) ? null : id;
    Array.prototype.forEach.call(document.querySelectorAll('#map .county-path'), function (p) {
      p.classList.toggle('selected', p.dataset.districtId === state.selectedDistrict);
    });
    var info = document.getElementById('district-info');
    if (state.selectedDistrict && d) {
      info.innerHTML = '<strong>' + esc(id) + '</strong> &middot; D ' + fmt(d.dem) + ' &middot; R '
        + fmt(d.rep) + ' &middot; U ' + fmt(d.unaff) + ' &middot; ' + fmt(total(d)) + ' ballots &middot; D−R '
        + fmtPp(margin(d));
    } else {
      info.textContent = 'Click a district for details.';
    }
    renderRightPanel();
  }

  function renderRightPanel() {
    var chamber = state.chamber;
    var controls = document.querySelector('.chart-controls');
    if (state.selectedDistrict) {
      if (controls) controls.style.display = 'none';
      renderDistrictDetail();
      return;
    }
    if (controls) controls.style.display = '';
    renderChart();
  }

  function renderDistrictDetail() {
    var chamber = state.chamber;
    var chamberLabel = state.data.chambers[chamber].label;
    var d = state.data.chambers[chamber].districts.filter(function (x) {
      return x.id === state.selectedDistrict;
    })[0];
    if (!d) { state.selectedDistrict = null; renderChart(); return; }
    var t = total(d);
    var shares = [
      { key: 'dem', label: 'Democratic', color: COLORS.dem, v: d.dem },
      { key: 'rep', label: 'Republican', color: COLORS.rep, v: d.rep },
      { key: 'unaff', label: 'Unaffiliated', color: COLORS.unaff, v: d.unaff },
      { key: 'other', label: 'Other parties', color: '#f59e0b', v: d.other },
    ];
    var bar = shares.map(function (s) {
      return '<span class="share-seg" style="width:' + (s.v / t * 100).toFixed(2)
        + '%;background:' + s.color + '" title="' + s.label + ' ' + fmt(s.v) + '"></span>';
    }).join('');
    var rows = shares.map(function (s) {
      return '<tr><td>' + s.label + '</td><td>' + fmt(s.v) + '</td><td>'
        + (t ? (s.v / t * 100).toFixed(1) + '%' : '—') + '</td></tr>';
    }).join('');
    rows += '<tr class="total-row"><td>Total ballots</td><td>' + fmt(t) + '</td><td>100%</td></tr>';

    document.getElementById('chart').innerHTML =
      '<div class="district-detail">'
      + '<h3 class="detail-title">' + esc(d.id) + '</h3>'
      + '<p class="section-sub">' + esc(chamberLabel) + ' &middot; ' + fmt(t) + ' ballots recorded so far</p>'
      + '<div class="share-bar">' + bar + '</div>'
      + '<table class="stat-rows"><thead><tr><th>Party</th><th>Ballots</th><th>Share</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table>'
      + '<p class="margin-line">Democratic−Republican share: <strong>' + margin(d).toFixed(1) + '%</strong> '
      + '(<span class="' + (margin(d) >= 0 ? 'pos' : 'neg') + '">' + fmtPp(margin(d)) + '</span>)</p>'
      + '<button type="button" class="toggle back-btn" id="back-to-chart">&larr; Trajectory</button>'
      + '</div>';
    document.getElementById('chart-legend').innerHTML = '';
    document.getElementById('chart-sub').innerHTML =
      '<strong>' + esc(d.id) + '</strong> &middot; ' + esc(chamberLabel);
    var back = document.getElementById('back-to-chart');
    if (back) back.addEventListener('click', function () {
      state.selectedDistrict = null;
      Array.prototype.forEach.call(document.querySelectorAll('#map .county-path'), function (p) {
        p.classList.remove('selected');
      });
      var info = document.getElementById('district-info');
      if (info) info.textContent = 'Click a district for details.';
      renderRightPanel();
    });
  }

  function showTooltip(e, id, d) {
    var tip = document.getElementById('map-tooltip');
    var wrap = document.querySelector('.map-wrap').getBoundingClientRect();
    tip.innerHTML = '<strong>' + esc(id) + '</strong>'
      + 'D−R share: <b>' + fmtPp(margin(d)) + '</b><br>'
      + 'Dem ' + fmt(d.dem) + ' · Rep ' + fmt(d.rep) + ' · Unaff ' + fmt(d.unaff) + '<br>'
      + 'Total ballots: ' + fmt(total(d));
    tip.style.display = 'block';
    tip.style.left = Math.min(e.clientX - wrap.left + 14, wrap.width - 260) + 'px';
    tip.style.top = (e.clientY - wrap.top + 10) + 'px';
  }
  function hideTooltip() {
    var tip = document.getElementById('map-tooltip');
    if (tip) tip.style.display = 'none';
  }

  function renderChamberToggles() {
    var bar = document.getElementById('chamber-toggles');
    bar.innerHTML = '';
    CHAMBERS.forEach(function (key) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'toggle' + (key === state.chamber ? ' active' : '');
      b.textContent = state.data.chambers[key].label;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', key === state.chamber ? 'true' : 'false');
      b.addEventListener('click', function () {
        state.chamber = key;
        state.selectedDistrict = null;
        document.getElementById('district-info').textContent = 'Click a district for details.';
        renderChamberToggles();
        renderMap();
        renderRightPanel();
      });
      bar.appendChild(b);
    });
  }

  // ---------- trajectory chart ----------

  // Cumulative series per election: [{offset, dem, rep, unaff, total}], offset
  // in days relative to that election's election day.
  function cumulative(election) {
    var out = [];
    var c = { dem: 0, rep: 0, unaff: 0, total: 0 };
    var electionDay = Date.parse(election.date + 'T00:00:00Z');
    election.days.forEach(function (day) {
      c.dem += day.dem; c.rep += day.rep; c.unaff += day.unaff;
      c.total += day.dem + day.rep + day.unaff + day.other;
      out.push({
        offset: Math.round((Date.parse(day.date + 'T00:00:00Z') - electionDay) / 86400000),
        dem: c.dem, rep: c.rep, unaff: c.unaff, total: c.total,
      });
    });
    return out;
  }

  function niceCeil(v, steps) {
    var raw = v / steps;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return nice * mag * steps;
  }
  function fmtAxis(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
  }

  function renderChart() {
    var data = state.data;
    var current = data.elections.filter(function (e) { return e.id === data.currentId; })[0];
    var comparisons = [state.compareA, state.compareB].filter(function (id, i, arr) {
      return id !== 'none' && arr.indexOf(id) === i;
    }).map(function (id) {
      return data.elections.filter(function (e) { return e.id === id; })[0];
    }).filter(Boolean);

    var currentSeries = cumulative(current);
    var compareSeries = comparisons.map(cumulative);

    var allSeries = [currentSeries].concat(compareSeries);
    var xMin = Math.min.apply(null, allSeries.map(function (s) { return s[0].offset; }));
    var xMax = Math.max.apply(null, allSeries.map(function (s) { return s[s.length - 1].offset; }));
    xMax = Math.max(xMax, 0);
    var yMax = niceCeil(Math.max.apply(null, allSeries.map(function (s) { return s[s.length - 1].total; })), 4);

    var W = 420, H = 300, m = { l: 46, r: 10, t: 12, b: 34 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    function X(offset) { return m.l + (offset - xMin) / (xMax - xMin) * iw; }
    function Y(v) { return m.t + ih - v / yMax * ih; }

    var svg = [];
    // Horizontal gridlines + y labels.
    for (var i = 0; i <= 4; i++) {
      var v = yMax / 4 * i;
      svg.push('<line x1="' + m.l + '" y1="' + Y(v) + '" x2="' + (W - m.r) + '" y2="' + Y(v)
        + '" stroke="' + (i === 0 ? '#cbd5e1' : '#eef2f7') + '" stroke-width="1"/>');
      svg.push('<text x="' + (m.l - 6) + '" y="' + (Y(v) + 3) + '" text-anchor="end" class="axis">' + fmtAxis(v) + '</text>');
    }
    // X ticks every 14 days, plus election day.
    for (var o = Math.ceil(xMin / 14) * 14; o <= xMax; o += 14) {
      svg.push('<text x="' + X(o) + '" y="' + (H - m.b + 16) + '" text-anchor="middle" class="axis">'
        + (o === 0 ? '0' : o) + '</text>');
      svg.push('<line x1="' + X(o) + '" y1="' + (m.t + ih) + '" x2="' + X(o) + '" y2="' + (m.t + ih + 4) + '" stroke="#cbd5e1"/>');
    }
    // Election-day vertical rule.
    svg.push('<line x1="' + X(0) + '" y1="' + m.t + '" x2="' + X(0) + '" y2="' + (m.t + ih)
      + '" stroke="#94a3b8" stroke-dasharray="3 3"/>');
    svg.push('<text x="' + ((m.l + W - m.r) / 2) + '" y="' + (H - 4) + '" text-anchor="middle" class="axis axis-caption">Days before election day</text>');

    function pathFor(series, key) {
      return series.map(function (p, i) {
        return (i === 0 ? 'M' : 'L') + X(p.offset).toFixed(1) + ',' + Y(p[key]).toFixed(1);
      }).join(' ');
    }
    compareSeries.forEach(function (s, i) {
      svg.push('<path d="' + pathFor(s, 'total') + '" fill="none" stroke="' + COMPARE_COLORS[i]
        + '" stroke-width="1.8" stroke-dasharray="5 4"/>');
    });
    ['dem', 'rep', 'unaff'].forEach(function (key) {
      svg.push('<path d="' + pathFor(currentSeries, key) + '" fill="none" stroke="' + COLORS[key]
        + '" stroke-width="2.2"/>');
    });

    document.getElementById('chart').innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block">' + svg.join('') + '</svg>';

    var legend = ['dem', 'rep', 'unaff'].map(function (key) {
      var label = key === 'dem' ? 'Democratic' : key === 'rep' ? 'Republican' : 'Unaffiliated';
      return '<span class="chart-key"><span class="line-swatch" style="border-color:' + COLORS[key] + '"></span>'
        + current.id + ' ' + label + '</span>';
    });
    comparisons.forEach(function (e, i) {
      legend.push('<span class="chart-key"><span class="line-swatch dashed" style="border-color:' + COMPARE_COLORS[i] + '"></span>'
        + e.id + ' total</span>');
    });
    document.getElementById('chart-legend').innerHTML = legend.join('');

    var last = currentSeries[currentSeries.length - 1];
    var latestDate = current.days[current.days.length - 1].date;
    document.getElementById('chart-sub').innerHTML =
      '<strong>' + fmt(last.total) + '</strong> ballots through ' + fmtDate(latestDate) + ' — '
      + 'D ' + (last.dem / last.total * 100).toFixed(1) + '% · '
      + 'R ' + (last.rep / last.total * 100).toFixed(1) + '% · '
      + 'U ' + (last.unaff / last.total * 100).toFixed(1) + '%';
  }

  function fillCompareSelects() {
    var options = state.data.elections.filter(function (e) { return e.id !== state.data.currentId; });
    ['compare-a', 'compare-b'].forEach(function (id, idx) {
      var sel = document.getElementById(id);
      sel.innerHTML = '<option value="none">None</option>' + options.map(function (e) {
        return '<option value="' + e.id + '">' + e.name + '</option>';
      }).join('');
      sel.value = idx === 0 ? state.compareA : state.compareB;
      sel.addEventListener('change', function () {
        if (idx === 0) state.compareA = sel.value; else state.compareB = sel.value;
        renderRightPanel();
      });
    });
  }

  // ---------- init ----------

  var fetches = [fetch('data/early-vote.json').then(function (r) { return r.json(); })];
  CHAMBERS.forEach(function (c) {
    fetches.push(fetch('data/geo/' + c + '.json').then(function (r) { return r.json(); }));
  });
  Promise.all(fetches).then(function (results) {
    state.data = results[0];
    CHAMBERS.forEach(function (c, i) { state.geo[c] = results[i + 1]; });

    var current = state.data.elections[0];
    var latestDate = current.days[current.days.length - 1].date;
    document.getElementById('updated-line').textContent =
      'Ballots through ' + fmtDate(latestDate) + ' · Source: Carolina Elections';

    renderChamberToggles();
    renderMap();
    fillCompareSelects();
    renderRightPanel();

    var tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.id = 'map-tooltip';
    document.querySelector('.map-wrap').appendChild(tip);

    document.getElementById('app').hidden = false;
    document.getElementById('loading').hidden = true;
  }).catch(function (err) {
    document.getElementById('loading').textContent = 'Could not load the data: ' + err.message;
  });
})();
