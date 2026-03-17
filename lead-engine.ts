import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// ─── ENV ──────────────────────────────────────────────────────────────────────
const supabaseUrl        = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY     = Deno.env.get("OPENAI_API_KEY")!;
const PARALLEL_API_KEY   = Deno.env.get("PARALLEL_API_KEY")!;
const TAVILY_API_KEY     = Deno.env.get("TAVILY_API_KEY")!;

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const FINAL_OUTPUT_SIZE  = 100;
const EXTRACT_BATCH_SIZE = 10;
const MAX_DIR_PAGES      = 5;   // allow up to 5 URLs from the same directory domain
const SUB_QUERY_COUNT    = 20;

// ─── DOMAIN LISTS ─────────────────────────────────────────────────────────────

// Directory pages list 10-30 businesses each — highest yield per extraction.
// We WANT these and will extract EVERY business from them.
const DIRECTORY_DOMAINS = [
  "justdial.com", "sulekha.com", "zomato.com", "swiggy.com",
  "tripadvisor.", "yelp.", "indiamart.com", "tradeindia.com",
  "magicpin.in", "dineout.co.in", "eazydiner.com", "burrp.com",
  "happytrips.com", "timescity.com", "so.city", "nearbuy.com",
  "yellowpages.", "lbb.in", "whatshot.in",
];

