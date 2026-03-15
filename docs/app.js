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
const doiText = el('doi');

const meta = el('meta');
const results = el('results');
const pager = el('pager');
const prevBtn = el('prev');
const nextBtn = el('next');
const pageStatus = el('page-status');


// === Journal selector elements & state ===
const journalSelect = el('journalSelect');
const journalHelp   = el('journalHelp');

// Persist selected journals across re-renders of the list
let selectedJournalIds = new Set();   // values like "https://openalex.org/S123456789"


// Journal filter UI
const journalFilter      = el('journalFilter');
const journalFilterClear = el('journalFilterClear');

// Cache the full, unfiltered list from group_by=journal
// Each item: { id, name, count }
let allJournals = [];

// Debounce handle
let journalFilterTimer = null;

function norm(s) {
  return String(s || '')
    .normalize('NFD')                // split diacritics
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase();
}
/* ===== Theme toggle (JS) =====
   - expects this HTML inside your header:

   <label class="theme-toggle">
     <input id="themeToggle" type="checkbox" aria-label="Toggle dark mode" />
     <span class="toggle-slider" aria-hidden="true"></span>
     <span class="toggle-label">Dark</span>
   </label>
*/
(function initThemeToggle() {
  const root  = document.documentElement;
  const toggle = document.getElementById('themeToggle');
  const label  = document.querySelector('.theme-toggle .toggle-label');

  if (!toggle) return; // toggle not on this page

  // --- helpers ---
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
      // no user override → follow system
      root.removeAttribute('data-theme');
      localStorage.removeItem('theme');
      const sys = systemPref();
      toggle.checked = (sys === 'dark');
      if (label) label.textContent = sys === 'dark' ? 'Dark' : 'Light';
    }
  };

  // --- initialize from saved value or system ---
  const saved = localStorage.getItem('theme'); // 'light' | 'dark' | null
  if (saved === 'light' || saved === 'dark') {
    applyTheme(saved, { persist: false });
  } else {
    applyTheme(null, { persist: false }); // follow system
  }

  // --- user changes ---
  toggle.addEventListener('change', () => {
    const next = toggle.checked ? 'dark' : 'light';
    applyTheme(next, { persist: true });
  });

  // --- system changes (only if no user override) ---
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemChange = () => {
    if (!localStorage.getItem('theme')) applyTheme(null, { persist: false });
  };
  if (mq.addEventListener) mq.addEventListener('change', onSystemChange);
  else if (mq.addListener) mq.addListener(onSystemChange); // older Safari

  // Optional: expose a small API you can call from Console
  window.setTheme = applyTheme;  // setTheme('dark'|'light'|null)
})();


// ===== Rank maps (ISSN-L → grade) =====
// Keep the names exactly like this (case-sensitive!)
let jufoMap = null;   // e.g., { "0028-0836": "3",  ... }
let ajgMap  = null;   // e.g., { "0028-0836": "4*", ... }

/**
 * Load /docs/data/ajg.json and /docs/data/jufo.json (optional).
 * Files are optional: helpers below are null-safe and will just return "" if maps aren't present.
 */
