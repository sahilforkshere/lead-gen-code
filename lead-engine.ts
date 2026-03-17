import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// ─── ENV ──────────────────────────────────────────────────────────────────────
const supabaseUrl            = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY         = Deno.env.get("OPENAI_API_KEY")!;
const PARALLEL_API_KEY       = Deno.env.get("PARALLEL_API_KEY")!;
const TAVILY_API_KEY         = Deno.env.get("TAVILY_API_KEY")!;

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const BLOCKED_DOMAINS = [
  // ── Social media (profiles, not business pages) ──
  "facebook.", "instagram.", "twitter.", "linkedin.", "pinterest.",
  "youtube.com", "youtu.be", "tiktok.com", "snapchat.com",
  "reddit.com", "quora.com", "tumblr.com",

  // ── App stores ──
  "apps.apple.com", "play.google.com",

  // ── Pure encyclopedias ──
  "wikipedia.org", "wikimedia.", "britannica.com",
];
const FINAL_OUTPUT_SIZE  = 100;  // save the best 100 leads (or all if fewer found)
const EXTRACT_BATCH_SIZE = 10;   // concurrent extractions per batch

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Safely parse a hostname from a URL string. Returns null on failure. */
function safeHostname(raw: string): string | null {
  try {
    return new URL(raw).hostname.replace("www.", "");
  } catch {
    return null;
  }
}