// Pure noise — zero chance of real business contact data.
const HARD_BLOCKED = [
  "facebook.com", "instagram.com", "twitter.com", "x.com",
  "linkedin.com", "youtube.com", "youtu.be", "tiktok.com",
  "reddit.com", "quora.com", "pinterest.com", "tumblr.com",
  "wikipedia.org", "wikimedia.org",
  "amazon.com", "amazon.in", "flipkart.com",
  "apps.apple.com", "play.google.com",
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function safeHostname(raw: string): string | null {
  try { return new URL(raw).hostname.replace("www.", ""); }
  catch { return null; }
}

function isDirectory(domain: string): boolean {
  return DIRECTORY_DOMAINS.some((d) => domain.includes(d));
}

function isBlocked(domain: string): boolean {
  return HARD_BLOCKED.some((b) => domain.includes(b));
}

/** Normalise a company name for dedup (lowercase, strip punctuation). */
function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

async function gptJson<T>(
  messages: { role: string; content: string }[],
  label: string,
): Promise<T | null> {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model:           "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages,
      }),
    });
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content) as T;
  } catch (e) {
    console.error(`gptJson [${label}] failed:`, (e as Error).message);
    return null;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
serve(async (req) => {
  console.log("══════════════════════════════════════════════════════════");
  console.log("🚀 [INVOCATION] Lead-Alert Pipeline Started");

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  let preference_id = "";

  try {
    const payload = await req.json();
    const record  = payload.record;
    if (!record) throw new Error("No record in payload.");

    const { id: pref_id, user_id, search_query } = record;
    preference_id = pref_id;

    await supabase
      .from("lead_preferences")
      .update({ status: "processing", started_at: new Date().toISOString() })
      .eq("id", preference_id);

    // ══════════════════════════════════════════════════════════
    // PHASE 1 — QUERY EXPANSION
    // Mix of directory queries (high yield: 10-20 leads/page)
    // AND direct/official-site queries (richer data per lead).
    // ══════════════════════════════════════════════════════════
    console.log("🧠 [PHASE 1] Expanding query…");

    const expandResult = await gptJson<{ queries: string[] }>(
      [{
        role:    "user",
        content: `You are a lead-generation expert. Given the search intent below, produce a JSON
object with key "queries" containing exactly ${SUB_QUERY_COUNT} search strings.

COMPOSITION (follow strictly):

GROUP A — 10 queries targeting DIRECTORY / LISTING sites (highest lead yield):
  Use these site names directly in queries:
  Justdial, Sulekha, Zomato, Magicpin, Tripadvisor, Yelp, Dineout, EazyDiner, Yellow Pages, LBB
  Format examples:
    "justdial [business type] [city/area] contact phone"
    "zomato [business type] [city] restaurants list"
    "sulekha [business type] [area] [city] list with phone numbers"
    "tripadvisor [business type] [city] reviews phone"
  VARY the area/neighbourhood in each query to get DIFFERENT listing pages.

GROUP B — 10 queries targeting OFFICIAL / DIRECT business websites:
  Use specific neighbourhoods, business names if known, "official site", "contact us",
  "phone number", "email", "address".
  Format examples:
    "[business type] [specific neighbourhood] official website contact"
    "best [business type] [area] phone number email"
    "[famous business name] [city] official site"
  VARY keywords: restaurant, eatery, dining, kitchen, café, bistro, cuisine, dhaba etc.
  INCLUDE regional language terms if relevant.

Output ONLY the JSON object. No extra keys. No markdown.
Search intent: "${search_query}"`,
      }],
      "phase-1-expand",
    );

    const subQueries: string[] = (
      expandResult?.queries ??
      (expandResult as any)?.searchQueries ??
      (expandResult ? (Object.values(expandResult)[0] as string[]) : null) ??
      [search_query]
    ).slice(0, SUB_QUERY_COUNT);

    console.log(`✨ [PHASE 1] ${subQueries.length} sub-queries generated.`);

    // ══════════════════════════════════════════════════════════
    // PHASE 2 — DISCOVERY (Parallel + Tavily in parallel)
    // ══════════════════════════════════════════════════════════
    console.log("🔍 [PHASE 2] Running bulk URL discovery…");

    const rawResults: { url: string; snippet: string }[] = [];

    const [parallelPages, tavilyPages] = await Promise.all([
      // 2A — Parallel Search
      Promise.all(
        subQueries.map((q) =>
          fetch("https://api.parallel.ai/v1beta/search", {
            method:  "POST",
            headers: { "Content-Type": "application/json", "x-api-key": PARALLEL_API_KEY },
            body: JSON.stringify({
              objective: q, search_queries: [q],
              mode: "fast", max_results: 25,
              excerpts: { max_chars_per_result: 4000 },
            }),
          }).then((r) => r.json()).catch(() => ({ results: [] }))
        )
      ),
      // 2B — Tavily Search
      Promise.all(
        subQueries.map((q) =>
          fetch("https://api.tavily.com/search", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_key: TAVILY_API_KEY, query: q,
              search_depth: "advanced", max_results: 20,
            }),
          }).then((r) => r.json()).catch(() => ({ results: [] }))
        )
      ),
    ]);

    for (const page of parallelPages) {
      for (const item of (page.results ?? [])) {
        const url = item.url ?? item.content_url;
        if (url) rawResults.push({ url, snippet: item.excerpts?.join(" ") ?? "" });
      }
    }
    for (const page of tavilyPages) {
      for (const item of (page.results ?? [])) {
        if (item.url) rawResults.push({ url: item.url, snippet: item.content ?? "" });
      }
    }

    console.log(`🌐 [PHASE 2] ${rawResults.length} total raw URLs collected.`);

    // ══════════════════════════════════════════════════════════
    // PHASE 3 — FILTER, DEDUP & SORT
    //
    // KEY LOGIC:
    //   Directory domains → allow up to MAX_DIR_PAGES different
    //     URLs from the same domain (each page lists different
    //     businesses, so justdial.com/page1 ≠ justdial.com/page2).
    //   Direct domains    → 1 URL per domain (it's one business).
    //   Directory targets come FIRST (highest yield per GPT call).
    // ══════════════════════════════════════════════════════════
    console.log("🧹 [PHASE 3] Filtering and deduplicating…");

    const seenUrls          = new Set<string>();
    const seenDirectDomains = new Set<string>();
    const dirPageCount      = new Map<string, number>();

    const dirTargets:    { url: string; domain: string; snippet: string; isDirectory: true  }[] = [];
    const directTargets: { url: string; domain: string; snippet: string; isDirectory: false }[] = [];

    for (const item of rawResults) {
      if (seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);

      const domain = safeHostname(item.url);
      if (!domain) continue;
      if (isBlocked(domain)) continue;

      if (isDirectory(domain)) {
        // Allow multiple pages from the same directory domain
        const count = dirPageCount.get(domain) ?? 0;
        if (count >= MAX_DIR_PAGES) continue;
        dirPageCount.set(domain, count + 1);
        dirTargets.push({ url: item.url, domain, snippet: item.snippet, isDirectory: true });
      } else {
        // Direct sites: one URL per domain
        if (seenDirectDomains.has(domain)) continue;
        seenDirectDomains.add(domain);
        directTargets.push({ url: item.url, domain, snippet: item.snippet, isDirectory: false });
      }
    }

    // Directory pages first (more leads per call), then direct sites
    const targets = [...dirTargets, ...directTargets];
    const dirCount = dirTargets.length;

    console.log(`🎯 [PHASE 3] ${targets.length} targets (${dirCount} directory pages + ${directTargets.length} direct sites).`);

    // ══════════════════════════════════════════════════════════
    // PHASE 4 — EXTRACTION & SCORING
    //
    // TWO EXTRACTION MODES:
    //   Directory pages → GPT returns businesses[] array with
    //     EVERY business listed on the page. A single Justdial
    //     page can yield 10-20 leads.
    //   Direct sites    → GPT returns a single-item businesses[]
    //     array for that one business.
    //
    // DEDUP: By normalised company name across ALL sources.
    //   Domain-based dedup would wrongly merge different
    //   restaurants from the same directory.
    //
    // LENIENT CRITERIA: A lead is kept if it has a company_name.
    //   Phone/email/address are scored but NOT required.
    //   This maximises unique lead count.
    // ══════════════════════════════════════════════════════════
    console.log(`⛏️  [PHASE 4] Extracting ${targets.length} targets in batches of ${EXTRACT_BATCH_SIZE}…`);

    const allLeads: { lead: object; score: number }[] = [];
    const seenNames = new Set<string>(); // dedup by normalised company name

    for (let i = 0; i < targets.length; i += EXTRACT_BATCH_SIZE) {
      const batch    = targets.slice(i, i + EXTRACT_BATCH_SIZE);
      const batchNum = Math.floor(i / EXTRACT_BATCH_SIZE) + 1;
      const total    = Math.ceil(targets.length / EXTRACT_BATCH_SIZE);
      console.log(`  Batch ${batchNum}/${total}: ${batch.length} targets…`);

      const batchResults = await Promise.all(
        batch.map(async (target) => {
          try {
            // ── 4A: Get page content ─────────────────────────
            let content = target.snippet;

            // Always fetch full content for directory pages (listing
            // data is in the full HTML, not the snippet).
            // For direct sites, only fetch if snippet is too short.
            const shouldFetch = target.isDirectory || content.length < 400;

            if (shouldFetch) {
              const scrapeRes = await fetch("https://api.tavily.com/extract", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ api_key: TAVILY_API_KEY, urls: [target.url] }),
              }).catch(() => null);

              if (scrapeRes?.ok) {
                const scrapeData = await scrapeRes.json().catch(() => ({}));
                const extracted  = scrapeData.results?.[0]?.raw_content ?? "";
                if (extracted.length > content.length) content = extracted;
              }
            }

            if (content.length < 80) {
              console.warn(`    ⚠️  ${target.domain}: content too short, skipping.`);
              return [];
            }

            // ── 4B: GPT extraction ───────────────────────────
            // UNIFIED shape: always returns { businesses: [] }
            // Directory pages → 10-20 entries
            // Direct sites    → exactly 1 entry
            const extracted = await gptJson<{
              businesses: {
                company_name: string;
                address:      string;
                phone:        string;
                email:        string;
                website:      string;
                description:  string;
              }[];
            }>(
              [
                {
                  role: "system",
                  content: `You are a lead extraction assistant.

THE USER'S SEARCH: "${search_query}"

${target.isDirectory ? `THIS IS A DIRECTORY / LISTING PAGE (e.g. Justdial, Zomato, Sulekha, Tripadvisor, Yelp).
- Return EVERY business listed on this page as a SEPARATE object in the businesses array.
- If 15 businesses are listed, return 15 objects. Do NOT merge or skip any.
- Phones typically appear as "+91-XXXXXXXXXX", "098XXXXXXXX", or 10-digit strings near "Call"/"Tel"/"Ph".
- Include businesses even if they only have a name and phone — partial data is fine.
` : `THIS IS A DIRECT BUSINESS WEBSITE.
- Return exactly 1 object for this business.
- Extract every contact detail visible on the page.
`}
Rules:
1. company_name: the business name. REQUIRED — skip any entry with no identifiable name.
2. phone: copy exactly as written — never reformat or shorten. "" if not found.
3. email: extract if present. "" if not.
4. address: include area/locality/city even if partial. "" if not found.
5. website: the business's own URL if explicitly linked; "" otherwise.
6. description: one sentence about what the business does. "" if unknown.
7. NEVER invent data. Leave any missing field as "".
8. Be LENIENT — include a business even if it only has a name and one other field.

Return ONLY valid JSON:
{ "businesses": [
  { "company_name": "", "address": "", "phone": "", "email": "", "website": "", "description": "" }
] }
No businesses found: { "businesses": [] }`,
                },
                {
                  role: "user",
                  content: content.substring(0, 12000),
                },
              ],
              `extract-${target.domain}`,
            );

            const businesses = extracted?.businesses ?? [];
            if (businesses.length === 0) return [];

            console.log(`    ✅ ${target.domain}${target.isDirectory ? " [DIR]" : ""}: ${businesses.length} business(es)`);

            const pageResults: { lead: object; score: number }[] = [];

            for (const biz of businesses) {
              const name = biz.company_name?.trim();
              if (!name) continue;

              // ── Name-based dedup across all sources ────────
              const norm = normaliseName(name);
              if (seenNames.has(norm)) continue;
              seenNames.add(norm);

              // Use biz.website if provided, else fall back to source URL
              // (only for direct sites — for directories the source URL
              // is the listing page, not the individual business)
              const website = biz.website?.trim()
                ? biz.website.trim()
                : (target.isDirectory ? "" : target.url);

              // Unique domain key per business so upsert doesn't collide
              const slug      = norm.replace(/\s+/g, "-").substring(0, 60);
              const domainKey = target.isDirectory
                ? `${target.domain}#${slug}`   // e.g. justdial.com#corporate-dhaba
                : target.domain;               // e.g. thecorporatedhaba.com

              const lead = {
                preference_id,
                search_query,
                domain:    domainKey,
                lead_data: { ...biz, company_name: name, website },
                status:    "verified",
              };

              // LENIENT scoring — every field adds points, nothing is required
              const score =
                (name                    ? 10 : 0) +
                (biz.phone?.trim()       ? 30 : 0) +
                (biz.email?.trim()       ? 30 : 0) +
                (biz.address?.trim()     ? 10 : 0) +
                (website                 ? 10 : 0) +
                (biz.description?.trim() ?  5 : 0);

              pageResults.push({ lead, score });
            }

            return pageResults;
          } catch (err) {
            console.error(`    ⚠️  ${target.domain}:`, (err as Error).message);
            return [];
          }
        }),
      );

      // Flatten and accumulate
      for (const item of batchResults.flat()) {
        allLeads.push(item);
      }

      console.log(`  Running total: ${allLeads.length} unique leads.`);

      // Stop early if we already have more than enough
      if (allLeads.length >= FINAL_OUTPUT_SIZE * 2) {
        console.log(`  🎯 ${allLeads.length} leads collected — stopping extraction early.`);
        break;
      }
    }

    // Sort by score, take best 100
    allLeads.sort((a, b) => b.score - a.score);
    const finalLeads = allLeads.slice(0, FINAL_OUTPUT_SIZE).map((x) => x.lead);

    console.log(`✅ [PHASE 4] ${allLeads.length} extracted → top ${finalLeads.length} selected.`);

    // ══════════════════════════════════════════════════════════
    // PHASE 5 — SAVE TO DATABASE
    // ══════════════════════════════════════════════════════════
    if (finalLeads.length > 0) {
      console.log("💾 [PHASE 5] Saving leads…");

      const { data: inserted, error: leadsError } = await supabase
        .from("leads")
        .upsert(finalLeads, { onConflict: "domain" })
        .select("id");

      if (leadsError) console.error("  Leads upsert error:", leadsError.message);

      if (inserted && inserted.length > 0) {
        const junction = inserted.map((l: { id: string }) => ({
          user_id,
          lead_id: l.id,
        }));

        const { error: junctionError } = await supabase
          .from("user_leads")
          .upsert(junction, { onConflict: "user_id,lead_id" });

        if (junctionError) {
          console.error("  user_leads error:", junctionError.message);
        } else {
          console.log(`💾 [SUCCESS] ${inserted.length} leads saved & linked to user.`);
        }
      }
    } else {
      console.log("⚠️  No leads extracted.");
    }

    await supabase
      .from("lead_preferences")
      .update({ status: "completed", completed_at: new Date().toISOString() })
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

    if (preference_id) {
      await supabase
        .from("lead_preferences")
        .update({ status: "failed", error_message: (error as Error).message })
        .eq("id", preference_id).catch(() => {});
    }

    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});