async function loadRankMaps() {
  try {
    const [ajgRes, jufoRes] = await Promise.allSettled([
      fetch('./data/ajg.json'),
      fetch('./data/jufo.json')
    ]);

    if (ajgRes.status === 'fulfilled' && ajgRes.value.ok) {
      ajgMap = await ajgRes.value.json();
    } else {
      ajgMap = null;
    }

    if (jufoRes.status === 'fulfilled' && jufoRes.value.ok) {
      jufoMap = await jufoRes.value.json();
    } else {
      jufoMap = null;
    }

    // Optional: quick visibility in Console
    console.debug('[AJG] entries:', ajgMap ? Object.keys(ajgMap).length : 0);
    console.debug('[JUFO] entries:', jufoMap ? Object.keys(jufoMap).length : 0);

  } catch (err) {
    console.warn('loadRankMaps() failed:', err);
    ajgMap = null;
    jufoMap = null;
  }
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function escapeAttr(str) {
  return String(str).replace(/["'&<>]/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function badge(text, cls = "") {
  return `<span class="badge ${cls}">${escapeHTML(text)}</span>`;
}
function pick(val, fallback) {
  return val !== undefined && val !== null ? val : fallback;
}

// Reconstruct plaintext abstract from inverted index
function abstractFromInvertedIndex(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const positions = [];
  for (const [word, idxs] of Object.entries(obj)) idxs.forEach(i => positions[i] = word);
  return positions.join(' ');
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

/**
 * Render <option>s into #journalSelect from a given list and query string.
 * - Always pins currently selected journals at the top (even if they don't match).
 * - Preserves selection.
 * - Shows "(count)" next to each name.
 */
function renderJournalOptions(list, query = '') {
  if (!journalSelect) return;

  const q = norm(query);
  const matches = q.length >= 2
    ? list.filter(j => norm(j.name).includes(q))
    : list.slice(); // no filtering for <2 chars

  // Selected (pin to top, sorted by name)
  const selectedTop = [];
  selectedJournalIds.forEach(id => {
    const j = list.find(x => x.id === id);
    if (j) selectedTop.push(j);
  });
  selectedTop.sort((a,b)=>a.name.localeCompare(b.name));

  // Remove any already pinned from matches
  const pinnedIds = new Set(selectedTop.map(j => j.id));
  const body = matches.filter(j => !pinnedIds.has(j.id));

  // Rebuild options
  const frag = document.createDocumentFragment();

  // Selected pinned section
  if (selectedTop.length) {
    for (const j of selectedTop) {
      const o = document.createElement('option');
      o.value = j.id;
      o.textContent = `${j.name} (${j.count.toLocaleString()})`;
      o.selected = true;
      frag.appendChild(o);
    }
    // Optional visual divider (disabled, non-selectable)
    const divider = document.createElement('option');
    divider.disabled = true;
    divider.textContent = '──────────';
    frag.appendChild(divider);
  }

  // Body matches
  for (const j of body) {
    const o = document.createElement('option');
    o.value = j.id;
    o.textContent = `${j.name} (${j.count.toLocaleString()})`;
    o.selected = selectedJournalIds.has(j.id);
    frag.appendChild(o);
  }

  // Replace content
  journalSelect.innerHTML = '';
  journalSelect.appendChild(frag);

  // Update helper text
  if (journalHelp) {
    const vis = selectedTop.length + body.length;
    const msg = q.length >= 2
      ? `Showing ${vis.toLocaleString()} journals matching “${query}”. Selected: ${selectedJournalIds.size}`
      : `${list.length.toLocaleString()} journals for this query. Selected: ${selectedJournalIds.size}`;
    journalHelp.textContent = msg;
  }
}


/**
 * Get all journals matching the current query using group_by=journal.
 * Returns [{ id, name, count }]
 */
async function fetchAllJournalsForQuery({ q, year, sourceType, oa, hasFulltext, hasAbs }) {
  const params = new URLSearchParams();

  if (q) params.set('search', q);

  const filters = [];
  if (year) filters.push(`publication_year:${year}`);
  if (sourceType) filters.push(`locations.source.type:${sourceType}`); // e.g., journal/repository/conference [3](https://www.humanitarianlibrary.org/resource/bureau-humanitarian-assistance-technical-guidance-monitoring-evaluation-and-reporting)
  if (oa) filters.push('is_oa:true');
  if (hasFulltext) filters.push('has_fulltext:true');
  if (hasAbs) filters.push('has_abstract:true');
  if (filters.length) params.set('filter', filters.join(','));

  params.set('group_by', 'journal');     // enumerate journals for the query [1](https://humanitarianencyclopedia.org/library)
  params.set('per-page', '200');         // fetch many groups per call (hyphen) [4](https://www.ihffc.org/feeds.html)
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
        id:   b?.key,                    // e.g., "https://openalex.org/S123456789"
        name: b?.key_display_name || b?.key || 'Unknown journal',
        count: b?.count ?? 0
      });
    }

    if (buckets.length < 200) break;     // finished this aggregation “page”
    p += 1;
    if (p > 25) break;                   // safety cap; increase if needed
  }

  // Sort by count desc, then name
  out.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
  return out;
}


