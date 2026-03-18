import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// ─── ENV ──────────────────────────────────────────────────────────────────────
const supabaseUrl        = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY     = Deno.env.get("OPENAI_API_KEY")!;
const PARALLEL_API_KEY   = Deno.env.get("PARALLEL_API_KEY")!;
const TAVILY_API_KEY     = Deno.env.get("TAVILY_API_KEY")!;

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const FINAL_OUTPUT_SIZE      = 100;
const EXTRACT_BATCH_SIZE     = 10;
const URL_RESOLVE_BATCH_SIZE = 5;
const MAX_DIR_PAGES          = 5;
const SUB_QUERY_COUNT        = 20;

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

const DIRECTORY_SITE_PREFIX: Record<string, string> = {
  "justdial.com":   "site:justdial.com",
  "sulekha.com":    "site:sulekha.com",
  "zomato.com":     "site:zomato.com",
  "swiggy.com":     "site:swiggy.com",
  "magicpin.in":    "site:magicpin.in",
  "dineout.co.in":  "site:dineout.co.in",
  "eazydiner.com":  "site:eazydiner.com",
  "lbb.in":         "site:lbb.in",
  "whatshot.in":    "site:whatshot.in",
  "indiamart.com":  "site:indiamart.com",
  "tradeindia.com": "site:tradeindia.com",
  "tripadvisor.":   "site:tripadvisor.com",
  "yelp.":          "site:yelp.com",
  "yellowpages.":   "site:yellowpages.com",
};

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

function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Check if a URL is an INDIVIDUAL business profile page on a directory
 * (not a search/category/listing page with multiple businesses).
 */
function isIndividualListingPage(url: string, domain: string): boolean {
  try {
    const path = new URL(url).pathname;
    const segments = path.split("/").filter(Boolean);

    if (domain.includes("justdial.com")) {
      return /\d{3}PXX/i.test(url) || segments.length >= 3;
    }
    if (domain.includes("zomato.com")) {
      return segments.length >= 2 && !path.toLowerCase().includes("-restaurants");
    }
    if (domain.includes("tripadvisor.")) {
      return path.includes("Restaurant_Review") || path.includes("Hotel_Review");
    }
    if (domain.includes("yelp.")) {
      return path.includes("/biz/");
    }
    if (domain.includes("sulekha.com")) {
      return segments.length >= 2 && path.includes("-contact");
    }
    if (domain.includes("magicpin.in")) {
      return segments.length >= 3;
    }
    if (domain.includes("swiggy.com")) {
      return path.includes("/restaurants/") && segments.length >= 2;
    }
    if (domain.includes("lbb.in")) {
      return segments.length >= 3;
    }
    return segments.length >= 3;
  } catch {
    return false;
  }
}

