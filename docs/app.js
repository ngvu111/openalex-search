const API_BASE = "https://api.openalex.org/works";
const API_KEY = (typeof window.OPENALEX_API_KEY === 'string' && window.OPENALEX_API_KEY.trim())
  ? window.OPENALEX_API_KEY.trim()
  : null;
// ---- Journal facets: build filter, facet works, resolve names, populate dropdown ----

// Read current UI and build the filter string; set excludeJournal=true to "show all journals"
function buildFilterStringFromUI({ excludeJournal = false } = {}) {
  const filters = [];

  // Query-independent filters from your form
  const yearIn  = document.getElementById('year');              // text box "YYYY" or "YYYY-YYYY"
  const sourceTypeIn = document.getElementById('sourceType');
  const oaIn    = document.getElementById('oa');
  const hasFulltextIn = document.getElementById('hasFulltext');
  const hasAbstractIn = document.getElementById('hasAbstract');
  const journalSel = document.getElementById('journal');

  const year = yearIn?.value?.trim();
  if (year) {
    // Allow "YYYY" or "YYYY-YYYY" as you used originally
    const m = year.match(/^(\d{4})\s*-\s*(\d{4})$/);
    if (m) {
      const a = Math.min(+m[1], +m[2]);
      const b = Math.max(+m[1], +m[2]);
      filters.push(`from_publication_date:${a}-01-01`, `to_publication_date:${b}-12-31`);
    } else if (/^\d{4}$/.test(year)) {
      filters.push(`publication_year:${year}`);
    }
  }

  const sourceType = sourceTypeIn?.value || '';
  if (sourceType) filters.push(`primary_location.source.type:${sourceType}`); // nested OK in filters [1](https://guidebook.devops.uis.cam.ac.uk/howtos/development/generate-api-clients/)

  if (oaIn?.checked)           filters.push('is_oa:true');
  if (hasFulltextIn?.checked)  filters.push('has_fulltext:true');
  if (hasAbstractIn?.checked)  filters.push('has_abstract:true');

  // Journal filter (ISSN) — include only if not excluded
 
// #4 — Journal filter (multiple)
  if (!excludeJournal) {
    const selectedIssns = getSelectedJournals();       // returns ['1234-5678', 'xxxx-xxxx', ...]
    if (selectedIssns.length) {
      const capped = selectedIssns.slice(0, 100);      // API OR-limit = 100 values per filter
      if (selectedIssns.length > 100) {
        console.warn('[Journal] Too many selections; only first 100 applied.');
      }
      // Use locations.source.issn so it matches ANY location (primary/best OA)
      filters.push(`locations.source.issn:${capped.join('|')}`);
    }
  }

  return filters.join(',');

}

// Facet journals for the current filter string: returns an array of ISSNs (strings)
async function facetJournalsForFilter(filterStr) {
  const sp = new URLSearchParams();
  if (filterStr) sp.set('filter', filterStr);
  sp.set('group_by', 'locations.source.issn');
  sp.set('per_page', '200');                 // get up to 200 journal buckets per call
  if (API_KEY) sp.set('api_key', API_KEY);

  const url = `${API_BASE}?${sp.toString()}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const data = await r.json();
  // data.group_by: [{key: "<ISSN>", count: N}, ...]
  return (data.group_by || [])
    .map(g => g?.key)
    .filter(Boolean);
}

// ===== Journal facet cache & renderer =====
const JOURNAL_CACHE = {
  items: [],      // array of {issn, name, issn_l}
  filter: ''      // current text filter (lowercased)
};

// Return selected ISSNs from the multi-select
function getSelectedJournals() {
  const sel = document.getElementById('journal');
  if (!sel) return [];
  return Array.from(sel.selectedOptions || []).map(o => o.value).filter(Boolean);
}

// Render options according to the current text filter; preserve selection
function renderJournalOptions(filterTerm = '') {
  const sel = document.getElementById('journal');
  if (!sel) return;

  JOURNAL_CACHE.filter = String(filterTerm || '').toLowerCase();
  const term = JOURNAL_CACHE.filter;

  const selected = new Set(getSelectedJournals());

  const filtered = !term
    ? JOURNAL_CACHE.items
    : JOURNAL_CACHE.items.filter(j =>
        j.name.toLowerCase().includes(term) ||
        j.issn.toLowerCase().includes(term) ||
        j.issn_l.toLowerCase().includes(term)
      );

  sel.innerHTML = ''; // rebuild
  if (!filtered.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No journals match your search';
    opt.disabled = true;
    sel.appendChild(opt);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const j of filtered) {
    const opt = document.createElement('option');
    opt.value = j.issn; // we filter by locations.source.issn
    opt.textContent = `${j.name} (${j.issn})`;
    if (selected.has(j.issn)) opt.selected = true;
    frag.appendChild(opt);
  }
  sel.appendChild(frag);
}

// Resolve ISSNs to names using /sources; chunk by 100 due to OR limit in filters
async function resolveIssnNames(issns) {
  if (!issns.length) return [];

  // chunk by 100 (OR limit) [1](https://guidebook.devops.uis.cam.ac.uk/howtos/development/generate-api-clients/)
  const chunks = [];
  for (let i = 0; i < issns.length; i += 100) chunks.push(issns.slice(i, i + 100));

  const results = [];
  for (const chunk of chunks) {
    const sp = new URLSearchParams();
    sp.set('filter', `issn:${chunk.join('|')}`);               // /sources supports issn filter [2](https://github.com/diverged/openalex-openapi)
    sp.set('select', 'display_name,issn_l,issn');
    sp.set('per_page', String(Math.max(chunk.length, 25)));
    if (API_KEY) sp.set('api_key', API_KEY);

    const url = `https://api.openalex.org/sources?${sp.toString()}`;
    const r = await fetch(url);
    if (!r.ok) continue;
    const data = await r.json();
    for (const s of (data.results || [])) {
      // Build a quick lookup of all known ISSNs for this source
      const allIssns = Array.isArray(s.issn) ? s.issn : [];
      results.push({
        name: s.display_name || '',
        issn_l: s.issn_l || '',
        issns: allIssns
      });
    }
  }

  return results;
}

