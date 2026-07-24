// Runtime refinements layered on top of app.js (owner video, 24 Jul).
// 1) Auth buttons failsafe: exactly one of Sign in / Sign out visible.
// 2) Topic filter: honest empty state instead of "No questions yet."
// 3) Queue page: reassure that leaving the page doesn't lose the question.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const supabase = createClient(
  'https://euixoavdzwaactdbxnpk.supabase.co',
  'sb_publishable_viKz06_JdVM5ToTUCgCAbw_l96GI4Bu',
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }
);

// --- 1) Auth slot failsafe -------------------------------------------------
function applyAuthVisibility(session) {
  const slot = document.querySelector('#auth-slot');
  if (!slot) return;
  const signInBtn = slot.querySelector('.auth-button');
  const account = slot.querySelector('.auth-account');
  const signedIn = Boolean(session);
  if (signInBtn) signInBtn.hidden = signedIn;
  if (account) account.hidden = !signedIn;
}
supabase.auth.getSession().then(({ data }) => applyAuthVisibility(data.session));
supabase.auth.onAuthStateChange((_event, session) => applyAuthVisibility(session));

// --- 2) Topic filter empty state ------------------------------------------
const feedList = document.querySelector('#feed-list');
if (feedList) {
  const fixEmptyState = () => {
    const empty = feedList.querySelector('.empty');
    if (!empty) return;
    const activeChip = document.querySelector('#keyword-filter-list button.active');
    const keyword = activeChip?.dataset?.keyword;
    if (keyword) {
      empty.textContent = 'No published questions in this topic yet — tap “All” to see the whole feed.';
    }
  };
  new MutationObserver(fixEmptyState).observe(feedList, { childList: true });
  fixEmptyState();
}

// --- 3) Queue page reassurance ---------------------------------------------
const detail = document.querySelector('#detail');
if (detail) {
  const addQueueNote = () => {
    if (detail.hidden) return;
    if (detail.querySelector('.queue-note')) return;
    const text = detail.textContent || '';
    if (!/research queue|waiting for the research process|Research in progress/i.test(text)) return;
    const host = detail.querySelector('.research-status, .progress, .detail-inner') || detail;
    const note = document.createElement('p');
    note.className = 'queue-note';
    note.style.cssText = 'margin:18px auto 0;max-width:520px;text-align:center;color:#a99f8c;font-size:13.5px;line-height:1.55;';
    note.textContent = 'You can safely leave this page. Your question stays in the research queue and will appear in the feed — with its full sourced answer — as soon as it is published.';
    host.appendChild(note);
  };
  new MutationObserver(addQueueNote).observe(detail, { childList: true, subtree: true });
  addQueueNote();
}
