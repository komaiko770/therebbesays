// Runtime refinements layered on top of app.js.
// 1) Auth controls that are ALWAYS reachable — including on research/answer pages
//    where the overlay covers the site header.
// 2) Bold, truthful research preloader: driven entirely by real backend state
//    (status, research_stage, research_started_at). It never invents progress and
//    never resets on reload — elapsed time and stage come from the database.
// 3) Topic filter: honest empty state instead of "No questions yet."
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const supabase = createClient(
  'https://euixoavdzwaactdbxnpk.supabase.co',
  'sb_publishable_viKz06_JdVM5ToTUCgCAbw_l96GI4Bu',
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }
);

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
  chip.style.cssText = [
    'position:fixed', 'top:14px', 'right:16px', 'z-index:4000', 'display:none',
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

supabase.auth.getSession().then(({ data }) => { currentSession = data.session; applyAuthVisibility(); });
supabase.auth.onAuthStateChange((_event, session) => { currentSession = session; applyAuthVisibility(); });

// --- 2) Truthful research preloader -----------------------------------------
// Stage contract with the Fly worker (research_stage column):
const STAGES = [
  ['analyzing',    'Analyzing your question',        'Building Hebrew search queries and key terms from what you asked.'],
  ['retrieving',   'Searching the source archives',  'Hybrid semantic + keyword retrieval across Toras Menachem and Igros Kodesh.'],
  ['reflecting',   'Reading what was found',         'Re-examining the retrieved passages and refining the research focus.'],
  ['verifying',    'Verifying every source',         'Each candidate passage faces adversarial verification votes before it may be cited.'],
  ['synthesizing', 'Writing the sourced answer',     'Composing the answer strictly from verified passages — every claim cited.'],
];

const overlayCss = `
#tw-research-overlay{position:fixed;inset:0;z-index:3000;background:radial-gradient(1200px 700px at 50% -10%,#26211a 0%,#141210 60%);color:#efe9dd;overflow:auto;font-family:Inter,system-ui,sans-serif}
#tw-research-overlay .tw-wrap{max-width:640px;margin:0 auto;padding:72px 24px 60px;text-align:center}
#tw-research-overlay .tw-kicker{color:#c9a349;font-family:Fraunces,Georgia,serif;font-size:26px;margin:0}
#tw-research-overlay h1{font-family:Fraunces,Georgia,serif;font-weight:500;font-size:clamp(22px,4vw,32px);margin:14px 0 6px}
#tw-research-overlay .tw-q{color:#a99f8c;font-style:italic;margin:0 0 34px;font-size:15px}
#tw-research-overlay .tw-pulse{position:relative;width:120px;height:120px;margin:0 auto 30px}
#tw-research-overlay .tw-pulse::before,#tw-research-overlay .tw-pulse::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid rgba(201,163,73,.5);animation:twPulse 2.4s ease-out infinite}
#tw-research-overlay .tw-pulse::after{animation-delay:1.2s}
#tw-research-overlay .tw-pulse span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:Fraunces,Georgia,serif;font-size:34px;color:#c9a349}
@keyframes twPulse{0%{transform:scale(.55);opacity:.9}100%{transform:scale(1.25);opacity:0}}
#tw-research-overlay .tw-elapsed{font:500 13px "JetBrains Mono",monospace;color:#c9a349;letter-spacing:.08em;margin-bottom:36px}
#tw-research-overlay .tw-stages{text-align:left;display:flex;flex-direction:column;gap:0;border-left:2px solid rgba(201,163,73,.22);margin:0 auto;max-width:460px}
#tw-research-overlay .tw-stage{position:relative;padding:12px 0 12px 26px;opacity:.42;transition:opacity .4s}
#tw-research-overlay .tw-stage::before{content:"";position:absolute;left:-7px;top:18px;width:12px;height:12px;border-radius:50%;background:#3a342b;border:2px solid rgba(201,163,73,.35)}
#tw-research-overlay .tw-stage.done{opacity:.72}
#tw-research-overlay .tw-stage.done::before{background:#c9a349;border-color:#c9a349}
#tw-research-overlay .tw-stage.active{opacity:1}
#tw-research-overlay .tw-stage.active::before{background:#141210;border-color:#c9a349;box-shadow:0 0 0 4px rgba(201,163,73,.25);animation:twGlow 1.6s ease-in-out infinite alternate}
@keyframes twGlow{from{box-shadow:0 0 0 3px rgba(201,163,73,.18)}to{box-shadow:0 0 0 7px rgba(201,163,73,.32)}}
#tw-research-overlay .tw-stage h3{margin:0;font:600 15px Inter,system-ui,sans-serif;color:#efe9dd}
#tw-research-overlay .tw-stage.active h3{color:#c9a349}
#tw-research-overlay .tw-stage p{margin:4px 0 0;font-size:13px;line-height:1.5;color:#a99f8c}
#tw-research-overlay .tw-note{margin:38px auto 0;max-width:460px;font-size:13.5px;line-height:1.6;color:#a99f8c}
#tw-research-overlay .tw-back{display:inline-block;margin-top:26px;color:#c9a349;font-size:13.5px;text-decoration:none;border:1px solid rgba(201,163,73,.4);border-radius:999px;padding:9px 18px}
#tw-research-overlay .tw-back:hover{background:rgba(201,163,73,.12)}
#tw-research-overlay .tw-live{display:inline-flex;align-items:center;gap:7px;font:600 11px Inter,sans-serif;letter-spacing:.14em;color:#8bbf74;margin-bottom:14px}
#tw-research-overlay .tw-live i{width:7px;height:7px;border-radius:50%;background:#8bbf74;animation:twGlow 1.4s ease-in-out infinite alternate}
`;

function fmtElapsed(startIso) {
  if (!startIso) return null;
  const s = Math.max(0, Math.floor((Date.now() - new Date(startIso).getTime()) / 1000));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function stageIndex(stage) {
  return STAGES.findIndex(([key]) => key === stage);
}

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
  const queued = q.status === 'queued';
  const idx = stageIndex(q.research_stage);
  const elapsed = !queued ? fmtElapsed(q.research_started_at) : null;
  const stagesHtml = STAGES.map(([key, title, desc], i) => {
    let cls = '';
    if (!queued && idx >= 0) cls = i < idx ? 'done' : i === idx ? 'active' : '';
    else if (!queued && idx < 0) cls = i === 0 ? 'active' : '';
    return `<div class="tw-stage ${cls}"><h3>${title}</h3><p>${desc}</p></div>`;
  }).join('');
  overlay.innerHTML = `
    <div class="tw-wrap">
      <p class="tw-kicker">ב״ה</p>
      <h1>${queued ? 'In the research queue' : 'Research in progress'}</h1>
      <p class="tw-q">“${(q.question || '').replace(/</g, '&lt;')}”</p>
      <div class="tw-live"><i></i>LIVE FROM THE RESEARCH ENGINE</div>
      <div class="tw-pulse"><span>770</span></div>
      ${elapsed ? `<div class="tw-elapsed">RUNNING ${elapsed}</div>` : ''}
      <div class="tw-stages">${stagesHtml}</div>
      <p class="tw-note">${queued
        ? 'Your question is saved and holds its place in line. Research begins automatically — nothing is lost if you leave.'
        : 'This is the live state of the pipeline, read directly from the research engine. You can safely leave — the finished, fully-sourced answer will appear in the feed.'}</p>
      <a class="tw-back" href="/">← Back to the feed</a>
    </div>`;
  syncChipVisibility();
}

function removeOverlay() {
  document.querySelector('#tw-research-overlay')?.remove();
  document.body.style.overflow = '';
  syncChipVisibility();
}

async function fetchQuestion(slug) {
  const url = 'https://euixoavdzwaactdbxnpk.supabase.co/rest/v1/questions'
    + `?select=slug,question,status,research_stage,research_started_at&slug=eq.${encodeURIComponent(slug)}&limit=1`;
  const res = await fetch(url, { headers: { apikey: supabase.supabaseKey, authorization: `Bearer ${supabase.supabaseKey}` } });
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
      empty.textContent = 'No published questions in this topic yet — tap “All” to see the whole feed.';
    }
  };
  new MutationObserver(fixEmptyState).observe(feedList, { childList: true });
  fixEmptyState();
}
