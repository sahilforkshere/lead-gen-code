import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// ─── ENV ──────────────────────────────────────────────────────────────────────
const supabaseUrl        = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY     = Deno.env.get("OPENAI_API_KEY")!;
const PARALLEL_API_KEY   = Deno.env.get("PARALLEL_API_KEY")!;
const TAVILY_API_KEY     = Deno.env.get("TAVILY_API_KEY")!;

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
// Supabase edge function hard limit: 150s.
// Budget: Phase1 ~4s | Phase2 ~10s | Phase3 ~1s | Phase4 ~80s | Phase5 ~4s = ~99s
// DEADLINE_MS forces Phase4 to stop early so Phase5 always runs.

const FINAL_OUTPUT_SIZE  = 100;   // target leads to return
const EXTRACT_BATCH_SIZE = 10;    // concurrent GPT extractions per batch
const MAX_DIR_PAGES      = 5;     // max URLs scraped per directory domain
const MAX_TARGETS        = 30;    // hard cap on URLs to process (dir pages first)
const SUB_QUERY_COUNT    = 10;    // total search queries (mix of dir + direct)
const FETCH_TIMEOUT_MS   = 12000; // abort any single external HTTP call after 12s
const DEADLINE_MS        = 110000; // stop extraction at 110s — leave 40s for DB

// ─── DOMAIN LISTS ─────────────────────────────────────────────────────────────
// Directory pages list 10-30 businesses each — highest yield per extraction.
// We WANT these; GPT will extract every restaurant listed on the page.
const DIRECTORY_DOMAINS = [
  "justdial.com", "sulekha.com", "zomato.com", "swiggy.com",
  "tripadvisor.", "yelp.", "indiamart.com", "tradeindia.com",
  "magicpin.in", "dineout.co.in", "eazydiner.com", "burrp.com",
  "happytrips.com", "timescity.com", "so.city", "nearbuy.com",
  "yellowpages.", "lbb.in", "whatshot.in",
];

