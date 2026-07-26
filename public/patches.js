// Runtime refinements layered on top of app.js.
// 1) Auth controls that are ALWAYS reachable — including on research/answer pages
//    where the overlay covers the site header. The chip sits TOP-LEFT (owner request,
//    26 Jul): it pairs with the Back-to-feed pill at top-right and never covers the
//    answer modal's close button (which is top-right; the chip is on the other side).
// 2) Bold, truthful research preloader: driven entirely by real backend state
//    (status, research_stage, research_started_at). It never invents progress and
//    never resets on reload — elapsed time and stage come from the database.
//    Single-viewport layout, sized to FILL the screen (owner: "bigger and bolder"),
//    with a properly proportioned 770 facade — three steep gables (center highest),
//    three stories of windows, arched center entrance — traced by a glowing spark.
// 3) Topic filter: honest empty state instead of "No questions yet."
//
// IMPORTANT: this file must NOT create its own Supabase client. Running two
// GoTrueClient instances against the same storage key caused auth to wedge
// (getSession never resolved: no sign-in UI, OAuth/magic-link sessions dropped).
// It reuses the single client that app.js exposes on window.__twSupabase.

const SUPABASE_URL = 'https://euixoavdzwaactdbxnpk.supabase.co';
const SUPABASE_KEY = 'sb_publishable_viKz06_JdVM5ToTUCgCAbw_l96GI4Bu';

let currentSession = null;

// --- 1) Auth: header failsafe + floating chip for overlay pages -------------
function applyAuthVisibility() {
  const slot = document.querySelector('#auth-slot');
  const signedIn = Boolean(currentSession);
  if (slot) {
    const signInBtn = slot.querySelector('.auth-button');
    const account = slot.querySelector('.auth-account');
    if (signInBtn) signInBtn.hidden = signedIn;
    if (account) account.hidden = !signedIn;
  }
  const chip = document.querySelector('#tw-auth-chip');
  if (chip) {
    chip.textContent = signedIn ? 'Sign out' : 'Sign in';
    chip.dataset.mode = signedIn ? 'out' : 'in';
  }
  syncChipVisibility();
}

function ensureAuthChip() {
  if (document.querySelector('#tw-auth-chip')) return;
  const chip = document.createElement('button');
  chip.id = 'tw-auth-chip';
  chip.type = 'button';
  // Top-left (owner request, 26 Jul): mirrors the Back-to-feed pill at top-right,
  // and stays clear of the answer modal's close button (top-right) on every page.
  chip.style.cssText = [
    'position:fixed', 'top:16px', 'left:16px', 'z-index:4000', 'display:none',
    'font:600 13px Inter,system-ui,sans-serif', 'letter-spacing:.02em',
    'padding:8px 16px', 'border-radius:999px', 'cursor:pointer',
    'color:#c9a349', 'background:rgba(20,18,16,.85)', 'backdrop-filter:blur(6px)',
    'border:1px solid rgba(201,163,73,.45)',
  ].join(';');
  chip.addEventListener('click', () => {
    if (chip.dataset.mode === 'out') document.querySelector('[data-auth-signout]')?.click();
    else document.querySelector('[data-auth-open]')?.click();
  });
  document.body.appendChild(chip);
}

function syncChipVisibility() {
  const chip = document.querySelector('#tw-auth-chip');
  if (!chip) return;
  const detail = document.querySelector('#detail');
  const overlayOpen = (detail && !detail.hidden) || document.querySelector('#tw-research-overlay');
  chip.style.display = overlayOpen ? 'inline-block' : 'none';
}

// Reuse the shared auth client from app.js (retry briefly in case app.js is still loading).
(function wireSharedAuth(attempt = 0) {
  const sb = window.__twSupabase;
  if (!sb) {
    if (attempt < 40) setTimeout(() => wireSharedAuth(attempt + 1), 250);
    return;
  }
  sb.auth.getSession().then(({ data }) => { currentSession = data.session; applyAuthVisibility(); }).catch(() => {});
  sb.auth.onAuthStateChange((_event, session) => { currentSession = session; applyAuthVisibility(); });
})();

