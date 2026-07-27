const API_BASE = "https://api.openalex.org/works";
const API_KEY = (typeof window.OPENALEX_API_KEY === 'string' && window.OPENALEX_API_KEY.trim())
  ? window.OPENALEX_API_KEY.trim()
  : null;

// ---- Elements ----
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

const journalFilter      = el('journalFilter');
const journalFilterClear = el('journalFilterClear');
const journalSelect      = el('journalSelect');
const journalHelp        = el('journalHelp');

// ---- Global State ----
let page = 1;
let allJournals = [];        
let selectedJournalIds = new Set();

let journalSearchWired = false;
let journalSelectWired = false;
let journalFilterTimer = null;

// ===== Journal Selection Logic =====

// Diacritics-insensitive normalization
function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// Rebuild <option>s based on a (possibly filtered) list + query
function renderJournalOptions(list, query = '') {
  if (!journalSelect) return;

  const q = norm(query);
  const matches = (q.length >= 2)
    ? list.filter(j => norm(j.name).includes(q))
    : list.slice();

  // Pin selected journals to the top so they don't disappear while filtering
  const selectedTop = [];
  selectedJournalIds.forEach(id => {
    const j = list.find(x => x.id === id);
    if (j) selectedTop.push(j);
  });
  selectedTop.sort((a, b) => a.name.localeCompare(b.name));

  const pinnedIds = new Set(selectedTop.map(j => j.id));
  const body = matches.filter(j => !pinnedIds.has(j.id));

  const frag = document.createDocumentFragment();

  // 1. Selected pinned first
  for (const j of selectedTop) {
    const opt = document.createElement('option');
    opt.value = j.id;
    opt.textContent = `${j.name} (${j.count.toLocaleString()})`;
    opt.selected = true;
    frag.appendChild(opt);
  }

  // Visual divider if we have both pinned and unpinned items
  if (selectedTop.length > 0 && body.length > 0) {
    const divider = document.createElement('option');
    divider.disabled = true;
    divider.textContent = '──────────';
    frag.appendChild(divider);
  }

  // 2. Rest of matches
  for (const j of body) {
    const opt = document.createElement('option');
    opt.value = j.id;
    opt.textContent = `${j.name} (${j.count.toLocaleString()})`;
    opt.selected = false;
    frag.appendChild(opt);
  }

  journalSelect.innerHTML = '';
  journalSelect.appendChild(frag);

  // Helper text
  if (journalHelp) {
    const shown = selectedTop.length + body.length;
    journalHelp.textContent = q.length >= 2
      ? `Showing ${shown.toLocaleString()} journals matching “${query}”. Selected: ${selectedJournalIds.size}`
      : `${list.length.toLocaleString()} journals for this query. Selected: ${selectedJournalIds.size}`;
  }
}

function populateJournalSelect(list) {
  allJournals = Array.isArray(list) ? list : [];
  const q = journalFilter ? journalFilter.value.trim() : '';
  renderJournalOptions(allJournals, q);
}

function wireJournalSelect() {
  if (journalSelectWired || !journalSelect) return;
  journalSelectWired = true;

  journalSelect.addEventListener('change', () => {
    selectedJournalIds = new Set(
      Array.from(journalSelect.selectedOptions, o => o.value)
    );
    // Trigger a fresh query, BUT tell doSearch not to overwrite our journal dropdown
    doSearch({ freshPage: true, skipJournalFetch: true });
  });
}

function wireJournalSearch() {
  if (journalSearchWired) return;
  journalSearchWired = true;

  if (journalFilter) {
    journalFilter.addEventListener('input', () => {
      clearTimeout(journalFilterTimer);
      journalFilterTimer = setTimeout(() => {
        renderJournalOptions(allJournals, journalFilter.value.trim());
      }, 120); 
    });
  }

  if (journalFilterClear) {
    journalFilterClear.addEventListener('click', () => {
      if (!journalFilter) return;
      journalFilter.value = '';
      renderJournalOptions(allJournals, '');
      journalFilter.focus();
    });
  }
}

