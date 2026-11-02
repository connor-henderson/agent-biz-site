/* Westworks C2 Prospect CSV engine (UMD: browser + node).
 *
 * Open code, on purpose. It builds one state's CSV in the buyer's browser from four
 * keyless, read-only queries to USAC Open Data (Socrata, CORS-open, Public Domain):
 *   6brt-5pbv  C2 Budget Tool Data FY2021+   (this cycle's and last cycle's budgets)
 *   qdmp-ygft  Form 471 FRN Status           (C2 FRNs FY2021+: vendors, discount, contract end)
 *   jt8s-3q52  FCC Form 470 Tool Data        (FY2026/FY2027 Form 470s, grouped per form)
 * No person fields are requested: no contact names, emails or phone numbers. USAC says
 * email harvesting is not an authorized use of its open data; this file never asks for any.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.C2CSV = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var BASE = 'https://opendata.usac.org/resource/';
  var CYCLE = 'FY2026-2030', PREV = 'FY2021-2025';
  var C2_TYPES = ['Internal Connections', 'Basic Maintenance of Internal Connections', 'Managed Internal Broadband Services'];
  var VENDOR_STATUSES = {Funded: 1, Pending: 1};
  var PAGE = 50000;
  var STATES = ['AK','AL','AR','AS','AZ','CA','CO','CT','DC','DE','FL','GA','GU','HI','IA','ID','IL','IN','KS','KY','LA','MA','MD','ME','MI','MN','MO','MP','MS','MT','NC','ND','NE','NH','NJ','NM','NV','NY','OH','OK','OR','PA','PR','RI','SC','SD','TN','TX','UT','VA','VI','VT','WA','WI','WV','WY'];

  // Column order of the CSV (header = these keys). Documented on csv.html.
  var COLUMNS = [
    'rank', 'ben', 'entity_name', 'entity_type', 'city', 'state', 'budget_status',
    'full_time_students', 'library_sq_ft', 'child_entities',
    'c2_budget_fy2026_2030', 'funded', 'pending', 'left', 'pct_left',
    'c2_discount_pct', 'c2_discount_from_fy', 'est_erate_share_of_left',
    'prev_cycle_budget_fy2021_2025', 'prev_cycle_funded', 'prev_cycle_used_pct',
    'c2_frns_fy2021_on', 'last_c2_frn_fy', 'c2_vendors_fy2021_on', 'latest_c2_contract_end',
    'consultant_crn', 'flags',
    'f470_fy2026_count', 'f470_fy2027_count', 'latest_470_number', 'latest_470_fy',
    'latest_470_categories', 'latest_470_certified', 'latest_470_contract_from',
    'fy2027_c2_470_bidding_open', 'usac_data_pulled_utc'
  ];

  function q(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

  /** The four query specs for one state. Each: {key, dataset, params}. */
  function queries(state) {
    if (STATES.indexOf(state) < 0) throw new Error('unknown state ' + state);
    var types = C2_TYPES.map(q).join(',');
    return [
      {key: 'cur', dataset: '6brt-5pbv', params: {
        $select: 'ben,billed_entity_name,city,state,applicant_type,consulting_firm_name_crn,child_entity_count,full_time_students,library_square_footage,c2_budget,c2_budget_version,funded_c2_budget_amount,pending_c2_budget_amount,available_c2_budget_amount',
        $where: 'state=' + q(state) + ' AND c2_budget_cycle=' + q(CYCLE), $order: 'ben'}},
      {key: 'prev', dataset: '6brt-5pbv', params: {
        $select: 'ben,c2_budget,funded_c2_budget_amount,pending_c2_budget_amount',
        $where: 'state=' + q(state) + ' AND c2_budget_cycle=' + q(PREV), $order: 'ben'}},
      {key: 'frn', dataset: 'qdmp-ygft', params: {
        $select: 'funding_request_number,form_version,ben,funding_year,spin_name,form_471_frn_status_name,dis_pct,total_pre_discount_costs,contract_expiration_date',
        $where: 'state=' + q(state) + " AND funding_year>='2021' AND form_471_service_type_name in(" + types + ')',
        $order: 'funding_request_number,form_version'}},
      {key: 'f470', dataset: 'jt8s-3q52', params: {
        $select: 'application_number,form_version,fcc_form_470_status,funding_year,billed_entity_number,service_category,max(certified_date_time) AS cert,max(allowable_contract_date) AS ok',
        $where: 'billed_entity_state=' + q(state) + " AND funding_year in('2026','2027')",
        $group: 'application_number,form_version,fcc_form_470_status,funding_year,billed_entity_number,service_category',
        $order: 'application_number,form_version,service_category'}}
    ];
  }

  function url(spec, offset) {
    var p = [], k;
    for (k in spec.params) p.push(encodeURIComponent(k) + '=' + encodeURIComponent(spec.params[k]));
    p.push('$limit=' + PAGE, '$offset=' + (offset || 0));
    return BASE + spec.dataset + '.json?' + p.join('&');
  }

  /** Fetch every page of one spec. fetchFn(url) -> Promise<array>. */
  function fetchAll(spec, fetchFn) {
    var rows = [];
    function page(off) {
      return fetchFn(url(spec, off)).then(function (got) {
        if (!Array.isArray(got)) throw new Error('USAC returned an unexpected answer');
        rows = rows.concat(got);
        return got.length < PAGE ? rows : page(off + PAGE);
      });
    }
    return page(0);
  }

  function num(v) { if (v == null || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function cents(v) { return v == null ? null : Math.round(v * 100) / 100; }
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function day(s) { return s ? String(s).slice(0, 10) : ''; }

  /** USAC publishes the consultant as "Firm Name (CRN)". We keep only the CRN, a USAC
   *  identifier: some firm names are a person's name, and the CSV carries no person names. */
  function crn(s) { var m = /\((\d{6,9})\)\s*$/.exec(clean(s)); return m ? m[1] : ''; }

  function flags(r, left, b) {
    var f = [];
    if (r.c2_budget_version === 'Forecast') f.push('forecast_not_validated');
    if (left != null && left < 0) f.push('requests_exceed_budget');
    if (r.c2_budget_version === 'Forecast' && r.applicant_type === 'School' && (num(r.full_time_students) || 0) >= 5000) f.push('large_single_school_forecast');
    return f.join(' ');
  }

  /** Keep each form's Current version if one exists, else its Original. */
  function pickVersion(rows, key) {
    var cur = {};
    rows.forEach(function (r) { if (r[key] && r.form_version === 'Current') cur[r[key]] = 1; });
    return rows.filter(function (r) { return r[key] && ((r.form_version === 'Current') === !!cur[r[key]]); });
  }

  /** raw = {cur, prev, frn, f470} arrays as returned by USAC; today = 'YYYY-MM-DD'. */
  function build(state, raw, today, pulledUtc) {
    var prev = {};
    raw.prev.forEach(function (r) { prev[r.ben] = r; });

    // C2 FRNs under each BEN (deduped by FRN, Current preferred).
    var frn = {};
    pickVersion(raw.frn, 'funding_request_number').forEach(function (r) {
      if (!VENDOR_STATUSES[r.form_471_frn_status_name] || !r.ben) return;
      var e = frn[r.ben] || (frn[r.ben] = {n: 0, lastFy: 0, disc: null, discFy: 0, vendors: {}, end: ''});
      var fy = Number(r.funding_year), d = num(r.dis_pct), amt = num(r.total_pre_discount_costs) || 0;
      e.n++;
      if (fy > e.lastFy) e.lastFy = fy;
      if (d != null && (fy > e.discFy || (fy === e.discFy && d > e.disc))) { e.disc = d; e.discFy = fy; }
      var v = clean(r.spin_name);
      if (v) e.vendors[v] = (e.vendors[v] || 0) + amt;
      var end = day(r.contract_expiration_date);
      if (end > e.end) e.end = end;
    });

    // Form 470s per BEN (certified only, one entry per form).
    var forms = {};
    pickVersion(raw.f470, 'application_number').forEach(function (r) {
      if (r.fcc_form_470_status !== 'Certified') return;
      var a = r.application_number;
      var f = forms[a] || (forms[a] = {app: a, ben: r.billed_entity_number, fy: Number(r.funding_year), cert: day(r.cert), ok: day(r.ok), cats: {}});
      var c = r.service_category || '';
      if (c.indexOf('Category 1') === 0) f.cats['1'] = 1; else if (c.indexOf('Category 2') === 0) f.cats['2'] = 1;
      if (day(r.cert) > f.cert) f.cert = day(r.cert);
      if (day(r.ok) > f.ok) f.ok = day(r.ok);
    });
    var by470 = {};
    Object.keys(forms).forEach(function (a) { var f = forms[a]; (by470[f.ben] || (by470[f.ben] = [])).push(f); });

    var out = raw.cur.map(function (r) {
      var b = num(r.c2_budget), fu = num(r.funded_c2_budget_amount), pe = num(r.pending_c2_budget_amount),
          left = num(r.available_c2_budget_amount), p = prev[r.ben], e = frn[r.ben], fs = by470[r.ben] || [];
      fs.sort(function (x, y) { return x.cert < y.cert ? 1 : x.cert > y.cert ? -1 : Number(y.app) - Number(x.app); });
      var latest = fs[0], pb = p ? num(p.c2_budget) : null, pf = p ? num(p.funded_c2_budget_amount) : null;
      var vendors = e ? Object.keys(e.vendors).sort(function (x, y) { return e.vendors[y] - e.vendors[x] || (x < y ? -1 : 1); }).slice(0, 3)
        .map(function (v) { return v + ' ($' + Math.round(e.vendors[v]).toLocaleString('en-US') + ')'; }).join('; ') : '';
      var open = fs.some(function (f) { return f.fy === 2027 && f.cats['2'] && f.ok && f.ok > today; });
      return {
        ben: r.ben, entity_name: clean(r.billed_entity_name), entity_type: clean(r.applicant_type), city: clean(r.city), state: state,
        budget_status: clean(r.c2_budget_version),
        full_time_students: num(r.full_time_students), library_sq_ft: num(r.library_square_footage), child_entities: num(r.child_entity_count),
        c2_budget_fy2026_2030: cents(b), funded: cents(fu), pending: cents(pe), left: cents(left),
        pct_left: b > 0 && left != null ? Math.round(Math.max(0, left) / b * 1000) / 10 : null,
        c2_discount_pct: e && e.disc != null ? Math.round(e.disc * 100) : null,
        c2_discount_from_fy: e && e.disc != null ? e.discFy : null,
        est_erate_share_of_left: e && e.disc != null && left > 0 ? cents(left * e.disc) : null,
        prev_cycle_budget_fy2021_2025: cents(pb), prev_cycle_funded: cents(pf),
        prev_cycle_used_pct: pb > 0 && pf != null ? Math.round(pf / pb * 1000) / 10 : null,
        c2_frns_fy2021_on: e ? e.n : 0, last_c2_frn_fy: e ? e.lastFy : null,
        c2_vendors_fy2021_on: vendors, latest_c2_contract_end: e ? e.end : '',
        consultant_crn: crn(r.consulting_firm_name_crn),
        flags: flags(r, left, b),
        f470_fy2026_count: fs.filter(function (f) { return f.fy === 2026; }).length,
        f470_fy2027_count: fs.filter(function (f) { return f.fy === 2027; }).length,
        latest_470_number: latest ? latest.app : '', latest_470_fy: latest ? latest.fy : null,
        latest_470_categories: latest ? Object.keys(latest.cats).sort().map(function (c) { return 'C' + c; }).join('+') : '',
        latest_470_certified: latest ? latest.cert : '', latest_470_contract_from: latest ? latest.ok : '',
        fy2027_c2_470_bidding_open: open ? 'yes' : 'no',
        usac_data_pulled_utc: pulledUtc || ''
      };
    });
    out.sort(function (x, y) { return (y.left || 0) - (x.left || 0) || (x.ben < y.ben ? -1 : 1); });
    out.forEach(function (r, i) { r.rank = i + 1; });
    return out;
  }

  function cell(v) {
    if (v == null) return '';
    var s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;  // spreadsheet formula guard
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(rows) {
    var lines = [COLUMNS.join(',')];
    rows.forEach(function (r) { lines.push(COLUMNS.map(function (c) { return cell(r[c]); }).join(',')); });
    return lines.join('\r\n') + '\r\n';
  }

  function summary(rows) {
    var s = {n: rows.length, left: 0, budget: 0, open470: 0, noC2Frn: 0};
    rows.forEach(function (r) { s.left += r.left || 0; s.budget += r.c2_budget_fy2026_2030 || 0;
      if (r.fy2027_c2_470_bidding_open === 'yes') s.open470++; if (!r.c2_frns_fy2021_on) s.noC2Frn++; });
    return s;
  }

  /** Browser/node: run all four queries and build. fetchFn(url) -> Promise<json>. */
  function run(state, fetchFn, today, onProgress) {
    var specs = queries(state), raw = {}, done = 0;
    return Promise.all(specs.map(function (s) {
      return fetchAll(s, fetchFn).then(function (rows) { raw[s.key] = rows; done++; if (onProgress) onProgress(done, specs.length); });
    })).then(function () {
      if (!raw.cur.length) throw new Error('USAC returned no budget rows for ' + state);
      var pulled = new Date().toISOString().slice(0, 19) + 'Z';
      return {rows: build(state, raw, today, pulled), raw: raw, pulled: pulled};
    });
  }

  return {COLUMNS: COLUMNS, STATES: STATES, C2_TYPES: C2_TYPES, queries: queries, url: url, fetchAll: fetchAll,
          pickVersion: pickVersion, crn: crn, build: build, toCsv: toCsv, cell: cell, summary: summary, run: run};
}));
