import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// ─── ENV ──────────────────────────────────────────────────────────────────────
const supabaseUrl        = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY     = Deno.env.get("OPENAI_API_KEY")!;
const PARALLEL_API_KEY   = Deno.env.get("PARALLEL_API_KEY")!;
const TAVILY_API_KEY     = Deno.env.get("TAVILY_API_KEY")!;
const JINA_API_KEY       = Deno.env.get("JINA_API_KEY")!;    // ← NEW
const SERPER_API_KEY     = Deno.env.get("SERPER_API_KEY")!;  // ← NEW

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
// const FINAL_OUTPUT_SIZE  = 100;
// const EXTRACT_BATCH_SIZE = 10;
// const MAX_DIR_PAGES      = 5;
// const SUB_QUERY_COUNT    = 20;
// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const FINAL_OUTPUT_SIZE  = 20;  // Decrease from 100 to 20
const EXTRACT_BATCH_SIZE = 5;   // Decrease from 10 to 5
const MAX_DIR_PAGES      = 2;   // Decrease from 5 to 2
const SUB_QUERY_COUNT    = 4;   // Decrease from 20 to 4

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

function resolveUrl(href: string, pageUrl: string): string {
  if (!href) return "";
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("//")) return "https:" + href;
  const origin = safeOrigin(pageUrl);
  if (!origin) return href;
  if (href.startsWith("/")) return origin + href;
  try {
    return new URL(href, pageUrl).href;
  } catch {
    return origin + "/" + href;
  }
}

/** Validate that a URL is a real absolute https link, not fabricated. */
function isValidHttpUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
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

// ─── JINA AI PAGE READER ──────────────────────────────────────────────────────
/**
 * Uses Jina AI Reader (r.jina.ai) to fetch a URL and return clean Markdown
 * that PRESERVES all href links — exactly what GPT needs to extract listing_urls.
 *
 * Jina returns structured Markdown like:
 *   [Business Name](https://justdial.com/Delhi/BusinessName-/...)
 * which gives GPT real, extractable URLs instead of broken HTML fragments.
 */