// --- 2) Truthful research preloader -----------------------------------------
// Stage contract with the Fly worker (research_stage column):
const STAGES = [
  ['analyzing',    'Analyzing your question',                  'Building Hebrew search queries and key terms from what you asked.'],
  ['retrieving',   'Searching Toras Menachem (vols. 1–73) & Igros Kodesh (vols. 1–28)',  'Toras Menachem covers 1950–1973. Igros Kodesh covers letters from 1928–1973 in Hebrew and Yiddish.'],
  ['reflecting',   'Reading what was found',                   'Re-examining the retrieved passages and refining the research focus.'],
  ['verifying',    'Verifying every source',                   'Each passage faces adversarial verification votes before it may be cited.'],
  ['synthesizing', 'Writing the sourced answer',               'Composed strictly from verified passages — every claim cited.'],
];

const overlayCss = `
#tw-research-overlay{position:fixed;inset:0;z-index:3000;background:radial-gradient(1200px 700px at 50% -10%,#26211a 0%,#141210 60%);color:#efe9dd;overflow:auto;font-family:Inter,system-ui,sans-serif}
#tw-research-overlay .tw-wrap{min-height:100svh;max-width:660px;margin:0 auto;padding:20px 24px;display:flex;flex-direction:column;justify-content:center;text-align:center;box-sizing:border-box}
#tw-research-overlay .tw-kicker{color:#c9a349;font-family:Fraunces,Georgia,serif;font-size:20px;margin:0}
#tw-research-overlay h1{font-family:Fraunces,Georgia,serif;font-weight:500;font-size:clamp(26px,4.6vw,38px);margin:8px 0 4px}
#tw-research-overlay .tw-q{color:#a99f8c;font-style:italic;margin:0 0 12px;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#tw-research-overlay .tw-770{width:min(270px,62vw);height:auto;margin:4px auto 6px;display:block}
#tw-research-overlay .tw-770-outline{stroke:rgba(201,163,73,.42);stroke-width:2;fill:none}
#tw-research-overlay .tw-770-detail{stroke:rgba(201,163,73,.32);stroke-width:1.4;fill:none}
#tw-research-overlay .tw-770-spark{stroke:#f6d998;stroke-width:3;fill:none;stroke-linecap:round;stroke-dasharray:9 91;animation:twTrace 3.4s linear infinite;filter:url(#twGlow770)}
@keyframes twTrace{to{stroke-dashoffset:-100}}
#tw-research-overlay .tw-meta{display:flex;align-items:center;justify-content:center;gap:16px;margin:4px 0 14px}
#tw-research-overlay .tw-live{display:inline-flex;align-items:center;gap:7px;font:600 11.5px Inter,sans-serif;letter-spacing:.14em;color:#8bbf74}
#tw-research-overlay .tw-live i{width:7px;height:7px;border-radius:50%;background:#8bbf74;animation:twGlow 1.4s ease-in-out infinite alternate}
#tw-research-overlay .tw-elapsed{font:500 14px "JetBrains Mono",monospace;color:#c9a349;letter-spacing:.08em}
#tw-research-overlay .tw-stages{text-align:left;display:flex;flex-direction:column;border-left:2px solid rgba(201,163,73,.22);margin:0 auto;width:100%;max-width:480px}
#tw-research-overlay .tw-stage{position:relative;padding:8px 0 8px 26px;opacity:.42;transition:opacity .4s}
#tw-research-overlay .tw-stage::before{content:"";position:absolute;left:-7px;top:14px;width:11px;height:11px;border-radius:50%;background:#3a342b;border:2px solid rgba(201,163,73,.35)}
#tw-research-overlay .tw-stage.done{opacity:.72}
#tw-research-overlay .tw-stage.done::before{background:#c9a349;border-color:#c9a349}
#tw-research-overlay .tw-stage.active{opacity:1;padding:10px 0 10px 26px}
#tw-research-overlay .tw-stage.active::before{background:#141210;border-color:#c9a349;box-shadow:0 0 0 4px rgba(201,163,73,.25);animation:twGlow 1.6s ease-in-out infinite alternate;top:16px}
@keyframes twGlow{from{box-shadow:0 0 0 3px rgba(201,163,73,.18)}to{box-shadow:0 0 0 6px rgba(201,163,73,.32)}}
#tw-research-overlay .tw-stage h3{margin:0;font:600 16px Inter,system-ui,sans-serif;color:#efe9dd}
#tw-research-overlay .tw-stage.active h3{color:#c9a349}
#tw-research-overlay .tw-stage p{display:none;margin:4px 0 0;font-size:13.5px;line-height:1.5;color:#a99f8c}
#tw-research-overlay .tw-stage.active p{display:block}
#tw-research-overlay .tw-note{margin:14px auto 0;max-width:480px;font-size:13px;line-height:1.55;color:#a99f8c}
#tw-research-overlay .tw-back{position:fixed;top:16px;right:16px;z-index:3100;margin:0;color:#c9a349;font:600 13px Inter,system-ui,sans-serif;letter-spacing:.02em;text-decoration:none;border:1px solid rgba(201,163,73,.4);border-radius:999px;padding:8px 16px;background:rgba(20,18,16,.85);backdrop-filter:blur(6px)}
#tw-research-overlay .tw-back:hover{background:rgba(201,163,73,.12)}
@media (max-height:780px){
  #tw-research-overlay .tw-770{width:min(215px,54vw)}
  #tw-research-overlay h1{font-size:clamp(23px,4vw,30px)}
  #tw-research-overlay .tw-stage{padding:6px 0 6px 26px}
  #tw-research-overlay .tw-stage.active{padding:8px 0 8px 26px}
  #tw-research-overlay .tw-stage::before{top:12px}
  #tw-research-overlay .tw-stage.active::before{top:14px}
}
@media (max-height:660px){
  #tw-research-overlay .tw-770{width:min(160px,44vw)}
  #tw-research-overlay .tw-note{display:none}
  #tw-research-overlay .tw-kicker{font-size:16px}
  #tw-research-overlay .tw-stage{padding:4px 0 4px 26px}
  #tw-research-overlay .tw-stage.active{padding:6px 0 6px 26px}
  #tw-research-overlay .tw-stage::before{top:9px}
  #tw-research-overlay .tw-stage.active::before{top:11px}
}
`;

