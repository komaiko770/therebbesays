import type { Config, Context } from "@netlify/functions";

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL") || process.env.SUPABASE_URL || "https://euixoavdzwaactdbxnpk.supabase.co";
const SUPABASE_KEY = Netlify.env.get("SUPABASE_PUBLISHABLE_KEY") || process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_viKz06_JdVM5ToTUCgCAbw_l96GI4Bu";

const escapeHtml = (value = "") => value.replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]!));

const stripMarkdown = (value = "") => value
  .replace(/```[\s\S]*?```/g, " ")
  // Drop heading LINES entirely (not just the # marks): "## Synthesis across the
  // sources" is pipeline scaffolding, not a share-card description (owner, 26 Jul).
  .replace(/(^|\n)#{1,6}[^\n]*/g, " ")
  .replace(/\[\^\d+\]/g, " ")
  .replace(/\*\*([^*]+)\*\*/g, "$1")
  .replace(/\*([^*]+)\*/g, "$1")
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/[>_`~]/g, "")
  .replace(/\s+/g, " ")
  .trim();

// Mirror the site's question styling (app.js questionText/titleCaseTopic) so the share
// card reads "What does the Rebbe say about Chabad on Campus?" instead of the raw
// lowercase question text (owner, 26 Jul).
const topicText = (value = "") => value
  .replace(/^what (?:did|does) (?:the )?rebbe say about\s+/i, "")
  .replace(/[?.!]+$/, "")
  .trim();
const titleCaseTopic = (value = "") => {
  const small = new Set(["a","an","the","and","but","or","for","nor","on","at","to","from","by","of","in","with","about","over"]);
  const words = String(value || "").trim().split(/\s+/);
  return words.map((word, index) => {
    if (/^[A-Z0-9]{2,}$/.test(word)) return word;
    const lower = word.toLowerCase();
    if ((index === 0 || index < words.length - 1) && small.has(lower)) return lower;
    return lower.replace(/(^|[-'\u2019])([a-z])/g, (_m, lead, char) => lead + char.toUpperCase());
  }).join(" ");
};
const questionTitle = (value = "") => {
  const topic = titleCaseTopic(topicText(value));
  return topic ? `What does the Rebbe say about ${topic}?` : String(value || "").trim();
};

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const slug = decodeURIComponent(url.pathname.replace(/^\/answer\//, "").replace(/\/+$/, ""));
  const origin = url.origin;

  // Always start from the SPA shell so the browser experience is unchanged.
  let html = "";
  try {
    const shell = await fetch(`${origin}/index.html`, { headers: { "x-answer-ssr": "1" } });
    html = await shell.text();
  } catch {
    return new Response("", { status: 302, headers: { location: "/" } });
  }

  let row: Record<string, any> | null = null;
  if (slug && /^[\w-]+$/.test(slug)) {
    try {
      const params = new URLSearchParams({
        select: "slug,question,short_answer,answer_markdown,image_url,status,keywords,created_at,updated_at,completed_at",
        slug: `eq.${slug}`,
        limit: "1",
      });
      const response = await fetch(`${SUPABASE_URL}/rest/v1/questions?${params}`, {
        headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` },
      });
      if (response.ok) row = (await response.json())[0] || null;
    } catch (error) {
      console.error("answer-page fetch failed", error);
    }
  }

  if (!row) {
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, s-maxage=300" } });
  }

  const question = String(row.question || "").trim();
  // Just the styled question — no "— The Rebbe / Index" suffix (owner request, 26 Jul).
  const title = questionTitle(question);
  // short_answer may be a raw markdown slice from older worker builds — strip BOTH
  // candidates, never trust either to be plain text.
  const rawDescription = stripMarkdown(String(row.short_answer || "")) || stripMarkdown(String(row.answer_markdown || "")).slice(0, 220);
  const description = rawDescription.length > 300 ? `${rawDescription.slice(0, 297)}\u2026` : rawDescription;
  const pageUrl = `${origin}/answer/${encodeURIComponent(row.slug)}`;
  const image = String(row.image_url || `${origin}/images/rebbe-portrait-close.png`);

  const replaceTag = (source: string, pattern: RegExp, replacement: string) =>
    pattern.test(source) ? source.replace(pattern, replacement) : source.replace("</head>", `${replacement}\n</head>`);

  html = replaceTag(html, /<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`);
  html = replaceTag(html, /<meta name="description" content="[^"]*">/, `<meta name="description" content="${escapeHtml(description)}">`);
  html = replaceTag(html, /<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${escapeHtml(title)}">`);
  html = replaceTag(html, /<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${escapeHtml(description)}">`);
  html = replaceTag(html, /<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${escapeHtml(pageUrl)}">`);
  html = replaceTag(html, /<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="${escapeHtml(image)}">`);
  html = replaceTag(html, /<meta property="og:type" content="[^"]*">/, `<meta property="og:type" content="article">`);
  html = replaceTag(html, /<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${escapeHtml(title)}">`);
  html = replaceTag(html, /<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${escapeHtml(description)}">`);
  html = replaceTag(html, /<meta name="twitter:image" content="[^"]*">/, `<meta name="twitter:image" content="${escapeHtml(image)}">`);
  html = replaceTag(html, /<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${escapeHtml(pageUrl)}">`);

  const articleBody = stripMarkdown(String(row.answer_markdown || "")).slice(0, 5000);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "QAPage",
    mainEntity: {
      "@type": "Question",
      name: questionTitle(question),
      text: questionTitle(question),
      dateCreated: row.created_at || undefined,
      acceptedAnswer: {
        "@type": "Answer",
        text: articleBody || description,
        dateCreated: row.completed_at || row.updated_at || undefined,
        url: pageUrl,
      },
    },
  };
  html = html.replace("</head>", `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>\n</head>`);

  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, s-maxage=600" },
  });
};

export const config: Config = { path: "/answer/*" };
