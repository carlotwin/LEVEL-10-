// Cities, counties and the buy box. Every list here is only a default: the
// dashboard's Settings page stores the team's own list and passes it in.
import { normText, titleCase } from './util.js';

const STATE_NAMES = {
  california: 'CA', nevada: 'NV', oregon: 'OR', arizona: 'AZ', washington: 'WA', texas: 'TX',
};

// Bay Area (the buy box the meeting named) plus the out-of-area cities that
// were spending money without leads. `inBuyBox` is editable in Settings.
export const DEFAULT_GEO = Object.freeze([
  ['San Jose', 'Santa Clara', true], ['Santa Clara', 'Santa Clara', true], ['Sunnyvale', 'Santa Clara', true],
  ['Mountain View', 'Santa Clara', true], ['Palo Alto', 'Santa Clara', true], ['Milpitas', 'Santa Clara', true],
  ['Campbell', 'Santa Clara', true], ['Gilroy', 'Santa Clara', true], ['Morgan Hill', 'Santa Clara', true],
  ['San Francisco', 'San Francisco', true],
  ['Oakland', 'Alameda', true], ['Fremont', 'Alameda', true], ['Hayward', 'Alameda', true], ['Berkeley', 'Alameda', true],
  ['San Leandro', 'Alameda', true], ['Union City', 'Alameda', true], ['Pleasanton', 'Alameda', true],
  ['Livermore', 'Alameda', true], ['Alameda', 'Alameda', true], ['Newark', 'Alameda', true],
  ['Concord', 'Contra Costa', true], ['Richmond', 'Contra Costa', true], ['Antioch', 'Contra Costa', true],
  ['Pittsburg', 'Contra Costa', true], ['Walnut Creek', 'Contra Costa', true], ['San Ramon', 'Contra Costa', true],
  ['Brentwood', 'Contra Costa', true],
  ['San Mateo', 'San Mateo', true], ['Daly City', 'San Mateo', true], ['Redwood City', 'San Mateo', true],
  ['San Carlos', 'San Mateo', true], ['South San Francisco', 'San Mateo', true], ['San Bruno', 'San Mateo', true],
  ['Vallejo', 'Solano', true], ['Fairfield', 'Solano', true], ['Vacaville', 'Solano', true], ['Benicia', 'Solano', true],
  ['Santa Rosa', 'Sonoma', true], ['Petaluma', 'Sonoma', true], ['Rohnert Park', 'Sonoma', true],
  ['Napa', 'Napa', true], ['San Rafael', 'Marin', true], ['Novato', 'Marin', true],
  ['Stockton', 'San Joaquin', false], ['Tracy', 'San Joaquin', false], ['Manteca', 'San Joaquin', false],
  ['Modesto', 'Stanislaus', false], ['Fresno', 'Fresno', false], ['Sacramento', 'Sacramento', false],
  ['Elk Grove', 'Sacramento', false],
].map(([city, county, inBuyBox]) => ({ city, state: 'CA', county, inBuyBox })));

const ALIASES = {
  sf: 'San Francisco', 'san fran': 'San Francisco', 'st carlos': 'San Carlos', 'st. carlos': 'San Carlos',
  'sj': 'San Jose', 'san josé': 'San Jose', 'ssf': 'South San Francisco', 'so san francisco': 'South San Francisco',
};

export function normalizeState(value) {
  const s = normText(value).replace(/\./g, '');
  if (!s) return '';
  if (/^[a-z]{2}$/.test(s)) return s.toUpperCase();
  return STATE_NAMES[s] || titleCase(s);
}

/**
 * "San Jose, California, United States" -> {city: 'San Jose', state: 'CA'}
 * "oakland ca" -> {city: 'Oakland', state: 'CA'}; '' -> {city: '', state: ''}
 */
export function parseLocation(value, defaultState = '') {
  const raw = String(value ?? '').trim();
  if (!raw || /^(unknown|--|n\/a|\(not set\)|not set|none)$/i.test(raw)) return { city: '', state: '' };
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  let city = parts[0] || '';
  let state = parts.length > 1 ? normalizeState(parts[1]) : '';
  if (parts.length === 1) {
    const m = /^(.*?)[\s]+(ca|california)$/i.exec(city);
    if (m) {
      city = m[1];
      state = 'CA';
    }
  }
  return { city: normalizeCity(city), state: state || (city ? defaultState : '') };
}

export function normalizeCity(value) {
  const s = normText(value).replace(/\s+(city of|township)$/, '');
  if (!s) return '';
  return ALIASES[s] || titleCase(s);
}

/** Build a lookup from the (possibly edited) geo list. */
export function geoIndex(geoList = DEFAULT_GEO) {
  const map = new Map();
  for (const g of geoList) map.set(`${normText(g.city)}|${g.state || 'CA'}`, g);
  return {
    get(city, state = 'CA') {
      if (!city) return null;
      return map.get(`${normText(city)}|${state || 'CA'}`) || null;
    },
    county(city, state) {
      return this.get(city, state)?.county || '';
    },
    inBuyBox(city, state) {
      const g = this.get(city, state);
      return g ? !!g.inBuyBox : null; // null = city not in the list (unknown)
    },
    outOfAreaNames() {
      return geoList.filter((g) => !g.inBuyBox).map((g) => normText(g.city));
    },
    list: geoList,
  };
}

export function cityKey(city, state) {
  return city ? `${city}|${state || ''}` : '(unknown)';
}