// Line drawing of the 770 Eastern Parkway facade, redrawn from reference photos
// (26 Jul): ~4:3 proportions instead of the old flat 2:1, three steep gables with
// the CENTER peak highest, three stories of paired windows, gable attic windows,
// and the arched center entrance with "770" above it. A glowing spark endlessly
// traces the silhouette.
const SVG_770 = `
<svg class="tw-770" viewBox="0 0 220 170" aria-hidden="true" role="img">
  <defs>
    <filter id="twGlow770" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="2.2" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <path class="tw-770-outline" d="M10 160 L10 64 L43 22 L76 64 L77 64 L110 14 L143 64 L144 64 L177 22 L210 64 L210 160 Z"/>
  <g class="tw-770-detail">
    <path d="M98 160 v-22 a12 12 0 0 1 24 0 v22"/>
    <rect x="22" y="126" width="13" height="18" rx="1"/>
    <rect x="45" y="126" width="13" height="18" rx="1"/>
    <rect x="162" y="126" width="13" height="18" rx="1"/>
    <rect x="185" y="126" width="13" height="18" rx="1"/>
    <rect x="22" y="98" width="13" height="18" rx="1"/>
    <rect x="45" y="98" width="13" height="18" rx="1"/>
    <rect x="86" y="98" width="13" height="18" rx="1"/>
    <rect x="121" y="98" width="13" height="18" rx="1"/>
    <rect x="162" y="98" width="13" height="18" rx="1"/>
    <rect x="185" y="98" width="13" height="18" rx="1"/>
    <rect x="22" y="72" width="13" height="16" rx="1"/>
    <rect x="45" y="72" width="13" height="16" rx="1"/>
    <rect x="86" y="72" width="13" height="16" rx="1"/>
    <rect x="121" y="72" width="13" height="16" rx="1"/>
    <rect x="162" y="72" width="13" height="16" rx="1"/>
    <rect x="185" y="72" width="13" height="16" rx="1"/>
    <path d="M36 46 l7 -6 l7 6"/>
    <path d="M103 38 l7 -6 l7 6"/>
    <path d="M170 46 l7 -6 l7 6"/>
    <path d="M10 94 H210"/>
  </g>
  <text x="110" y="132" text-anchor="middle" font-family="Fraunces,Georgia,serif" font-size="12" fill="rgba(201,163,73,.85)">770</text>
  <path class="tw-770-spark" pathLength="100" d="M10 160 L10 64 L43 22 L76 64 L77 64 L110 14 L143 64 L144 64 L177 22 L210 64 L210 160 Z"/>
</svg>`;

