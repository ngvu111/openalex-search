const API_BASE = "https://api.openalex.org/works";
const API_PUBLISHERS = "https://api.openalex.org/publishers";
const API_KEY = (typeof window.OPENALEX_API_KEY === 'string' && window.OPENALEX_API_KEY.trim())
  ? window.OPENALEX_API_KEY.trim()
  : null;

const el = (id) => document.getElementById(id);
// form controls
const form = el('search-form');
const qIn = el('q');
const yearIn = el('year');
const oaIn = el('oa');
const perIn = el('per');
const sortIn = el('sort');
const sourceTypeIn = el('sourceType');
const publisherIn = el('publisher');
const hasFulltextIn = el('hasFulltext');
const hasAbstractIn = el('hasAbstract');
// output
const meta = el('meta');
const results = el('results');
const pager = el('pager');
const prevBtn = el('prev');
const nextBtn = el('next');
const pageStatus = el('page-status');

let page = 1;
let cachedPublisherId = null;
// optional sidecar rank maps
let jufoMap = null;   // { ISSN-L: "0|1|2|3" }
let ajgMap  = null;   // { ISSN-L: "4*|4|3|2|1" }

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

function badge(text, cls="") {
  return `<span class="badge ${cls}">${escapeHTML(text)}</span>`;
}

// reconstructs plaintext from abstract_inverted_index
function abstractFromInvertedIndex(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const positions = [];
  for (const [word, idxs] of Object.entries(obj)) {
    idxs.forEach(i => positions[i] = word);
  }
  return positions.join(' ');
}

function pick(val, fallback) { return (val !== undefined && val !== null) ? val : fallback; }

function makeURL({ q, year, oa, per, sort, page, sourceType, publisherId, hasFulltext, hasAbs }) {
  const params = new URLSearchParams();

  if (q) params.set('search', q);

  const filters = [];
  if (year) filters.push(`publication_year:${year}`);
  if (oa) filters.push('is_oa:true');
  if (hasFulltext) filters.push('has_fulltext:true');
  if (hasAbs) filters.push('has_abstract:true');

  // Source type filter (on primary location)
  // e.g., primary_location.source.type:journal|repository|conference
  if (sourceType) filters.push(`primary_location.source.type:${sourceType}`);

  // Publisher filter via host organization (OpenAlex Publisher ID)
  if (publisherId) filters.push(`primary_location.source.host_organization:${publisherId}`);

  if (filters.length) params.set('filter', filters.join(','));

  // Select only what we need for list view (nested fields allowed)
  params.set('select', [
    'id','doi','display_name','publication_year','cited_by_count',
    'open_access','has_fulltext','has_abstract',
    'authorships.author.display_name',
    'primary_location.source.display_name',
    'primary_location.source.issn_l',
    'primary_location.source.type'
  ].join(','));

  params.set('per_page', String(per || 20));
  if (sort) params.set('sort', sort);
  params.set('page', String(page || 1));
  if (API_KEY) params.set('api_key', API_KEY);
  return `${API_BASE}?${params.toString()}`;
}

async function resolvePublisherId(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // If user typed an OpenAlex Publisher ID (starts with P), use it as-is
  if (/^P\d+$/i.test(trimmed)) return `https://openalex.org/${trimmed.toUpperCase()}`;

  // Otherwise, search by name (take the first match)
  const sp = new URLSearchParams({ search: trimmed, select: 'id,display_name', per_page: '1' });
  if (API_KEY) sp.set('api_key', API_KEY);
  const url = `${API_PUBLISHERS}?${sp.toString()}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Publisher lookup failed (${r.status})`);
  const data = await r.json();
  const hit = (data?.results && data.results[0]) || null;
  return hit?.id || null;
}

function venueBadges(issnL) {
  const out = [];
  if (jufoMap && jufoMap[issnL]) out.push(badge(`JUFO ${jufoMap[issnL]}`));
  if (ajgMap  && ajgMap[issnL])  out.push(badge(`AJG ${ajgMap[issnL]}`));
  return out.join(' ');
}

function renderItem(w) {
  const title = w.display_name || '(untitled)';
  const year = pick(w.publication_year, 'n/a');
  const cites = pick(w.cited_by_count, 0);
  const isOA = !!w.open_access?.is_oa;
  const hasFull = !!w.has_fulltext;
  const venue = w.primary_location?.source?.display_name || '—';
  const issnL = w.primary_location?.source?.issn_l || null;
  const type = w.primary_location?.source?.type || '—';

  const authors = Array.isArray(w.authorships)
    ? w.authorships.map(a => a?.author?.display_name).filter(Boolean).slice(0, 6)
    : [];

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
        <br/>${w.id ? `<a href="${w.id}" target="_blank" rel="noreferrer">OpenAlex</a>` : ''}
        ${w.doi ? ` • <a href="${w.doi}" target="_blank" rel="noreferrer">DOI</a>` : ''}
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
  const oa = oaIn.checked;
  const per = Number(perIn.value);
  const sort = sortIn.value;
  const sourceType = sourceTypeIn.value || '';
  const hasFulltext = hasFulltextIn.checked;
  const hasAbs = hasAbstractIn.checked;

  // resolve publisher only when changed
  let publisherId = cachedPublisherId;
  const pubInput = publisherIn.value.trim();
  if (pubInput && !cachedPublisherId?.toLowerCase().includes(pubInput.toLowerCase())) {
    try { publisherId = await resolvePublisherId(pubInput); }
    catch (e) { console.warn(e); publisherId = null; }
    cachedPublisherId = publisherId;
  }
  if (!q) {
    meta.textContent = 'Type a query to search.';
    results.innerHTML = '';
    pager.classList.add('hidden');
    return;
  }

  const url = makeURL({ q, year, oa, per, sort, page, sourceType, publisherId, hasFulltext, hasAbs });
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

    // set up lazy abstract loading
    results.querySelectorAll('details[data-abs]').forEach(det => {
      det.addEventListener('toggle', async () => {
        if (!det.open) return;
        const box = det.querySelector('div');
        const node = det.closest('.item');
        const workId = node?.getAttribute('data-id');
        if (!workId) return;
        // fetch single work with abstract only on demand
        const sp = new URLSearchParams({ select: 'abstract_inverted_index' });
        if (API_KEY) sp.set('api_key', API_KEY);
        const rr = await fetch(`${API_BASE}/${encodeURIComponent(workId)}?${sp.toString()}`);
        if (!rr.ok) { box.textContent = 'No abstract available.'; return; }
        const wfull = await rr.json();
        const abs = abstractFromInvertedIndex(wfull.abstract_inverted_index) || 'No abstract available.';
        box.textContent = abs;
      }, { once: true });
    });

    // simple pager
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
  oaIn.checked = false;
  sourceTypeIn.value = '';
  publisherIn.value = '';
  hasFulltextIn.checked = false;
  hasAbstractIn.checked = false;
  cachedPublisherId = null;
  results.innerHTML = '';
  meta.textContent = '';
  pager.classList.add('hidden');
});

prevBtn.addEventListener('click', () => { if (page > 1) { page -= 1; doSearch(); } });
nextBtn.addEventListener('click', () => { page += 1; doSearch(); });

// starter query (optional)
qIn.value = 'humanitarian logistics';
doSearch({ freshPage: true });
