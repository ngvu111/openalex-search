const API_BASE = "https://api.openalex.org/works"; // entity: works
const API_KEY = (typeof window.OPENALEX_API_KEY === 'string' && window.OPENALEX_API_KEY.trim())
  ? window.OPENALEX_API_KEY.trim()
  : null;

const el = (id) => document.getElementById(id);
const form = el('search-form');
const qIn = el('q');
const yearIn = el('year');
const oaIn = el('oa');
const perIn = el('per');
const sortIn = el('sort');
const meta = el('meta');
const results = el('results');
const pager = el('pager');
const prevBtn = el('prev');
const nextBtn = el('next');
const pageStatus = el('page-status');

let page = 1; // simple page param (not cursor) for small result sets

function makeURL({ q, year, oa, per, sort, page }) {
  const params = new URLSearchParams();
  if (q) params.set('search', q);                     // full-text search
  const filters = [];
  if (year) filters.push(`publication_year:${year}`); // year or range like 2020-2026
  if (oa) filters.push('is_oa:true');                 // OA toggle
  if (filters.length) params.set('filter', filters.join(','));

  // pick only fields we need to keep payload small
  // (fields exist on /works as per the schema docs)
  params.set('select', [
    'id','doi','display_name','publication_year',
    'cited_by_count','open_access'
  ].join(','));

  params.set('per_page', String(per || 20));
  if (sort) params.set('sort', sort);
  params.set('page', String(page || 1));

  if (API_KEY) params.set('api_key', API_KEY);        // required per API docs
  return `${API_BASE}?${params.toString()}`;
}

function renderItem(w) {
  const title = w.display_name || '(untitled)';
  const year = w.publication_year ?? 'n/a';
  const cites = w.cited_by_count ?? 0;
  const doi = w.doi ? w.doi.replace(/^https?:\/\//,'') : null;
  const oa = w.open_access?.is_oa === true;

  return `
    <article class="item">
      <h3>${escapeHTML(title)}
        <span class="badges">
          ${oa ? `<span class="badge oa">OA</span>` : ``}
          <span class="badge">Citations: ${cites}</span>
          <span class="badge">Year: ${year}</span>
        </span>
      </h3>
      <div class="kv">
        <a href="${w.id}" target="_blank" rel="noreferrer">OpenAlex</a>
        ${doi ? ` • <a href="https://${doi}" target="_blank" rel="noreferrer">DOI</a>` : ``}
      </div>
    </article>
  `;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m]));
}

async function doSearch({ freshPage=false } = {}) {
  if (freshPage) page = 1;
  const q = qIn.value.trim();
  const year = yearIn.value.trim();
  const oa = oaIn.checked;
  const per = Number(perIn.value);
  const sort = sortIn.value;

  if (!q) {
    meta.textContent = 'Type a query to search.';
    results.innerHTML = '';
    pager.classList.add('hidden');
    return;
  }

  const url = makeURL({ q, year, oa, per, sort, page });
  meta.innerHTML = `Searching<span class="spinner"></span>`;
  results.innerHTML = '';

  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    const count = data?.meta?.count ?? 0;
    const items = Array.isArray(data?.results) ? data.results : [];
    meta.textContent = `Found ${count.toLocaleString()} works • Showing ${items.length} on page ${page}`;

    if (items.length === 0) {
      results.innerHTML = `<div class="muted">No results.</div>`;
      pager.classList.add('hidden');
      return;
    }

    results.innerHTML = items.map(renderItem).join('');

    // Basic pager: show next if there might be more (~count / per)
    const totalPages = Math.ceil(count / per);
    pageStatus.textContent = `Page ${page} / ${totalPages || 1}`;
    prevBtn.disabled = page <= 1;
    nextBtn.disabled = page >= totalPages;
    pager.classList.toggle('hidden', totalPages <= 1);
  } catch (e) {
    console.error(e);
    meta.textContent = `Error: ${e.message}`;
    pager.classList.add('hidden');
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  doSearch({ freshPage: true });
});

el('clear').addEventListener('click', () => {
  qIn.value = '';
  yearIn.value = '';
  oaIn.checked = false;
  results.innerHTML = '';
  meta.textContent = '';
  pager.classList.add('hidden');
});

prevBtn.addEventListener('click', () => { if (page > 1) { page -= 1; doSearch(); } });
nextBtn.addEventListener('click', () => { page += 1; doSearch(); });

// Optional: run a starter query to demonstrate
qIn.value = 'humanitarian logistics';
doSearch({ freshPage: true });