function fmtElapsed(startIso) {
  if (!startIso) return null;
  const s = Math.max(0, Math.floor((Date.now() - new Date(startIso).getTime()) / 1000));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function stageIndex(stage) {
  return STAGES.findIndex(([key]) => key === stage);
}

// Real-time (1s) elapsed counter, independent of the 5s data poll.
let elapsedTimer = null;
function startElapsedTicker() {
  if (elapsedTimer) return;
  elapsedTimer = setInterval(() => {
    const el = document.querySelector('#tw-research-overlay .tw-elapsed');
    if (el?.dataset.start) el.textContent = `RUNNING ${fmtElapsed(el.dataset.start)}`;
  }, 1000);
}
function stopElapsedTicker() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
}

let lastOverlayKey = '';

function renderOverlay(q) {
  let overlay = document.querySelector('#tw-research-overlay');
  if (!overlay) {
    const style = document.createElement('style');
    style.textContent = overlayCss;
    document.head.appendChild(style);
    overlay = document.createElement('div');
    overlay.id = 'tw-research-overlay';
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
  }
  // Only re-render when the real state changes — keeps the spark animation smooth
  // and lets the 1s ticker own the timer text between polls.
  const key = `${q.slug}|${q.status}|${q.research_stage || ''}|${q.research_started_at || ''}`;
  if (lastOverlayKey === key) { syncChipVisibility(); return; }
  lastOverlayKey = key;
  const queued = q.status === 'queued';
  const idx = stageIndex(q.research_stage);
  const elapsed = !queued ? fmtElapsed(q.research_started_at) : null;
  const stagesHtml = STAGES.map(([key2, title, desc], i) => {
    let cls = '';
    if (!queued && idx >= 0) cls = i < idx ? 'done' : i === idx ? 'active' : '';
    else if (!queued && idx < 0) cls = i === 0 ? 'active' : '';
    return `<div class="tw-stage ${cls}"><h3>${title}</h3><p>${desc}</p></div>`;
  }).join('');
  overlay.innerHTML = `
    <a class="tw-back" href="/">← Back to the feed</a>
    <div class="tw-wrap">
      <p class="tw-kicker">ב״ה</p>
      <h1>${queued ? 'In the research queue' : 'Research in progress'}</h1>
      <p class="tw-q">“${(q.question || '').replace(/</g, '&lt;')}”</p>
      ${SVG_770}
      <div class="tw-meta">
        <span class="tw-live"><i></i>LIVE FROM THE RESEARCH ENGINE</span>
        ${elapsed ? `<span class="tw-elapsed" data-start="${q.research_started_at}">RUNNING ${elapsed}</span>` : ''}
      </div>
      <div class="tw-stages">${stagesHtml}</div>
      <p class="tw-note">${queued
        ? 'Your question is saved and holds its place in line. Research begins automatically — nothing is lost if you leave.'
        : 'Live pipeline state, read directly from the research engine. You can safely leave — the finished answer will appear in the feed.'}</p>
    </div>`;
  if (elapsed) startElapsedTicker();
  syncChipVisibility();
}