// Populate #journal with resolved names; preserve previous selection when possible
function populateJournalDropdownResolved(issns, sourcesResolved) {
  const sel = document.getElementById('journal');
  if (!sel) return;

  // Build a map: ISSN -> {display, issn_l}
  const byIssn = new Map();
  for (const src of sourcesResolved) {
    for (const i of (src.issns || [])) {
      if (!byIssn.has(i)) {
        byIssn.set(i, { display: src.name || i, issn_l: src.issn_l || i });
      }
    }
  }

  // For ISSNs we didn't resolve (rare), fall back to showing the ISSN itself
  const items = issns.map(i => {
    const hit = byIssn.get(i);
    return { keyIssn: i, name: hit?.display || i, issn_l: hit?.issn_l || i };
  });

  // Deduplicate by keyIssn (issn) and sort by name
  const unique = Array.from(new Map(items.map(it => [it.keyIssn, it])).values())
    .sort((a, b) => a.name.localeCompare(b.name));

  // Preserve selection if still present
  const prev = sel.value;
  sel.innerHTML = '<option value="">Any journal</option>';

  const frag = document.createDocumentFragment();
  for (const j of unique) {
    const opt = document.createElement('option');
    // For filtering we can use the ISSN key directly with locations.source.issn
    opt.value = j.keyIssn;
    opt.textContent = `${j.name} (${j.keyIssn})`;
    frag.appendChild(opt);
  }
  sel.appendChild(frag);

  if (prev && unique.some(j => j.keyIssn === prev)) {
    sel.value = prev;
  }
}

// End-to-end updater: facet → resolve names → populate
async function updateJournalFacetDropdown() {
  // Build filters from UI but exclude the journal selection to show *all* matching journals
  const filterStr = buildFilterStringFromUI({ excludeJournal: true });
  const issns = await facetJournalsForFilter(filterStr);  // list of ISSNs for current query
  if (!issns.length) {
    // Reset to just "Any journal" if no matches
    const sel = document.getElementById('journal');
    if (sel) sel.innerHTML = '<option value="">Any journal</option>';
    return;
  }
  const resolved = await resolveIssnNames(issns);

  JOURNAL_CACHE.items = Array.from(new Map(items.map(it => [it.issn, it])).values())
  .sort((a, b) => a.name.localeCompare(b.name));
  
// Build: {issn, name, issn_l} for each ISSN we got from the facet
  const byIssn = new Map();
  for (const s of resolved) {
    for (const i of (s.issns || [])) {
      if (!byIssn.has(i)) byIssn.set(i, { name: s.display || i, issn_l: s.issn_l || i });
    }
  }

  const items = issns.map(i => {
    const hit = byIssn.get(i);
    return { issn: i, name: hit?.name || i, issn_l: hit?.issn_l || i };
  });

  // Deduplicate & sort by name
  JOURNAL_CACHE.items = Array.from(new Map(items.map(it => [it.issn, it])).values())
    .sort((a, b) => a.name.localeCompare(b.name));

  renderJournalOptions(''); // initial render with no text filter
}

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


// Journal filter from dropdown
  const journalSel = document.getElementById('journal');
  if (journalSel && journalSel.value) {
    filters.push(`locations.source.issn:${journalSel.value}`); // robust across locations [1](https://guidebook.devops.uis.cam.ac.uk/howtos/development/generate-api-clients/)
  }

  
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
  const openalexLink =  w.id ? ` • ${escapeAttr(w.id)}</a>` : "";

  
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

updateJournalFacetDropdown().catch(console.warn);  // facet-based dropdown for *all* results

document.getElementById('journal')?.addEventListener('change', () => {
  doSearch({ freshPage: true });
});


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

// Typing in the search box filters the list client-side (no API call)
const journalSearch = document.getElementById('journalSearch');
if (journalSearch) {
  const debounce = (fn, ms = 150) => {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };
  journalSearch.addEventListener('input', debounce(e => {
    renderJournalOptions(e.target.value || '');
  }, 150));
}

// Selecting journals triggers a new search (ANY of the selected)
document.getElementById('journal')?.addEventListener('change', () => {
  page = 1;
  doSearch({ freshPage: true });
});


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
}
