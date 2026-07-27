// Feed preloader (owner report, 26 Jul 21:12): on first load the feed could show
// "No questions yet. Ask the first one above." BEFORE the first /api/questions
// response arrived — misleading, since the site already has many published answers.
// This module swaps that pre-data empty state for skeleton loading cards. It asks
// the API independently whether any questions exist, so a GENUINELY empty site
// still gets the real empty message. It never touches other feed states — the
// search/filter/hearted empty messages and the error message use different copy —
// and it stands down permanently once real cards render (or after 20s, so the UI
// can never be trapped in a skeleton).

const feedList = document.getElementById('feed-list');
if (feedList) {
  const style = document.createElement('style');
  style.textContent = `
    .feed-skeleton { display:grid; gap:14px; }
    .feed-skeleton .skel-card { border:1px solid rgba(201,163,73,.16); background:#1c1a17; border-radius:16px; padding:18px; }
    .skel-line { height:12px; border-radius:6px; background:linear-gradient(90deg, rgba(201,163,73,.08) 25%, rgba(201,163,73,.2) 50%, rgba(201,163,73,.08) 75%); background-size:200% 100%; animation:skel-shimmer 1.4s ease-in-out infinite; }
    .skel-title { height:16px; width:62%; margin-bottom:12px; }
    .skel-line + .skel-line { margin-top:8px; }
    .skel-w80 { width:80%; } .skel-w95 { width:95%; } .skel-w45 { width:45%; }
    .skel-note { text-align:center; color:#a99f8c; font-size:13px; padding:10px 0 2px; }
    @keyframes skel-shimmer { 0% { background-position:200% 0; } 100% { background-position:-200% 0; } }
  `;
  document.head.appendChild(style);

  let verdict = null;   // null = unknown yet, true = questions exist, false = genuinely empty
  let done = false;
  const started = Date.now();

  const skeletonHtml = () => {
    const card = '<div class="skel-card"><div class="skel-line skel-title"></div><div class="skel-line skel-w95"></div><div class="skel-line skel-w80"></div><div class="skel-line skel-w45"></div></div>';
    return `<div class="feed-skeleton" aria-hidden="true">${card}${card}${card}${card}</div><div class="skel-note" role="status">Loading the latest research…</div>`;
  };

  const isPrematureEmpty = () => {
    const empty = feedList.querySelector('.empty');
    return !!empty && /No questions yet/i.test(empty.textContent || '');
  };
  const hasRealContent = () => {
    for (const el of feedList.children) {
      if (el.classList.contains('empty') || el.classList.contains('feed-skeleton') || el.classList.contains('skel-note')) continue;
      return true;
    }
    return false;
  };
  const showSkeleton = () => {
    if (feedList.dataset.skeleton === '1') return;
    feedList.dataset.skeleton = '1';
    feedList.innerHTML = skeletonHtml();
  };
  const clearSkeletonFlagIfGone = () => {
    if (feedList.dataset.skeleton === '1' && !feedList.querySelector('.feed-skeleton')) delete feedList.dataset.skeleton;
  };

  const observer = new MutationObserver(() => tick());
  const finish = () => { done = true; observer.disconnect(); };

  const tick = () => {
    if (done) return;
    clearSkeletonFlagIfGone();
    if (hasRealContent()) { finish(); return; }              // real cards rendered — stand down
    if (Date.now() - started > 20000) { finish(); return; }  // safety valve
    if (verdict === false) {                                  // genuinely empty site
      if (feedList.dataset.skeleton === '1') {
        delete feedList.dataset.skeleton;
        feedList.innerHTML = '<div class="empty">No questions yet. Ask the first one above.</div>';
      }
      finish();
      return;
    }
    if (isPrematureEmpty() || !feedList.children.length) showSkeleton();
  };

  observer.observe(feedList, { childList: true, subtree: true });

  fetch('/api/questions?limit=1')
    .then(r => (r.ok ? r.json() : []))
    .then(rows => { verdict = Array.isArray(rows) && rows.length > 0; tick(); })
    .catch(() => { verdict = null; });

  tick(); // handle whatever state already exists at module start
}
