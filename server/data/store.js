// =============================================================================
// Resume-safe job state. Written after EVERY contact so a crash/Stop/restart
// resumes cleanly and nothing is re-processed. Plain JSON on disk.
// =============================================================================
import fs from 'node:fs';
import { statePath } from './paths.js';

const EMPTY = () => ({
  jobId: null,
  campaignBatch: null,
  status: 'idle', // idle | running | paused | stopped | done
  createdAt: null,
  updatedAt: null,
  cursor: 0, // index of the next contact to process
  totals: {},
  contactsMeta: { count: 0, tab: null, source: null },
  results: [], // per-contact result rows (aligned to contact index)
});

export class Store {
  constructor(file = statePath()) {
    this.file = file;
    this.state = EMPTY();
    this._load();
  }

  _load() {
    try {
      this.state = { ...EMPTY(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      this.state = EMPTY();
    }
  }

  save() {
    this.state.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  reset() {
    this.state = EMPTY();
    this.save();
  }

  init({ jobId, campaignBatch, count, tab, source }) {
    this.state = EMPTY();
    this.state.jobId = jobId;
    this.state.campaignBatch = campaignBatch;
    this.state.status = 'running';
    this.state.createdAt = new Date().toISOString();
    this.state.contactsMeta = { count, tab, source };
    this.state.results = new Array(count).fill(null);
    this.save();
    return this.state;
  }

  setStatus(status) {
    this.state.status = status;
    this.save();
  }

  recordResult(index, result) {
    this.state.results[index] = result;
    this.state.cursor = Math.max(this.state.cursor, index + 1);
    this.save();
  }

  get() {
    return this.state;
  }
}