function populateJournalSelect(list /* [{id,name,count}] */) {
  allJournals = Array.isArray(list) ? list : [];
  // Re-render using the current textbox value (if any)
  const q = journalFilter ? journalFilter.value.trim() : '';
  renderJournalOptions(allJournals, q);
}
``


function wireJournalSelect() {
  if (!journalSelect) return;
  journalSelect.addEventListener('change', () => {
    selectedJournalIds = new Set(
      Array.from(journalSelect.selectedOptions, o => o.value)
    );
    // Selections change → restart paging and re-run
    doSearch({ freshPage: true });
  });
}

// --- HTML escaping helper (prevents XSS and broken markup) ---

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

  // Links
  const openalexLink =  w.id ? 
` • <a href="${escapeAttr(w.id)}" target="_blank" rel="noopener">OpenAlex</a>`
  : "";


  
  // DOI
  
  
const doiHref = w.doi
  ? (/^https?:\/\//i.test(w.doi) ? String(w.doi).trim()
                                 : 'https://doi.org/' + String(w.doi).replace(/^doi:\s*/i,''))
  : null;

const doiText = w.doi
  ? String(w.doi).replace(/^https?:\/\/doi\.org\//i, 'doi:')
  : 'DOI';

const doiLink = doiHref
  ? ` • <a href="${escapeAttr(doiHref)}" target="_blank" rel="noopener">${escapeHTML(doiText)}</a>`
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

 
async function doSearch({ freshPage = false } = {}) {
  if (freshPage) page = 1;

  const q = qIn.value.trim();
  const year = yearIn.value.trim();

  const sourceType = sourceTypeIn.value || "";
  const per = Number(perIn.value);
  const sort = sortIn.value;

  const oa = oaIn.checked;
  const hasFulltext = hasFulltextIn.checked;
  const hasAbs = hasAbstractIn.checked;

  if (!q) {
    meta.textContent = "Type a query to search.";
    results.innerHTML = "";
    pager.classList.add("hidden");
    return;
  }

  const url = makeURL({
    q,
    year,
    sourceType,
    per,
    sort,
    oa,
    hasFulltext,
    hasAbs,
    page,
  });

  meta.innerHTML = `Searching<span class="spinner"></span>`;
  results.innerHTML = "";

  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    const count = data?.meta?.count ?? 0;
    const items = Array.isArray(data?.results) ? data.results : [];
    meta.textContent = `Found ${count.toLocaleString()} works • Showing ${
      items.length
    } on page ${page}`;

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
          const rr = await fetch(
            `${API_BASE}/${encodeURIComponent(workId)}?${sp.toString()}`
          );
          if (!rr.ok) {
            box.textContent = "No abstract available.";
            return;
          }
          const wfull = await rr.json();
          const abs =
            abstractFromInvertedIndex(wfull.abstract_inverted_index) ||
            "No abstract available.";
          box.textContent = abs;
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
  if (!form) {
    console.error("search-form not found; ensure scripts use defer or run after DOM.");
    return;
  }
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    doSearch({ freshPage: true });
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

      results.innerHTML = "";
      meta.textContent = "";
      pager.classList.add("hidden");
    });
  }

  prevBtn.addEventListener("click", () => {
    if (page > 1) {
      page -= 1;
      doSearch();
    }
  });
  nextBtn.addEventListener("click", () => {
    page += 1;
    doSearch();
  });
}

// If scripts aren’t loaded with defer, wait for DOM
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    wireHandlers();
    // Starter query (optional)
    
    doSearch({ freshPage: true });
  });
} else {
  wireHandlers();
  
  doSearch({ freshPage: true });

  wireJournalSelect();
  wireJournalSearch();

  let journalSearchWired = false;

function wireJournalSearch() {
  if (journalSearchWired) return;
  journalSearchWired = true;

  if (journalFilter) {
    journalFilter.addEventListener('input', () => {
      if (journalFilterTimer) clearTimeout(journalFilterTimer);
      journalFilterTimer = setTimeout(() => {
        renderJournalOptions(allJournals, journalFilter.value.trim());
      }, 120); // debounce
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
}


if (!q) {
    meta.textContent = "Type a query to search.";
    results.innerHTML = "";
    pager.classList.add("hidden");
    return;
  }


// In the catch(e) block
if (journalSelect) journalSelect.innerHTML = "";
