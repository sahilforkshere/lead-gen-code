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
const MAX_DIR_PAGES      = 5;
const SUB_QUERY_COUNT    = 20;

// ─── DOMAIN LISTS ─────────────────────────────────────────────────────────────

const DIRECTORY_DOMAINS = [
  "justdial.com", "sulekha.com", "zomato.com", "swiggy.com",
  "tripadvisor.", "yelp.", "indiamart.com", "tradeindia.com",
  "magicpin.in", "dineout.co.in", "eazydiner.com", "burrp.com",
  "happytrips.com", "timescity.com", "so.city", "nearbuy.com",
  "yellowpages.", "lbb.in", "whatshot.in",
];

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

function safeOrigin(raw: string): string | null {
  try { return new URL(raw).origin; }
  catch { return null; }
}

function isDirectory(domain: string): boolean {
  return DIRECTORY_DOMAINS.some((d) => domain.includes(d));
}

function isBlocked(domain: string): boolean {
  return HARD_BLOCKED.some((b) => domain.includes(b));
}

function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Resolve a possibly-relative URL against a base page URL.
 * e.g. "/Delhi/SomeBiz/..." + "https://www.justdial.com/search?q=..." → "https://www.justdial.com/Delhi/SomeBiz/..."
 */
function resolveUrl(href: string, pageUrl: string): string {
  if (!href) return "";
  // Already absolute
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  // Protocol-relative
  if (href.startsWith("//")) return "https:" + href;
  // Relative — resolve against page origin
  const origin = safeOrigin(pageUrl);
  if (!origin) return href;
  if (href.startsWith("/")) return origin + href;
  // Relative without leading slash — append to page path
  try {
    return new URL(href, pageUrl).href;
  } catch {
    return origin + "/" + href;
  }
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

/**
 * Fetch page content via Tavily Extract.
 * include_raw_content = true gives us the full HTML so GPT can see <a href="..."> links.
 * We return BOTH raw_content (HTML with links) and text content.
 */
async function fetchPageContent(url: string): Promise<{ html: string; text: string }> {
  try {
    const res = await fetch("https://api.tavily.com/extract", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        urls: [url],
      }),
    });

    if (!res.ok) return { html: "", text: "" };

    const data = await res.json();
    const result = data.results?.[0];
    if (!result) return { html: "", text: "" };

    return {
      html: result.raw_content ?? "",
      text: result.raw_content ?? "",
    };
  } catch {
    return { html: "", text: "" };
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

    const targets = [...dirTargets, ...directTargets];
    const dirCount = dirTargets.length;

    console.log(`🎯 [PHASE 3] ${targets.length} targets (${dirCount} directory pages + ${directTargets.length} direct sites).`);

    // ══════════════════════════════════════════════════════════
    // PHASE 4 — EXTRACTION & SCORING
    //
    // KEY CHANGES:
    //   1. For directory pages, we now fetch full HTML content
    //      so GPT can see <a href="..."> links for each business.
    //   2. GPT extracts listing_url per business (the exact link
    //      to that business on the directory page).
    //   3. We store source_url (the page we scraped) and
    //      listing_url (the per-business link) in lead_data.
    // ══════════════════════════════════════════════════════════
    console.log(`⛏️  [PHASE 4] Extracting ${targets.length} targets in batches of ${EXTRACT_BATCH_SIZE}…`);

    const allLeads: { lead: object; score: number }[] = [];
    const seenNames = new Set<string>();

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

            // ALWAYS fetch full content for directory pages —
            // we need the HTML links. For direct sites, only
            // fetch if snippet is too short.
            const shouldFetch = target.isDirectory || content.length < 400;

            if (shouldFetch) {
              const fetched = await fetchPageContent(target.url);
              const fetchedContent = fetched.html || fetched.text;
              if (fetchedContent.length > content.length) {
                content = fetchedContent;
              }
            }

            if (content.length < 80) {
              console.warn(`    ⚠️  ${target.domain}: content too short, skipping.`);
              return [];
            }

            // ── 4B: GPT extraction ───────────────────────────
            const extracted = await gptJson<{
              businesses: {
                company_name: string;
                address:      string;
                phone:        string;
                email:        string;
                website:      string;
                listing_url:  string;
                description:  string;
              }[];
            }>(
              [
                {
                  role: "system",
                  content: `You are a lead extraction assistant.

THE USER'S SEARCH: "${search_query}"
SOURCE PAGE URL: "${target.url}"

${target.isDirectory ? `THIS IS A DIRECTORY / LISTING PAGE (e.g. Justdial, Zomato, Sulekha, Tripadvisor, Yelp).
- Return EVERY business listed on this page as a SEPARATE object in the businesses array.
- If 15 businesses are listed, return 15 objects. Do NOT merge or skip any.
- Phones typically appear as "+91-XXXXXXXXXX", "098XXXXXXXX", or 10-digit strings near "Call"/"Tel"/"Ph".
- Include businesses even if they only have a name and phone — partial data is fine.

CRITICAL — listing_url extraction:
- For EACH business, extract its INDIVIDUAL detail/profile page URL from the directory.
- Look for <a href="..."> links wrapping or near each business name.
- On Justdial: URLs look like "justdial.com/Delhi/BusinessName-Near-Area/011PXX11-XX11-..."
- On Zomato: URLs look like "zomato.com/ncr/business-name-locality"
- On Sulekha: URLs look like "sulekha.com/business-name-city-contact-address"
- On Tripadvisor: URLs look like "tripadvisor.com/Restaurant_Review-..."
- On Yelp: URLs look like "yelp.com/biz/business-name-city"
- On Magicpin: URLs look like "magicpin.in/city/business-name/..."
- On LBB: URLs look like "lbb.in/city/business-name/..."
- On Swiggy: URLs look like "swiggy.com/restaurants/business-name-..."
- If the URL is RELATIVE (starts with "/" or no "http"), prepend the directory's origin.
- If you cannot find the individual URL, use "" — NEVER make one up.
` : `THIS IS A DIRECT BUSINESS WEBSITE.
- Return exactly 1 object for this business.
- Extract every contact detail visible on the page.
- listing_url: "" (not applicable for direct sites).
`}
Rules:
1. company_name: the business name. REQUIRED — skip any entry with no identifiable name.
2. phone: copy exactly as written — never reformat or shorten. "" if not found.
3. email: extract if present. "" if not.
4. address: include area/locality/city even if partial. "" if not found.
5. website: the business's OWN official website URL (not the directory URL). "" if not found or not explicitly linked.
6. listing_url: the EXACT URL to this specific business's page on THIS directory/listing site.
   - For directory pages: extract from href links in the HTML. This is the clickable link to the business's detail page.
   - For direct sites: leave as "".
   - MUST be a real URL found in the content. NEVER fabricate or guess URLs.
7. description: one sentence about what the business does. "" if unknown.
8. NEVER invent data. Leave any missing field as "".
9. Be LENIENT — include a business even if it only has a name and one other field.

Return ONLY valid JSON:
{ "businesses": [
  { "company_name": "", "address": "", "phone": "", "email": "", "website": "", "listing_url": "", "description": "" }
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

              // website = official business website (NOT directory)
              const website = biz.website?.trim()
                ? biz.website.trim()
                : (target.isDirectory ? "" : target.url);

              // listing_url = the exact link to this business on the directory
              // Resolve relative URLs against the source page URL
              let listing_url = "";
              if (target.isDirectory && biz.listing_url?.trim()) {
                listing_url = resolveUrl(biz.listing_url.trim(), target.url);
              }

              // source_url = the page we actually scraped
              const source_url = target.url;

              // The "best link" for display: use listing_url if available,
              // else website, else source_url
              const best_link = listing_url || website || source_url;

              const slug      = norm.replace(/\s+/g, "-").substring(0, 60);
              const domainKey = target.isDirectory
                ? `${target.domain}#${slug}`
                : target.domain;

              const lead = {
                preference_id,
                search_query,
                domain:    domainKey,
                lead_data: {
                  ...biz,
                  company_name: name,
                  website,
                  listing_url,   // exact directory page link for this business
                  source_url,    // the page we scraped this from
                  best_link,     // most useful link to display to user
                },
                status: "verified",
              };

              // Scoring — listing_url adds points since it's a real actionable link
              const score =
                (name                    ? 10 : 0) +
                (biz.phone?.trim()       ? 30 : 0) +
                (biz.email?.trim()       ? 30 : 0) +
                (biz.address?.trim()     ? 10 : 0) +
                (website                 ? 10 : 0) +
                (listing_url             ?  8 : 0) +  // bonus for having exact link
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

      for (const item of batchResults.flat()) {
        allLeads.push(item);
      }

      console.log(`  Running total: ${allLeads.length} unique leads.`);

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