function extractLocationHint(searchQuery: string): string {
  const cities = [
    "delhi", "new delhi", "mumbai", "bangalore", "bengaluru",
    "hyderabad", "chennai", "kolkata", "pune", "ahmedabad",
    "jaipur", "lucknow", "chandigarh", "goa", "noida",
    "gurgaon", "gurugram", "faridabad", "ghaziabad",
    "indore", "bhopal", "nagpur", "surat", "vadodara",
    "cochin", "kochi", "thiruvananthapuram", "coimbatore",
    "mysore", "vizag", "visakhapatnam", "patna", "ranchi",
  ];
  const lower = searchQuery.toLowerCase();
  for (const city of cities) {
    if (lower.includes(city)) return city;
  }
  const words = searchQuery.trim().split(/\s+/);
  return words.slice(-2).join(" ");
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
 * PHASE 4.5 — Search Tavily for a specific business to find its REAL listing URL.
 *
 * e.g. "Parikrama New Delhi site:justdial.com"
 *   → https://www.justdial.com/Delhi/Parikrama-Near-HT-Building/011PXX11...
 */
async function resolveListingUrl(
  businessName: string,
  sourceDomain: string,
  locationHint: string,
): Promise<string> {
  try {
    const sitePrefix = Object.entries(DIRECTORY_SITE_PREFIX)
      .find(([key]) => sourceDomain.includes(key))?.[1] ?? "";

    const query = sitePrefix
      ? `${businessName} ${locationHint} ${sitePrefix}`
      : `${businessName} ${locationHint} ${sourceDomain}`;

    const res = await fetch("https://api.tavily.com/search", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: "basic",
        max_results: 5,
      }),
    });

    if (!res.ok) return "";

    const data = await res.json();
    const results = data.results ?? [];

    const domainRoot = sourceDomain.split(".").slice(-2, -1)[0]; // "justdial", "zomato", etc.

    // Priority 1: individual profile page on the same directory
    for (const r of results) {
      const rDomain = safeHostname(r.url);
      if (!rDomain) continue;
      if (!rDomain.includes(domainRoot)) continue;
      if (isIndividualListingPage(r.url, rDomain)) {
        return r.url;
      }
    }

    // Priority 2: any page on the same directory domain
    for (const r of results) {
      const rDomain = safeHostname(r.url);
      if (rDomain && rDomain.includes(domainRoot)) {
        return r.url;
      }
    }

    // Priority 3: try the business's official site from ANY result
    // (better than nothing — user gets a clickable link)
    if (results.length > 0 && results[0].url) {
      const topDomain = safeHostname(results[0].url);
      if (topDomain && !isBlocked(topDomain)) {
        return results[0].url;
      }
    }

    return "";
  } catch {
    return "";
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

    const locationHint = extractLocationHint(search_query);

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
    // PHASE 2 — DISCOVERY
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
    //
    // KEY CHANGE: Separate directory URLs into TWO types:
    //   1. Individual profile pages → treated as direct sites,
    //      URL itself IS the real listing link.
    //   2. Listing/category pages → multi-extraction,
    //      real URLs resolved in Phase 4.5.
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
        if (isIndividualListingPage(item.url, domain)) {
          // ✅ INDIVIDUAL profile page → the URL IS the real link
          directTargets.push({
            url: item.url, domain, snippet: item.snippet,
            isDirectory: false,
          });
        } else {
          // 📋 LISTING page → extract multiple businesses
          const count = dirPageCount.get(domain) ?? 0;
          if (count >= MAX_DIR_PAGES) continue;
          dirPageCount.set(domain, count + 1);
          dirTargets.push({ url: item.url, domain, snippet: item.snippet, isDirectory: true });
        }
      } else {
        if (seenDirectDomains.has(domain)) continue;
        seenDirectDomains.add(domain);
        directTargets.push({ url: item.url, domain, snippet: item.snippet, isDirectory: false });
      }
    }

    const targets = [...dirTargets, ...directTargets];

    console.log(`🎯 [PHASE 3] ${targets.length} targets (${dirTargets.length} listing pages + ${directTargets.length} direct/individual).`);

    // ══════════════════════════════════════════════════════════
    // PHASE 4 — EXTRACTION & SCORING
    // ══════════════════════════════════════════════════════════
    console.log(`⛏️  [PHASE 4] Extracting in batches of ${EXTRACT_BATCH_SIZE}…`);

    interface LeadEntry {
      lead: {
        preference_id: string;
        search_query:  string;
        domain:        string;
        lead_data:     Record<string, string>;
        status:        string;
      };
      score:           number;
      needsUrlResolve: boolean;
      sourceDomain:    string;
      businessName:    string;
    }

    const allLeads: LeadEntry[] = [];
    const seenNames = new Set<string>();

    for (let i = 0; i < targets.length; i += EXTRACT_BATCH_SIZE) {
      const batch    = targets.slice(i, i + EXTRACT_BATCH_SIZE);
      const batchNum = Math.floor(i / EXTRACT_BATCH_SIZE) + 1;
      const total    = Math.ceil(targets.length / EXTRACT_BATCH_SIZE);
      console.log(`  Batch ${batchNum}/${total}: ${batch.length} targets…`);

      const batchResults = await Promise.all(
        batch.map(async (target) => {
          try {
            let content = target.snippet;

            const shouldFetch = target.isDirectory || content.length < 400;
            if (shouldFetch) {
              try {
                const scrapeRes = await fetch("https://api.tavily.com/extract", {
                  method:  "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ api_key: TAVILY_API_KEY, urls: [target.url] }),
                });
                if (scrapeRes.ok) {
                  const scrapeData = await scrapeRes.json();
                  const extracted  = scrapeData.results?.[0]?.raw_content ?? "";
                  if (extracted.length > content.length) content = extracted;
                }
              } catch { /* ignore */ }
            }

            if (content.length < 80) {
              console.warn(`    ⚠️  ${target.domain}: content too short, skipping.`);
              return [];
            }

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

${target.isDirectory ? `THIS IS A DIRECTORY / LISTING PAGE (e.g. Justdial, Zomato, Sulekha).
- Return EVERY business listed on this page as a SEPARATE object.
- If 15 businesses are listed, return 15 objects. Do NOT merge or skip any.
- Include businesses even if they only have a name and phone.
` : `THIS IS A SINGLE BUSINESS PAGE.
- Return exactly 1 object for this business.
- Extract every contact detail visible on the page.
`}
Rules:
1. company_name: the business name. REQUIRED.
2. phone: copy exactly as written. "" if not found.
3. email: extract if present. "" if not.
4. address: include area/locality/city. "" if not found.
5. website: the business's OWN official website URL. "" if not found.
6. description: one sentence about the business. "" if unknown.
7. NEVER invent data. Leave missing fields as "".

Return ONLY valid JSON:
{ "businesses": [
  { "company_name": "", "address": "", "phone": "", "email": "", "website": "", "description": "" }
] }`,
                },
                { role: "user", content: content.substring(0, 12000) },
              ],
              `extract-${target.domain}`,
            );

            const businesses = extracted?.businesses ?? [];
            if (businesses.length === 0) return [];

            console.log(`    ✅ ${target.domain}${target.isDirectory ? " [DIR]" : ""}: ${businesses.length} business(es)`);

            const pageResults: LeadEntry[] = [];

            for (const biz of businesses) {
              const name = biz.company_name?.trim();
              if (!name) continue;

              const norm = normaliseName(name);
              if (seenNames.has(norm)) continue;
              seenNames.add(norm);

              const isFromListingPage = target.isDirectory;
              const isOnDirectoryDomain = isDirectory(target.domain);

              // ── URL logic ───────────────────────────────────
              const website = biz.website?.trim() || "";

              // For individual directory profile pages → target.url IS the listing link
              // For listing page extractions → empty, resolved in Phase 4.5
              // For direct non-directory sites → not applicable
              let listing_url = "";
              if (!isFromListingPage && isOnDirectoryDomain) {
                listing_url = target.url;
              }

              const source_url = target.url;
              const best_link  = listing_url || website || source_url;

              // Domain key for upsert
              const slug = norm.replace(/\s+/g, "-").substring(0, 60);
              let domainKey: string;
              if (listing_url) {
                domainKey = listing_url;
              } else if (!isFromListingPage && !isOnDirectoryDomain) {
                domainKey = target.domain;
              } else {
                domainKey = `${target.domain}#${slug}`;
              }

              const lead = {
                preference_id,
                search_query,
                domain: domainKey,
                lead_data: {
                  company_name: name,
                  address:      biz.address?.trim()     ?? "",
                  phone:        biz.phone?.trim()        ?? "",
                  email:        biz.email?.trim()        ?? "",
                  website:      website || (!isFromListingPage && !isOnDirectoryDomain ? target.url : ""),
                  listing_url,
                  source_url,
                  best_link,
                  description:  biz.description?.trim()  ?? "",
                },
                status: "verified",
              };

              const score =
                (name                    ? 10 : 0) +
                (biz.phone?.trim()       ? 30 : 0) +
                (biz.email?.trim()       ? 30 : 0) +
                (biz.address?.trim()     ? 10 : 0) +
                (website                 ? 10 : 0) +
                (listing_url             ?  8 : 0) +
                (biz.description?.trim() ?  5 : 0);

              pageResults.push({
                lead,
                score,
                needsUrlResolve: isFromListingPage,
                sourceDomain:    target.domain,
                businessName:    name,
              });
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
        console.log(`  🎯 Enough leads — stopping extraction early.`);
        break;
      }
    }

    console.log(`✅ [PHASE 4] ${allLeads.length} total leads extracted.`);

    // ══════════════════════════════════════════════════════════
    // PHASE 4.5 — URL RESOLUTION
    //
    // For businesses extracted from directory LISTING pages,
    // we got the name but NOT the individual page URL.
    //
    // We now search for each business by name to find its
    // REAL listing URL on the directory.
    //
    // e.g. "Parikrama New Delhi site:justdial.com"
    //   → https://www.justdial.com/Delhi/Parikrama-Near-HT-Building/011PXX11...
    //
    // This replaces the fake "justdial.com#parikrama" slug with
    // the actual clickable URL.
    // ══════════════════════════════════════════════════════════
    const needsResolve = allLeads.filter((l) => l.needsUrlResolve);

    if (needsResolve.length > 0) {
      console.log(`🔗 [PHASE 4.5] Resolving ${needsResolve.length} listing URLs…`);

      let resolvedCount = 0;

      for (let i = 0; i < needsResolve.length; i += URL_RESOLVE_BATCH_SIZE) {
        const batch = needsResolve.slice(i, i + URL_RESOLVE_BATCH_SIZE);
        const batchNum = Math.floor(i / URL_RESOLVE_BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(needsResolve.length / URL_RESOLVE_BATCH_SIZE);

        console.log(`  URL resolve batch ${batchNum}/${totalBatches}…`);

        const resolved = await Promise.all(
          batch.map((entry) =>
            resolveListingUrl(entry.businessName, entry.sourceDomain, locationHint)
          ),
        );

        for (let j = 0; j < batch.length; j++) {
          const realUrl = resolved[j];
          if (realUrl) {
            const entry = batch[j];
            entry.lead.lead_data.listing_url = realUrl;
            entry.lead.lead_data.best_link   = realUrl;
            entry.lead.domain                = realUrl;
            entry.score += 8;
            resolvedCount++;
            console.log(`    ✅ ${entry.businessName} → ${realUrl}`);
          } else {
            // Fallback: keep source_url as best_link
            const entry = batch[j];
            entry.lead.lead_data.best_link = entry.lead.lead_data.source_url;
          }
        }
      }

      console.log(`🔗 [PHASE 4.5] Resolved ${resolvedCount}/${needsResolve.length} URLs.`);
    }

    // ── Sort by score, take best 100 ──────────────────────────
    allLeads.sort((a, b) => b.score - a.score);
    const finalLeads = allLeads.slice(0, FINAL_OUTPUT_SIZE).map((x) => x.lead);

    console.log(`✅ [FINAL] ${allLeads.length} extracted → top ${finalLeads.length} selected.`);

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