// Pure noise — no restaurant contact data here at all.
const BLOCKED_DOMAINS = [
  "facebook.", "instagram.", "twitter.", "linkedin.", "pinterest.",
  "youtube.com", "youtu.be", "tiktok.com", "snapchat.com",
  "reddit.com", "quora.com", "tumblr.com",
  "wikipedia.org", "wikimedia.", "britannica.com",
  "apps.apple.com", "play.google.com",
  "food.ndtv.com", "ndtv.com", "hindustantimes.com", "timesofindia.",
  "economictimes.", "thehindu.com", "scroll.in",
  "timeout.com", "eater.com", "thrillist.com", "zagat.com",
  "seriouseats.com", "bonappetit.com", "foodandwine.com",
  "cntraveller.", "cntraveler.", "lonelyplanet.",
  "amazon.com", "amazon.in", "flipkart.com",
  "booking.com", "makemytrip.com", "airbnb.com",
  "wordpress.com", "blogspot.com", "medium.com", "substack.com",
  "wixsite.com", "weebly.com", "squarespace.com",
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function safeHostname(raw: string): string | null {
  try { return new URL(raw).hostname.replace("www.", ""); }
  catch { return null; }
}

function isDirectoryDomain(domain: string): boolean {
  return DIRECTORY_DOMAINS.some((d) => domain.includes(d));
}

function isBlockedDomain(domain: string): boolean {
  return BLOCKED_DOMAINS.some((b) => domain.includes(b));
}

/** Normalise a company name for deduplication (lowercase, strip punctuation). */
function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

/** fetch with AbortController — never hangs indefinitely. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Call GPT-4o-mini and parse a JSON response. Returns null on any error. */
async function gptJson<T>(
  messages: { role: string; content: string }[],
  label: string,
): Promise<T | null> {
  try {
    const res = await fetchWithTimeout(
      "https://api.openai.com/v1/chat/completions",
      {
        method:  "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
          model:           "gpt-4o-mini",
          response_format: { type: "json_object" },
          messages,
        }),
      },
      22000, // GPT gets a slightly longer budget than raw fetches
    );
    const data = await res.json();
    if (!data.choices?.[0]?.message?.content) {
      console.error(`gptJson [${label}] bad response:`, JSON.stringify(data).slice(0, 300));
      return null;
    }
    return JSON.parse(data.choices[0].message.content) as T;
  } catch (e) {
    console.error(`gptJson [${label}] failed:`, (e as Error).message);
    return null;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
serve(async (req) => {
  const START_TIME = Date.now();
  const elapsed    = () => `${((Date.now() - START_TIME) / 1000).toFixed(1)}s`;

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
    // PHASE 1 — QUERY EXPANSION
    // Mix of directory queries (yield 10-20 leads/page) and
    // direct-site queries (1-2 leads/page but richer data).
    // ══════════════════════════════════════════════════════════
    console.log("🧠 [PHASE 1] Expanding query…");

    const expandResult = await gptJson<{ queries: string[] }>(
      [{
        role:    "user",
        content: `You are a lead-generation expert. Given the search intent below, produce a JSON
object with key "queries" containing exactly ${SUB_QUERY_COUNT} search strings.

Composition rules (STRICT — follow exactly):
- 6 queries MUST target directory/listing pages. Use these sites directly:
  Justdial, Sulekha, Zomato, Magicpin, Tripadvisor, Yelp, Dineout, EazyDiner
  Example formats:
    "justdial [type] [city] contact phone"
    "sulekha [type] [area] list"
    "zomato [type] [city] restaurants"
    "tripadvisor restaurants [city] [type]"
  Each of these pages lists 10-20 businesses — highest lead yield.

- 4 queries MUST target individual business websites directly:
  Use specific restaurant names, neighbourhoods, "official site", "phone number", "contact"
  Example:
    "Chinese restaurant Connaught Place Delhi official site phone"
    "South Indian restaurant Bandra Mumbai contact details"

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

    console.log(`✨ [PHASE 1] ${subQueries.length} queries (${elapsed()}):`, subQueries);

    // ══════════════════════════════════════════════════════════
    // PHASE 2 — DISCOVERY
    // Both APIs run in parallel across all queries simultaneously.
    // Every fetch is guarded by FETCH_TIMEOUT_MS.
    // ══════════════════════════════════════════════════════════
    console.log("🔍 [PHASE 2] Discovery (Parallel AI + Tavily simultaneously)…");

    const rawResults: { url: string; snippet: string }[] = [];

    const [parallelPages, tavilyPages] = await Promise.all([
      Promise.all(
        subQueries.map((q) =>
          fetchWithTimeout("https://api.parallel.ai/v1beta/search", {
            method:  "POST",
            headers: { "Content-Type": "application/json", "x-api-key": PARALLEL_API_KEY },
            body: JSON.stringify({
              objective: q, search_queries: [q],
              mode: "fast", max_results: 20,
              excerpts: { max_chars_per_result: 2000 },
            }),
          }).then((r) => r.json()).catch(() => ({ results: [] }))
        )
      ),
      Promise.all(
        subQueries.map((q) =>
          fetchWithTimeout("https://api.tavily.com/search", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_key: TAVILY_API_KEY, query: q,
              search_depth: "basic", max_results: 15,
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

    console.log(`🌐 [PHASE 2 RESULT] ${rawResults.length} raw hits (${elapsed()}).`);

    // ══════════════════════════════════════════════════════════
    // PHASE 3 — FILTER, DEDUP & SORT
    //
    // Directory pages come first (highest lead yield).
    // For directories: allow up to MAX_DIR_PAGES per domain so we
    //   get multiple listing pages from the same site.
    // For direct sites: one URL per domain only.
    // Hard cap at MAX_TARGETS total.
    // ══════════════════════════════════════════════════════════
    console.log("🧹 [PHASE 3] Filtering, deduplicating, sorting…");

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
      if (isBlockedDomain(domain)) continue;

      if (isDirectoryDomain(domain)) {
        const count = dirPageCount.get(domain) ?? 0;
        if (count >= MAX_DIR_PAGES) continue;
        dirPageCount.set(domain, count + 1);
        dirTargets.push({ url: item.url, domain, snippet: item.snippet, isDirectory: true });
      } else {
        if (seenDirectDomains.has(domain)) continue;
        seenDirectDomains.add(domain);
        directTargets.push({ url: item.url, domain, snippet: item.snippet, isDirectory: false });
      }
    }

    // Directory pages first (more leads per call), then direct sites
    const targets  = [...dirTargets, ...directTargets].slice(0, MAX_TARGETS);
    const dirCount = targets.filter((t) => t.isDirectory).length;

    console.log(`🎯 [PHASE 3 RESULT] ${targets.length} targets (${dirCount} directory + ${targets.length - dirCount} direct).`);

    // ══════════════════════════════════════════════════════════
    // PHASE 4 — EXTRACTION
    //
    // Directory pages  → Tavily Extract for full HTML → GPT returns
    //                    businesses[] array (every restaurant on page).
    // Direct sites     → snippet only (skip extra HTTP call) → GPT
    //                    returns single-item businesses[] array.
    //
    // Deduplication is by normalised company name across ALL sources.
    // Domain-based dedup alone is wrong — Justdial has hundreds of
    // different restaurants on different pages.
    //
    // Global deadline guard at DEADLINE_MS ensures Phase 5 always runs.
    // ══════════════════════════════════════════════════════════
    console.log(`⛏️  [PHASE 4] Extracting ${targets.length} targets in batches of ${EXTRACT_BATCH_SIZE}…`);

    // Shared state across batches
    const allLeads: { lead: object; score: number }[] = [];
    const seenNames = new Set<string>(); // dedup by normalised company name

    outer:
    for (let i = 0; i < targets.length; i += EXTRACT_BATCH_SIZE) {
      if (Date.now() - START_TIME > DEADLINE_MS) {
        console.warn(`  ⏰ Deadline at ${elapsed()} — stopping extraction.`);
        break outer;
      }

      const batch    = targets.slice(i, i + EXTRACT_BATCH_SIZE);
      const batchNum = Math.floor(i / EXTRACT_BATCH_SIZE) + 1;
      console.log(`  Batch ${batchNum}/${Math.ceil(targets.length / EXTRACT_BATCH_SIZE)}: ${batch.length} targets (${elapsed()})…`);

      const batchResults = await Promise.all(
        batch.map(async (target) => {
          try {
            // ── 4A: Get page content ─────────────────────────
            let content = target.snippet;

            // Always fetch full content for directory pages (listing data is in full HTML).
            // For direct sites, only fetch if the snippet is too short.
            const shouldExtract = target.isDirectory || content.length < 400;

            if (shouldExtract) {
              const scrapeRes = await fetchWithTimeout(
                "https://api.tavily.com/extract",
                {
                  method:  "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ api_key: TAVILY_API_KEY, urls: [target.url] }),
                },
              ).catch(() => null);

              if (scrapeRes?.ok) {
                const scrapeData = await scrapeRes.json().catch(() => ({}));
                const extracted  = scrapeData.results?.[0]?.raw_content ?? "";
                if (extracted.length > content.length) content = extracted;
              }
            }

            if (content.length < 80) {
              console.warn(`    ⚠️  ${target.domain}: content too short, skip.`);
              return [];
            }

            // ── 4B: GPT extraction ───────────────────────────
            // Always returns { businesses: [] } — even for single-site pages.
            // This unified shape means directory pages return 15+ entries
            // and direct sites return exactly 1.
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
                  role:    "system",
                  content: `You are a restaurant lead extractor. Extract contact details for EVERY restaurant mentioned on this page.

${target.isDirectory ? `THIS IS A DIRECTORY/LISTING PAGE (e.g. Justdial, Zomato, Sulekha, Tripadvisor, Yelp).
- Return EVERY restaurant as a SEPARATE object in the businesses array.
- If 15 restaurants are listed, return 15 objects. Do not merge or skip any.
- Phones typically appear as "+91-XXXXXXXXXX", "098XXXXXXXX", or 10-digit strings near "Call"/"Tel"/"Ph".
- Include restaurants that are listed on this platform but may not have their own website.
` : `THIS IS A SINGLE RESTAURANT WEBSITE.
- Return exactly 1 object for this restaurant.
- Extract every contact detail visible on the page.
`}
Rules for all extractions:
1. phone: copy exactly as written — never reformat or shorten.
2. address: include area/locality/city even if partial.
3. website: the restaurant's own URL if explicitly linked; "" otherwise.
4. email: extract if present; "" if not.
5. NEVER invent data. Leave any missing field as "".
6. Only skip an entry if zero restaurant name can be found.

Return ONLY valid JSON in this exact shape:
{ "businesses": [
  { "company_name": "", "address": "", "phone": "", "email": "", "website": "", "description": "" }
] }
Empty: { "businesses": [] }`,
                },
                {
                  role:    "user",
                  content: content.substring(0, 8000),
                },
              ],
              `extract-${target.domain}`,
            );

            const businesses = extracted?.businesses ?? [];
            if (businesses.length === 0) return [];

            console.log(`    ✅ ${target.domain}${target.isDirectory ? " [DIR]" : ""}: ${businesses.length} business(es) found`);

            const pageResults: { lead: object; score: number }[] = [];

            for (const biz of businesses) {
              const name = biz.company_name?.trim();
              if (!name) continue;

              const norm = normaliseName(name);
              if (seenNames.has(norm)) continue; // cross-source deduplication
              seenNames.add(norm);

              // Use biz.website if provided, else fall back to the source URL
              // (only for direct sites — for directories the source URL is the listing page, not the restaurant)
              const website = biz.website?.trim()
                ? biz.website.trim()
                : (target.isDirectory ? "" : target.url);

              // Unique domain key per restaurant so upsert doesn't collide
              const slug      = norm.replace(/\s+/g, "-").substring(0, 60);
              const domainKey = target.isDirectory
                ? `${target.domain}#${slug}`
                : target.domain;

              const lead = {
                preference_id,
                search_query,
                domain:    domainKey,
                lead_data: { ...biz, company_name: name, website },
                status:    "verified",
              };

              // Score — phone + email are most valuable for outreach
              const score =
                (name                        ? 10 : 0) +
                (biz.phone?.trim()           ? 35 : 0) +
                (biz.email?.trim()           ? 35 : 0) +
                (biz.address?.trim()         ? 10 : 0) +
                (website                     ?  5 : 0) +
                (biz.description?.trim()     ?  5 : 0);

              pageResults.push({ lead, score });
            }

            return pageResults;
          } catch (err) {
            console.error(`    ⚠️  ${target.domain}:`, (err as Error).message);
            return [];
          }
        }),
      );

      // Flatten batch results and push (name dedup already applied above)
      for (const item of batchResults.flat()) {
        allLeads.push(item);
      }

      console.log(`  Running total: ${allLeads.length} unique leads (${elapsed()}).`);

      if (allLeads.length >= FINAL_OUTPUT_SIZE) {
        console.log(`  🎯 Reached ${FINAL_OUTPUT_SIZE} leads — stopping early.`);
        break outer;
      }
    }

    // Sort by data completeness, take best 100
    allLeads.sort((a, b) => b.score - a.score);
    const finalLeads = allLeads.slice(0, FINAL_OUTPUT_SIZE).map((x) => x.lead);

    console.log(`✅ [PHASE 4 RESULT] ${allLeads.length} unique leads → ${finalLeads.length} selected (${elapsed()}).`);

    // ══════════════════════════════════════════════════════════
    // PHASE 5 — SAVE TO DATABASE
    // ══════════════════════════════════════════════════════════
    if (finalLeads.length > 0) {
      console.log("💾 [PHASE 5] Saving…");

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
      .update({ status: "completed" })
      .eq("id", preference_id);

    console.log(`🏁 [FINISHED] Total time: ${elapsed()}`);
    console.log("══════════════════════════════════════════════════════════");

    return new Response(
      JSON.stringify({
        success:         true,
        total_extracted: allLeads.length,
        leads_saved:     finalLeads.length,
        elapsed_s:       parseFloat(elapsed()),
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
