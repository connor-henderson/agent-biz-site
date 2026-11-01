/* Westworks refrigerant leak-rate core.
 * Pure functions, no I/O. Used by index.html in the browser and by tests/leakcore.test.js in node.
 *
 * Rules implemented (eCFR text as of 2026-10-29; see ../../README.md "Verified rule facts"):
 *  - Leak rate formulas: 40 CFR 84.102 "Leak rate" (identical wording in 40 CFR 82.152).
 *  - Applicability: 84.106(a) (>=15 lb, HFC or substitute GWP>53; not solely-ODS; not residential/light commercial AC)
 *                   82.157(a) (>=50 lb of a class I/II ODS or a blend containing one).
 *  - Thresholds: 84.106(c)(2) and 82.157(c)(2): 20% commercial refrigeration, 30% IPR, 10% comfort cooling/other.
 *  - Transition: 84.106(b)(1)-(2) and the 2024 preamble (89 FR 82724): with no records of earlier additions, use 365 days /
 *    pounds since 2026-01-01. Pre-2026 additions that ARE entered are used (the preamble allows the substitute only when
 *    records are absent).
 *  - Deadlines: 84.106(d)-(h), (j); 82.157(d)-(h), (j).
 * Interpretations that are ours (not spelled out in the rule) are marked "OUR READING" and listed in reviews/r1.md and reviews/r2.md.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LeakCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY = 86400000;
  var PART84_START = '2026-01-01';

  // hfc: contains an HFC listed as a regulated substance in the AIM Act (40 CFR part 84 appendix A).
  // ods: contains a class I or class II ozone-depleting substance (40 CFR part 82 subpart A).
  // gwp: only needed when hfc is false and ods is false (a "substitute"); values from 40 CFR 84.64(b) table 1.
  // Blend makeup per ASHRAE Standard 34 designations (ashrae.org refrigerant designations; UNEP blend list).
  var REFRIGERANTS = [
    { id: 'R-404A', name: 'R-404A (HFC-125/143a/134a)', hfc: true, ods: false },
    { id: 'R-507A', name: 'R-507A (HFC-125/143a)', hfc: true, ods: false },
    { id: 'R-448A', name: 'R-448A (HFC-32/125/134a + HFOs)', hfc: true, ods: false },
    { id: 'R-449A', name: 'R-449A (HFC-32/125/134a + HFO-1234yf)', hfc: true, ods: false },
    { id: 'R-407A', name: 'R-407A (HFC-32/125/134a)', hfc: true, ods: false },
    { id: 'R-407C', name: 'R-407C (HFC-32/125/134a)', hfc: true, ods: false },
    { id: 'R-407F', name: 'R-407F (HFC-32/125/134a)', hfc: true, ods: false },
    { id: 'R-410A', name: 'R-410A (HFC-32/125)', hfc: true, ods: false },
    { id: 'R-134a', name: 'R-134a (HFC-134a)', hfc: true, ods: false },
    { id: 'R-32', name: 'R-32 (HFC-32)', hfc: true, ods: false },
    { id: 'R-422D', name: 'R-422D (HFC-125/134a + isobutane)', hfc: true, ods: false },
    { id: 'R-438A', name: 'R-438A (HFC-32/125/134a + hydrocarbons)', hfc: true, ods: false },
    { id: 'R-450A', name: 'R-450A (HFC-134a + HFO-1234ze)', hfc: true, ods: false },
    { id: 'R-513A', name: 'R-513A (HFC-134a + HFO-1234yf)', hfc: true, ods: false },
    { id: 'R-454A', name: 'R-454A (HFC-32 + HFO-1234yf)', hfc: true, ods: false },
    { id: 'R-454B', name: 'R-454B (HFC-32 + HFO-1234yf)', hfc: true, ods: false },
    { id: 'R-454C', name: 'R-454C (HFC-32 + HFO-1234yf)', hfc: true, ods: false },
    { id: 'R-455A', name: 'R-455A (CO2 + HFC-32 + HFO-1234yf)', hfc: true, ods: false },
    { id: 'R-22', name: 'R-22 (HCFC-22)', hfc: false, ods: true },
    { id: 'R-12', name: 'R-12 (CFC-12)', hfc: false, ods: true },
    { id: 'R-502', name: 'R-502 (HCFC-22 + CFC-115)', hfc: false, ods: true },
    { id: 'R-409A', name: 'R-409A (HCFC-22/124/142b)', hfc: false, ods: true },
    { id: 'R-401A', name: 'R-401A (HCFC-22/124 + HFC-152a)', hfc: true, ods: true },
    { id: 'R-402A', name: 'R-402A (HCFC-22 + HFC-125 + propane)', hfc: true, ods: true },
    { id: 'R-408A', name: 'R-408A (HCFC-22 + HFC-125/143a)', hfc: true, ods: true },
    { id: 'R-744', name: 'R-744 (carbon dioxide)', hfc: false, ods: false, gwp: 1 },
    { id: 'R-717', name: 'R-717 (ammonia)', hfc: false, ods: false, gwp: 1 },
    { id: 'R-290', name: 'R-290 (propane)', hfc: false, ods: false, gwp: 3.3 },
    { id: 'R-600a', name: 'R-600a (isobutane)', hfc: false, ods: false, gwp: 1 },
    { id: 'R-1270', name: 'R-1270 (propylene)', hfc: false, ods: false, gwp: 1.8 },
    { id: 'R-1234yf', name: 'R-1234yf (HFO-1234yf)', hfc: false, ods: false, gwp: 1 },
    { id: 'R-1234ze(E)', name: 'R-1234ze(E) (HFO-1234ze(E))', hfc: false, ods: false, gwp: 1 },
    { id: 'R-1233zd(E)', name: 'R-1233zd(E) (HCFO-1233zd(E))', hfc: false, ods: false, gwp: 4 }
  ];

  var CATEGORIES = {
    cr: { label: 'Commercial refrigeration (supermarket, convenience store, restaurant, cold storage)', t84: 20, t82: 20 },
    ipr: { label: 'Industrial process refrigeration (process cooling, industrial ice machines, ice rinks)', t84: 30, t82: 30 },
    comfort: { label: 'Comfort cooling (chillers and other building AC not in the light-commercial group)', t84: 10, t82: 10 },
    transport: { label: 'Refrigerated transport', t84: 10, t82: 10 },
    other: { label: 'Other appliance', t84: 10, t82: 10 },
    // EPA's Jan 2026 fact sheet (footnote 3) says chillers and certain VRF systems are NOT in this subsector,
    // while the 2024 preamble (89 FR 82719) treated VRF as part of it. VRF is therefore left out of this label.
    rlc: { label: 'Residential or light commercial AC / heat pump (rooms, homes, small commercial buildings: e.g. window and room units, PTACs, mini-splits, residential-size split systems and rooftop units)', t84: null, t82: 10 }
  };

  function findRefrigerant(id) {
    for (var i = 0; i < REFRIGERANTS.length; i++) if (REFRIGERANTS[i].id === id) return REFRIGERANTS[i];
    return null;
  }

  // ---------- dates (calendar dates as 'YYYY-MM-DD', UTC arithmetic) ----------
  function parseDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
    var p = s.split('-').map(Number);
    var t = Date.UTC(p[0], p[1] - 1, p[2]);
    var d = new Date(t);
    if (d.getUTCFullYear() !== p[0] || d.getUTCMonth() !== p[1] - 1 || d.getUTCDate() !== p[2]) return NaN;
    return t;
  }
  function fmt(t) { return new Date(t).toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / DAY); }
  function addDays(s, n) { return fmt(parseDate(s) + n * DAY); }
  function addMonths(s, n) {
    var t = new Date(parseDate(s));
    var y = t.getUTCFullYear(), m = t.getUTCMonth() + n, d = t.getUTCDate();
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return fmt(Date.UTC(y, m, Math.min(d, last)));
  }

  // ---------- formulas (40 CFR 84.102 / 82.152 "Leak rate") ----------
  function annualizingRate(lbsAdded, fullCharge, daysSinceLastAddition) {
    if (!(fullCharge > 0)) throw new Error('Full charge must be more than 0 lb');
    if (!(daysSinceLastAddition > 0)) throw new Error('Days since the last addition must be at least 1');
    var step1 = lbsAdded / fullCharge;
    var step2 = Math.min(daysSinceLastAddition, 365) / 365;
    return (step1 / step2) * 100;
  }
  function rollingRate(lbsAddedInWindow, fullCharge) {
    if (!(fullCharge > 0)) throw new Error('Full charge must be more than 0 lb');
    return (lbsAddedInWindow / fullCharge) * 100;
  }

  // ---------- applicability ----------
  // input: { refrigerant: id | {hfc, ods, gwp}, fullCharge, category }
  function applicability(input) {
    var r = typeof input.refrigerant === 'string' ? findRefrigerant(input.refrigerant) : input.refrigerant;
    var fc = Number(input.fullCharge);
    var cat = CATEGORIES[input.category];
    var out = { part84: false, part82: false, threshold84: null, threshold82: null, reasons: [], notes: [] };
    if (!r || !cat || !(fc > 0)) { out.reasons.push('Enter the refrigerant, full charge and appliance type.'); out.applies = false; out.threshold = null; out.regime = null; return out; }

    var gwpUnknown = !r.hfc && !r.ods && !(Number(r.gwp) >= 0 && r.gwp !== '' && r.gwp !== null);
    if (gwpUnknown) {
      out.reasons.push('For a refrigerant with no HFC and no HCFC/CFC, enter its GWP (from the SDS) to check Part 84 coverage (84.106(a)(2), GWPs from 84.64(b)).');
      out.needsGwp = true; out.applies = false; out.threshold = null; out.regime = null;
      return out;
    }
    var odsOnly = r.ods && !r.hfc;
    var substituteOver53 = !r.hfc && !r.ods && Number(r.gwp) > 53;
    // Part 84 subpart C (84.106(a))
    if (fc < 15) out.reasons.push('Part 84 leak repair: not covered, full charge under 15 lb (84.106(a)).');
    else if (odsOnly) out.reasons.push('Part 84 leak repair: not covered, the refrigerant is solely an ozone-depleting substance (84.106(a)(3)(i)).');
    else if (!r.hfc && !substituteOver53) out.reasons.push('Part 84 leak repair: not covered, no HFC and the refrigerant’s GWP is 53 or less (84.106(a)(2), GWPs from 84.64(b)).');
    else if (input.category === 'rlc') out.reasons.push('Part 84 leak repair: not covered, residential and light commercial AC and heat pumps are exempt (84.106(a)(3)(ii)).');
    else {
      out.part84 = true; out.threshold84 = cat.t84;
      out.reasons.push('Part 84 leak repair applies: ' + fc + ' lb (15 lb or more) of a refrigerant ' + (r.hfc ? 'containing an HFC' : 'with GWP over 53') + ', in force since January 1, 2026 (84.106(a)). Repair trigger: over ' + cat.t84 + '% (84.106(c)(2)).');
    }
    // Part 82 subpart F (82.157(a))
    if (r.ods) {
      if (fc >= 50) {
        out.part82 = true; out.threshold82 = cat.t82;
        out.reasons.push('Section 608 leak repair (Part 82) applies: ' + fc + ' lb (50 lb or more) of a refrigerant containing an ozone-depleting substance (82.157(a)). Repair trigger: over ' + cat.t82 + '% (82.157(c)(2)).');
      } else out.reasons.push('Section 608 leak repair (Part 82): not covered, under 50 lb (82.157(a)).');
    }
    if (out.part84 && out.part82) out.notes.push('Both rule sets apply to this appliance. Their formulas and triggers are the same, but Section 608 has applied all along and has no 2026 transition, so the log calculates under Section 608 rules: every earlier addition you enter counts. Keep records that satisfy both, and ask EPA whether a chronic-leak report goes through HAWK (Part 84) or 608reports@epa.gov (Part 82), or both.');
    if (input.category === 'transport' && out.part84) out.notes.push('EPA proposed on May 26, 2026 to exempt road and intermodal container transport refrigeration units from Part 84 leak repair (FR Doc. 2026-10388). As of November 1, 2026 that is a proposal, not a final rule.');
    if (input.category === 'rlc') out.notes.push('EPA says chillers are not in the exempt residential and light commercial group (89 FR 82718), and its January 2026 fact sheet says certain variable refrigerant flow (VRF) systems are not either. If this is a chiller or a large VRF system, choose comfort cooling unless EPA tells you otherwise.');
    out.applies = out.part84 || out.part82;
    out.threshold = out.part84 ? out.threshold84 : out.threshold82;
    // When both apply, calculate under Part 82 (no transition rule, so no earlier additions are dropped).
    out.regime = out.part82 ? '82' : (out.part84 ? '84' : null);
    out.both = out.part84 && out.part82;
    return out;
  }

  // ---------- the log ----------
  // appliance: { fullCharge, method: 'annualizing'|'rolling', regime: '84'|'82', category, threshold,
  //              priorAdditionDate?: 'YYYY-MM-DD', shutdownRequired?: bool }
  // events: [{ date, kind: 'add'|'fvt', lbs, exempt: null|'seasonal'|'install'|'retrofit', sameLeak: bool, purgedDestroyedLbs }]
  function computeLog(appliance, events) {
    var fc = Number(appliance.fullCharge);
    var method = appliance.method === 'rolling' ? 'rolling' : 'annualizing';
    var regime = appliance.regime === '82' ? '82' : '84';
    var threshold = Number(appliance.threshold);
    var cat = appliance.category;
    var errors = [];
    if (!(fc > 0)) errors.push('Enter the full charge in pounds.');
    if (!(threshold > 0)) errors.push('This appliance has no leak repair trigger under either rule.');

    var evs = (events || []).map(function (e, i) {
      return {
        idx: i, date: e.date, kind: e.kind === 'fvt' ? 'fvt' : 'add',
        lbs: Number(e.lbs) || 0, exempt: e.exempt || null, sameLeak: !!e.sameLeak,
        purged: Math.max(0, Number(e.purgedDestroyedLbs) || 0), note: e.note || ''
      };
    }).filter(function (e) {
      if (isNaN(parseDate(e.date))) { errors.push('Row ' + (e.idx + 1) + ': enter a date as YYYY-MM-DD.'); return false; }
      if (e.kind === 'add' && !(e.lbs > 0)) { errors.push('Row ' + (e.idx + 1) + ': enter the pounds added.'); return false; }
      return true;
    });
    // stable sort by date; on the same date an addition sorts before a follow-up verification test (OUR READING:
    // refrigerant added on the day of a successful follow-up test is treated as added before that test).
    evs.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.kind !== b.kind) return a.kind === 'add' ? -1 : 1;
      return a.idx - b.idx;
    });
    if (errors.length) return { errors: errors, rows: [], years: [] };

    var rows = [];
    var prior = appliance.priorAdditionDate && !isNaN(parseDate(appliance.priorAdditionDate)) ? appliance.priorAdditionDate : null;
    var lastFvt = null;
    var adds = []; // additions that count toward leak rates (not exempt), including pre-2026 records, for window sums
    var addDates = []; // every addition date seen so far (exempt or not): "the last day refrigerant was added"
    if (prior) addDates.push(prior);
    var groupStartPrevDate; // for annualizing same-leak groups
    var groupLbs = 0, groupFirstDate = null, groupLastDate = null;
    var hasPre2026 = !!(prior && prior < PART84_START);
    evs.forEach(function (e) { if (e.date < PART84_START) hasPre2026 = true; });
    function lastAddBefore(d) {
      var best = null;
      addDates.forEach(function (x) { if (x < d && (best === null || x > best)) best = x; });
      return best;
    }

    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      var row = { date: e.date, kind: e.kind, lbs: e.lbs, exempt: e.exempt, sameLeak: e.sameLeak, purged: e.purged, note: e.note,
        rate: null, exceeds: false, counted: true, calc: '', deadlines: [], warnings: [] };
      var leakLbs = Math.max(0, e.lbs - e.purged); // 84.106(k) / 82.157(k): purged refrigerant destroyed at >=98% is not counted

      if (regime === '84' && e.date < PART84_START) {
        // Part 84 did not apply yet: no calculation or deadline for this entry. But you have a record of it, and
        // EPA's preamble (89 FR 82724) allows the "no earlier additions" substitute only when records are absent,
        // so the entry still counts as an earlier addition for later 2026 calculations.
        row.counted = false;
        if (e.kind === 'fvt') { lastFvt = e.date; row.calc = 'Before January 1, 2026: recorded as the last successful follow-up verification test.'; }
        else {
          row.calc = 'Before January 1, 2026: Part 84 leak repair did not apply yet, so no calculation or deadline for this entry. Because you have a record of it, it is used as an earlier addition in later 2026 calculations (EPA allows ignoring pre-2026 additions only when records are absent, 89 FR 82724).';
          if (!e.exempt) adds.push({ date: e.date, lbs: leakLbs });
          addDates.push(e.date); groupStartPrevDate = undefined; groupLbs = 0; groupLastDate = null;
        }
        rows.push(row);
        continue;
      }

      if (e.kind === 'fvt') {
        lastFvt = e.date;
        row.calc = 'Successful follow-up verification test showing all identified leaks repaired. A rolling-average window restarts after this date.';
        var big = (cat === 'cr' || cat === 'ipr') && fc >= 500;
        if (regime === '84') {
          row.deadlines.push({ what: big ? 'Next leak inspection (quarterly until 4 quarters in a row under the trigger), only if this repair followed an exceedance' : 'Next leak inspection (yearly until one year under the trigger), only if this repair followed an exceedance',
            by: big ? addMonths(e.date, 3) : addMonths(e.date, 12), cite: '84.106(g)(1)' });
        } else {
          row.deadlines.push({ what: big ? 'Leak inspections once every three months until 4 quarters in a row under the trigger, if this repair followed an exceedance' : 'A leak inspection once per calendar year until one year under the trigger, if this repair followed an exceedance',
            by: null, cite: '82.157(g)(1)' });
        }
        rows.push(row);
        continue;
      }

      // ----- an addition -----
      if (e.purged > e.lbs) row.warnings.push('Purged-and-destroyed pounds are more than the pounds added; counted as 0 lb.');

      if (e.exempt) {
        row.counted = false;
        row.calc = { seasonal: 'Seasonal variance: no leak rate calculation required (84.106(b); 82.157(b)).',
          install: 'Added right after installing a new appliance: no leak rate calculation required (84.106(b); 82.157(b)).',
          retrofit: 'Added right after a retrofit: no leak rate calculation required (84.106(b); 82.157(b)).' }[e.exempt] +
          ' Not counted in later rolling sums or the 125% yearly total (OUR READING: these pounds replace no leak). Its date still counts as the last day refrigerant was added.';
        addDates.push(e.date); groupLbs = 0; groupStartPrevDate = undefined; groupLastDate = null;
        rows.push(row);
        continue;
      }

      // Same-date additions in the current group are combined (OUR READING: the formula has no meaning for zero days).
      var autoSame = groupStartPrevDate !== undefined && groupLastDate === e.date;
      var same = e.sameLeak || autoSame;
      adds.push({ date: e.date, lbs: leakLbs });

      if (method === 'annualizing') {
        var prevForCalc, dayEnd = e.date;
        if (same && groupStartPrevDate !== undefined) {
          // OUR READING: pounds for one leak are summed (84.102 Step 1 "in one addition or in multiple additions
          // related to same leak"); days run from the addition before the leak to the leak's first addition,
          // which gives the higher (more conservative) rate.
          groupLbs += leakLbs; prevForCalc = groupStartPrevDate; dayEnd = groupFirstDate;
        } else {
          groupFirstDate = e.date;
          // the last addition strictly before today (a same-day exempt addition does not make the interval zero)
          prevForCalc = lastAddBefore(e.date);
          if (prevForCalc === null && prior && prior >= e.date) prevForCalc = prior; // reported as a date error below
          groupStartPrevDate = prevForCalc; groupLbs = leakLbs;
        }
        groupLastDate = e.date;
        var days;
        if (prevForCalc === null || prevForCalc === undefined) {
          days = 365;
          if (regime === '84') row.warnings.push('No earlier addition entered, so 365 days were used (84.106(b)(1)). EPA allows this only when you have no record of an earlier addition (89 FR 82724). If refrigerant was added earlier, even in 2025, enter that date.');
          else row.warnings.push('No earlier addition entered, so 365 days were assumed. Section 608 has no default: enter the date refrigerant was last added (or the installation date) for a correct rate.');
        } else {
          days = Math.min(daysBetween(prevForCalc, dayEnd), 365);
          if (days < 1) {
            row.warnings.push('The earlier addition date (' + prevForCalc + ') is not before this one, so no rate was calculated. Check the dates.');
            addDates.push(e.date); rows.push(row); continue;
          }
        }
        row.days = days; row.step1Lbs = groupLbs;
        row.rate = annualizingRate(groupLbs, fc, days);
        row.calc = 'Annualizing: (' + round2(groupLbs) + ' lb ÷ ' + fc + ' lb) ÷ (' + days + ' ÷ 365) × 100' +
          (same && groupLbs !== leakLbs ? ' (pounds summed with earlier additions for the same leak' + (autoSame ? ' on the same day' : '') + ')' : '');
      } else {
        var start = parseDate(e.date) - 365 * DAY; // previous 365-day period: (date-365, date]
        var startLabel = 'the previous 365 days';
        if (lastFvt && parseDate(lastFvt) >= start) { start = parseDate(lastFvt); startLabel = 'the follow-up verification test on ' + lastFvt; }
        var sum = 0;
        adds.forEach(function (a) { var t = parseDate(a.date); if (t > start && t <= parseDate(e.date)) sum += a.lbs; });
        row.windowLbs = sum;
        row.rate = rollingRate(sum, fc);
        row.calc = 'Rolling average: ' + round2(sum) + ' lb added since ' + startLabel + ' ÷ ' + fc + ' lb × 100';
        if (rows.filter(function (r) { return r.kind === 'add'; }).length === 0) {
          if (regime === '84' && !hasPre2026 && e.date < addDays(PART84_START, 365)) row.warnings.push('Only additions from January 1, 2026 on are counted, because none earlier were entered (84.106(b)(2)). EPA allows this only when you have no records of earlier additions (89 FR 82724); if you do, enter them.');
          else row.warnings.push('Rolling average counts every addition in the past 365 days. Enter all of them, or this rate will be too low.');
        }
      }
      addDates.push(e.date);

      row.exceeds = row.rate > threshold; // "over the applicable leak rate" (84.106(c)(1)): strictly greater
      if (row.exceeds) {
        var n = appliance.shutdownRequired ? 120 : 30;
        var part = regime === '84' ? '84.106' : '82.157';
        var how = regime === '84' ? 'through EPA\'s reporting platform (HAWK in CDX)' : 'by email to 608reports@epa.gov (82.157(m))';
        row.deadlines.push({ what: 'Find and repair the leaks (leak inspection by a certified technician), and pass an initial verification test', by: addDays(e.date, n), cite: part + '(d), (e)(1)' });
        row.deadlines.push({ what: 'Follow-up verification test: within 10 days of the successful initial test (or of returning to normal operating conditions if the system was evacuated)', by: null, cite: part + '(e)(2)' });
        row.deadlines.push({ what: 'If you need more time and qualify (parts not available, other laws, radiological areas): request an extension from EPA ' + how, by: addDays(e.date, n), cite: part + '(f)' });
        row.deadlines.push({ what: 'If you will retrofit or retire instead of repairing, or take no action: a written, signed retrofit or retirement plan', by: addDays(e.date, 30), cite: part + '(h)(1)' });
      }
      rows.push(row);
    }

    // chronic leakers: 125% or more of full charge in a calendar year (84.106(j); 82.157(j)).
    // Part 84 years before 2026 are not reported (the section applied from 2026-01-01).
    var byYear = {};
    adds.forEach(function (a) { var y = a.date.slice(0, 4); if (regime === '84' && y < PART84_START.slice(0, 4)) return; byYear[y] = (byYear[y] || 0) + a.lbs; });
    var years = Object.keys(byYear).sort().map(function (y) {
      var pct = byYear[y] / fc * 100;
      return { year: y, lbs: byYear[y], pct: pct, chronic: pct >= 125, reportDue: (Number(y) + 1) + '-03-01',
        reportTo: regime === '84' ? 'through EPA\'s reporting platform (HAWK in CDX)' : 'by email to 608reports@epa.gov',
        cite: regime === '84' ? '84.106(j), (m)(4)' : '82.157(j), (m)(4)' };
    });
    return { errors: [], rows: rows, years: years, method: method, regime: regime, threshold: threshold };
  }

  function round2(x) { return Math.round(x * 100) / 100; }

  // ---------- CSV export / import (plain text, pasteable into an email) ----------
  var CSV_HEAD = ['appliance', 'refrigerant', 'full_charge_lb', 'appliance_type', 'method', 'date', 'entry', 'lbs', 'same_leak', 'no_calc_reason', 'purged_destroyed_lb', 'leak_rate_pct', 'over_trigger', 'note'];
  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from treating text as a formula
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(appliance, result) {
    var lines = [CSV_HEAD.join(',')];
    result.rows.forEach(function (r) {
      lines.push([appliance.name || '', appliance.refrigerant || '', appliance.fullCharge, appliance.category, result.method, r.date,
        r.kind === 'fvt' ? 'follow-up test passed' : 'addition', r.kind === 'add' ? r.lbs : '', r.sameLeak ? 'yes' : '', r.exempt || '',
        r.purged || '', r.rate === null ? '' : r.rate.toFixed(1), r.rate === null ? '' : (r.exceeds ? 'yes' : 'no'), r.note || ''].map(csvCell).join(','));
    });
    return lines.join('\n');
  }

  return {
    REFRIGERANTS: REFRIGERANTS, CATEGORIES: CATEGORIES, PART84_START: PART84_START,
    findRefrigerant: findRefrigerant, parseDate: parseDate, daysBetween: daysBetween, addDays: addDays, addMonths: addMonths,
    annualizingRate: annualizingRate, rollingRate: rollingRate, applicability: applicability, computeLog: computeLog, toCSV: toCSV
  };
});