// ===== Theme toggle (JS) =====
(function initThemeToggle() {
  const root  = document.documentElement;
  const toggle = document.getElementById('themeToggle');
  const label  = document.querySelector('.theme-toggle .toggle-label');

  if (!toggle) return;

  const systemPref = () =>
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';

  const applyTheme = (mode, { persist = true } = {}) => {
    if (mode === 'light' || mode === 'dark') {
      root.setAttribute('data-theme', mode);
      if (persist) localStorage.setItem('theme', mode);
      toggle.checked = (mode === 'dark');
      if (label) label.textContent = mode === 'dark' ? 'Dark' : 'Light';
    } else {
      root.removeAttribute('data-theme');
      localStorage.removeItem('theme');
      const sys = systemPref();
      toggle.checked = (sys === 'dark');
      if (label) label.textContent = sys === 'dark' ? 'Dark' : 'Light';
    }
  };

  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') {
    applyTheme(saved, { persist: false });
  } else {
    applyTheme(null, { persist: false });
  }

  toggle.addEventListener('change', () => {
    const next = toggle.checked ? 'dark' : 'light';
    applyTheme(next, { persist: true });
  });

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemChange = () => {
    if (!localStorage.getItem('theme')) applyTheme(null, { persist: false });
  };
  if (mq.addEventListener) mq.addEventListener('change', onSystemChange);
  else if (mq.addListener) mq.addListener(onSystemChange);
  
  window.setTheme = applyTheme;
})();

// ===== Rank maps (ISSN-L → grade) =====
let jufoMap = null;
let ajgMap  = null;

async function loadRankMaps() {
  try {
    const [ajgRes, jufoRes] = await Promise.allSettled([
      fetch('./data/ajg.json'),
      fetch('./data/jufo.json')
    ]);

    if (ajgRes.status === 'fulfilled' && ajgRes.value.ok) {
      ajgMap = await ajgRes.value.json();
    }
    if (jufoRes.status === 'fulfilled' && jufoRes.value.ok) {
      jufoMap = await jufoRes.value.json();
    }
  } catch (err) {
    console.warn('loadRankMaps() failed:', err);
  }
}