/** Call GPT-4o-mini and parse a JSON response. */
async function gptJson<T>(
  messages: { role: string; content: string }[],
  label: string,
): Promise<T | null> {
  try {
    const res  = await fetch("https://api.openai.com/v1/chat/completions", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model:           "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages,
      }),
    });
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content) as T;
  } catch (e) {
    console.error(`⚠️  gptJson [${label}] failed:`, (e as Error).message);
    return null;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
serve(async (req) => {
  console.log("══════════════════════════════════════════════════════════");
  console.log("🚀 [INVOCATION] Lead-Alert Search Engine Started");

  try {
    const payload = await req.json();
    const record  = payload.record;
    if (!record) throw new Error("No record in payload.");

    const { id: preference_id, user_id, search_query } = record;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    await supabase
      .from("lead_preferences")
      .update({ status: "processing" })
      .eq("id", preference_id);

    // ══════════════════════════════════════════════════════════
    // PHASE 1 — QUERY EXPANSION  (10–12 targeted sub-queries)
    // ══════════════════════════════════════════════════════════
    console.log("🧠 [PHASE 1] Expanding query with GPT-4o-mini…");

    const expandResult = await gptJson<{ queries: string[] }>(
      [{
        role:    "user",
        content: `You are a lead-generation expert. Given the search intent below, produce a JSON
object with key "queries" containing an array of 20 highly targeted search strings.

Rules for generating queries:
1. VARY GEOGRAPHY — use specific neighbourhoods, areas, cities, not just the main city name
2. VARY KEYWORDS — use synonyms: "restaurant", "eatery", "dining", "kitchen", "cuisine", "bistro", "cafe"
3. VARY INTENT — mix "contact", "website", "phone number", "address", "official site", "book table"
4. INCLUDE SPECIFIC NAMES — if you know famous establishments in this niche, include them directly
5. USE LOCAL LANGUAGE — include Hindi/regional transliterations where relevant
6. TARGET DIRECT WEBSITES — add "official website" or "direct contact" to some queries
7. DO NOT include aggregators like Zomato, Tripadvisor, Swiggy, Justdial in queries

Example for "Chinese restaurants Delhi":
- "Chinese restaurant Connaught Place Delhi website"
- "authentic Chinese food Hauz Khas phone number"
- "best Chinese dining South Delhi official site"
- "Chinese kitchen Lajpat Nagar contact details"
- "Szechuan restaurant Delhi NCR direct booking"
- "dim sum restaurant Gurgaon website"
- "Chinese bistro Noida contact"
... and so on with 20 total

Search intent: "${search_query}"`,
      }],
      "phase-1-expand",
    );

    const subQueries: string[] = (
      expandResult?.queries ??
      (expandResult as any)?.searchQueries ??
      (expandResult ? (Object.values(expandResult)[0] as string[]) : null) ??
      [search_query]
    ).slice(0, 20);

    console.log(`✨ [PHASE 1] ${subQueries.length} queries generated:`, subQueries);

    // ══════════════════════════════════════════════════════════
    // PHASE 2 — DISCOVERY  (Parallel Search → Tavily fallback)
    // ══════════════════════════════════════════════════════════
    console.log("🔍 [PHASE 2] Running bulk discovery…");

    let rawResults: { url: string; snippet: string }[] = [];

    // ── 2A: Parallel Search ──────────────────────────────────
    console.log("🔍 [PHASE 2A] Parallel Search — all 20 queries concurrently…");
    try {
      const parallelCalls = subQueries.map((q) =>
        fetch("https://api.parallel.ai/v1beta/search", {
          method:  "POST",
          headers: { "Content-Type": "application/json", "x-api-key": PARALLEL_API_KEY },
          body: JSON.stringify({
            objective:      q,
            search_queries: [q],
            mode:           "fast",
            max_results:    25,
            excerpts:       { max_chars_per_result: 4000 },
          }),
        }).then((r) => r.json()).catch(() => ({ results: [] }))
      );
      const parallelPages = await Promise.all(parallelCalls);
      for (const page of parallelPages) {
        for (const item of (page.results ?? [])) {
          const url = item.url ?? item.content_url;
          if (url) rawResults.push({ url, snippet: item.excerpts?.join(" ") ?? "" });
        }
      }
      console.log(`  Parallel → ${rawResults.length} raw hits`);
    } catch (e) {
      console.error("  Parallel failed entirely:", (e as Error).message);
    }

    // ── 2B: Tavily — ALWAYS runs, not just as fallback ───────
    // Two separate sources means more unique restaurant websites.
    // Tavily indexes different pages than Parallel — always worth running.
    console.log("🔍 [PHASE 2B] Tavily Search — always runs for maximum coverage…");
    try {
      const tavilyCalls = subQueries.map((q) =>
        fetch("https://api.tavily.com/search", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key:      TAVILY_API_KEY,
            query:        q,
            search_depth: "advanced",
            max_results:  20,
          }),
        }).then((r) => r.json()).catch(() => ({ results: [] }))
      );
      const tavilyPages = await Promise.all(tavilyCalls);
      for (const page of tavilyPages) {
        for (const item of (page.results ?? [])) {
          if (item.url) rawResults.push({ url: item.url, snippet: item.content ?? "" });
        }
      }
      console.log(`  After Tavily → ${rawResults.length} total raw hits`);
    } catch (e) {
      console.error("  Tavily failed entirely:", (e as Error).message);
    }

    console.log(`🌐 [PHASE 2 RESULT] ${rawResults.length} total raw results collected.`);

    // ══════════════════════════════════════════════════════════
    // PHASE 3 — FILTERING & DEDUPLICATION
    // ══════════════════════════════════════════════════════════
    console.log("🧹 [PHASE 3] Filtering and deduplicating…");

    const seenDomains = new Set<string>();
    const targets: { url: string; domain: string; snippet: string }[] = [];

    for (const item of rawResults) {
      const domain = safeHostname(item.url);
      if (!domain) continue;
      if (seenDomains.has(domain)) continue;
      if (BLOCKED_DOMAINS.some((b) => domain.includes(b))) continue;
      seenDomains.add(domain);
      targets.push({ url: item.url, domain, snippet: item.snippet });
      // No cap — collect every clean domain available
    }

    console.log(`🎯 [PHASE 3 RESULT] ${targets.length} unique clean domains queued — extracting all, then ranking top ${FINAL_OUTPUT_SIZE}.`);

    // ══════════════════════════════════════════════════════════
    // PHASE 4 — EXTRACTION  (batched to avoid overwhelming APIs)
    // ══════════════════════════════════════════════════════════
    console.log(`⛏️  [PHASE 4] Extracting ALL ${targets.length} targets in batches of ${EXTRACT_BATCH_SIZE}…`);

    const allLeads: { lead: object; score: number }[] = [];
    const seenCompanyNames = new Set<string>();

    for (let i = 0; i < targets.length; i += EXTRACT_BATCH_SIZE) {
      const batch   = targets.slice(i, i + EXTRACT_BATCH_SIZE);
      const batchNum = Math.floor(i / EXTRACT_BATCH_SIZE) + 1;
      console.log(`  Batch ${batchNum}/${Math.ceil(targets.length / EXTRACT_BATCH_SIZE)}: processing ${batch.length} domains…`);

      const batchResults = await Promise.all(
        batch.map(async (target) => {
          try {
            // ── 4A: Fetch page content ───────────────────────
            let content = target.snippet;

            if (content.length < 500) {
              const scrapeRes = await fetch("https://api.tavily.com/extract", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ api_key: TAVILY_API_KEY, urls: [target.url] }),
              }).catch(() => null);

              if (scrapeRes?.ok) {
                const scrapeData = await scrapeRes.json().catch(() => ({}));
                content = scrapeData.results?.[0]?.raw_content ?? content;
              }
            }

            if (content.length < 100) {
              console.warn(`    ⚠️  ${target.domain}: content too short, skipping.`);
              return [];
            }

            // ── 4B: GPT extraction — returns ALL businesses on the page ──
            const extracted = await gptJson<{
              businesses: {
                company_name: string;
                website:      string;
                email:        string;
                phone:        string;
                description:  string;
              }[];
            }>(
              [
                {
                  role:    "system",
                  content: `You are a lead extraction assistant for B2B sales.
From the website text provided, extract EVERY business mentioned on the page.

If the page is a directory, listing site, or search results page (like Justdial, Sulekha, Yelp, etc.)
that shows multiple businesses — extract ALL of them as separate entries.
If the page is a single business website — extract that one business.

SKIP a business only if it has no identifiable name.

Return ONLY valid JSON:
{ "businesses": [
  { "company_name": "", "website": "", "email": "", "phone": "", "description": "" }
] }
For "website": use the business's own URL if mentioned; otherwise leave empty.
Leave any missing field as an empty string. Never invent data.
If nothing found return { "businesses": [] }.`,
                },
                {
                  role:    "user",
                  content: content.substring(0, 12000),
                },
              ],
              `extract-${target.domain}`,
            );

            const businesses = extracted?.businesses ?? [];
            if (businesses.length === 0) return [];

            console.log(`    ✅ ${target.domain}: ${businesses.length} business(es) found`);

            const pageResults: { lead: object; score: number }[] = [];
            for (const biz of businesses) {
              if (!biz.company_name?.trim()) continue;

              const website = biz.website?.trim() ? biz.website.trim() : target.url;

              // For multi-listing pages, append a slug so each business gets its own DB row
              const slug = biz.company_name.toLowerCase()
                .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
              const domainKey = businesses.length > 1
                ? `${target.domain}#${slug}`
                : target.domain;

              const lead = {
                preference_id,
                search_query,
                domain:    domainKey,
                lead_data: { ...biz, website },
                status:    "verified",
              };

              const score =
                (biz.company_name?.trim() ? 10 : 0) +
                (biz.email?.trim()        ? 40 : 0) +
                (biz.phone?.trim()        ? 30 : 0) +
                (website                  ? 10 : 0) +
                (biz.description?.trim()  ?  5 : 0) +
                Math.min(biz.description?.length ?? 0, 5);

              pageResults.push({ lead, score });
            }
            return pageResults;
          } catch (err) {
            console.error(`    ⚠️  Error at ${target.domain}:`, (err as Error).message);
            return [];
          }
        }),
      );

      // Each target returns an array — flatten, then deduplicate by company name
      for (const item of (batchResults.flat() as { lead: object; score: number }[])) {
        const name = ((item.lead as any).lead_data?.company_name ?? "").toLowerCase().trim();
        if (name && !seenCompanyNames.has(name)) {
          seenCompanyNames.add(name);
          allLeads.push(item);
        }
      }
      console.log(`  Running total: ${allLeads.length} leads extracted so far.`);
    }

    // ── Rank by score descending, take top FINAL_OUTPUT_SIZE ──
    allLeads.sort((a, b) => b.score - a.score);
    const finalLeads = allLeads
      .slice(0, FINAL_OUTPUT_SIZE)
      .map((x) => x.lead);

    console.log(`✅ [PHASE 4 RESULT] Extracted ${allLeads.length} total leads.`);
    console.log(`   Top ${finalLeads.length} selected by quality score (email+phone completeness).`);

    // ══════════════════════════════════════════════════════════
    // PHASE 5 — SAVE TO DATABASE
    // ══════════════════════════════════════════════════════════
    if (finalLeads.length > 0) {
      console.log("💾 [PHASE 5] Saving leads…");

      // Upsert leads (conflict on unique domain column)
      const { data: inserted, error: leadsError } = await supabase
        .from("leads")
        .upsert(finalLeads, { onConflict: "domain" })
        .select("id");

      if (leadsError) {
        console.error("  Leads upsert error:", leadsError.message);
      }

      // Link leads to user via junction table
      if (inserted && inserted.length > 0) {
        const junction = inserted.map((l: { id: string }) => ({
          user_id,
          lead_id: l.id,
        }));

        const { error: junctionError } = await supabase
          .from("user_leads")
          .upsert(junction, { onConflict: "user_id,lead_id" }); // composite PK

        if (junctionError) {
          console.error("  user_leads upsert error:", junctionError.message);
        } else {
          console.log(`💾 [SUCCESS] ${inserted.length} leads saved and linked to user.`);
        }
      }
    } else {
      console.log("⚠️  No leads were extracted for this run.");
    }

    // Mark preference as completed
    await supabase
      .from("lead_preferences")
      .update({ status: "completed" })
      .eq("id", preference_id);

    console.log("🏁 [FINISHED] Pipeline complete.");
    console.log("══════════════════════════════════════════════════════════");

    return new Response(
      JSON.stringify({
        success:         true,
        total_extracted: allLeads.length,
        leads_saved:     finalLeads.length,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  } catch (error) {
    console.error("⛔ [CRITICAL]", (error as Error).message);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});