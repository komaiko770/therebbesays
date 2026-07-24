import type { Config, Context } from "@netlify/functions";

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL") || process.env.SUPABASE_URL || "https://euixoavdzwaactdbxnpk.supabase.co";
const SUPABASE_KEY = Netlify.env.get("SUPABASE_PUBLISHABLE_KEY") || process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_viKz06_JdVM5ToTUCgCAbw_l96GI4Bu";

const escapeXml = (value = "") => value.replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&apos;" }[c]!));

export default async (req: Request, _context: Context) => {
  const origin = new URL(req.url).origin;
  let rows: Array<{ slug: string; updated_at?: string; completed_at?: string; created_at?: string }> = [];
  try {
    const params = new URLSearchParams({
      select: "slug,updated_at,completed_at,created_at",
      status: "eq.published",
      order: "updated_at.desc",
      limit: "5000",
    });
    const response = await fetch(`${SUPABASE_URL}/rest/v1/questions?${params}`, {
      headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (response.ok) rows = await response.json();
  } catch (error) {
    console.error("sitemap fetch failed", error);
  }

  const urls = [
    `<url><loc>${origin}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    ...rows.map(row => {
      const lastmod = (row.updated_at || row.completed_at || row.created_at || "").slice(0, 10);
      return `<url><loc>${origin}/answer/${encodeURIComponent(row.slug)}</loc>${lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : ""}<changefreq>weekly</changefreq><priority>0.8</priority></url>`;
    }),
  ].join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
  return new Response(xml, {
    status: 200,
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=0, s-maxage=3600" },
  });
};

export const config: Config = { path: "/sitemap.xml" };
