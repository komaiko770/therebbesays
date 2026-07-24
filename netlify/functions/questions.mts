import type { Config, Context } from "@netlify/functions";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

// Feature flag: when false, new-research submission is open (no sign-in required).
// Flip to true once Supabase Auth is configured to enforce the sign-in gate.
const AUTH_GATE_ENABLED = false;

function getConfig() {
  const url = Netlify.env.get("SUPABASE_URL") || process.env.SUPABASE_URL || "https://euixoavdzwaactdbxnpk.supabase.co";
  const key = Netlify.env.get("SUPABASE_PUBLISHABLE_KEY") || process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_viKz06_JdVM5ToTUCgCAbw_l96GI4Bu";
  const edgeJwt = Netlify.env.get("SUPABASE_ANON_JWT") || process.env.SUPABASE_ANON_JWT || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV1aXhvYXZkendhYWN0ZGJ4bnBrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwNTUwOTksImV4cCI6MjA5OTYzMTA5OX0.GT1eb-6Az9GnHATdGFE8ooluCwiaEdVYjsRCx1gBp24";
  if (!url || !key) throw new Error("The database connection is not configured.");
  return { url, key, edgeJwt };
}

function headers(key: string, prefer?: string) {
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    ...(prefer ? { prefer } : {}),
  };
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

// Verify the caller holds a valid Supabase user session. Returns the user id, or null.
async function verifyUser(url: string, apiKey: string, req: Request) {
  const authz = req.headers.get("authorization") || "";
  const token = authz.replace(/^Bearer\s+/i, "").trim();
  if (!token || token === apiKey) return null;
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: apiKey, authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const user = await response.json().catch(() => null);
  return user?.id ? { id: user.id, email: user.email || null } : null;
}

async function triggerResearch(url: string, edgeJwt: string, questionId: string) {
  const response = await fetch(`${url}/functions/v1/research-question`, {
    method: "POST",
    headers: {
      apikey: edgeJwt,
      authorization: `Bearer ${edgeJwt}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ question_id: questionId }),
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

export default async (req: Request, _context: Context) => {
  try {
    const { url, key, edgeJwt } = getConfig();

    if (req.method === "GET") {
      const requestUrl = new URL(req.url);
      const slug = requestUrl.searchParams.get("slug");
      const visitorId = req.headers.get("x-visitor-id") || "";
      const limit = Math.min(Math.max(Number(requestUrl.searchParams.get("limit")) || 40, 1), 100);
      const params = new URLSearchParams({
        select: "id,slug,question,status,answer_markdown,short_answer,keywords,confidence,source_count,image_url,image_status,image_generated_at,created_at,updated_at,completed_at,sources(id,ordinal,title,url,publisher,host_publisher,original_source_title,original_source_detail,citation_label,supporting_excerpt,source_type,verified_at)",
        order: "created_at.desc",
        limit: String(limit),
      });
      if (slug) params.set("slug", `eq.${slug}`);

      const response = await fetch(`${url}/rest/v1/questions?${params}`, { headers: headers(key) });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data) || !data.length) return json(data, response.status);

      const ids = data.map((item: { id: string }) => item.id);
      const idFilter = `in.(${ids.join(",")})`;
      const countsResponse = await fetch(`${url}/rest/v1/question_heart_counts?select=question_id,heart_count&question_id=${encodeURIComponent(idFilter)}`, { headers: headers(key) });
      const countRows = countsResponse.ok ? await countsResponse.json() : [];
      const countMap = new Map((Array.isArray(countRows) ? countRows : []).map((row: { question_id: string; heart_count: number }) => [row.question_id, Number(row.heart_count) || 0]));

      let heartedIds = new Set<string>();
      if (/^[A-Za-z0-9_-]{16,80}$/.test(visitorId)) {
        const heartedResponse = await fetch(`${url}/rest/v1/rpc/get_question_hearts`, {
          method: "POST",
          headers: headers(key),
          body: JSON.stringify({ p_visitor_id: visitorId, p_question_ids: ids }),
        });
        const heartedRows = heartedResponse.ok ? await heartedResponse.json() : [];
        heartedIds = new Set((Array.isArray(heartedRows) ? heartedRows : []).map((row: { question_id: string }) => row.question_id));
      }

      return json(data.map((item: { id: string }) => ({ ...item, heart_count: countMap.get(item.id) || 0, hearted: heartedIds.has(item.id) })), response.status);
    }

    if (req.method === "POST") {
      const payload = await req.json().catch(() => null) as { question?: unknown; action?: unknown; question_id?: unknown; visitor_id?: unknown; hearted?: unknown } | null;
      if (payload?.action === "heart") {
        const questionId = typeof payload.question_id === "string" ? payload.question_id : "";
        const visitorId = typeof payload.visitor_id === "string" ? payload.visitor_id : "";
        const hearted = payload.hearted === true;
        if (!/^[0-9a-f-]{36}$/i.test(questionId) || !/^[A-Za-z0-9_-]{16,80}$/.test(visitorId)) {
          return json({ error: "A valid question and visitor are required." }, 400);
        }
        const reactionResponse = await fetch(`${url}/rest/v1/rpc/toggle_question_heart`, {
          method: "POST",
          headers: headers(key),
          body: JSON.stringify({ p_question_id: questionId, p_visitor_id: visitorId, p_hearted: hearted }),
        });
        const reactionRows = await reactionResponse.json().catch(() => []);
        if (!reactionResponse.ok) return json({ error: reactionRows?.message || "The heart could not be saved." }, reactionResponse.status);
        return json(Array.isArray(reactionRows) ? reactionRows[0] : reactionRows);
      }

      // Creating a new research question requires a signed-in user when the gate is enabled.
      if (AUTH_GATE_ENABLED) {
        const user = await verifyUser(url, edgeJwt, req);
        if (!user) return json({ error: "Please sign in to start new research." }, 401);
      }

      const question = typeof payload?.question === "string" ? payload.question.trim().replace(/\s+/g, " ") : "";
      if (question.length < 2 || question.length > 500) {
        return json({ error: "Please enter a topic or question between 2 and 500 characters." }, 400);
      }

      const normalized = normalize(question);
      const lookup = new URLSearchParams({
        select: "id,slug,question,status,created_at",
        normalized_question: `eq.${normalized}`,
        limit: "1",
      });
      const existingResponse = await fetch(`${url}/rest/v1/questions?${lookup}`, { headers: headers(key) });
      const existing = await existingResponse.json();
      if (Array.isArray(existing) && existing.length) {
        const research = ["queued", "failed"].includes(existing[0].status)
          ? await triggerResearch(url, edgeJwt, existing[0].id)
          : null;
        return json({ question: existing[0], existing: true, research });
      }

      const response = await fetch(`${url}/rest/v1/questions?select=id,slug,question,status,created_at`, {
        method: "POST",
        headers: headers(key, "return=representation"),
        body: JSON.stringify({ question }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409) return json({ error: "That question is already in the research queue." }, 409);
        return json({ error: data?.message || "The question could not be submitted." }, response.status);
      }
      const research = await triggerResearch(url, edgeJwt, data[0].id);
      return json({ question: data[0], existing: false, research }, 201);
    }

    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Unexpected server error." }, 500);
  }
};

export const config: Config = { path: "/api/questions" };
