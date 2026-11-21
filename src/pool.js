/*
 * Two bots side by side: one for Divar, one for Bama, each in its own tab of the same Chrome.
 * Each site still sees one slow visitor; the two only run at the same time.
 *
 * Has the same face as a single Scanner (busy, current, start, controls) so the rest of the
 * code keeps working, plus what knows about both: runs, free(criteria), byRun(id).
 */
'use strict';

const { Scanner } = require('./scanner');

const siteOf = (c) => (c && c.source === 'bama' ? 'bama' : 'divar');

class ScannerPool {
  constructor(opts) {
    this.scanners = { divar: new Scanner(opts), bama: new Scanner(opts) };
  }

  /** Runs in progress now (0, 1 or 2). */
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
    if (s.busy) throw new Error(`یک جستجوی ${siteOf(criteria) === 'bama' ? 'باما' : 'آگهی‌ها'} در حال انجام است.`);
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

module.exports = { ScannerPool, siteOf };
