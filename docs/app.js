const API_BASE = "https://api.openalex.org/works";
const API_KEY = (typeof window.OPENALEX_API_KEY === 'string' && window.OPENALEX_API_KEY.trim())
  ? window.OPENALEX_API_KEY.trim()
  : null;

// Elements
const el = (id) => document.getElementById(id);
const form = el('search-form');
const qIn = el('q');
const yearIn = el('year');

const sourceTypeIn = el('sourceType');
const perIn = el('per');
const sortIn = el('sort');

const oaIn = el('oa');
const hasFulltextIn = el('hasFulltext');
const hasAbstractIn = el('hasAbstract');

const meta = el('meta');
const results = el('results');
const pager = el('pager');
const prevBtn = el('prev');
const nextBtn = el('next');
const pageStatus = el('page-status');

// Optional sidecar rank maps (ISSN-L → level/grade)
let jufoMap = null;   // e.g., { "0028-0836": "3", ... }
let ajgMap  = null;   // e.g., { "0028-0836": "4*", ... }

let page = 1;

// Try to load sidecar rank maps if present
(async function maybeLoadRanks() {
  try {
    const [jufoRes, ajgRes] = await Promise.allSettled([
      fetch('./data/jufo.json'),
      fetch('./data/ajg.json')
    ]);
    if (jufoRes.status === 'fulfilled' && jufoRes.value.ok) jufoMap = await jufoRes.value.json();
    if (ajgRes.status === 'fulfilled' && ajgRes.value.ok) ajgMap  = await ajgRes.value.json();
  } catch (_) { /* ignore */ }
})();

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function badge(text, cls="") { return `<span class="badge ${cls}">${escapeHTML(text)}</span>`; }
function pick(val, fallback) { return (val !== undefined && val !== null) ? val : fallback; }

// Reconstruct plaintext abstract from inverted index
function abstractFromInvertedIndex(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const positions = [];
  for (const [word, idxs] of Object.entries(obj)) idxs.forEach(i => positions[i] = word);
  return positions.join(' ');
}

// Return a list of candidate ISSN keys (ISSN-L first, then any raw ISSNs) to try
function getIssnKeys(w) {
  const keys = new Set();

  const pl = w?.primary_location?.source;
  const bo = w?.best_oa_location?.source;

  // Preferred: ISSN-L from primary location or best OA location
  [pl?.issn_l, bo?.issn_l].filter(Boolean).forEach(x => keys.add(String(x).trim()));

  // Optional: if an 'issn' array exists, try those too (lets you map by ISSN as well)
  [pl?.issn, bo?.issn].forEach(arr => {
    if (Array.isArray(arr)) {
      arr.forEach(i => keys.add(String(i).trim()));
    }
  });

  return [...keys];
}

// Use any of the candidate keys against JUFO/AJG maps and assemble badges
function venueBadgesByKeys(issnKeys) {
  const out = [];
  if (jufoMap) {
    const hit = issnKeys.find(k => jufoMap[k]);
    if (hit) out.push(badge(`JUFO ${jufoMap[hit]}`));
  }
  if (ajgMap) {
    const hit = issnKeys.find(k => ajgMap[k]);
    if (hit) out.push(badge(`AJG ${ajgMap[hit]}`));
  }
  return out.join(' ');
}

function venueBadges(issnL) {
  const out = [];
  if (jufoMap && jufoMap[issnL]) out.push(badge(`JUFO ${jufoMap[issnL]}`));
  if (ajgMap  && ajgMap[issnL])  out.push(badge(`AJG ${ajgMap[issnL]}`));
  return out.join(' ');
}

// Build URL with filters
function makeURL({ q, year, sourceType, per, sort, oa, hasFulltext, hasAbs, page }) {
  const params = new URLSearchParams();
  if (q) params.set('search', q);

  const filters = [];
  if (year) filters.push(`publication_year:${year}`);
  if (sourceType) filters.push(`primary_location.source.type:${sourceType}`);
  if (oa) filters.push('is_oa:true');
  if (hasFulltext) filters.push('has_fulltext:true');
  if (hasAbs) filters.push('has_abstract:true');
  if (filters.length) params.set('filter', filters.join(','));

  params.set('select', [
    'id','doi','display_name','publication_year','cited_by_count',
    'open_access','has_fulltext','abstract_inverted_index',
    'authorships',
    'primary_location',
    'best_oa_location' 
  ].join(','));

  params.set('per_page', String(per || 20));
  if (sort) params.set('sort', sort);
  params.set('page', String(page || 1));
  if (API_KEY) params.set('api_key', API_KEY);

  return `${API_BASE}?${params.toString()}`;
}

