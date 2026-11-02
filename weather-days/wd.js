/* Westworks Weather Days engine (wd.js). Vanilla JS, no framework, no CDN.
 * Counts days at nearby NOAA stations that cross a buyer's thresholds, against the NOAA 1991-2020
 * monthly normals. All data is fetched live, in the visitor's browser, from NOAA NCEI's public
 * Access Data Service and Search Service (both send Access-Control-Allow-Origin: *).
 * The pure functions at the top are also loaded by node for tests (experiments/candidates/weather-days/tests).
 * Rules (also in the page's Methods section): a day counts if ANY selected threshold is crossed; values
 * NOAA flags as failing quality control are treated as missing; we never interpolate.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NCEI_DATA = 'https://www.ncei.noaa.gov/access/services/data/v1';
  var NCEI_SEARCH = 'https://www.ncei.noaa.gov/access/services/search/v1/data';
  var ELEMENTS = ['PRCP', 'SNOW', 'SNWD', 'TMAX', 'TMIN', 'AWND', 'WSF2'];
  var EARLIEST = '1991-01-01';
  var MAX_DAYS = 731; // 24 months

  // ---------------------------------------------------------------- thresholds
  // opts: the values a buyer can pick. normal(t): the NOAA 1991-2020 monthly normals type, or null.
  var KINDS = {
    rain: { label: 'Precipitation', unit: 'in', els: ['PRCP'], opts: ['0.01', '0.10', '0.25', '0.50', '1.00'], def: '0.10',
      text: function (t) { return 'precipitation ≥ ' + t + ' in'; },
      normal: function (t) { return 'MLY-PRCP-AVGNDS-GE' + pad3(Math.round(+t * 100)) + 'HI'; } },
    snow: { label: 'Snowfall', unit: 'in', els: ['SNOW'], opts: ['0.1', '1.0', '2.0', '3.0', '5.0', '6.0'], def: '1.0',
      text: function (t) { return 'snowfall ≥ ' + t + ' in'; },
      normal: function (t) { var n = Math.round(+t * 10); return [1, 10, 20, 30, 40, 50, 100, 200].indexOf(n) >= 0 ? 'MLY-SNOW-AVGNDS-GE' + pad3(n) + 'TI' : null; } },
    freeze: { label: 'Freezing', unit: '°F', els: ['TMIN'], opts: ['32', '40'], def: '32',
      text: function (t) { return 'low temperature ≤ ' + t + '°F'; },
      normal: function (t) { return 'MLY-TMIN-AVGNDS-LSTH' + pad3(+t); } },
    heat: { label: 'Heat', unit: '°F', els: ['TMAX'], opts: ['90', '100'], def: '90',
      text: function (t) { return 'high temperature ≥ ' + t + '°F'; },
      normal: function (t) { return 'MLY-TMAX-AVGNDS-GRTH' + pad3(+t); } },
    wind: { label: 'Wind', unit: 'mph', els: ['AWND', 'WSF2'], opts: ['15', '20'], def: '15',
      text: function (t) { return 'average wind ≥ ' + t + ' mph or 2-minute gust ≥ ' + WIND_GUST[t] + ' mph'; },
      normal: function () { return null; } }
  };
  var WIND_GUST = { '15': '25', '20': '35' };
  var ORDER = ['rain', 'snow', 'freeze', 'heat', 'wind'];

  function pad3(n) { n = String(n); while (n.length < 3) n = '0' + n; return n; }

  // A threshold object: {kind, t, key, label, text, els, normalType}
  function makeTh(kind, t) {
    var k = KINDS[kind]; if (!k) return null;
    if (k.opts.indexOf(t) < 0) return null;
    return { kind: kind, t: t, key: kind + ':' + t, label: k.label, text: k.text(t), els: k.els, normalType: k.normal(t) };
  }

  // URL query -> {zip, from, to, mode, t, ths[]} or {error}
  // mode=rain|snow|freeze|heat|wind with t=<value>; mode=custom with t=rain:0.10,freeze:32
  function parseQuery(p, today) {
    var get = function (k) { return (typeof p.get === 'function' ? p.get(k) : p[k]) || ''; };
    var zip = String(get('zip')).trim(), from = String(get('from')).trim(), to = String(get('to')).trim();
    var mode = String(get('mode') || 'rain').trim(), t = String(get('t')).trim();
    var q = { zip: zip, from: from, to: to, mode: mode, t: t, ths: [] };
    if (!/^\d{5}$/.test(zip)) return err(q, 'Enter a 5-digit US ZIP code.');
    if (!isDate(from) || !isDate(to)) return err(q, 'Enter a start and end date.');
    if (from < EARLIEST) return err(q, 'The start date can be no earlier than 1991-01-01.');
    if (to < from) return err(q, 'The end date is before the start date.');
    if (today && to > today) return err(q, 'The end date is in the future. NOAA only has past days.');
    if (daysBetween(from, to) + 1 > MAX_DAYS) return err(q, 'Pick a range of 24 months or less.');
    if (mode === 'custom') {
      var seen = {};
      t.split(',').forEach(function (part) {
        var a = part.split(':'), th = makeTh(a[0], a[1]);
        if (th && !seen[th.kind]) { seen[th.kind] = 1; q.ths.push(th); }
      });
      q.ths.sort(function (a, b) { return ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind); });
      if (!q.ths.length) return err(q, 'Choose at least one threshold.');
      q.t = q.ths.map(function (h) { return h.key; }).join(',');
    } else {
      if (!KINDS[mode]) return err(q, 'Unknown mode.');
      if (!t) t = q.t = KINDS[mode].def;
      var th = makeTh(mode, t);
      if (!th) return err(q, 'Pick one of the listed thresholds.');
      q.ths.push(th);
    }
    return q;
  }
  function err(q, m) { q.error = m; return q; }
  function queryString(q) {
    return 'zip=' + q.zip + '&from=' + q.from + '&to=' + q.to + '&mode=' + q.mode + '&t=' + encodeURIComponent(q.t).replace(/%3A/g, ':').replace(/%2C/g, ',');
  }

  // Every threshold kind for the paid report: the buyer's own values, plus the default for the rest.
  function reportThresholds(q) {
    var mine = {}; q.ths.forEach(function (h) { mine[h.kind] = h; });
    return ORDER.map(function (k) {
      var h = mine[k] || makeTh(k, KINDS[k].def); h.mine = !!mine[k]; return h;
    });
  }

  // ---------------------------------------------------------------- dates
  function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s; }
  function dayNum(s) { return Date.parse(s + 'T00:00:00Z') / 864e5; }
  function daysBetween(a, b) { return Math.round(dayNum(b) - dayNum(a)); }
  function addDays(s, n) { return new Date((dayNum(s) + n) * 864e5).toISOString().slice(0, 10); }
  function eachDay(from, to) { var out = [], n = daysBetween(from, to); for (var i = 0; i <= n; i++) out.push(addDays(from, i)); return out; }
  function daysInMonth(ym) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function monthLabel(ym) { return MON[+ym.slice(5, 7) - 1] + ' ' + ym.slice(0, 4); }
  function fmtDate(s) { return MON[+s.slice(5, 7) - 1] + ' ' + (+s.slice(8, 10)) + ', ' + s.slice(0, 4); }

  // ---------------------------------------------------------------- geometry
  function km(lat1, lon1, lat2, lon2) {
    var R = 6371.0088, r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function bbox(lat, lon, deg) {
    var dl = deg / Math.max(0.2, Math.cos(lat * Math.PI / 180));
    return [(lat + deg).toFixed(4), (lon - dl).toFixed(4), (lat - deg).toFixed(4), (lon + dl).toFixed(4)].join(',');
  }

  // NCEI Search Service results -> [{id, name, lat, lon, km, cocorahs, types[]}], nearest first.
  function parseSearch(json, lat, lon) {
    var out = [], seen = {};
    ((json && json.results) || []).forEach(function (r) {
      var s = (r.stations || [])[0], pt = ((r.boundingPoints || [])[0] || {}).coordinates || (r.location || {}).coordinates;
      if (!s || !s.id || !pt || seen[s.id]) return; seen[s.id] = 1;
      var types = (r.dataTypes || s.dataTypes || []).map(function (d) { return d.id; });
      out.push({ id: s.id, name: s.name || s.id, lat: +pt[1], lon: +pt[0], km: km(lat, lon, +pt[1], +pt[0]),
        cocorahs: s.id.indexOf('US1') === 0, types: types, end: (r.endDate || '').slice(0, 10) });
    });
    out.sort(function (a, b) { return a.km - b.km; });
    return out;
  }

  // Candidate daily stations: prefer non-CoCoRaHS (USW airport / USC co-op); CoCoRaHS (US1) only when
  // nothing else is within 15 km. Returns up to n, nearest first.
  function candidates(list, n) {
    var main = list.filter(function (s) { return !s.cocorahs; });
    var use = (main.length && main[0].km <= 15) ? main : list;
    var out = use.slice(0, n || 8);
    // Plus the two nearest airport (USW) stations: they are the ones that measure wind.
    list.filter(function (s) { return s.id.indexOf('USW') === 0 && out.indexOf(s) < 0; }).slice(0, 2).forEach(function (s) { out.push(s); });
    return out;
  }

  // ---------------------------------------------------------------- daily values
  function num(v) { if (v == null) return null; var s = String(v).trim(); if (s === '') return null; var x = Number(s); return isFinite(x) ? x : null; }
  // NCEI v1 rows (with includeAttributes=true) -> {stationId: {date: {PRCP: 0.12, PRCP_T: true, ...}}}
  // Attributes are "mflag,qflag,sflag[,time]". A non-empty qflag means the value failed NOAA's quality
  // control, so it is dropped (missing). mflag T = trace.
  function indexRows(rows) {
    var by = {}, meta = {};
    (rows || []).forEach(function (r) {
      var st = r.STATION, d = r.DATE; if (!st || !d) return;
      var day = (by[st] = by[st] || {})[d] = {};
      ELEMENTS.forEach(function (e) {
        var v = num(r[e]); if (v == null) return;
        var at = String(r[e + '_ATTRIBUTES'] || '').split(',');
        if (at[1] && at[1].trim()) { day[e + '_Q'] = at[1].trim(); return; }
        day[e] = v; if (at[0] === 'T') day[e + '_T'] = true;
      });
      if (!meta[st] && r.NAME) meta[st] = { name: r.NAME, lat: num(r.LATITUDE), lon: num(r.LONGITUDE), elev: num(r.ELEVATION) };
    });
    return { by: by, meta: meta };
  }

  // Does one day cross threshold th? true / false / null (no data for it).
  function crosses(day, th) {
    if (!day) return null;
    var t = +th.t;
    if (th.kind === 'rain') return day.PRCP == null ? null : Math.round(day.PRCP * 100) >= Math.round(t * 100);
    if (th.kind === 'snow') return day.SNOW == null ? null : Math.round(day.SNOW * 10) >= Math.round(t * 10);
    if (th.kind === 'freeze') return day.TMIN == null ? null : day.TMIN <= t;
    if (th.kind === 'heat') return day.TMAX == null ? null : day.TMAX >= t;
    if (th.kind === 'wind') {
      var g = +WIND_GUST[th.t], a = day.AWND, w = day.WSF2;
      if (a == null && w == null) return null;
      return (a != null && a >= t) || (w != null && w >= g);
    }
    return null;
  }
  // Combined status for the selected thresholds: 'hit' if any crosses; 'none' if none crosses but one
  // has no data (unknown); else 'below'.
  function status(day, ths) {
    var anyNull = false;
    for (var i = 0; i < ths.length; i++) { var c = crosses(day, ths[i]); if (c === true) return 'hit'; if (c === null) anyNull = true; }
    return anyNull ? 'none' : 'below';
  }

  function completeness(dayMap, ths, days) {
    var have = 0; days.forEach(function (d) { if (status(dayMap && dayMap[d], ths) !== 'none') have++; });
    return days.length ? have / days.length : 0;
  }

  // Pick up to 3 stations: primary = nearest with >= 90% of days usable for the selected thresholds,
  // otherwise the most complete; then the next two nearest with >= 50%, otherwise the most complete left.
  function pickStations(cands, by, ths, days) {
    var scored = cands.map(function (s) { var c = Object.assign({}, s); c.completeness = completeness(by[s.id], ths, days); return c; })
      .filter(function (s) { return s.completeness > 0; });
    if (!scored.length) return [];
    var good = scored.filter(function (s) { return s.completeness >= 0.9; });
    var primary = good.length ? good[0] : scored.slice().sort(function (a, b) { return b.completeness - a.completeness || a.km - b.km; })[0];
    var rest = scored.filter(function (s) { return s !== primary; });
    var ok = rest.filter(function (s) { return s.completeness >= 0.5; });
    var others = ok.concat(rest.filter(function (s) { return s.completeness < 0.5; }).sort(function (a, b) { return b.completeness - a.completeness; }));
    return [primary].concat(others.slice(0, 2));
  }

  // ---------------------------------------------------------------- normals
  // NCEI normals rows -> {stationId: {month(1-12): {type: value}}}. -7777 = non-zero but rounds to zero.
  function indexNormals(rows) {
    var out = {};
    (rows || []).forEach(function (r) {
      var st = r.STATION, m = +r.DATE; if (!st || !(m >= 1 && m <= 12)) return;
      var o = ((out[st] = out[st] || {})[m] = {});
      Object.keys(r).forEach(function (k) {
        if (k.indexOf('MLY-') !== 0) return;
        var v = parseFloat(String(r[k]).trim());
        if (!isFinite(v) || v === -9999 || v === -8888 || v === -6666 || v === -5555) return;
        o[k] = v === -7777 ? 0 : v;
      });
    });
    return out;
  }
  // For each threshold: the counting station's own normals when NOAA publishes that type for it (prefer =
  // {thresholdKey: stationId}), so actual and normal come from the same gauge; otherwise the nearest normals
  // station within 50 km that publishes the type. (QA 2026-11-02: Miami ZIP 33101 counted heat days at Miami
  // airport but compared them with Miami Beach's normal, 59 vs. the airport's own 183 over 24 months.)
  function pickNormals(ths, normStations, maxKm, prefer) {
    var out = {};
    ths.forEach(function (th) {
      if (!th.normalType) { out[th.key] = null; return; }
      var ok = normStations.filter(function (n) { return n.km <= (maxKm || 50) && n.types.indexOf(th.normalType) >= 0; });
      var want = prefer && prefer[th.key];
      var s = (want && ok.filter(function (n) { return n.id === want; })[0]) || ok[0];
      out[th.key] = s ? { id: s.id, name: s.name, km: s.km, type: th.normalType, same: !!want && s.id === want } : null;
    });
    return out;
  }

  // ---------------------------------------------------------------- months
  // Builds the month table. o.sel = the buyer's thresholds (decide "counted", missing days and fills);
  // o.ths = the thresholds to count (sel, or every kind for the paid report). stations[0] is primary.
  // If o.fill, a month with more than 3 days without usable data at the primary takes those days, whole,
  // from station 2, then 3, and says so. Never interpolates. o.thSource {key: stationId} counts a
  // threshold the buyer didn't pick from one named station (one that measures it), unfilled.
  function buildMonths(o) {
    var ths = o.ths, sel = o.sel || o.ths, days = o.days, st = o.stations, by = o.by, fill = !!o.fill;
    var normals = o.normals || {}, nvals = o.nvals || {}, src = o.thSource || {};
    var months = [], record = [], groups = {};
    days.forEach(function (d) { (groups[d.slice(0, 7)] = groups[d.slice(0, 7)] || []).push(d); });
    Object.keys(groups).sort().forEach(function (ym) {
      var md = groups[ym], filled = {}, rows = md.map(function (d) {
        var day = st[0] && by[st[0].id] ? by[st[0].id][d] : null;
        return { date: d, src: st[0] ? st[0].id : null, day: day || null, s: status(day, sel) };
      });
      var missing = rows.filter(function (r) { return r.s === 'none'; }).length;
      if (fill && missing > 3) {
        rows.forEach(function (r) {
          if (r.s !== 'none') return;
          for (var i = 1; i < st.length; i++) {
            var alt = by[st[i].id] ? by[st[i].id][r.date] : null, s = status(alt, sel);
            if (s !== 'none') { r.day = alt; r.src = st[i].id; r.s = s; r.filled = true; filled[st[i].id] = (filled[st[i].id] || 0) + 1; break; }
          }
        });
        missing = rows.filter(function (r) { return r.s === 'none'; }).length;
      }
      var m = +ym.slice(5, 7), dim = daysInMonth(ym), frac = md.length / dim;
      var row = { ym: ym, label: monthLabel(ym), days: md.length, partial: md.length < dim, missing: missing,
        withData: md.length - missing, incomplete: missing > 3, filledFrom: filled,
        any: rows.filter(function (r) { return r.s === 'hit'; }).length, th: {} };
      ths.forEach(function (th) {
        var c = 0, miss = 0, sid = src[th.key];
        rows.forEach(function (r) {
          var day = sid ? (by[sid] ? by[sid][r.date] : null) : r.day, x = crosses(day, th);
          if (x === true) c++; else if (x === null) miss++;
        });
        var nst = normals[th.key], full = null;
        if (nst && nvals[nst.id] && nvals[nst.id][m] && nvals[nst.id][m][th.normalType] != null) full = nvals[nst.id][m][th.normalType];
        var normal = full == null ? null : full * frac;
        row.th[th.key] = { count: c, missing: miss, normal: normal, normalFull: full, excess: normal == null ? null : c - normal };
      });
      months.push(row);
      record = record.concat(rows);
    });
    var totals = { days: 0, missing: 0, any: 0, th: {} };
    months.forEach(function (r) { totals.days += r.days; totals.missing += r.missing; totals.any += r.any; });
    ths.forEach(function (th) {
      var c = 0, n = 0, haveN = true, miss = 0;
      months.forEach(function (r) { var x = r.th[th.key]; c += x.count; miss += x.missing; if (x.normal == null) haveN = false; else n += x.normal; });
      totals.th[th.key] = { count: c, missing: miss, normal: haveN ? n : null, excess: haveN ? c - n : null };
    });
    return { months: months, totals: totals, record: record };
  }

  // Snow events: runs of consecutive days with snowfall >= 0.1 in (as in Snow Ledger), with totals.
  function snowEvents(record) {
    var ev = [], cur = null;
    record.forEach(function (r) {
      var s = r.day && r.day.SNOW != null ? r.day.SNOW : null;
      if (s != null && Math.round(s * 10) >= 1) {
        if (!cur) { cur = { start: r.date, end: r.date, total: 0, days: 0 }; ev.push(cur); }
        cur.end = r.date; cur.total = Math.round((cur.total + s) * 10) / 10; cur.days++;
      } else cur = null;
    });
    return ev;
  }

  // Compact a sorted date list into ranges: "Oct 3–5, Oct 9, 2026"-style strings (ISO here).
  function ranges(dates) {
    var out = [], a = null, b = null;
    dates.forEach(function (d) {
      if (a && daysBetween(b, d) === 1) { b = d; return; }
      if (a) out.push(a === b ? a : a + ' to ' + b); a = b = d;
    });
    if (a) out.push(a === b ? a : a + ' to ' + b);
    return out;
  }

  function fmt1(x) { return x == null ? '' : (Math.round(x * 10) / 10).toFixed(1); }
  function excessText(x) {
    if (x == null) return 'no NOAA normal';
    var r = Math.round(x * 10) / 10;
    if (r > 0) return fmt1(r) + ' above normal';
    if (r < 0) return fmt1(-r) + ' below normal';
    return 'at normal';
  }

  // CSV (RFC 4180; cells that start with = + - @ are prefixed with ' so spreadsheets don't run them).
  function csv(rows) {
    return rows.map(function (r) {
      return r.map(function (c) {
        var s = c == null ? '' : String(c);
        if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n') + '\r\n';
  }

  // ---------------------------------------------------------------- network (browser)
  function fetchJSON(url, ms) {
    var tries = 0;
    function once() {
      tries++;
      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 30000);
      return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) {
        clearTimeout(timer);
        if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
        return r.json();
      }, function (e) { clearTimeout(timer); throw e; }).catch(function (e) {
        if (tries < 2 && !(e.status >= 400 && e.status < 429)) return new Promise(function (ok) { setTimeout(ok, 1500); }).then(once);
        var x = new Error('noaa'); x.noaa = true; x.cause = e; throw x;
      });
    }
    return once();
  }

  function zipLookup(zip, base) {
    return fetch((base || '') + 'data/zcta/' + zip.slice(0, 3) + '.json').then(function (r) {
      if (r.status === 404) return {}; if (!r.ok) throw new Error('zcta'); return r.json();
    }).then(function (m) { return m[zip] || null; });
  }

  // Full run. opts: {paid, base, onStep(text)}. Resolves to a result object, or rejects with
  // {user: message}. Never returns partial or invented numbers.
  function run(q, opts) {
    opts = opts || {};
    var step = opts.onStep || function () {};
    var paid = !!opts.paid, ths = paid ? reportThresholds(q) : q.ths, sel = q.ths;
    var res = { q: q, paid: paid, ths: ths, sel: sel, generated: new Date().toISOString() };
    step('Finding ZIP ' + q.zip + '…');
    return zipLookup(q.zip, opts.base).then(function (ll) {
      if (!ll) throw { user: 'We couldn’t find ZIP ' + q.zip + '. It may be a PO-box or single-business ZIP with no Census area; try the ZIP of the street address of your site.' };
      res.lat = ll[0]; res.lon = ll[1];
      step('Finding NOAA stations near ZIP ' + q.zip + '…');
      var searchType = sel[0].els[0];
      var boxes = [0.25, 0.5, 1.0], i = 0;
      function search() {
        var url = NCEI_SEARCH + '?dataset=daily-summaries&bbox=' + bbox(res.lat, res.lon, boxes[i]) + '&startDate=' + q.from + 'T00:00:00&endDate=' + q.to + 'T23:59:59&dataTypes=' + searchType + '&limit=1000';
        return fetchJSON(url).then(function (j) {
          var list = parseSearch(j, res.lat, res.lon);
          if (list.length < 3 && ++i < boxes.length) return search();
          return list;
        });
      }
      return search();
    }).then(function (list) {
      var cands = candidates(list, 8);
      if (!cands.length) throw { user: 'NOAA lists no daily weather station within about 110 km (70 miles) of ZIP ' + q.zip + ' with data for these dates.' };
      res.searched = list.length;
      step('Reading daily records from ' + cands.length + ' nearby NOAA stations…');
      var types = paid ? ELEMENTS : sel.reduce(function (a, h) { return a.concat(h.els); }, []);
      var url = NCEI_DATA + '?dataset=daily-summaries&stations=' + cands.map(function (s) { return s.id; }).join(',') + '&startDate=' + q.from + '&endDate=' + q.to +
        '&dataTypes=' + types.join(',') + '&format=json&units=standard&includeAttributes=true&includeStationName=true&includeStationLocation=1';
      return fetchJSON(url, 60000).then(function (rows) { return { cands: cands, rows: rows }; });
    }).then(function (x) {
      var ix = indexRows(x.rows), latest = '';
      Object.keys(ix.by).forEach(function (s) { Object.keys(ix.by[s]).forEach(function (d) { if (d > latest) latest = d; }); });
      if (!latest) throw { user: 'NOAA returned no daily records for these dates near ZIP ' + q.zip + '. If the dates are within the last week, NOAA may not have posted them yet.' };
      res.dataThrough = latest < q.to ? latest : q.to;
      res.notYet = latest < q.to ? { from: addDays(latest, 1), to: q.to } : null;
      var days = eachDay(q.from, res.dataThrough);
      var st = pickStations(x.cands, ix.by, sel, days);
      if (!st.length) throw { user: 'The NOAA stations near ZIP ' + q.zip + ' have no usable records for these dates and thresholds.' };
      st.forEach(function (s) { var m = ix.meta[s.id] || {}; s.elev = m.elev; if (m.name) s.name = m.name; });
      res.stations = paid ? st : st.slice(0, 1);
      // Paid report: a threshold the buyer didn't pick is counted at the nearest station that measures it.
      res.thSource = {}; res.thStation = {};
      if (paid) ths.forEach(function (h) {
        if (h.mine) return;
        var pool = x.cands.slice().sort(function (a, b) { return a.km - b.km; });
        var scored = pool.map(function (c) { return { s: c, c: completeness(ix.by[c.id], [h], days) }; });
        var pick = scored.filter(function (z) { return z.c >= 0.8; })[0] || scored.sort(function (a, b) { return b.c - a.c; })[0];
        if (pick && pick.c > 0) { res.thSource[h.key] = pick.s.id; var m = ix.meta[pick.s.id] || {};
          res.thStation[h.key] = { id: pick.s.id, name: m.name || pick.s.name, km: pick.s.km, completeness: pick.c }; }
        else res.thStation[h.key] = null;
      });
      res.by = ix.by; res.days = days;
      step('Reading the 1991–2020 normals…');
      var url = NCEI_SEARCH + '?dataset=normals-monthly-1991-2020&bbox=' + bbox(res.lat, res.lon, 0.5) + '&limit=1000';
      return fetchJSON(url).then(function (j) {
        var ns = parseSearch(j, res.lat, res.lon);
        var prefer = {};
        ths.forEach(function (h) { prefer[h.key] = res.thSource[h.key] || res.stations[0].id; });
        res.normals = pickNormals(ths, ns, 50, prefer);
        var ids = {}, typ = {};
        ths.forEach(function (h) { var n = res.normals[h.key]; if (n) { ids[n.id] = 1; typ[h.normalType] = 1; } });
        if (!Object.keys(ids).length) return [];
        return fetchJSON(NCEI_DATA + '?dataset=normals-monthly-1991-2020&stations=' + Object.keys(ids).join(',') + '&dataTypes=' + Object.keys(typ).join(',') + '&format=json');
      });
    }).then(function (nrows) {
      res.nvals = indexNormals(nrows);
      var built = buildMonths({ ths: ths, sel: sel, days: res.days, stations: res.stations, by: res.by, fill: paid,
        normals: res.normals, nvals: res.nvals, thSource: res.thSource });
      if (paid) res.perStation = res.stations.map(function (s) {
        return buildMonths({ ths: sel, days: res.days, stations: [s], by: res.by }).months.map(function (m) { return { any: m.any, missing: m.missing }; });
      });
      res.months = built.months; res.totals = built.totals; res.record = built.record;
      res.events = snowEvents(built.record);
      return res;
    }).catch(function (e) {
      if (e && e.user) throw e;
      throw { user: 'NOAA’s data service didn’t answer (it may be busy or down for maintenance). Nothing was counted. Please try again in a few minutes.', cause: e };
    });
  }

  return {
    KINDS: KINDS, ORDER: ORDER, WIND_GUST: WIND_GUST, ELEMENTS: ELEMENTS,
    makeTh: makeTh, parseQuery: parseQuery, queryString: queryString, reportThresholds: reportThresholds,
    isDate: isDate, addDays: addDays, eachDay: eachDay, daysInMonth: daysInMonth, monthLabel: monthLabel, fmtDate: fmtDate,
    km: km, bbox: bbox, parseSearch: parseSearch, candidates: candidates, indexRows: indexRows, crosses: crosses, status: status,
    completeness: completeness, pickStations: pickStations, indexNormals: indexNormals, pickNormals: pickNormals,
    buildMonths: buildMonths, snowEvents: snowEvents, ranges: ranges, fmt1: fmt1, excessText: excessText, csv: csv,
    fetchJSON: fetchJSON, zipLookup: zipLookup, run: run
  };
});
