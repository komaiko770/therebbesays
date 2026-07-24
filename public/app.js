import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = 'https://euixoavdzwaactdbxnpk.supabase.co';
const SUPABASE_ANON = 'sb_publishable_viKz06_JdVM5ToTUCgCAbw_l96GI4Bu';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });

// Feature flag: when false, new-research submission is open (no sign-in required).
// Flip to true once Supabase Auth is configured to enforce the sign-in gate.
const AUTH_GATE_ENABLED = false;

const state = { questions: [], query: '', feedView:'newest', activeKeyword:'', suggestionIndex:-1 };
const auth = { session: null, isAdmin: false, pending: null, ready: false };
let detailPollTimer;
let researchStageTimer;
let modalReturnFocus = null;
const form = document.querySelector('#question-form');
const input = document.querySelector('#question');
const formStatus = document.querySelector('#form-status');
const charCount = document.querySelector('#char-count');
const feedList = document.querySelector('#feed-list');
const feedStatus = document.querySelector('#feed-status');
const detail = document.querySelector('#detail');
const suggestions = document.querySelector('#question-suggestions');
const keywordFilterList = document.querySelector('#keyword-filter-list');
const authModal = document.querySelector('#auth-modal');
const authSlot = document.querySelector('#auth-slot');
let searchDocked = false;
let searchPlaceholder;
const teaserTrack = document.querySelector('#teaser-track');
const routeSlug = () => location.pathname.match(/^\/answer\/([^/]+)/)?.[1];
state.activeKeyword = new URLSearchParams(location.search).get('keyword') || '';
const visitorId = (() => {
  const key = 'rebbe-heart-visitor';
  const existing = localStorage.getItem(key);
  if (existing && /^[A-Za-z0-9_-]{16,80}$/.test(existing)) return existing;
  const created = crypto.randomUUID().replace(/-/g, '');
  localStorage.setItem(key, created);
  return created;
})();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const revealObserver = !reducedMotion && 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) { entry.target.classList.add('is-visible'); revealObserver.unobserve(entry.target); }
  });
}, { threshold:.12, rootMargin:'0px 0px -7% 0px' }) : null;

function activateInteractions(root = document) {
  root.querySelectorAll('.method-grid article,.question-card,.source-entry,.article-discovery,.article-ask').forEach((element, index) => {
    if (element.dataset.revealReady) return;
    element.dataset.revealReady = 'true';
    element.classList.add('reveal-item');
    element.style.transitionDelay = `${Math.min(index * 45, 240)}ms`;
    if (revealObserver) revealObserver.observe(element);
    else element.classList.add('is-visible');
  });
}