function renderItem(w) {
  const title = w.display_name || '(untitled)';
  const year  = w.publication_year ?? 'n/a';
  const cites = w.cited_by_count ?? 0;
  const isOA  = !!w.open_access?.is_oa;
  const hasFull = !!w.has_fulltext;

  const venue = w.primary_location?.source?.display_name || '—';
  const type  = w.primary_location?.source?.type || '—';

  const issnKeys = getIssnKeys(w);
  
  const authors = Array.isArray(w.authorships)
    ? w.authorships.map(a => a?.author?.display_name).filter(Boolean).slice(0, 6)
    : [];
  console.debug('ISSN-L', w.primary_location?.source?.issn_l);
console.debug('JUFO hit?', !!(jufoMap && jufoMap[w.primary_location?.source?.issn_l || '']));
console.debug('AJG hit?',  !!(ajgMap  && ajgMap [w.primary_location?.source?.issn_l || '']));
  return `
    <article class="item" data-id="${w.id}">
      <h3>${escapeHTML(title)}
        <span class="badges">
          ${isOA ? badge('OA','oa') : ''}
          ${hasFull ? badge('Fulltext') : ''}
          ${badge(`Citations: ${cites}`)}
          ${badge(`Year: ${year}`)}
        </span>
      </h3>
      <div class="kv">
        <strong>Authors:</strong> ${authors.length ? authors.map(escapeHTML).join(', ') : '—'}
        <br/><strong>Journal / Source:</strong> ${escapeHTML(venue)} (${escapeHTML(type)}) ${issnL ? venueBadges(issnL) : ''}
        <br/>${w.id  ? `${w.id}OpenAlex</a>` : ''}
        ${w.doi ? ` • ${w.doi}DOI</a>` : ''}
      </div>
      <details class="kv" data-abs>
        <summary>Abstract</summary>
        <div class="muted">Fetching…</div>
      </details>
    </article>
  `;
}

async function doSearch({ freshPage=false } = {}) {
  if (freshPage) page = 1;

  const q = qIn.value.trim();
  const year = yearIn.value.trim();

  const sourceType = sourceTypeIn.value || '';
  const per = Number(perIn.value);
  const sort = sortIn.value;

  const oa = oaIn.checked;
  const hasFulltext = hasFulltextIn.checked;
  const hasAbs = hasAbstractIn.checked;

  if (!q) {
    meta.textContent = 'Type a query to search.';
    results.innerHTML = '';
    pager.classList.add('hidden');
    return;
  }

  const url = makeURL({ q, year, sourceType, per, sort, oa, hasFulltext, hasAbs, page });
  meta.innerHTML = `Searching<span class="spinner"></span>`;
  results.innerHTML = '';

  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    const count = data?.meta?.count ?? 0;
    const items = Array.isArray(data?.results) ? data.results : [];
    meta.textContent = `Found ${count.toLocaleString()} works • Showing ${items.length} on page ${page}`;

    if (!items.length) {
      results.innerHTML = `<div class="muted">No results.</div>`;
      pager.classList.add('hidden');
      return;
    }

    results.innerHTML = items.map(renderItem).join('');

    // Lazy abstracts
    results.querySelectorAll('details[data-abs]').forEach(det => {
      det.addEventListener('toggle', async () => {
        if (!det.open) return;
        const box = det.querySelector('div');
        const node = det.closest('.item');
        const workId = node?.getAttribute('data-id');
        if (!workId) return;

        const sp = new URLSearchParams({ select: 'abstract_inverted_index' });
        if (API_KEY) sp.set('api_key', API_KEY);
        const rr = await fetch(`${API_BASE}/${encodeURIComponent(workId)}?${sp.toString()}`);
        if (!rr.ok) { box.textContent = 'No abstract available.'; return; }
        const wfull = await rr.json();
        const abs = abstractFromInvertedIndex(wfull.abstract_inverted_index) || 'No abstract available.';
        box.textContent = abs;
      }, { once: true });
    });

    // Pager
    const totalPages = Math.ceil(count / per);
    pageStatus.textContent = `Page ${page} / ${Math.max(totalPages, 1)}`;
    prevBtn.disabled = page <= 1;
    nextBtn.disabled = page >= totalPages;
    pager.classList.toggle('hidden', totalPages <= 1);
  } catch (e) {
    console.error(e);
    meta.textContent = `Error: ${e.message}`;
    pager.classList.add('hidden');
  }
}

form.addEventListener('submit', (e) => { e.preventDefault(); doSearch({ freshPage: true }); });

el('clear').addEventListener('click', () => {
  qIn.value = '';
  yearIn.value = '';
  sourceTypeIn.value = '';
  perIn.value = '20';
  sortIn.value = 'cited_by_count:desc';
  oaIn.checked = false;
  hasFulltextIn.checked = false;
  hasAbstractIn.checked = false;

  results.innerHTML = '';
  meta.textContent = '';
  pager.classList.add('hidden');
});

prevBtn.addEventListener('click', () => { if (page > 1) { page -= 1; doSearch(); } });
nextBtn.addEventListener('click', () => { page += 1; doSearch(); } );

// Starter query (optional)
qIn.value = 'humanitarian logistics';
doSearch({ freshPage: true });