function removeOverlay() {
  document.querySelector('#tw-research-overlay')?.remove();
  document.body.style.overflow = '';
  lastOverlayKey = '';
  stopElapsedTicker();
  syncChipVisibility();
}

async function fetchQuestion(slug) {
  const url = `${SUPABASE_URL}/rest/v1/questions`
    + `?select=slug,question,status,research_stage,research_started_at&slug=eq.${encodeURIComponent(slug)}&limit=1`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` } });
  const rows = res.ok ? await res.json() : [];
  return rows[0] || null;
}

let pollTimer = null;
let pollSlug = null;

async function pollResearch() {
  const slug = location.pathname.match(/^\/answer\/([^/]+)/)?.[1];
  if (!slug) { stopPolling(); removeOverlay(); return; }
  const decoded = decodeURIComponent(slug);
  const q = await fetchQuestion(decoded).catch(() => null);
  if (!q) return;
  if (q.status === 'queued' || q.status === 'researching') {
    renderOverlay(q);
    if (!pollTimer || pollSlug !== decoded) {
      stopPolling();
      pollSlug = decoded;
      pollTimer = setInterval(pollResearch, 5000);
    }
  } else {
    const hadOverlay = Boolean(document.querySelector('#tw-research-overlay'));
    stopPolling();
    removeOverlay();
    if (hadOverlay) location.reload(); // published (or failed): show the real page
  }
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  pollSlug = null;
}

// --- Kill the legacy-loader flash (owner video, 26 Jul 16:16) -----------------
// app.js renders its old in-modal "Research in progress" card synchronously the
// moment an in-progress card is clicked; the full-screen preloader used to appear
// only after the first status fetch returned (~0.5s later — and instantly when
// cached, which is why the flash came and went). A MutationObserver raises the
// full-screen overlay in the SAME frame the legacy loader mounts, seeded from the
// data already on the page; the first poll then swaps in the true backend state.
const detailNode = document.querySelector('#detail');
if (detailNode) {
  const preemptLegacyLoader = () => {
    if (!detailNode.querySelector('.research-loader')) return;
    if (!document.querySelector('#tw-research-overlay')) {
      const slug = location.pathname.match(/^\/answer\/([^/]+)/)?.[1];
      if (!slug) return;
      const topic = (detailNode.getAttribute('aria-label') || '')
        .replace(/^What does the Rebbe say about\s*/i, '')
        .replace(/\?+\s*$/, '')
        .trim();
      renderOverlay({
        slug: decodeURIComponent(slug),
        question: topic || '…',
        status: 'researching',
        research_stage: null,
        research_started_at: null,
      });
    }
    pollResearch();
  };
  new MutationObserver(preemptLegacyLoader).observe(detailNode, { childList: true, subtree: true });
  preemptLegacyLoader();
}

// Watch for navigation into an answer route (SPA pushState or full load).
ensureAuthChip();
pollResearch();
setInterval(() => {
  const onAnswer = /^\/answer\//.test(location.pathname);
  if (onAnswer && !pollTimer) pollResearch();
  if (!onAnswer && (pollTimer || document.querySelector('#tw-research-overlay'))) { stopPolling(); removeOverlay(); }
  syncChipVisibility();
}, 1500);

// --- 3) Topic filter empty state ---------------------------------------------
const feedList = document.querySelector('#feed-list');
if (feedList) {
  const fixEmptyState = () => {
    const empty = feedList.querySelector('.empty');
    if (!empty) return;
    const activeChip = document.querySelector('#keyword-filter-list button.active');
    if (activeChip?.dataset?.keyword) {
      empty.textContent = 'No published questions in this topic yet — tap "All" to see the whole feed.';
    }
  };
  new MutationObserver(fixEmptyState).observe(feedList, { childList: true });
  fixEmptyState();
}