// ===== Helpers =====
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function escapeAttr(str) {
  return String(str).replace(/["'&<>]/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

function badge(text, cls = "") {
  return `<span class="badge ${cls}">${escapeHTML(text)}</span>`;
}

function abstractFromInvertedIndex(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const positions = [];
  for (const [word, idxs] of Object.entries(obj)) idxs.forEach(i => positions[i] = word);
  return positions.join(' ');
}

// ===== API Logic =====
function makeURL({ q, year, sourceType, per, sort, oa, hasFulltext, hasAbs, page }) {
  const params = new URLSearchParams();
  // Wrap the query in quotes for an exact match
  if (q) {
    const exactQuery = `"${q.replace(/"/g, '')}"`;
    params.set('search', exactQuery);
  }

  const filters = [];
  if (year) filters.push(`publication_year:${year}`);
  if (sourceType) filters.push(`primary_location.source.type:${sourceType}`);
  if (oa) filters.push('is_oa:true');
  if (hasFulltext) filters.push('has_fulltext:true');
  if (hasAbs) filters.push('has_abstract:true');

  // Apply selected journals filter
  if (selectedJournalIds.size > 0) {
    // OpenAlex IDs are URLs (https://openalex.org/S123). We extract the S123 part.
    const shortIds = Array.from(selectedJournalIds).map(url => url.split('/').pop());
    filters.push(`primary_location.source.id:${shortIds.join('|')}`);
  }

  if (filters.length) params.set('filter', filters.join(','));

  params.set('select', [
    'id','doi','display_name','publication_year','cited_by_count',
    'open_access','has_fulltext','abstract_inverted_index',
    'authorships',
    'primary_location',
    'best_oa_location' 
  ].join(','));

  params.set('per-page', String(per || 20));
  if (sort) params.set('sort', sort);
  params.set('page', String(page || 1));
  if (API_KEY) params.set('api_key', API_KEY);

  return `${API_BASE}?${params.toString()}`;
}

async function fetchAllJournalsForQuery({ q, year, sourceType, oa, hasFulltext, hasAbs }) {
  const params = new URLSearchParams();

  // Wrap the query in quotes for an exact match
  if (q) {
    const exactQuery = `"${q.replace(/"/g, '')}"`;
    params.set('search', exactQuery);
  }

  const filters = [];
  if (q) params.set('search', q);

  const filters = [];
  if (year) filters.push(`publication_year:${year}`);
  if (sourceType) filters.push(`locations.source.type:${sourceType}`);
  if (oa) filters.push('is_oa:true');
  if (hasFulltext) filters.push('has_fulltext:true');
  if (hasAbs) filters.push('has_abstract:true');
  if (filters.length) params.set('filter', filters.join(','));

  params.set('group_by', 'journal');
  params.set('per-page', '200');
  if (API_KEY) params.set('api_key', API_KEY);

  const out = [];
  let p = 1;

  while (true) {
    params.set('page', String(p));
    const url = `${API_BASE}?${params.toString()}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`group_by journals HTTP ${r.status}`);
    const g = await r.json();

    const buckets = Array.isArray(g?.group_by) ? g.group_by : [];
    for (const b of buckets) {
      out.push({
        id:   b?.key,
        name: b?.key_display_name || b?.key || 'Unknown journal',
        count: b?.count ?? 0
      });
    }

    if (buckets.length < 200) break;
    p += 1;
    if (p > 25) break; // safety cap
  }

  out.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
  return out;
}

// ===== Rendering =====
function venueBadges(issnL) {
  if (!issnL) return '';
  const out = [];
  if (jufoMap && jufoMap[issnL]) out.push(badge(`JUFO ${jufoMap[issnL]}`, 'jufo'));
  if (ajgMap  && ajgMap[issnL])  out.push(badge(`AJG ${ajgMap[issnL]}`,  'ajg'));
  return out.join(' ');
}

function renderItem(w) {
  const title = w.display_name ?? '(untitled)';
  const year  = w.publication_year ?? 'n/a';
  const cites = w.cited_by_count ?? 0;
  const isOA  = !!w.open_access?.is_oa;
  const hasFull = !!w.has_fulltext;

  const venue = w.primary_location?.source?.display_name ?? '—';
  const type  = w.primary_location?.source?.type ?? '—';

  const authors = Array.isArray(w.authorships)
    ? w.authorships.map(a => a?.author?.display_name).filter(Boolean).slice(0, 6)
    : [];

  const issnL =
  w.primary_location?.source?.issn_l ??
  w.best_oa_location?.source?.issn_l ??
  null;

  const rankBadges = issnL ? ' ' + venueBadges(issnL) : ''; 
  const badges = [
    isOA ? badge("OA", "oa") : "",
    hasFull ? badge("Fulltext") : "",
    badge(`Citations: ${cites}`),
    badge(`Year: ${year}`),
  ]
    .filter(Boolean)
    .join("");

  const openalexLink =  w.id ? 
    ` • <a href="${escapeAttr(w.id)}" target="_blank" rel="noopener">OpenAlex</a>`
    : "";

  const doiHref = w.doi
    ? (/^https?:\/\//i.test(w.doi) ? String(w.doi).trim()
                                   : 'https://doi.org/' + String(w.doi).replace(/^doi:\s*/i,''))
    : null;

  const doiTextStr = w.doi
    ? String(w.doi).replace(/^https?:\/\/doi\.org\//i, 'doi:')
    : 'DOI';

  const doiLink = doiHref
    ? ` • <a href="${escapeAttr(doiHref)}" target="_blank" rel="noopener">${escapeHTML(doiTextStr)}</a>`
    : '';

  return `
    <article class="item" data-id="${escapeAttr(w.id || '')}">
      <h3>${escapeHTML(title)}
        <span class="badges">${badges}</span>
      </h3>
      <div class="kv">
        <strong>Authors:</strong> ${authors.length ? authors.map(escapeHTML).join(', ') : '—'}<br/>
        <strong>Journal / Source:</strong> ${escapeHTML(venue)} (${escapeHTML(type)})${rankBadges}<br/>
        ${openalexLink}${doiLink}
      </div>
      <details class="kv" data-abs>
        <summary>Abstract</summary>
        <div class="muted">Fetching…</div>
      </details>
    </article>
  `;
}

// ===== Main Execution =====
async function doSearch({ freshPage = false, skipJournalFetch = false } = {}) {
  const q = qIn.value.trim();
  const year = yearIn.value.trim();
  const sourceType = sourceTypeIn.value || "";
  const per = Number(perIn.value);
  const sort = sortIn.value;
  const oa = oaIn.checked;
  const hasFulltext = hasFulltextIn.checked;
  const hasAbs = hasAbstractIn.checked;

  if (freshPage) page = 1;

  if (!q) {
    meta.textContent = "Type a query to search.";
    results.innerHTML = "";
    pager.classList.add("hidden");
    return;
  }

  meta.innerHTML = `Searching<span class="spinner"></span>`;
  results.innerHTML = "";

  // 1. Fetch updated journal groupings (skip if just clicking a journal filter)
  if (!skipJournalFetch) {
    try {
      selectedJournalIds.clear(); // reset filter for a brand new keyword search
      const journals = await fetchAllJournalsForQuery({
        q, year, sourceType, oa, hasFulltext, hasAbs
      });
      populateJournalSelect(journals);
    } catch (e) {
      console.warn('Journal list failed:', e);
      if (journalHelp) journalHelp.textContent = 'Unable to fetch journals for this query.';
      if (journalSelect) journalSelect.innerHTML = '';
    }
  }

  // 2. Fetch the actual articles
  const url = makeURL({ q, year, sourceType, per, sort, oa, hasFulltext, hasAbs, page });
  
  try {
    
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    const count = data?.meta?.count ?? 0;
    const items = Array.isArray(data?.results) ? data.results : [];
    
    meta.textContent = `Found ${count.toLocaleString()} works • Showing ${items.length} on page ${page}`;

    if (!items.length) {
      results.innerHTML = `<div class="muted">No results.</div>`;
      pager.classList.add("hidden");
      return;
    }

    results.innerHTML = items.map(renderItem).join("");

    // Lazy abstracts
    results.querySelectorAll("details[data-abs]").forEach((det) => {
      det.addEventListener(
        "toggle",
        async () => {
          if (!det.open) return;
          const box = det.querySelector("div");
          const node = det.closest(".item");
          const workId = node?.getAttribute("data-id");
          if (!workId) return;

          const sp = new URLSearchParams({ select: "abstract_inverted_index" });
          if (API_KEY) sp.set("api_key", API_KEY);
          try {
            const rr = await fetch(`${API_BASE}/${encodeURIComponent(workId)}?${sp.toString()}`);
            if (!rr.ok) {
              box.textContent = "No abstract available.";
              return;
            }
            const wfull = await rr.json();
            const abs = abstractFromInvertedIndex(wfull.abstract_inverted_index) || "No abstract available.";
            box.textContent = abs;
          } catch(err) {
            box.textContent = "Error fetching abstract.";
          }
        },
        { once: true }
      );
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

function wireHandlers() {
  if (!form) return;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    doSearch({ freshPage: true, skipJournalFetch: false });
  });

  const clearBtn = el("clear");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      qIn.value = "";
      yearIn.value = "";
      sourceTypeIn.value = "";
      perIn.value = "20";
      sortIn.value = "cited_by_count:desc";
      oaIn.checked = false;
      hasFulltextIn.checked = false;
      hasAbstractIn.checked = false;
      
      selectedJournalIds.clear();
      if (journalFilter) journalFilter.value = "";
      populateJournalSelect([]);

      results.innerHTML = "";
      meta.textContent = "";
      pager.classList.add("hidden");
    });
  }

  prevBtn.addEventListener("click", () => {
    if (page > 1) {
      page -= 1;
      // When paginating, we skip fetching the journal list so the dropdown stays intact
      doSearch({ skipJournalFetch: true }); 
    }
  });
  
  nextBtn.addEventListener("click", () => {
    page += 1;
    doSearch({ skipJournalFetch: true });
  });
}

// ===== Initialization =====
function init() {
  wireHandlers();
  wireJournalSelect();
  wireJournalSearch();
  loadRankMaps(); // Optional: load AJG/JUFO ranks
  doSearch({ freshPage: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
