const API_BASE = "https://api.openalex.org/works";
const API_KEY = (typeof window.OPENALEX_API_KEY === 'string' && window.OPENALEX_API_KEY.trim())
  ? window.OPENALEX_API_KEY.trim()
  : null;

// Elements
const el = (id) => document.getElementById(id);
const form = el('search-form');
const qIn = el('q');

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


const journalIn = document.getElementById('journal');

const yearMin = document.getElementById('yearMin');
const yearMax = document.getElementById('yearMax');
const yearMinLabel = document.getElementById('yearMinLabel');
const yearMaxLabel = document.getElementById('yearMaxLabel');

const themeToggle = document.getElementById('themeToggle');
let journals = [];

// Reconstruct plaintext abstract from inverted index
function abstractFromInvertedIndex(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const positions = [];
  for (const [word, idxs] of Object.entries(obj)) idxs.forEach(i => positions[i] = word);
  return positions.join(' ');
}

// Theme initialization: respect saved choice, else system preference applies
(function initTheme() {
  const saved = localStorage.getItem('theme'); // 'light' | 'dark' | null
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.setAttribute('data-theme', saved);
    themeToggle.checked = (saved === 'dark');
  } else {
    themeToggle.checked = window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
})();
themeToggle.addEventListener('change', () => {
  const next = themeToggle.checked ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
});

// Build URL with filters
function makeURL({ q, year, sourceType, per, sort, oa, hasFulltext, hasAbs, page }) {
  const params = new URLSearchParams();
  if (q) params.set('search', q);

  const filters = [];
 
// Year range → date filters
  if (yearMin && yearMax) {
    const from = `${yearMin.value}-01-01`;
    const to   = `${yearMax.value}-12-31`;
    filters.push(`from_publication_date:${from}`, `to_publication_date:${to}`);
  }

  if (sourceType) filters.push(`primary_location.source.type:${sourceType}`);
  if (oa) filters.push('is_oa:true');
  if (hasFulltext) filters.push('has_fulltext:true');
  if (hasAbs) filters.push('has_abstract:true');
  if (filters.length) params.set('filter', filters.join(','));

  const API_SOURCES = 'https://api.openalex.org/sources';

// Load ~200 journals sorted by works_count (adjust as needed)
async function loadJournals() {
  const sp = new URLSearchParams({
    filter: 'type:journal',
    per_page: '200',
    sort: 'works_count:desc',
    select: 'display_name,issn_l,works_count'
  });
  if (API_KEY) sp.set('api_key', API_KEY);
  const url = `${API_SOURCES}?${sp.toString()}`;
  const r = await fetch(url);
  if (!r.ok) return;
  const data = await r.json();
  journals = (data.results || []).filter(j => j.issn_l && j.display_name);
  // Populate select
  const frag = document.createDocumentFragment();
  journals.forEach(j => {
    const opt = document.createElement('option');
    opt.value = j.issn_l;
    opt.textContent = `${j.display_name} (${j.issn_l})`;
    frag.appendChild(opt);
  });
  journalIn.appendChild(frag);
}
  
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

async function initYearBounds() {
  try {
    const spOld = new URLSearchParams({ per_page: '1', sort: 'publication_year:asc', select: 'publication_year' });
    const spNew = new URLSearchParams({ per_page: '1', sort: 'publication_year:desc', select: 'publication_year' });
    if (API_KEY) { spOld.set('api_key', API_KEY); spNew.set('api_key', API_KEY); }

    const [rOld, rNew] = await Promise.all([
      fetch(`${API_BASE}?${spOld.toString()}`),
      fetch(`${API_BASE}?${spNew.toString()}`)
    ]);

    const yMin = (rOld.ok ? (await rOld.json())?.results?.[0]?.publication_year : null) ?? 1900;
    const yMax = (rNew.ok ? (await rNew.json())?.results?.[0]?.publication_year : null) ?? new Date().getFullYear();

    yearMin.min = String(yMin);
    yearMin.max = String(yMax);
    yearMax.min = String(yMin);
    yearMax.max = String(yMax);

    // Set defaults to full range
    yearMin.value = String(yMin);
    yearMax.value = String(yMax);

    // Show labels
    yearMinLabel.textContent = yearMin.value;
    yearMaxLabel.textContent = yearMax.value;

    // Keep From <= To
    yearMin.addEventListener('input', () => {
      if (+yearMin.value > +yearMax.value) yearMax.value = yearMin.value;
      yearMinLabel.textContent = yearMin.value;
      yearMaxLabel.textContent = yearMax.value;
    });
    yearMax.addEventListener('input', () => {
      if (+yearMax.value < +yearMin.value) yearMin.value = yearMax.value;
      yearMinLabel.textContent = yearMin.value;
      yearMaxLabel.textContent = yearMax.value;
    });
  } catch (e) {
    console.warn('initYearBounds()', e);
    // Fallback if API fails
    const yMin = 1900;
    const yMax = new Date().getFullYear();
    [yearMin.min, yearMin.max, yearMin.value] = [yMin, yMax, yMin].map(String);
    [yearMax.min, yearMax.max, yearMax.value] = [yMin, yMax, yMax].map(String);
    yearMinLabel.textContent = yearMin.value;
    yearMaxLabel.textContent = yearMax.value;
  }
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
  
  yearMin.value = yearMin.min;
  yearMax.value = yearMax.max;
  yearMinLabel.textContent = yearMin.value;
  yearMaxLabel.textContent = yearMax.value;
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

(async function boot() {
  await initYearBounds();        // ← make sure the range is ready
  qIn.value = 'humanitarian logistics';
  doSearch({ freshPage: true });
})();
