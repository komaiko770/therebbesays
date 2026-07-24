import type { Config, Context } from "@netlify/functions";

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL") || process.env.SUPABASE_URL || "https://euixoavdzwaactdbxnpk.supabase.co";
const SUPABASE_KEY = Netlify.env.get("SUPABASE_PUBLISHABLE_KEY") || process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_viKz06_JdVM5ToTUCgCAbw_l96GI4Bu";

const escapeHtml = (value = "") => value.replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]!));

const stripMarkdown = (value = "") => value
  .replace(/```[\s\S]*?```/g, " ")
  .replace(/^#{1,6}\s+/gm, "")
  .replace(/\*\*([^*]+)\*\*/g, "$1")
  .replace(/\*([^*]+)\*/g, "$1")
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/[>_`~]/g, "")
  .replace(/\s+/g, " ")
  .trim();

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
  const title = `${question} — What does the Rebbe say?`;
  const rawDescription = String(row.short_answer || "").trim() || stripMarkdown(String(row.answer_markdown || "")).slice(0, 220);
  const description = rawDescription.length > 300 ? `${rawDescription.slice(0, 297)}…` : rawDescription;
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
      name: question,
      text: question,
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
