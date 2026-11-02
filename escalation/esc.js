/* Westworks Price Escalation Calculator engine (browser + node).
   Data: BLS public index values. A static snapshot (data/series.json, built from BLS flat files) covers
   2005 onward; the browser then asks BLS's public API (v1, no key, CORS open) for the latest ~3 years of each
   series used and lets BLS's live values win. Source notes: experiments/candidates/escalation/ in the ops repo. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ESC = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var API = 'https://api.bls.gov/publicAPI/v1/timeseries/data/';
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var ID_RE = /^[A-Z0-9]{6,24}$/;

  function monthLabel(m) { var p = m.split('-'); return MONTHS[+p[1] - 1] + ' ' + p[0]; }
  function shortMonth(m) { var p = m.split('-'); return MONTHS[+p[1] - 1].slice(0, 3) + ' ' + p[0]; }
  function addMonths(m, k) { var p = m.split('-'), t = (+p[0]) * 12 + (+p[1] - 1) + k; return Math.floor(t / 12) + '-' + ('0' + (t % 12 + 1)).slice(-2); }
  function monthsBetween(a, b) { var out = [], m = a; while (m <= b) { out.push(m); m = addMonths(m, 1); } return out; }
  function isMonth(s) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || '')); }
  function money(x) { var neg = x < 0, s = Math.abs(x).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); return (neg ? '−$' : '$') + s; }
  function pct(x, d) { d = d == null ? 2 : d; return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(d) + '%'; }
  function round2(x) { return Math.round(x * 100 + (x >= 0 ? 1e-9 : -1e-9)) / 100; }

  // value strings in the snapshot look like "388.580" or "388.580P" (P = preliminary)
  function parseV(s) { if (s == null) return null; var p = /P$/.test(s); return { v: parseFloat(p ? s.slice(0, -1) : s), raw: p ? s.slice(0, -1) : s, prelim: p }; }

  /* Escalation rule.
     o.direction: 'both' (decreases credit back) or 'up' (increases only)
     o.trigger: percent; 0 = none
     o.mode: 'excess' (only the change beyond the trigger) or 'full' (the whole change once past the trigger)
     o.cap: percent; 0 = none (applied to the adjustment percent after the trigger)
     Returns { change, applied, adjustment, steps[] } with percents rounded only for display. */
  function applyRule(baseV, curV, amount, o) {
    o = o || {};
    var change = (curV / baseV - 1) * 100, eff = change, steps = [];
    steps.push('Index change = (' + curV + ' ÷ ' + baseV + ' − 1) × 100 = ' + pct(change, 3));
    if (o.direction === 'up' && eff < 0) { eff = 0; steps.push('Increases only: a decrease counts as 0%'); }
    var t = +o.trigger || 0;
    if (t > 0) {
      if (Math.abs(eff) <= t) { steps.push('Change is within the ' + t + '% trigger, so nothing is adjusted'); eff = 0; }
      else if (o.mode === 'full') steps.push('Change is past the ' + t + '% trigger; the whole change applies');
      else { eff = (eff > 0 ? 1 : -1) * (Math.abs(eff) - t); steps.push('Only the part beyond the ' + t + '% trigger applies: ' + pct(eff, 3)); }
    }
    var c = +o.cap || 0;
    if (c > 0 && Math.abs(eff) > c) { eff = (eff > 0 ? 1 : -1) * c; steps.push('Capped at ' + c + '%'); }
    var adj = amount != null && isFinite(amount) ? round2(amount * eff / 100) : null;
    if (adj != null) steps.push('Adjustment = ' + money(amount) + ' × ' + pct(eff, 3) + ' = ' + money(adj));
    return { change: change, applied: eff, adjustment: adj, steps: steps };
  }

  /* Data layer */
  var snapshot = null;
  function loadSnapshot(url) {
    if (snapshot) return Promise.resolve(snapshot);
    return fetch(url || 'data/series.json').then(function (r) { if (!r.ok) throw new Error('snapshot ' + r.status); return r.json(); })
      .then(function (j) { snapshot = j; j.byId = {}; j.series.forEach(function (s) { j.byId[s.id] = s; }); return j; });
  }
  function setSnapshot(j) { snapshot = j; j.byId = {}; j.series.forEach(function (s) { j.byId[s.id] = s; }); }

  // One GET per series: BLS v1 returns about the last 3 years. No key; BLS limits v1 to 25 requests a day per IP.
  function fetchLive(id, fetcher) {
    var f = fetcher || fetch;
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 12000);
    return f(API + encodeURIComponent(id), ctl ? { signal: ctl.signal } : {}).then(function (r) { return r.json(); }).then(function (j) {
      clearTimeout(timer);
      if (!j || j.status !== 'REQUEST_SUCCEEDED' || !j.Results || !j.Results.series || !j.Results.series[0]) {
        var msg = j && j.message && j.message.join ? j.message.join(' ') : '';
        return { ok: false, why: /threshold|daily/i.test(msg) ? 'limit' : 'error', msg: msg };
      }
      var s = j.Results.series[0], v = {};
      (s.data || []).forEach(function (d) {
        if (!/^M(0[1-9]|1[0-2])$/.test(d.period) || d.value === '-' || d.value === '') return;
        var prelim = (d.footnotes || []).some(function (fn) { return fn && fn.code === 'P'; });
        v[d.year + '-' + d.period.slice(1)] = d.value + (prelim ? 'P' : '');
      });
      if (!Object.keys(v).length) return { ok: false, why: 'empty', msg: (j.message || []).join(' ') };
      return { ok: true, v: v };
    }, function (e) { clearTimeout(timer); return { ok: false, why: 'network', msg: String(e && e.message || e) }; });
  }

  /* Merge snapshot + live for each id. Returns { series: {id: {meta, v, revised:[months], live:bool}}, notes } */
  function getSeries(ids, opts) {
    opts = opts || {};
    var uniq = ids.filter(function (x, i) { return ids.indexOf(x) === i; });
    return Promise.all(uniq.map(function (id) {
      var meta = snapshot && snapshot.byId[id];
      var live = opts.offline ? Promise.resolve({ ok: false, why: 'offline' }) : fetchLive(id, opts.fetcher);
      return live.then(function (L) {
        var v = {}, revised = [];
        if (meta) Object.keys(meta.v).forEach(function (m) { v[m] = meta.v[m]; });
        if (L.ok) Object.keys(L.v).forEach(function (m) {
          if (v[m] != null && parseV(v[m]).v !== parseV(L.v[m]).v) revised.push(m);
          v[m] = L.v[m];
        });
        var info = meta ? { id: id, label: meta.label, title: meta.title, kind: meta.kind, base: meta.base, group: meta.group }
                        : { id: id, label: 'BLS series ' + id, title: 'BLS series ' + id, kind: /^CU|^CW/.test(id) ? 'CPI' : 'Other', base: '', group: 'Other' };
        var months = Object.keys(v).sort();
        return { id: id, meta: info, v: v, live: !!L.ok, liveWhy: L.ok ? '' : L.why, revised: revised, first: months[0], last: months[months.length - 1], known: !!meta };
      });
    })).then(function (arr) { var out = {}; arr.forEach(function (s) { out[s.id] = s; }); return out; });
  }

  /* Validate one line. q: {id, base, cur, amount, direction, trigger, mode, cap} */
  function validate(q) {
    if (!q.id || !ID_RE.test(q.id)) return 'Pick an index.';
    if (!isMonth(q.base) || !isMonth(q.cur)) return 'Pick a base month and a current month.';
    if (q.cur <= q.base) return 'The current month has to be after the base month.';
    if (q.amount != null && (!isFinite(q.amount) || q.amount < 0 || q.amount > 1e10)) return 'Enter the dollar amount as a number, or leave it blank.';
    if (q.trigger != null && (!isFinite(q.trigger) || q.trigger < 0 || q.trigger > 100)) return 'The trigger has to be between 0 and 100 percent.';
    if (q.cap != null && (!isFinite(q.cap) || q.cap < 0 || q.cap > 1000)) return 'The cap has to be between 0 and 1000 percent.';
    return '';
  }

  /* Compute one line against merged series s. Returns {error} or a result. */
  function computeLine(q, s) {
    var b = parseV(s.v[q.base]), c = parseV(s.v[q.cur]);
    if (!b || !c) {
      var miss = !b ? q.base : q.cur;
      var why = miss > s.last ? 'BLS hasn\'t published ' + monthLabel(miss) + ' for this index yet (latest: ' + monthLabel(s.last) + ').'
        : miss < s.first ? 'This tool has this index from ' + monthLabel(s.first) + ' on.'
        : 'BLS published no value for ' + monthLabel(miss) + ' for this index.';
      return { error: why };
    }
    var r = applyRule(b.v, c.v, q.amount, q);
    r.baseV = b; r.curV = c; r.series = s;
    r.prelim = b.prelim || c.prelim;
    r.revised = s.revised.filter(function (m) { return m === q.base || m === q.cur; });
    return r;
  }

  function queryString(q) {
    var p = new URLSearchParams();
    p.set('s', q.id); p.set('b', q.base); p.set('c', q.cur);
    if (q.amount != null) p.set('amt', String(q.amount));
    if (q.direction === 'up') p.set('dir', 'up');
    if (q.trigger) p.set('trig', String(q.trigger));
    if (q.trigger && q.mode === 'full') p.set('mode', 'full');
    if (q.cap) p.set('cap', String(q.cap));
    return p.toString();
  }
  function num(x) { if (x == null || String(x).trim() === '') return null; var n = parseFloat(String(x).replace(/[$,\s]/g, '')); return isFinite(n) ? n : NaN; }
  function parseQuery(p) {
    var g = function (k) { return p.get ? p.get(k) : p[k]; };
    return { id: String(g('s') || '').toUpperCase().trim(), base: g('b') || '', cur: g('c') || '', amount: num(g('amt')),
             direction: g('dir') === 'up' ? 'up' : 'both', trigger: num(g('trig')) || 0, mode: g('mode') === 'full' ? 'full' : 'excess', cap: num(g('cap')) || 0 };
  }

  return { API: API, MONTHS: MONTHS, monthLabel: monthLabel, shortMonth: shortMonth, addMonths: addMonths, monthsBetween: monthsBetween,
           isMonth: isMonth, money: money, pct: pct, parseV: parseV, applyRule: applyRule, loadSnapshot: loadSnapshot, setSnapshot: setSnapshot,
           fetchLive: fetchLive, getSeries: getSeries, validate: validate, computeLine: computeLine, queryString: queryString, parseQuery: parseQuery, num: num };
}));
