// ─────────────────────────────────────────────────────────────
// LetsFly — AI proxy (Supabase Edge Function)
//
// Why this exists: NVIDIA's API does not send CORS headers, so a browser cannot
// call it directly. This function is the only thing that ever sees the NVIDIA key.
//
// Deploy:
//   supabase functions deploy ai
//   supabase secrets set NVIDIA_API_KEY=nvapi-xxxxxxxx
//
// Optional secrets:
//   NVIDIA_MODEL     default "meta/llama-3.3-70b-instruct"
//   AI_DAILY_LIMIT   default 40 requests per user per day
//   ALLOWED_ORIGIN   default "*" — set to your site to lock it down,
//                    e.g. https://israelletsfly.github.io
// ─────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const MODEL = Deno.env.get("NVIDIA_MODEL") ?? "meta/llama-3.3-70b-instruct";
const DAILY_LIMIT = Number(Deno.env.get("AI_DAILY_LIMIT") ?? "40");
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  // Browsers preflight any request carrying an Authorization header.
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const nvidiaKey = Deno.env.get("NVIDIA_API_KEY");
  if (!nvidiaKey) {
    return json({ error: "Server is missing NVIDIA_API_KEY. Run: supabase secrets set NVIDIA_API_KEY=nvapi-..." }, 500);
  }

  // ── 1. Require a real signed-in LetsFly user ──────────────
  // Without this, anyone who finds the function URL could burn the whole quota.
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Not signed in" }, 401);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return json({ error: "Not signed in" }, 401);

  // ── 2. Per-user daily cap ─────────────────────────────────
  // Requires the ai_usage table (see setup.sql). If the table is missing we fail
  // open rather than bricking the feature, but the cap is strongly recommended.
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await admin
      .from("ai_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gte("created_at", since);

    if (typeof count === "number" && count >= DAILY_LIMIT) {
      return json(
        { error: `Daily AI limit reached (${DAILY_LIMIT}). Try again tomorrow.` },
        429,
      );
    }
  } catch (_) {
    // table not created yet — continue without the cap
  }

  // ── 3. Forward to NVIDIA ──────────────────────────────────
  let prompt = "";
  try {
    const body = await req.json();
    prompt = String(body?.prompt ?? "").slice(0, 24000);
  } catch (_) {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!prompt.trim()) return json({ error: "Empty prompt" }, 400);

  let upstream: Response;
  try {
    upstream = await fetch(NVIDIA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${nvidiaKey}`,
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a precise data-extraction assistant. You always reply with a single valid JSON object and nothing else — no prose, no markdown fences.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        top_p: 0.7,
        max_tokens: 2048,
        stream: false,
      }),
    });
  } catch (e) {
    return json({ error: `Could not reach NVIDIA: ${String(e)}` }, 502);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    return json(
      { error: `NVIDIA returned ${upstream.status}`, detail: detail.slice(0, 500) },
      upstream.status === 401 ? 500 : 502, // a bad key is a server problem, not the user's
    );
  }

  const data = await upstream.json().catch(() => null);
  const text = data?.choices?.[0]?.message?.content ?? "";
  if (!text) return json({ error: "Empty response from NVIDIA" }, 502);

  // ── 4. Record usage (best-effort) ─────────────────────────
  admin.from("ai_usage").insert({ user_id: user.id }).then(
    () => {},
    () => {},
  );

  return json({ text, model: MODEL });
});
