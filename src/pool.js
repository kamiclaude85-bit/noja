/*
 * Bots side by side: one per site (Divar, Bama, Hamrah Mechanic, Khodro45), each in its own tab of
 * the same Chrome. Each site still sees one slow visitor; they only run at the same time.
 *
 * Has the same face as a single Scanner (busy, current, start, controls) so the rest of the
 * code keeps working, plus what knows about both: runs, free(criteria), byRun(id).
 */
'use strict';

const { Scanner } = require('./scanner');

const SITE_IDS = ['divar', 'bama', 'hamrah', 'k45'];
const SITE_NAMES = { divar: 'آگهی‌ها', bama: 'باما', hamrah: 'همراه مکانیک', k45: 'خودرو۴۵' };
const siteOf = (c) => (c && SITE_IDS.includes(c.source) ? c.source : 'divar');

class ScannerPool {
  constructor(opts) {
    this.scanners = Object.fromEntries(SITE_IDS.map((id) => [id, new Scanner(opts)]));
  }

  /** Runs in progress now (one at most per site). */
  get runs() {
    return Object.values(this.scanners).filter((s) => s.busy && s.current).map((s) => s.current);
  }

  /** Something is running (on either site). */
  get busy() { return this.runs.length > 0; }

  /** The run in progress (Divar's first), for code that shows one. */
  get current() { return this.runs[0] || null; }

  /** Can a search of this site start now? */
  free(criteria) { return !this.scanners[siteOf(criteria)].busy; }

  scannerFor(criteria) { return this.scanners[siteOf(criteria)]; }

  /** The scanner running this run, or null. */
  byRun(id) {
    return Object.values(this.scanners).find((s) => s.current && s.current.id === id) || null;
  }

  runById(id) {
    const s = this.byRun(id);
    return s ? s.current : null;
  }

  start(criteria) {
    const s = this.scannerFor(criteria);
    if (s.busy) throw new Error(`یک جستجوی ${SITE_NAMES[siteOf(criteria)]} در حال انجام است.`);
    return s.start(criteria);
  }

  // controls of a single run; without an id they act on all (used rarely)
  control(id, action) {
    const s = this.byRun(id);
    if (!s || typeof s[action] !== 'function') return false;
    s[action]();
    return true;
  }
  stop() { for (const s of Object.values(this.scanners)) s.stop(); }
  focus() { const s = this.byRun(this.current && this.current.id); if (s) s.focus(); }
}

module.exports = { ScannerPool, siteOf, SITE_IDS, SITE_NAMES };