async function fetchPageWithJina(url: string): Promise<string> {
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const res = await fetch(jinaUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${JINA_API_KEY}`,
        "Accept":        "text/plain",
        // Ask Jina to return full link text in Markdown format
        "X-Return-Format": "markdown",
        // Retain all links so GPT can see real hrefs
        "X-Retain-Images": "none",
      },
    });

    if (!res.ok) {
      console.warn(`    Jina fetch failed for ${url}: ${res.status}`);
      return "";
    }

    const text = await res.text();
    return text ?? "";
  } catch (e) {
    console.warn(`    Jina fetch error for ${url}:`, (e as Error).message);
    return "";
  }
}

// ─── SERPER URL SNIPER (Phase 4.5) ───────────────────────────────────────────
/**
 * When GPT extracts a business name from a directory but can't find the exact
 * profile URL, we fire a targeted Google search via Serper.dev to find it.
 *
 * e.g. query = 'Parikrama Restaurant New Delhi site:justdial.com'
 * Returns the first organic result URL, or "" if nothing found.
 */
async function resolveExactUrlWithSerper(
  businessName: string,
  directoryDomain: string,
  location: string,
): Promise<string> {
  if (!businessName || !directoryDomain) return "";

  // Build a pinpoint site-scoped Google query
  const siteScope = directoryDomain.replace(/\.$/, ""); // strip trailing dot
  const query     = `"${businessName}" ${location} site:${siteScope}`;

  try {
    const res = await fetch("https://google.serper.dev/search", {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY":    SERPER_API_KEY,
      },
      body: JSON.stringify({ q: query, num: 3 }),
    });

    if (!res.ok) return "";

    const data = await res.json();
    const firstResult = data.organic?.[0]?.link ?? "";

    // Only accept a URL that actually belongs to the target directory
    if (firstResult && firstResult.includes(siteScope)) {
      return firstResult;
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
    // KEY CHANGE: We now use Jina AI (r.jina.ai) to fetch page
    // content instead of Tavily Extract. Jina returns clean
    // Markdown that preserves [Link Text](https://...) format,
    // giving GPT REAL extractable hrefs — eliminating fake URLs.
    // ══════════════════════════════════════════════════════════
    console.log(`⛏️  [PHASE 4] Extracting ${targets.length} targets via Jina AI in batches of ${EXTRACT_BATCH_SIZE}…`);

    const allLeads: { lead: object; score: number; needsSerper?: { name: string; domain: string; location: string } }[] = [];
    const seenNames = new Set<string>();

    // Extract a rough location from the search query for Serper queries
    const locationHint = search_query.replace(/without websites?/gi, "").trim();

    for (let i = 0; i < targets.length; i += EXTRACT_BATCH_SIZE) {
      const batch    = targets.slice(i, i + EXTRACT_BATCH_SIZE);
      const batchNum = Math.floor(i / EXTRACT_BATCH_SIZE) + 1;
      const total    = Math.ceil(targets.length / EXTRACT_BATCH_SIZE);
      console.log(`  Batch ${batchNum}/${total}: ${batch.length} targets…`);

      const batchResults = await Promise.all(
        batch.map(async (target) => {
          try {
            // ── 4A: Fetch page via Jina AI ───────────────────
            // Jina returns Markdown with [Title](url) links intact,
            // which is exactly what GPT needs to extract real listing_urls.
            let content = "";
            const jinaMarkdown = await fetchPageWithJina(target.url);

            if (jinaMarkdown.length >= 200) {
              content = jinaMarkdown;
              console.log(`    📄 Jina OK: ${target.domain} (${jinaMarkdown.length} chars)`);
            } else {
              // Fallback: use the search snippet if Jina returned too little
              content = target.snippet;
              console.warn(`    ⚠️  Jina short for ${target.domain}, using snippet fallback.`);
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
The content below is Markdown rendered by Jina AI. Links appear as [Business Name](https://exact-url).
- Return EVERY business listed on this page as a SEPARATE object in the businesses array.
- If 15 businesses are listed, return 15 objects. Do NOT merge or skip any.
- Phones typically appear as "+91-XXXXXXXXXX", "098XXXXXXXX", or 10-digit strings near "Call"/"Tel"/"Ph".
- Include businesses even if they only have a name and phone — partial data is fine.

CRITICAL — listing_url extraction:
- For EACH business, find its INDIVIDUAL detail/profile page URL.
- In Jina Markdown, links look like: [Parikrama Restaurant](https://www.justdial.com/Delhi/Parikrama-...)
- The URL inside the parentheses is the real listing_url — copy it EXACTLY as written.
- On Justdial: URLs look like "justdial.com/Delhi/BusinessName-Near-Area/011PXX..."
- On Zomato: URLs look like "zomato.com/ncr/business-name-locality"
- On Sulekha: URLs look like "sulekha.com/business-name-city-contact"
- On Tripadvisor: URLs look like "tripadvisor.com/Restaurant_Review-..."
- On Yelp: URLs look like "yelp.com/biz/business-name-city"
- ONLY output listing_urls that you can literally see in the Markdown text.
- If you cannot find the individual URL, leave listing_url as "" — NEVER invent or guess URLs.
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
5. website: the business's OWN official website URL (not the directory URL). "" if not found.
6. listing_url: ONLY real URLs you can see in the content. Leave "" if not found — do NOT fabricate.
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

            const pageResults: { lead: object; score: number; needsSerper?: { name: string; domain: string; location: string } }[] = [];

            for (const biz of businesses) {
              const name = biz.company_name?.trim();
              if (!name) continue;

              const norm = normaliseName(name);
              if (seenNames.has(norm)) continue;
              seenNames.add(norm);

              const website = biz.website?.trim()
                ? biz.website.trim()
                : (target.isDirectory ? "" : target.url);

              // Resolve relative listing_url against source page
              let listing_url = "";
              if (target.isDirectory && biz.listing_url?.trim()) {
                const resolved = resolveUrl(biz.listing_url.trim(), target.url);
                // Only keep it if it's a real URL — not a fabricated one
                listing_url = isValidHttpUrl(resolved) ? resolved : "";
              }

              const source_url = target.url;
              const best_link  = listing_url || website || source_url;

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
                  listing_url,
                  source_url,
                  best_link,
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

              // Flag leads from directories that are missing listing_url for Serper repair
              const needsSerper = (target.isDirectory && !listing_url)
                ? { name, domain: target.domain, location: locationHint }
                : undefined;

              pageResults.push({ lead, score, needsSerper });
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

    // ══════════════════════════════════════════════════════════
    // PHASE 4.5 — SERPER SNIPER: Resolve missing listing URLs
    //
    // For any directory lead where GPT couldn't find the exact
    // profile URL (listing_url = ""), we ask Google via Serper
    // to find the real link. This eliminates the fallback of
    // storing a fake slug anchor as the clickable URL.
    // ══════════════════════════════════════════════════════════
    const leadsNeedingSniper = allLeads.filter((l) => l.needsSerper);
    if (leadsNeedingSniper.length > 0) {
      console.log(`🎯 [PHASE 4.5] Serper Sniper: resolving ${leadsNeedingSniper.length} missing URLs…`);

      // Fire all Serper lookups in parallel (they're cheap & fast)
      await Promise.all(
        leadsNeedingSniper.map(async (item) => {
          if (!item.needsSerper) return;
          const { name, domain, location } = item.needsSerper;

          const exactUrl = await resolveExactUrlWithSerper(name, domain, location);

          if (exactUrl) {
            // Patch the lead in-place
            const leadData = (item.lead as any).lead_data;
            leadData.listing_url = exactUrl;
            leadData.best_link   = exactUrl || leadData.website || leadData.source_url;
            item.score          += 8; // Award the same bonus as having a listing_url from extraction
            console.log(`    🔫 Sniper hit: "${name}" → ${exactUrl}`);
          } else {
            console.log(`    💨 Sniper miss: "${name}" on ${domain} — keeping source_url fallback.`);
          }
        })
      );

      console.log(`✅ [PHASE 4.5] Serper Sniper complete.`);
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