const escapeHtml = (value = '') => value.replace(/[&<>'"]/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]);
const inlineMarkdown = (value, sourcesByOrdinal = new Map(), displayByOrdinal = new Map()) => value
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/\*(.+?)\*/g, '<em>$1</em>')
  .replace(/\[\^(\d+)\]/g, (_, ordinal) => {
    const source = sourcesByOrdinal.get(Number(ordinal));
    const displayNumber = displayByOrdinal.get(Number(ordinal)) || ordinal;
    if (!source?.url) return `<sup class="source-note"><span>${displayNumber}</span></sup>`;
    const host = source.host_publisher || source.publisher || source.source_type || 'Original source';
    const sourceTitle = source.original_source_title || source.title;
    const excerpt = source.supporting_excerpt ? `<span class="citation-preview">${escapeHtml(source.supporting_excerpt)}</span>` : '';
    return `<sup class="source-note"><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer" aria-label="Open original source ${displayNumber}: ${escapeHtml(sourceTitle)}"><span class="citation-number">[${displayNumber}]</span><span class="citation-tooltip" role="tooltip"><span class="citation-kicker"><b>Original source</b><i>Hosted by ${escapeHtml(host)}</i></span><strong>${escapeHtml(sourceTitle)}</strong>${source.original_source_detail ? `<span class="citation-detail">${escapeHtml(source.original_source_detail)}</span>` : ''}${excerpt}<span class="citation-open">Click footnote to open the original page <b aria-hidden="true">↗</b></span></span></a></sup>`;
  });
const citationDisplay = (value = '', sources = []) => {
  const sourceByOrdinal = new Map(sources.map(source => [Number(source.ordinal), source]));
  const seen = [];
  for (const match of value.matchAll(/\[\^(\d+)\]/g)) {
    const ordinal = Number(match[1]);
    if (sourceByOrdinal.has(ordinal) && !seen.includes(ordinal)) seen.push(ordinal);
  }
  sources.map(source => Number(source.ordinal)).filter(ordinal => !seen.includes(ordinal)).forEach(ordinal => seen.push(ordinal));
  return {
    orderedSources:seen.map(ordinal => sourceByOrdinal.get(ordinal)).filter(Boolean),
    displayByOrdinal:new Map(seen.map((ordinal,index) => [ordinal,index + 1]))
  };
};
const normalizeMarkdownFlow = (value = '') => {
  let output = String(value || '');
  let previous;
  do {
    previous = output;
    output = output
      .replace(/([^\n]+)\n{2,}(?!(?:#{1,6}\s|[-•]\s|\d+\.\s))/g, (boundary, line) => {
        const trimmed = line.trim();
        return /(?:[.!?…]["'”’)]?|\[\^\d+\])$/.test(trimmed) ? boundary : `${trimmed} `;
      })
      .replace(/\s*\n{2,}\s*(?=(?:\[\^\d+\]|[.,;:]))/g, ' ')
      .replace(/([^\n])\n{2,}(?=(?:and|but|or|yet|so|because|while|which|that|where|when)\b)/gi, '$1 ')
      .replace(/([A-Za-z0-9”"')])\s+(\[\^\d+\])\s*\.\s+/g, '$1. $2\n\n');
  } while (output !== previous);
  return output;
};
const splitReadableParagraphs = (value = '') => {
  const text = String(value || '').replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!text || text.length < 720) return text ? [text] : [];
  const sentences = text.match(/.*?[.!?]\s*(?:\[\^\d+\])?(?=\s+(?:[A-Z0-9“"'])|$)|.+$/g)?.map(sentence => sentence.trim()).filter(Boolean) || [text];
  const paragraphs = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && (current.length + sentence.length > 650 || current.split(/(?<=[.!?])(?:\s*\[\^\d+\])?\s+/).length >= 3)) {
      paragraphs.push(current.trim());
      current = sentence;
    } else current = `${current} ${sentence}`.trim();
  }
  if (current) paragraphs.push(current.trim());
  return paragraphs;
};
const renderMarkdown = (value = '', sources = [], displayByOrdinal = new Map()) => {
  const sourcesByOrdinal = new Map(sources.map(source => [Number(source.ordinal), source]));
  return escapeHtml(normalizeMarkdownFlow(value)).split(/\n{2,}/).map(block => {
  const heading = block.match(/^#{1,3}\s+(.+)$/s);
  if (heading) return `<h3 class="answer-heading">${inlineMarkdown(heading[1], sourcesByOrdinal, displayByOrdinal)}</h3>`;
  const lines = block.split('\n');
  if (lines.every(line => /^[-•]\s+/.test(line))) {
    return `<ul>${lines.map(line => `<li>${inlineMarkdown(line.replace(/^[-•]\s+/, ''), sourcesByOrdinal, displayByOrdinal)}</li>`).join('')}</ul>`;
  }
  return splitReadableParagraphs(block).map(paragraph => `<p>${inlineMarkdown(paragraph, sourcesByOrdinal, displayByOrdinal)}</p>`).join('');
}).join('');
};
function splitAnswerSections(value = '') {
  const sourceHeading = /^#{1,3}\s+Source-by-source\s*$/im.exec(value);
  if (!sourceHeading) return { synthesis:value.trim(), sourceBySource:'' };
  const synthesis = value.slice(0, sourceHeading.index)
    .replace(/^#{1,3}\s+Synthesis across the sources\s*/i, '')
    .trim();
  const sourceBySource = value.slice(sourceHeading.index + sourceHeading[0].length).trim();
  return { synthesis, sourceBySource };
}


function parseSourceBriefs(value = '') {
  const matches = [...value.matchAll(/^###\s+(.+)$/gm)];
  if (!matches.length) return value.trim() ? [{ title:'Source brief', body:value.trim() }] : [];
  return matches.map((match,index) => ({
    title:match[1].trim(),
    body:value.slice(match.index + match[0].length, matches[index + 1]?.index ?? value.length).trim()
  })).filter(section => section.body || section.title);
}

function renderSourceBriefBody(value = '', sources = [], displayByOrdinal = new Map()) {
  const labelPattern = /^\s*[-•]?\s*\*\*(What the Rebbe says about this topic|What this source is generally about|How prominent the topic is):\*\*\s*(.*)$/gim;
  const matches = [...value.matchAll(labelPattern)];
  if (!matches.length) return renderMarkdown(value, sources, displayByOrdinal);
  const intro = value.slice(0, matches[0].index).trim();
  const fields = matches.map((match,index) => ({
    label:match[1],
    body:[match[2], value.slice(match.index + match[0].length, matches[index + 1]?.index ?? value.length).trim()].filter(Boolean).join('\n\n').trim()
  }));
  return `${intro ? `<div class="source-brief-intro">${renderMarkdown(intro, sources, displayByOrdinal)}</div>` : ''}<div class="source-brief-fields">${fields.map(field => `<section class="source-brief-field"><h4>${escapeHtml(field.label)}</h4><div>${field.body ? renderMarkdown(field.body, sources, displayByOrdinal) : '<p>Not specified in this source brief.</p>'}</div></section>`).join('')}</div>`;
}

function renderSourceReader(value = '', sources = [], displayByOrdinal = new Map(), sourceMaterial = '') {
  let briefs = parseSourceBriefs(value);
  if (briefs.length < 2 && sources.length > 1) {
    const structuredBody = briefs[0]?.body || '';
    briefs = sources.map((source,index) => ({
      title:source.original_source_title || source.title || `Source ${index + 1}`,
      body:index === 0 && structuredBody ? structuredBody : [
        source.original_source_detail ? `**What this source is generally about:**\n\n${source.original_source_detail}` : '',
        source.supporting_excerpt ? `**Relevant excerpt:**\n\n${source.supporting_excerpt}` : ''
      ].filter(Boolean).join('\n\n'),
      source
    }));
  }
  if (!briefs.length) return `<p class="source-tab-intro">No structured source briefs are available for this answer yet.</p>`;
  const nav = briefs.map((brief,index) => `<button type="button" data-source-brief="${index}" aria-selected="${index === 0 ? 'true' : 'false'}"><span>${String(index + 1).padStart(2,'0')}</span>${escapeHtml(brief.title)}</button>`).join('');
  const panels = briefs.map((brief,index) => `<article class="source-brief-panel" data-source-brief-panel="${index}" ${index ? 'hidden' : ''}><p class="source-brief-kicker">Source ${String(index + 1).padStart(2,'0')} of ${String(briefs.length).padStart(2,'0')}</p><h3>${escapeHtml(brief.title)}</h3><div class="answer-copy">${brief.body ? renderSourceBriefBody(brief.body, sources, displayByOrdinal) : '<p>This source is part of the verified citation trail for this answer.</p>'}</div>${brief.source?.url ? `<a class="source-brief-link" href="${escapeHtml(brief.source.url)}" target="_blank" rel="noopener noreferrer">Open original source <span aria-hidden="true">↗</span></a>` : ''}</article>`).join('');
  return `<div class="source-reader"><nav class="source-reader-nav" aria-label="Source briefs">${nav}</nav><div class="source-reader-detail">${panels}</div></div>${sourceMaterial ? `<details class="source-directory"><summary>All cited sources (${sources.length})</summary>${sourceMaterial}</details>` : ''}`;
}
function sourcesMarkup(orderedSources, displayByOrdinal) {
  if (!orderedSources.length) return '';
  return `<div class="sources"><h3>Notes &amp; sources</h3><p class="sources-intro">Notes are numbered in reading order. “Source” identifies the work or page; “Hosted by” identifies the website serving it.</p>${orderedSources.map(source => `
    <article class="source-entry" id="source-${displayByOrdinal.get(Number(source.ordinal))}">
      <span class="source-number">${displayByOrdinal.get(Number(source.ordinal))}</span>
      <div>
        <a class="source-link" href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">
          <strong>${escapeHtml(source.original_source_title || source.title)}</strong><span aria-hidden="true">↗</span>
        </a>
        ${source.original_source_detail ? `<span class="source-detail">${escapeHtml(source.original_source_detail)}</span>` : ''}
        <small><b>Hosted by:</b> ${escapeHtml(source.host_publisher || source.publisher || source.source_type)}</small>
        ${source.supporting_excerpt ? `<p>${escapeHtml(source.supporting_excerpt)}</p>` : ''}
      </div>
    </article>`).join('')}</div>`;
}
const label = status => ({ queued:'In the queue', researching:'Researching', published:'Answer published', inconclusive:'Direct sources limited', failed:'Research retrying' })[status] || status;
const formatDate = value => new Intl.DateTimeFormat('en-US', { month:'short', day:'numeric', year:'numeric' }).format(new Date(value));
const topicText = value => value.replace(/^what (?:did|does) (?:the )?rebbe say about\s+/i, '').replace(/[?.!]+$/, '').trim();
const displayTopic = value => {
  const topic = topicText(value);
  return topic ? `${topic.charAt(0).toUpperCase()}${topic.slice(1)}` : topic;
};
const titleCaseTopic = value => {
  const small = new Set(['a','an','the','and','but','or','for','nor','on','at','to','from','by','of','in','with','about','over']);
  const words = String(value || '').trim().split(/\s+/);
  const acronyms = new Map([['adhd','ADHD'],['ai','AI'],['usa','USA'],['us','US'],['u.s.','U.S.']]);
  return words.map((word,index) => {
    if (/^[A-Z0-9]{2,}$/.test(word)) return word;
    const lower = word.toLowerCase();
    if (acronyms.has(lower)) return acronyms.get(lower);
    if ((index === 0 || index < words.length - 1) && small.has(lower)) return lower;
    return lower.replace(/(^|[-'’])([a-z])/g, (_,lead,char) => lead + char.toUpperCase());
  }).join(' ');
};
const displayKeyword = value => String(value || '').trim().toLowerCase();
const questionText = value => `What does the Rebbe say about ${titleCaseTopic(topicText(value))}?`;
const feedImages = {
  'dealing-with-anxiety-ba0fa624':'/images/feed-anxiety-4x5.png',
  'intermarriage-766a53e3':'/images/feed-intermarriage-4x5.png',
  'the-iranian-republic-55ce6649':'/images/feed-iran-4x5.png'
};
const keywordStopwords = new Set('about after again against also among answer archive because been before being between chabad could direct does each from further have into itself just more most other over published rebbe research said says show shows source sources than that their them then there these they this those through under very what when where which while with would your dealing republic'.split(' '));
function keywordsFor(item) {
  if (Array.isArray(item.keywords) && item.keywords.length) return [...new Set(item.keywords.map(keyword => String(keyword).trim()).filter(Boolean))].slice(0,4);
  const questionWords = topicText(item.question || '').toLowerCase().match(/[a-z][a-z-]{3,}/g) || [];
  const text = `${item.question || ''} ${item.short_answer || ''} ${item.answer_markdown || ''}`.toLowerCase().replace(/\[\^\d+\]|https?:\/\/\S+|[#*_“”"'()]/g,' ');
  const counts = new Map();
  for (const word of text.match(/[a-z][a-z-]{3,}/g) || []) {
    const normalized = word.replace(/-+/g,'-');
    if (keywordStopwords.has(normalized) || normalized.length > 22) continue;
    counts.set(normalized,(counts.get(normalized) || 0) + 1);
  }
  questionWords.forEach(word => { if (!keywordStopwords.has(word)) counts.set(word,(counts.get(word) || 0) + 8); });
  return [...counts].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([word]) => word).slice(0,4);
}
const editorialHooks = {
  'dealing-with-anxiety-ba0fa624': {
    label:'The unexpected diagnosis',
    tease:'The Rebbe argued that the reason a person identifies for anxiety may not be its real cause—and paired spiritual trust with professional care.'
  },
  'intermarriage-766a53e3': {
    label:'A difficult, direct answer',
    tease:'The Rebbe called intermarriage a communal calamity, then closed his letter with a pastoral point people often leave out.'
  }
};

function fallbackTeaser(item) {
  const text = (item.short_answer || item.answer_markdown || '')
    .replace(/^#{1,3}\s+.*$/gm, '')
    .replace(/\[\^\d+\]/g, '')
    .replace(/[\n*_#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  return sentences.slice(0, 2).join(' ').slice(0, 220).trim();
}

const hookFor = item => editorialHooks[item.slug] || { label:'From the sourced answer', tease:fallbackTeaser(item) };

function teaserCardMarkup(item, index = 0, duplicate = false) {
  const hook = hookFor(item);
  return `<a class="teaser-card" href="/answer/${encodeURIComponent(item.slug)}" ${duplicate ? 'aria-hidden="true" tabindex="-1"' : ''}>
    <span class="teaser-card-meta"><span class="teaser-label">${escapeHtml(hook.label)}</span><span class="teaser-heart" data-heart-count="${item.id}">♥ ${Number(item.heart_count) || 0}</span></span>
    <h3>${escapeHtml(questionText(item.question))}</h3>
    <p>${escapeHtml(hook.tease)}</p>
    <span class="teaser-cta">Read what the sources actually say <b aria-hidden="true">↗</b></span>
  </a>`;
}

function renderTeasers() {
  if (!teaserTrack) return;
  const published = state.questions.filter(item => item.status === 'published' && (item.answer_markdown || item.short_answer));
  const section = teaserTrack.closest('.question-teasers');
  if (!published.length) { section.hidden = true; return; }
  section.hidden = false;
  const base = [];
  while (base.length < 6) base.push(...published);
  const sequence = [...base.slice(0, 6), ...base.slice(0, 6)];
  teaserTrack.innerHTML = sequence.map((item, index) => teaserCardMarkup(item, index, index >= 6)).join('');
}

function articleDiscovery(currentSlug) {
  const published = state.questions.filter(item => item.status === 'published' && item.slug !== currentSlug && (item.answer_markdown || item.short_answer));
  const fallback = state.questions.filter(item => item.status === 'published' && (item.answer_markdown || item.short_answer));
  const items = published.length ? published : fallback;
  if (!items.length) return '';
  const base = [];
  while (base.length < 5) base.push(...items);
  const sequence = [...base.slice(0, 5), ...base.slice(0, 5)];
  return `<section class="article-discovery" aria-labelledby="article-discovery-title">
    <div class="article-discovery-head">
      <p class="eyebrow">Continue exploring</p>
      <h3 id="article-discovery-title">One answer usually leads to another question.</h3>
      <a href="/">Browse the full public index <span aria-hidden="true">↗</span></a>
    </div>
    <div class="article-teaser-window"><div class="teaser-track article-teaser-track">${sequence.map((entry, index) => teaserCardMarkup(entry, index, index >= 5)).join('')}</div></div>
  </section>`;
}

function sharePanel(item) {
  const pageUrl = `${location.origin}/answer/${encodeURIComponent(item.slug)}`;
  const title = questionText(item.question);
  return `<section class="share-panel" aria-label="Share this answer">
    <span>Share this answer</span>
    <div class="share-actions">
      <button type="button" class="share-icon" data-native-share data-url="${escapeHtml(pageUrl)}" data-title="${escapeHtml(title)}" title="Share"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="2.5"></circle><circle cx="6" cy="12" r="2.5"></circle><circle cx="18" cy="19" r="2.5"></circle><path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5"></path></svg><span class="sr-only">Share</span></button>
      <button type="button" class="share-icon" data-copy-link data-url="${escapeHtml(pageUrl)}" title="Copy link"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg><span class="sr-only">Copy link</span></button>
      <a class="share-icon" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(pageUrl)}" target="_blank" rel="noopener noreferrer" title="Share on X" aria-label="Share on X"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4.3l9.7 16h-4.3L5 4Zm1 16 12-16"></path></svg></a>
      <a class="share-icon" href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(pageUrl)}" target="_blank" rel="noopener noreferrer" title="Share on Facebook" aria-label="Share on Facebook"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 21v-8h3l.5-3H14V8.3c0-.9.3-1.8 1.9-1.8H18V3.8c-.4-.1-1.7-.2-2.8-.2-2.8 0-4.7 1.7-4.7 4.8V10H8v3h2.5v8H14Z"></path></svg></a>
      <a class="share-icon" href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(pageUrl)}" target="_blank" rel="noopener noreferrer" title="Share on LinkedIn" aria-label="Share on LinkedIn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 8.5V18M6.5 5.5v.1M10.5 18v-9.5M10.5 12.5c.8-2.2 6-3.1 6 1.5v4"></path></svg></a>
      <a class="share-icon" href="mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(`I thought you might want to read this sourced answer: ${pageUrl}`)}" title="Share by email" aria-label="Share by email"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m4 7 8 6 8-6"></path></svg></a>
    </div>
    <small class="share-status" role="status"></small>
  </section>`;
}

function heartButton(item, prominent = false) {
  const count = Number(item.heart_count) || 0;
  return `<button type="button" class="heart-button${item.hearted ? ' hearted' : ''}${prominent ? ' prominent' : ''}" data-heart-question="${item.id}" aria-pressed="${item.hearted ? 'true' : 'false'}" aria-label="${item.hearted ? 'Remove heart from' : 'Heart'} ${escapeHtml(questionText(item.question))}"><span aria-hidden="true">♥</span><b data-heart-count="${item.id}">${count}</b></button>`;
}

function adminDeleteButton(item, variant = 'card') {
  if (!auth.isAdmin) return '';
  return `<button type="button" class="admin-delete ${variant}" data-admin-delete="${item.id}" data-admin-slug="${escapeHtml(item.slug)}" aria-label="Delete ${escapeHtml(questionText(item.question))}" title="Delete this research page">🗑 Delete</button>`;
}

function askAnotherPanel() {
  return `<section class="article-ask" aria-labelledby="article-ask-title">
    <div><p class="eyebrow">Ask the archive</p><h3 id="article-ask-title">What should we research next?</h3><p>Your question becomes its own public research page, with the source trail preserved.</p></div>
    <form class="article-question-form">
      <label class="sr-only" for="article-question">Ask another question</label>
      <input id="article-question" name="question" type="text" minlength="2" maxlength="500" placeholder="What does the Rebbe say about…" required>
      <button type="submit">Begin research <span aria-hidden="true">↗</span></button>
      <p class="article-form-status" role="status"></p>
    </form>
  </section>`;
}

function updatePageMeta(item) {
  const title = `${questionText(item.question)} — The Rebbe / Index`;
  const description = hookFor(item).tease || fallbackTeaser(item);
  const url = `${location.origin}/answer/${encodeURIComponent(item.slug)}`;
  document.title = title;
  const values = { 'meta[name="description"]':description, 'meta[property="og:title"]':title, 'meta[property="og:description"]':description, 'meta[property="og:url"]':url, 'meta[name="twitter:title"]':title, 'meta[name="twitter:description"]':description };
  Object.entries(values).forEach(([selector, content]) => document.querySelector(selector)?.setAttribute('content', content));
  document.querySelector('link[rel="canonical"]')?.setAttribute('href', url);
}

function resetPageMeta() {
  const title = 'What does the Rebbe say?';
  const description = 'Ask what the Rebbe says about a topic and explore source-backed answers.';
  document.title = title;
  const values = { 'meta[name="description"]':description, 'meta[property="og:title"]':`${title} — The Rebbe / Index`, 'meta[property="og:description"]':'Source-backed answers from the published teachings and correspondence of the Lubavitcher Rebbe.', 'meta[property="og:url"]':`${location.origin}/`, 'meta[name="twitter:title"]':`${title} — The Rebbe / Index`, 'meta[name="twitter:description"]':'Source-backed answers from the published teachings and correspondence of the Lubavitcher Rebbe.' };
  Object.entries(values).forEach(([selector, content]) => document.querySelector(selector)?.setAttribute('content', content));
  document.querySelector('link[rel="canonical"]')?.setAttribute('href', `${location.origin}/`);
}

function applyHeartState(item) {
  const count = Number(item.heart_count) || 0;
  document.querySelectorAll(`[data-heart-question="${item.id}"]`).forEach(button => {
    button.classList.toggle('hearted', Boolean(item.hearted));
    button.setAttribute('aria-pressed', item.hearted ? 'true' : 'false');
    button.setAttribute('aria-label', `${item.hearted ? 'Remove heart from' : 'Heart'} ${questionText(item.question)}`);
  });
  document.querySelectorAll(`[data-heart-count="${item.id}"]`).forEach(node => { node.textContent = node.classList.contains('teaser-heart') ? `♥ ${count}` : String(count); });
}

async function toggleHeart(questionId) {
  const item = state.questions.find(question => question.id === questionId);
  if (!item) return;
  const previous = { hearted:Boolean(item.hearted), heart_count:Number(item.heart_count) || 0 };
  item.hearted = !previous.hearted;
  item.heart_count = Math.max(0, previous.heart_count + (item.hearted ? 1 : -1));
  applyHeartState(item);
  if (state.feedView === 'hearted' || state.feedView === 'loved') renderFeed();
  try {
    const result = await api('', { method:'POST', body:JSON.stringify({ action:'heart', question_id:item.id, visitor_id:visitorId, hearted:item.hearted }) });
    item.hearted = Boolean(result.hearted);
    item.heart_count = Number(result.heart_count) || 0;
    applyHeartState(item);
    if (state.feedView === 'hearted' || state.feedView === 'loved') renderFeed();
  } catch (error) {
    item.hearted = previous.hearted;
    item.heart_count = previous.heart_count;
    applyHeartState(item);
    if (state.feedView === 'hearted' || state.feedView === 'loved') renderFeed();
    console.warn('Heart update failed', error);
  }
}

function positionCitationTooltip(anchor) {
  const tooltip = anchor.querySelector('.citation-tooltip');
  if (!tooltip) return;
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(340, innerWidth - 24);
  const anchorCenter = rect.left + rect.width / 2;
  const left = Math.min(innerWidth - width - 12, Math.max(12, anchorCenter - width / 2));
  const arrow = Math.min(width - 22, Math.max(22, anchorCenter - left));
  const below = rect.top < 250;
  tooltip.classList.toggle('below', below);
  tooltip.style.setProperty('--citation-left', `${left}px`);
  tooltip.style.setProperty('--citation-y', `${below ? rect.bottom + 10 : rect.top - 10}px`);
  tooltip.style.setProperty('--citation-arrow-x', `${arrow}px`);
}

async function api(path = '', options = {}) {
  const authHeader = auth.session?.access_token ? { authorization: `Bearer ${auth.session.access_token}` } : {};
  const response = await fetch(`/api/questions${path}`, { ...options, headers: { 'content-type':'application/json', 'x-visitor-id':visitorId, ...authHeader, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

/* ---------- Authentication ---------- */
function redirectTarget() {
  return `${location.origin}${location.pathname}${location.search}`;
}

function setAuthStatus(message, tone = '') {
  const status = authModal?.querySelector('.auth-status');
  if (!status) return;
  status.textContent = message || '';
  status.dataset.tone = tone;
}

function openAuthModal(message = '') {
  if (!authModal) return;
  modalReturnFocus = document.activeElement;
  authModal.hidden = false;
  authModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  setAuthStatus(message, message ? 'info' : '');
  requestAnimationFrame(() => authModal.querySelector('.auth-card')?.focus({ preventScroll:true }));
}

function closeAuthModal() {
  if (!authModal || authModal.hidden) return;
  authModal.hidden = true;
  authModal.setAttribute('aria-hidden', 'true');
  if (detail.hidden) document.body.classList.remove('modal-open');
  setAuthStatus('');
  modalReturnFocus?.focus?.({ preventScroll:true });
  modalReturnFocus = null;
}

function refreshAuthUI() {
  if (!authSlot) return;
  const signInBtn = authSlot.querySelector('.auth-button');
  const account = authSlot.querySelector('.auth-account');
  const adminLink = authSlot.querySelector('.admin-link');
  const signedIn = Boolean(auth.session);
  if (signInBtn) signInBtn.hidden = signedIn || !auth.ready;
  if (account) account.hidden = !signedIn;
  if (adminLink) adminLink.hidden = !auth.isAdmin;
}

async function refreshAdminFlag() {
  if (!auth.session) { auth.isAdmin = false; return; }
  try {
    const { data, error } = await supabase.rpc('is_admin');
    auth.isAdmin = !error && data === true;
  } catch { auth.isAdmin = false; }
}

async function handleAuthChange(session) {
  const wasSignedIn = Boolean(auth.session);
  auth.session = session || null;
  auth.ready = true;
  await refreshAdminFlag();
  refreshAuthUI();
  // Re-render surfaces that depend on admin controls.
  renderFeed();
  if (!detail.hidden && detail.dataset.slug) {
    const current = state.questions.find(q => q.slug === detail.dataset.slug);
    if (current) renderDetail(current, false);
  }
  // Resume a pending question after a fresh sign-in.
  if (auth.session && !wasSignedIn && auth.pending) {
    const pending = auth.pending;
    auth.pending = null;
    closeAuthModal();
    await submitQuestion(pending.question, pending.statusEl, pending.button);
  } else if (auth.session) {
    closeAuthModal();
  }
}

async function signInWithGoogle() {
  setAuthStatus('Redirecting to Google…', 'info');
  const { error } = await supabase.auth.signInWithOAuth({ provider:'google', options:{ redirectTo: redirectTarget() } });
  if (error) setAuthStatus(error.message || 'Google sign-in is unavailable right now.', 'error');
}

async function signInWithEmail(email) {
  setAuthStatus('Sending your sign-in link…', 'info');
  const { error } = await supabase.auth.signInWithOtp({ email, options:{ emailRedirectTo: redirectTarget() } });
  if (error) setAuthStatus(error.message || 'We could not send the link. Please try again.', 'error');
  else setAuthStatus('Check your inbox for a one-time sign-in link.', 'success');
}

async function signOut() {
  await supabase.auth.signOut();
}

function ensureSignedIn(question, statusEl, button) {
  if (!AUTH_GATE_ENABLED) return true;
  if (auth.session) return true;
  auth.pending = { question, statusEl, button };
  if (statusEl) statusEl.textContent = 'Please sign in to start new research.';
  openAuthModal('Sign in to save and publish your research question.');
  return false;
}

async function submitQuestion(question, statusEl, button) {
  if (!question || question.length < 2) return;
  if (button) button.disabled = true;
  if (statusEl) statusEl.textContent = 'Saving your question…';
  try {
    const result = await api('', { method:'POST', body: JSON.stringify({ question }) });
    if (statusEl) statusEl.textContent = result.existing ? 'That question is already in the archive.' : 'Question saved. Its public research page is ready.';
    if (input) { input.value = ''; }
    if (charCount) charCount.textContent = '0';
    location.assign(`/answer/${encodeURIComponent(result.question.slug)}`);
  } catch (error) {
    if (error?.status === 401 || /sign in/i.test(error?.message || '')) {
      ensureSignedIn(question, statusEl, button);
    } else if (statusEl) {
      statusEl.textContent = error.message;
    }
  } finally {
    if (button) button.disabled = false;
  }
}

async function deleteQuestion(id, slug) {
  if (!auth.isAdmin) return;
  if (!confirm('Delete this research page permanently? This cannot be undone.')) return;
  try {
    const { error } = await supabase.rpc('admin_delete_question', { p_id: id });
    if (error) throw error;
    state.questions = state.questions.filter(q => q.id !== id);
    if (!detail.hidden && detail.dataset.slug === slug) closeQuestion(true);
    renderFeed();
  } catch (error) {
    alert(error.message || 'The delete failed. Please try again.');
  }
}

function matchingQuestions(value) {
  const query = value.trim().toLowerCase();
  if (query.length < 2) return [];
  return state.questions
    .map(item => ({ item, score:(item.question || '').toLowerCase().startsWith(query) ? 0 : (item.question || '').toLowerCase().includes(query) ? 1 : `${item.short_answer || ''} ${item.answer_markdown || ''}`.toLowerCase().includes(query) ? 2 : 9 }))
    .filter(entry => entry.score < 9)
    .sort((a,b) => a.score - b.score || new Date(b.item.created_at) - new Date(a.item.created_at))
    .slice(0,6)
    .map(entry => entry.item);
}

function closeSuggestions() {
  state.suggestionIndex = -1;
  suggestions.hidden = true;
  suggestions.innerHTML = '';
  input.setAttribute('aria-expanded','false');
  input.removeAttribute('aria-activedescendant');
}

function renderSuggestions() {
  const matches = matchingQuestions(input.value);
  if (!matches.length) { closeSuggestions(); return; }
  state.suggestionIndex = Math.min(state.suggestionIndex, matches.length - 1);
  suggestions.hidden = false;
  input.setAttribute('aria-expanded','true');
  suggestions.innerHTML = matches.map((item,index) => `<button type="button" id="question-suggestion-${index}" role="option" aria-selected="${index === state.suggestionIndex}" class="question-suggestion${index === state.suggestionIndex ? ' active' : ''}" data-suggestion-slug="${escapeHtml(item.slug)}">
    <span><strong>${escapeHtml(displayTopic(item.question))}</strong><small>${label(item.status)}${item.status === 'published' ? ' · Open sourced answer' : ' · Open research page'}</small></span><b aria-hidden="true">↗</b>
  </button>`).join('');
  if (state.suggestionIndex >= 0) {
    input.setAttribute('aria-activedescendant',`question-suggestion-${state.suggestionIndex}`);
    suggestions.querySelector('.active')?.scrollIntoView({ block:'nearest' });
  }
}

function renderKeywordFilters() {
  if (!keywordFilterList) return;
  const counts = new Map();
  state.questions.forEach(item => keywordsFor(item).forEach(keyword => counts.set(keyword,(counts.get(keyword) || 0) + 1)));
  const keywords = [...counts].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0,10);
  keywordFilterList.innerHTML = [`<button type="button" data-keyword="" class="${state.activeKeyword ? '' : 'active'}">All</button>`, ...keywords.map(([keyword,count]) => `<button type="button" data-keyword="${escapeHtml(keyword)}" class="${state.activeKeyword === keyword ? 'active' : ''}">${escapeHtml(displayKeyword(keyword))} <small>${count}</small></button>`)].join('');
}

function renderFeed() {
  renderTeasers();
  renderKeywordFilters();
  const query = state.query.trim().toLowerCase();
  let questions = state.questions.filter(item => !query || `${item.question || ''} ${item.short_answer || ''} ${item.answer_markdown || ''}`.toLowerCase().includes(query));
  if (state.activeKeyword) questions = questions.filter(item => keywordsFor(item).includes(state.activeKeyword));
  if (state.feedView === 'hearted') questions = questions.filter(item => item.hearted);
  if (state.feedView === 'loved') questions = [...questions].sort((a,b) => (Number(b.heart_count)||0) - (Number(a.heart_count)||0) || new Date(b.created_at) - new Date(a.created_at));
  feedStatus.textContent = state.questions.length ? `${questions.length} ${questions.length === 1 ? 'question' : 'questions'} shown` : '';
  if (!questions.length) {
    feedList.innerHTML = `<div class="empty">${state.feedView === 'hearted' ? 'You have not hearted any questions yet. Tap a heart to build your list.' : query ? 'No questions match that search yet.' : 'No questions yet. Ask the first one above.'}</div>`;
    return;
  }
  feedList.innerHTML = questions.map((item,index) => {
    const hook = hookFor(item);
    const summary = item.status === 'published' ? (hook.tease || fallbackTeaser(item)) : statusCopy(item);
    const image = item.image_url || feedImages[item.slug];
    return `
    <article class="question-card index-card" data-slug="${escapeHtml(item.slug)}">
      <a class="card-thumb" href="/answer/${encodeURIComponent(item.slug)}" aria-label="Open ${escapeHtml(questionText(item.question))}">
        ${image ? `<img src="${escapeHtml(image)}" alt="Editorial image for ${escapeHtml(topicText(item.question))}" loading="lazy">` : `<span class="card-thumb-fallback" aria-hidden="true">${String(index + 1).padStart(2,'0')}</span>`}
      </a>
      <div class="card-main">
        <div class="card-top"><span class="status ${item.status}">${label(item.status)}</span><div class="instagram-keywords">${keywordsFor(item).map(keyword => `<button type="button" class="keyword-pill" data-keyword="${escapeHtml(keyword)}">#${escapeHtml(displayKeyword(keyword))}</button>`).join('')}</div></div>
        <a class="question-title" href="/answer/${encodeURIComponent(item.slug)}">${escapeHtml(displayTopic(item.question))}</a>
        <p class="card-summary">${escapeHtml(summary)}</p>
        <a class="discovery-read" href="/answer/${encodeURIComponent(item.slug)}">${item.status === 'published' ? 'Read the complete sourced answer' : 'Open the research page'} ↗</a>
      </div>
      <div class="card-side"><time datetime="${item.created_at}">${formatDate(item.created_at)}</time>${heartButton(item)}${adminDeleteButton(item,'card')}</div>
    </article>`;
  }).join('');
  requestAnimationFrame(() => activateInteractions(document));
}

async function loadFeed({ quiet = false } = {}) {
  if (!quiet) feedStatus.textContent = 'Loading the archive…';
  try {
    const data = await api('?limit=80');
    state.questions = Array.isArray(data) ? data : [];
    renderFeed();
    const slug = location.pathname.match(/^\/answer\/([^/]+)/)?.[1];
    if (slug && (detail.hidden || detail.dataset.slug !== decodeURIComponent(slug))) openQuestion(decodeURIComponent(slug), false);
  } catch (error) {
    feedStatus.textContent = error.message;
    feedList.innerHTML = '<div class="empty">The archive is temporarily unavailable.</div>';
  }
}

function statusCopy(item) {
  if (item.status === 'queued') return 'This question has been saved and is waiting for the research process to begin.';
  if (item.status === 'researching') return 'Sources are being located and reviewed. Keep this page open—it updates automatically.';
  if (item.status === 'inconclusive') return 'The available direct sources address this topic only briefly or indirectly.';
  if (item.status === 'failed') return 'The research process did not complete successfully and will need to be retried.';
  return '';
}

function researchLoader(item) {
  const queued = item.status === 'queued';
  return `<div class="research-loader" aria-live="polite">
    <div class="research-orbit" aria-hidden="true"><span></span><i></i></div>
    <div class="research-progress">
      <div class="research-progress-head"><strong>${queued ? 'Joining the research queue' : 'Research in progress'}</strong><span class="live-dot">Live</span></div>
      <p>${escapeHtml(statusCopy(item))}</p>
      <div class="research-stages" aria-label="Research stages">
        <span class="active">Searching source archives</span>
        <span>Reading relevant texts</span>
        <span>Checking citations</span>
        <span>Preparing the answer</span>
      </div>
      <small>No refresh needed. This page checks for the completed answer every five seconds.</small>
    </div>
  </div>`;
}

function startResearchExperience(item) {
  clearInterval(detailPollTimer);
  clearInterval(researchStageTimer);
  if (!['queued', 'researching'].includes(item.status)) return;

  let stage = 0;
  researchStageTimer = setInterval(() => {
    const stages = [...detail.querySelectorAll('.research-stages span')];
    if (!stages.length) return;
    if (stage >= stages.length - 1) {
      clearInterval(researchStageTimer);
      return;
    }
    stages[stage].classList.remove('active');
    stages[stage].classList.add('complete');
    stage += 1;
    stages[stage].classList.add('active');
  }, 6500);

  detailPollTimer = setInterval(async () => {
    try {
      const data = await api(`?slug=${encodeURIComponent(item.slug)}&limit=1`);
      const fresh = data[0];
      if (!fresh) return;
      const index = state.questions.findIndex(question => question.slug === fresh.slug);
      if (index >= 0) state.questions[index] = fresh;
      if (fresh.status !== item.status || fresh.updated_at !== item.updated_at) {
        renderFeed();
        renderDetail(fresh, false);
      }
    } catch (error) {
      console.warn('Background answer check failed', error);
    }
  }, 5000);
}

function renderDetail(item, shouldScroll = true) {
  const sources = (item.sources || []).sort((a,b) => a.ordinal - b.ordinal);
  const answerText = item.answer_markdown || item.short_answer || '';
  const { orderedSources, displayByOrdinal } = citationDisplay(answerText, sources);
  const answerSections = splitAnswerSections(answerText);
  const sourceMaterial = sourcesMarkup(orderedSources, displayByOrdinal);
  document.body.classList.add('modal-open');
  detail.hidden = false;
  detail.setAttribute('role','dialog');
  detail.setAttribute('aria-modal','true');
  detail.setAttribute('aria-label',questionText(item.question));
  detail.dataset.slug = item.slug;
  detail.innerHTML = `<div class="detail-backdrop" data-close-answer aria-hidden="true"></div><div class="detail-inner${item.image_url ? ' has-hero-image' : ''}" tabindex="-1">
    <nav class="answer-nav" aria-label="Answer page navigation">
      ${adminDeleteButton(item,'detail')}
      <button class="answer-close" type="button" data-close-answer aria-label="Close this answer and return to the public index">×</button>
    </nav>
    ${item.image_url ? `<figure class="answer-hero-image"><img src="${escapeHtml(item.image_url)}" alt="Editorial image for ${escapeHtml(topicText(item.question))}"><figcaption class="answer-hero-title">${escapeHtml(questionText(item.question))}</figcaption></figure>` : ''}
    <div class="modal-layout"><main class="modal-answer-main">
    <div class="answer-meta-row"><p class="eyebrow">${label(item.status)} · asked ${formatDate(item.created_at)}</p><div class="answer-reaction"><span>Was this question worth asking?</span>${heartButton(item, true)}</div></div>
    ${item.image_url ? '' : `<h2>${escapeHtml(questionText(item.question))}</h2>`}
    ${item.status === 'published'
      ? `<div class="answer-tabs" role="tablist" aria-label="Answer sections">
          <button type="button" role="tab" aria-selected="true" data-answer-tab="synthesis">Overview</button>
          <button type="button" role="tab" aria-selected="false" data-answer-tab="sources">Source-by-source</button>
        </div>
        <section class="answer-tab-panel" role="tabpanel" data-answer-panel="synthesis">
          <div class="answer-copy">${renderMarkdown(answerSections.synthesis || answerText, sources, displayByOrdinal)}</div>
        </section>
        <section class="answer-tab-panel source-outline" role="tabpanel" data-answer-panel="sources" hidden>
          ${answerSections.sourceBySource ? renderSourceReader(answerSections.sourceBySource, orderedSources, displayByOrdinal, sourceMaterial) : `<p class="source-tab-intro">This earlier answer predates the source-by-source format. Its verified source trail is organized below.</p>${sourceMaterial}`}
        </section>`
      : ['queued', 'researching'].includes(item.status)
        ? researchLoader(item)
        : `<div class="status-panel"><strong>${label(item.status)}</strong><p>${escapeHtml(statusCopy(item))}</p></div>`}
    </main><aside class="modal-topic-rail" aria-label="Answer sharing and topics">
      ${sharePanel(item)}
      <div class="topic-rail-block"><p>Topics in this answer</p>
        <div>${keywordsFor(item).map(keyword => `<button type="button" data-keyword="${escapeHtml(keyword)}">${escapeHtml(displayKeyword(keyword))}</button>`).join('')}</div>
      </div>
    </aside></div>
  </div>`;
  requestAnimationFrame(() => activateInteractions(detail));
  if (shouldScroll) detail.querySelector('.detail-inner')?.scrollTo({ top:0, behavior:'auto' });
  requestAnimationFrame(() => detail.querySelector('.detail-inner')?.focus({ preventScroll:true }));
  updatePageMeta(item);
  startResearchExperience(item);
}

async function openQuestion(slug, updateHistory = true) {
  if (updateHistory) history.pushState({ answer:slug },'',`/answer/${encodeURIComponent(slug)}`);
  let item = state.questions.find(question => question.slug === slug);
  if (!item) {
    const data = await api(`?slug=${encodeURIComponent(slug)}&limit=1`);
    item = data[0];
  }
  if (!item) return;
  renderDetail(item);
}

function closeQuestion(updateHistory = true) {
  clearInterval(detailPollTimer);
  clearInterval(researchStageTimer);
  detail.hidden = true;
  detail.innerHTML = '';
  delete detail.dataset.slug;
  document.body.classList.remove('modal-open');
  resetPageMeta();
  if (updateHistory) {
    if (history.state?.answer) history.back();
    else history.replaceState({},'',`/${state.activeKeyword ? `?keyword=${encodeURIComponent(state.activeKeyword)}` : ''}`);
  }
  modalReturnFocus?.focus?.({ preventScroll:true });
  modalReturnFocus = null;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const matches = matchingQuestions(input.value);
  if (state.suggestionIndex >= 0 && matches[state.suggestionIndex]) {
    location.assign(`/answer/${encodeURIComponent(matches[state.suggestionIndex].slug)}`);
    return;
  }
  const question = input.value.trim();
  const button = form.querySelector('button[type="submit"]');
  if (!ensureSignedIn(question, formStatus, button)) return;
  await submitQuestion(question, formStatus, button);
});

input.addEventListener('input', () => {
  charCount.textContent = String(input.value.length);
  state.suggestionIndex = -1;
  renderSuggestions();
});
input.addEventListener('keydown', event => {
  const matches = matchingQuestions(input.value);
  if (!matches.length) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    state.suggestionIndex = (state.suggestionIndex + 1) % matches.length;
    renderSuggestions();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    state.suggestionIndex = state.suggestionIndex <= 0 ? matches.length - 1 : state.suggestionIndex - 1;
    renderSuggestions();
  } else if (event.key === 'Escape') {
    closeSuggestions();
  }
});
input.addEventListener('focus', renderSuggestions);
suggestions?.addEventListener('click', event => {
  const option = event.target.closest('[data-suggestion-slug]');
  if (option) location.assign(`/answer/${encodeURIComponent(option.dataset.suggestionSlug)}`);
});
suggestions?.addEventListener('wheel', event => {
  const atTop = suggestions.scrollTop <= 0 && event.deltaY < 0;
  const atBottom = suggestions.scrollTop + suggestions.clientHeight >= suggestions.scrollHeight - 1 && event.deltaY > 0;
  event.stopPropagation();
  if (atTop || atBottom) event.preventDefault();
}, { passive:false });
document.querySelector('.prompt-row')?.addEventListener('click', event => {
  const prompt = event.target.closest('[data-prompt]');
  if (!prompt) return;
  input.value = prompt.dataset.prompt;
  charCount.textContent = String(input.value.length);
  input.focus();
  renderSuggestions();
});
document.querySelector('#refresh-feed').addEventListener('click', () => loadFeed());
document.querySelector('.feed-views')?.addEventListener('click', event => {
  const control = event.target.closest('[data-feed-view]');
  if (!control) return;
  state.feedView = control.dataset.feedView;
  document.querySelectorAll('[data-feed-view]').forEach(button => {
    const active = button === control;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  renderFeed();
});
feedList.addEventListener('click', event => {
  const del = event.target.closest('[data-admin-delete]');
  if (del) { event.preventDefault(); deleteQuestion(del.dataset.adminDelete, del.dataset.adminSlug); return; }
  const keyword = event.target.closest('[data-keyword]');
  if (keyword) {
    state.activeKeyword = keyword.dataset.keyword || '';
    renderFeed();
    document.getElementById('feed')?.scrollIntoView({ behavior:'smooth', block:'start' });
    return;
  }
  const card = event.target.closest('[data-slug]');
  if (card && !event.target.closest('a,button')) openQuestion(card.dataset.slug);
});
keywordFilterList?.addEventListener('click', event => {
  const keyword = event.target.closest('[data-keyword]');
  if (!keyword) return;
  state.activeKeyword = keyword.dataset.keyword || '';
  const url = new URL(location.href);
  if (state.activeKeyword) url.searchParams.set('keyword',state.activeKeyword); else url.searchParams.delete('keyword');
  history.replaceState({},'',url);
  renderFeed();
});

/* Auth control wiring */
authSlot?.addEventListener('click', event => {
  if (event.target.closest('[data-auth-open]')) { openAuthModal(); return; }
  if (event.target.closest('[data-auth-signout]')) { signOut(); return; }
});
authModal?.addEventListener('click', event => {
  if (event.target.closest('[data-auth-close]')) { closeAuthModal(); return; }
  if (event.target.closest('[data-auth-google]')) { signInWithGoogle(); return; }
});
authModal?.querySelector('[data-auth-email]')?.addEventListener('submit', event => {
  event.preventDefault();
  const email = event.target.elements.email.value.trim();
  if (email) signInWithEmail(email);
});

document.addEventListener('click', async event => {
  if (!event.target.closest('.ask-form')) closeSuggestions();
  const sourceBrief = event.target.closest('[data-source-brief]');
  if (sourceBrief) {
    const reader = sourceBrief.closest('.source-reader');
    const target = sourceBrief.dataset.sourceBrief;
    reader?.querySelectorAll('[data-source-brief]').forEach(button => button.setAttribute('aria-selected', button === sourceBrief ? 'true' : 'false'));
    reader?.querySelectorAll('[data-source-brief-panel]').forEach(panel => { panel.hidden = panel.dataset.sourceBriefPanel !== target; });
    reader?.querySelector('.source-reader-detail')?.scrollTo({ top:0, behavior:'smooth' });
    return;
  }
  const answerTab = event.target.closest('[data-answer-tab]');
  if (answerTab) {
    const target = answerTab.dataset.answerTab;
    const tabRoot = answerTab.closest('.modal-answer-main');
    tabRoot?.querySelectorAll('[data-answer-tab]').forEach(button => button.setAttribute('aria-selected', button === answerTab ? 'true' : 'false'));
    tabRoot?.querySelectorAll('[data-answer-panel]').forEach(panel => { panel.hidden = panel.dataset.answerPanel !== target; });
    return;
  }
  const citationLink = event.target.closest('.source-note>a');
  if (citationLink && matchMedia('(hover: none)').matches) {
    if (!citationLink.classList.contains('touch-preview')) {
      event.preventDefault();
      document.querySelectorAll('.source-note>a.touch-preview').forEach(link => link.classList.remove('touch-preview'));
      positionCitationTooltip(citationLink);
      citationLink.classList.add('touch-preview');
      return;
    }
    citationLink.classList.remove('touch-preview');
  } else if (!citationLink) {
    document.querySelectorAll('.source-note>a.touch-preview').forEach(link => link.classList.remove('touch-preview'));
  }
  const adminDel = event.target.closest('[data-admin-delete]');
  if (adminDel) { event.preventDefault(); deleteQuestion(adminDel.dataset.adminDelete, adminDel.dataset.adminSlug); return; }
  const modalKeyword = event.target.closest('.modal-topic-rail [data-keyword]');
  if (modalKeyword) {
    state.activeKeyword = modalKeyword.dataset.keyword || '';
    state.query = '';
    input.value = '';
    charCount.textContent = '0';
    closeQuestion(false);
    history.pushState({},'',`/?keyword=${encodeURIComponent(state.activeKeyword)}`);
    renderFeed();
    document.getElementById('feed')?.scrollIntoView({ behavior:'smooth', block:'start' });
    return;
  }
  const closeAnswer = event.target.closest('[data-close-answer]');
  if (closeAnswer) {
    event.preventDefault();
    closeQuestion(true);
    return;
  }
  const answerLink = event.target.closest('a[href^="/answer/"]');
  if (answerLink) {
    event.preventDefault();
    modalReturnFocus = answerLink;
    openQuestion(decodeURIComponent(answerLink.getAttribute('href').replace(/^\/answer\//,'').split(/[?#]/)[0]));
    return;
  }
  const heart = event.target.closest('[data-heart-question]');
  if (heart) {
    event.preventDefault();
    await toggleHeart(heart.dataset.heartQuestion);
    return;
  }
  const button = event.target.closest('[data-scroll-target]');
  if (button) document.getElementById(button.dataset.scrollTarget)?.scrollIntoView({ behavior:'smooth', block:'start' });
  const nativeShare = event.target.closest('[data-native-share]');
  if (nativeShare) {
    const status = nativeShare.closest('.share-panel')?.querySelector('.share-status');
    if (navigator.share) navigator.share({ title:nativeShare.dataset.title, url:nativeShare.dataset.url }).catch(() => {});
    else navigator.clipboard.writeText(nativeShare.dataset.url).then(() => { if (status) status.textContent = 'Link copied.'; });
  }
  const copyLink = event.target.closest('[data-copy-link]');
  if (copyLink) {
    const status = copyLink.closest('.share-panel')?.querySelector('.share-status');
    navigator.clipboard.writeText(copyLink.dataset.url).then(() => {
      if (status) status.textContent = 'Link copied.';
      copyLink.classList.add('copied');
      copyLink.setAttribute('title','Link copied');
      setTimeout(() => { copyLink.classList.remove('copied'); copyLink.setAttribute('title','Copy link'); }, 1800);
    });
  }
});
document.addEventListener('pointermove', event => {
  document.documentElement.style.setProperty('--pointer-x', `${event.clientX}px`);
  document.documentElement.style.setProperty('--pointer-y', `${event.clientY}px`);
  const surface = event.target.closest('.teaser-card,.method-grid article,.question-card,.source-entry');
  if (!surface) return;
  const bounds = surface.getBoundingClientRect();
  surface.style.setProperty('--spot-x', `${event.clientX - bounds.left}px`);
  surface.style.setProperty('--spot-y', `${event.clientY - bounds.top}px`);
});
document.addEventListener('pointerover', event => {
  const citation = event.target.closest('.source-note>a');
  if (citation) positionCitationTooltip(citation);
});
document.addEventListener('focusin', event => {
  const citation = event.target.closest('.source-note>a');
  if (citation) positionCitationTooltip(citation);
});
function updateSearchDock() {
  const header = document.querySelector('.site-header');
  if (!header || !form) return;
  if (!searchPlaceholder) {
    searchPlaceholder = document.createElement('div');
    searchPlaceholder.className = 'search-placeholder';
    searchPlaceholder.setAttribute('aria-hidden','true');
    form.before(searchPlaceholder);
  }
  const shouldDock = searchPlaceholder.getBoundingClientRect().top <= header.getBoundingClientRect().bottom + 8;
  if (shouldDock === searchDocked) return;
  searchDocked = shouldDock;
  if (shouldDock) {
    searchPlaceholder.style.height = `${form.offsetHeight}px`;
    header.insertBefore(form, header.querySelector('.header-actions'));
    form.classList.add('is-docked');
  } else {
    searchPlaceholder.after(form);
    form.classList.remove('is-docked');
    searchPlaceholder.style.height = '0px';
  }
  header.classList.toggle('has-docked-search',shouldDock);
}
window.addEventListener('scroll', () => {
  document.querySelector('.site-header')?.classList.toggle('is-scrolled', scrollY > 18);
  updateSearchDock();
}, { passive:true });
window.addEventListener('resize', updateSearchDock, { passive:true });
document.addEventListener('submit', async event => {
  const articleForm = event.target.closest('.article-question-form');
  if (!articleForm) return;
  event.preventDefault();
  const question = articleForm.elements.question.value.trim();
  const button = articleForm.querySelector('button[type="submit"]');
  const status = articleForm.querySelector('.article-form-status');
  if (!ensureSignedIn(question, status, button)) return;
  await submitQuestion(question, status, button);
});
window.addEventListener('popstate', () => {
  const slug = location.pathname.match(/^\/answer\/([^/]+)/)?.[1];
  if (slug) openQuestion(decodeURIComponent(slug), false);
  else closeQuestion(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !authModal.hidden) { closeAuthModal(); return; }
  if (event.key === 'Escape' && !detail.hidden) closeQuestion(true);
});

supabase.auth.getSession().then(({ data }) => handleAuthChange(data.session));
supabase.auth.onAuthStateChange((_event, session) => handleAuthChange(session));

loadFeed();
activateInteractions(document);
requestAnimationFrame(updateSearchDock);
setInterval(() => loadFeed({ quiet:true }), 15000);
