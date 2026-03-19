import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// ─── ENV ──────────────────────────────────────────────────────────────────────
const supabaseUrl        = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY     = Deno.env.get("OPENAI_API_KEY")!;
const PARALLEL_API_KEY   = Deno.env.get("PARALLEL_API_KEY")!;
const TAVILY_API_KEY     = Deno.env.get("TAVILY_API_KEY")!;
const JINA_API_KEY       = Deno.env.get("JINA_API_KEY")!;
const SERPER_API_KEY     = Deno.env.get("SERPER_API_KEY")!;

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const FINAL_OUTPUT_SIZE  = 20;
const EXTRACT_BATCH_SIZE = 5;
const MAX_DIR_PAGES      = 2;
const SUB_QUERY_COUNT    = 4;

// ─── LEAD RANK TIERS ─────────────────────────────────────────────────────────
// Tier 1 (best):  Has own website       → score bonus +50
// Tier 2 (good):  Has social media page → score bonus +25
// Tier 3 (basic): Neither               → score bonus +0
const TIER_WEBSITE      = "tier_1_website";
const TIER_SOCIAL_MEDIA = "tier_2_social_media";
const TIER_NONE         = "tier_3_none";

const TIER_SCORE_BONUS: Record<string, number> = {
  [TIER_WEBSITE]:      50,
  [TIER_SOCIAL_MEDIA]: 25,
  [TIER_NONE]:          0,
};

// ─── SOCIAL MEDIA DOMAINS ─────────────────────────────────────────────────────
// These are used to DETECT social media links (not to block them).
// A lead with an instagram.com link but no website = Tier 2.
const SOCIAL_MEDIA_DOMAINS = [
  "facebook.com", "fb.com", "fb.me",
  "instagram.com",
  "twitter.com", "x.com",
  "linkedin.com",
  "youtube.com", "youtu.be",
  "pinterest.com",
  "tiktok.com",
  "threads.net",
  "snapchat.com",
  "wa.me", "whatsapp.com",
  "t.me", "telegram.me",
];

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
  try { return new URL(href, pageUrl).href; }
  catch { return origin + "/" + href; }
}

function isValidHttpUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch { return false; }
}

/**
 * Check if a URL belongs to a social media platform.
 */
function isSocialMediaUrl(url: string): boolean {
  if (!url) return false;
  const host = safeHostname(url);
  if (!host) return false;
  return SOCIAL_MEDIA_DOMAINS.some((d) => host.includes(d));
}

/**
 * Check if a URL is a real business website (not a directory, not social media).
 */
function isRealBusinessWebsite(url: string): boolean {
  if (!url) return false;
  if (!isValidHttpUrl(url)) return false;
  const host = safeHostname(url);
  if (!host) return false;
  // Not a directory page
  if (isDirectory(host)) return false;
  // Not social media
  if (isSocialMediaUrl(url)) return false;
  // Not blocked
  if (isBlocked(host)) return false;
  return true;
}

/**
 * Determine the lead's rank tier based on available online presence.
 *
 * Tier 1: Has a real business website (own domain, not directory/social)
 * Tier 2: Has at least one social media page (Instagram, Facebook, etc.)
 * Tier 3: Neither — only directory listing or phone/address
 */
function classifyLeadTier(
  website: string,
  socialMediaLinks: string[],
): { tier: string; tierLabel: string } {
  // Tier 1: Has a real business website
  if (isRealBusinessWebsite(website)) {
    return { tier: TIER_WEBSITE, tierLabel: "Has Website" };
  }

  // Tier 2: Has at least one social media link
  const validSocials = socialMediaLinks.filter((url) => url && isSocialMediaUrl(url));
  if (validSocials.length > 0) {
    return { tier: TIER_SOCIAL_MEDIA, tierLabel: "Has Social Media" };
  }

  // Tier 3: Neither
  return { tier: TIER_NONE, tierLabel: "No Online Presence" };
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
async function fetchPageWithJina(url: string): Promise<string> {
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const res = await fetch(jinaUrl, {
      method: "GET",
      headers: {
        "Authorization":   `Bearer ${JINA_API_KEY}`,
        "Accept":          "text/plain",
        "X-Return-Format": "markdown",
        "X-Retain-Images": "none",
      },
    });

    if (!res.ok) {
      console.warn(`    Jina fetch failed for ${url}: ${res.status}`);
      return "";
    }

    return (await res.text()) ?? "";
  } catch (e) {
    console.warn(`    Jina fetch error for ${url}:`, (e as Error).message);
    return "";
  }
}

// ─── SERPER URL SNIPER ────────────────────────────────────────────────────────
async function resolveExactUrlWithSerper(
  businessName: string,
  directoryDomain: string,
  location: string,
): Promise<string> {
  if (!businessName || !directoryDomain) return "";

  const siteScope = directoryDomain.replace(/\.$/, "");
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

    if (firstResult && firstResult.includes(siteScope)) {
      return firstResult;
    }
    return "";
  } catch { return ""; }
}

/**
 * PHASE 4.75 — Serper lookup for business website + social media.
 *
 * For leads that don't already have a website or social media link,
 * search Google to find them. This upgrades Tier 3 leads to Tier 1 or 2.
 */
async function resolveWebsiteAndSocials(
  businessName: string,
  location: string,
): Promise<{ website: string; socialLinks: string[] }> {
  if (!businessName) return { website: "", socialLinks: [] };

  const query = `${businessName} ${location} official website`;

  try {
    const res = await fetch("https://google.serper.dev/search", {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY":    SERPER_API_KEY,
      },
      body: JSON.stringify({ q: query, num: 8 }),
    });

    if (!res.ok) return { website: "", socialLinks: [] };

    const data = await res.json();
    const organicResults = data.organic ?? [];

    let website = "";
    const socialLinks: string[] = [];

    for (const r of organicResults) {
      const url = r.link ?? "";
      if (!url) continue;
      const host = safeHostname(url);
      if (!host) continue;

      // Check if it's a social media page for this business
      if (isSocialMediaUrl(url)) {
        socialLinks.push(url);
        continue;
      }

      // Check if it's a real business website (not directory, not blocked)
      if (!website && isRealBusinessWebsite(url)) {
        website = url;
      }
    }

    // Also check knowledge graph / sitelinks from Serper
    const knowledgeGraph = data.knowledgeGraph;
    if (knowledgeGraph) {
      if (knowledgeGraph.website && !website) {
        if (isRealBusinessWebsite(knowledgeGraph.website)) {
          website = knowledgeGraph.website;
        }
      }
      // Social profiles from knowledge graph
      const profiles = knowledgeGraph.profiles ?? [];
      for (const p of profiles) {
        if (p.link && isSocialMediaUrl(p.link)) {
          socialLinks.push(p.link);
        }
      }
    }

    return { website, socialLinks: [...new Set(socialLinks)] };
  } catch {
    return { website: "", socialLinks: [] };
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

GROUP A — ${Math.ceil(SUB_QUERY_COUNT / 2)} queries targeting DIRECTORY / LISTING sites:
  Use these site names directly in queries:
  Justdial, Sulekha, Zomato, Magicpin, Tripadvisor, Yelp, Dineout, EazyDiner, Yellow Pages, LBB
  Format examples:
    "justdial [business type] [city/area] contact phone"
    "zomato [business type] [city] restaurants list"
  VARY the area/neighbourhood in each query.

GROUP B — ${Math.floor(SUB_QUERY_COUNT / 2)} queries targeting OFFICIAL / DIRECT business websites:
  Use specific neighbourhoods, business names if known, "official site", "contact us",
  "phone number", "email", "address".
  VARY keywords and areas.

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

    console.log(`🎯 [PHASE 3] ${targets.length} targets (${dirTargets.length} directory + ${directTargets.length} direct).`);

    // ══════════════════════════════════════════════════════════
    // PHASE 4 — EXTRACTION & SCORING
    //
    // GPT now also extracts social media links (instagram_url,
    // facebook_url, etc.) so we can classify leads into tiers.
    // ══════════════════════════════════════════════════════════
    console.log(`⛏️  [PHASE 4] Extracting via Jina AI…`);

    interface LeadEntry {
      lead: {
        preference_id: string;
        search_query:  string;
        domain:        string;
        lead_data:     Record<string, any>;
        status:        string;
      };
      score:       number;
      tier:        string;
      tierLabel:   string;
      needsSerper: { name: string; domain: string; location: string } | undefined;
      needsEnrichment: boolean;  // true if Tier 3 — try to find website/social via Serper
      businessName: string;
    }

    const allLeads: LeadEntry[] = [];
    const seenNames = new Set<string>();

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
            let content = "";
            const jinaMarkdown = await fetchPageWithJina(target.url);

            if (jinaMarkdown.length >= 200) {
              content = jinaMarkdown;
              console.log(`    📄 Jina OK: ${target.domain} (${jinaMarkdown.length} chars)`);
            } else {
              content = target.snippet;
              console.warn(`    ⚠️  Jina short for ${target.domain}, using snippet.`);
            }

            if (content.length < 80) {
              console.warn(`    ⚠️  ${target.domain}: too short, skipping.`);
              return [];
            }

            // ── 4B: GPT extraction ───────────────────────────
            // NOW extracts social media links alongside other fields
            const extracted = await gptJson<{
              businesses: {
                company_name:   string;
                address:        string;
                phone:          string;
                email:          string;
                website:        string;
                listing_url:    string;
                instagram_url:  string;
                facebook_url:   string;
                twitter_url:    string;
                youtube_url:    string;
                other_social_url: string;
                description:    string;
              }[];
            }>(
              [
                {
                  role: "system",
                  content: `You are a lead extraction assistant.

THE USER'S SEARCH: "${search_query}"
SOURCE PAGE URL: "${target.url}"

${target.isDirectory ? `THIS IS A DIRECTORY / LISTING PAGE (e.g. Justdial, Zomato, Sulekha, Tripadvisor, Yelp).
The content below is Markdown rendered by Jina AI. Links appear as [Text](https://...).
- Return EVERY business listed on this page as a SEPARATE object.
- If 15 businesses are listed, return 15 objects. Do NOT merge or skip any.
- Include businesses even if they only have a name and phone.

CRITICAL — listing_url extraction:
- For EACH business, find its INDIVIDUAL detail/profile page URL.
- In Jina Markdown, links look like: [Business Name](https://www.justdial.com/Delhi/Business-...)
- Copy the URL from parentheses EXACTLY as written.
- ONLY output listing_urls you can literally see in the content.
- If not found, leave listing_url as "" — NEVER invent URLs.
` : `THIS IS A DIRECT BUSINESS WEBSITE.
- Return exactly 1 object for this business.
- Extract every contact detail visible on the page.
- listing_url: "" (not applicable for direct sites).
`}
Rules:
1. company_name: the business name. REQUIRED.
2. phone: copy exactly as written. "" if not found.
3. email: extract if present. "" if not.
4. address: include area/locality/city. "" if not found.
5. website: the business's OWN official website URL (not directory, not social media). "" if not found.
6. listing_url: ONLY real URLs you see in the content. "" if not found.
7. instagram_url: the business's Instagram profile URL if visible. "" if not.
8. facebook_url: the business's Facebook page URL if visible. "" if not.
9. twitter_url: the business's Twitter/X profile URL if visible. "" if not.
10. youtube_url: the business's YouTube channel URL if visible. "" if not.
11. other_social_url: any other social media URL (LinkedIn, TikTok, Pinterest, etc.). "" if not.
12. description: one sentence about the business. "" if unknown.
13. NEVER invent data. Leave missing fields as "".

Return ONLY valid JSON:
{ "businesses": [
  { "company_name": "", "address": "", "phone": "", "email": "", "website": "", "listing_url": "", "instagram_url": "", "facebook_url": "", "twitter_url": "", "youtube_url": "", "other_social_url": "", "description": "" }
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

              const website = biz.website?.trim()
                ? biz.website.trim()
                : (target.isDirectory ? "" : target.url);

              // Resolve listing_url
              let listing_url = "";
              if (target.isDirectory && biz.listing_url?.trim()) {
                const resolved = resolveUrl(biz.listing_url.trim(), target.url);
                listing_url = isValidHttpUrl(resolved) ? resolved : "";
              }

              // Collect all social media URLs from extracted fields
              const socialMediaLinks: string[] = [
                biz.instagram_url?.trim()    ?? "",
                biz.facebook_url?.trim()     ?? "",
                biz.twitter_url?.trim()      ?? "",
                biz.youtube_url?.trim()       ?? "",
                biz.other_social_url?.trim() ?? "",
              ].filter((url) => url && isSocialMediaUrl(url));

              const source_url = target.url;
              const best_link  = listing_url || website || source_url;

              // ── CLASSIFY TIER ───────────────────────────────
              const { tier, tierLabel } = classifyLeadTier(website, socialMediaLinks);
              const tierBonus = TIER_SCORE_BONUS[tier] ?? 0;

              // Domain key for dedup
              const slug        = norm.replace(/\s+/g, "-").substring(0, 60);
              const websiteHost = website ? safeHostname(website) : null;
              const listingHost = listing_url ? safeHostname(listing_url) : null;

              const domainKey = websiteHost && isRealBusinessWebsite(website)
                ? websiteHost
                : listingHost
                  ? `${listingHost}#${slug}`
                  : target.isDirectory
                    ? `${target.domain}#${slug}`
                    : target.domain;

              const lead = {
                preference_id,
                search_query,
                domain: domainKey,
                lead_data: {
                  company_name:     name,
                  address:          biz.address?.trim()     ?? "",
                  phone:            biz.phone?.trim()        ?? "",
                  email:            biz.email?.trim()        ?? "",
                  website,
                  listing_url,
                  source_url,
                  best_link,
                  instagram_url:    biz.instagram_url?.trim()    ?? "",
                  facebook_url:     biz.facebook_url?.trim()     ?? "",
                  twitter_url:      biz.twitter_url?.trim()      ?? "",
                  youtube_url:      biz.youtube_url?.trim()      ?? "",
                  other_social_url: biz.other_social_url?.trim() ?? "",
                  social_media_links: socialMediaLinks,
                  tier,
                  tier_label:       tierLabel,
                  description:      biz.description?.trim()  ?? "",
                },
                status: "verified",
              };

              // ── SCORING ─────────────────────────────────────
              // Base score from data completeness
              const baseScore =
                (name                    ? 10 : 0) +
                (biz.phone?.trim()       ? 30 : 0) +
                (biz.email?.trim()       ? 30 : 0) +
                (biz.address?.trim()     ? 10 : 0) +
                (listing_url             ?  8 : 0) +
                (biz.description?.trim() ?  5 : 0);

              // Tier bonus dominates ranking:
              //   Tier 1 (website):      +50
              //   Tier 2 (social media): +25
              //   Tier 3 (neither):       +0
              const score = baseScore + tierBonus;

              // Flag for enrichment: Tier 3 leads might have a website
              // or social page that GPT didn't find — Serper can discover them
              const needsEnrichment = (tier === TIER_NONE);

              const needsSerper = (target.isDirectory && !listing_url)
                ? { name, domain: target.domain, location: locationHint }
                : undefined;

              pageResults.push({
                lead,
                score,
                tier,
                tierLabel,
                needsSerper,
                needsEnrichment,
                businessName: name,
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

    // ══════════════════════════════════════════════════════════
    // PHASE 4.5 — SERPER SNIPER: Resolve missing listing URLs
    // ══════════════════════════════════════════════════════════
    const leadsNeedingSniper = allLeads.filter((l) => l.needsSerper);
    if (leadsNeedingSniper.length > 0) {
      console.log(`🎯 [PHASE 4.5] Serper Sniper: resolving ${leadsNeedingSniper.length} missing listing URLs…`);

      await Promise.all(
        leadsNeedingSniper.map(async (item) => {
          if (!item.needsSerper) return;
          const { name, domain, location } = item.needsSerper;

          const exactUrl = await resolveExactUrlWithSerper(name, domain, location);

          if (exactUrl) {
            item.lead.lead_data.listing_url = exactUrl;
            item.lead.lead_data.best_link   = exactUrl || item.lead.lead_data.website || item.lead.lead_data.source_url;
            item.score += 8;
            console.log(`    🔫 Sniper hit: "${name}" → ${exactUrl}`);
          } else {
            console.log(`    💨 Sniper miss: "${name}" on ${domain}`);
          }
        })
      );

      console.log(`✅ [PHASE 4.5] Serper Sniper complete.`);
    }

    // ══════════════════════════════════════════════════════════
    // PHASE 4.75 — ENRICHMENT: Find website/social for Tier 3
    //
    // Tier 3 leads have no website and no social media.
    // We do a Google search per business to try to discover
    // their official site or social page, potentially upgrading
    // them to Tier 1 or Tier 2.
    // ══════════════════════════════════════════════════════════
    const tier3Leads = allLeads.filter((l) => l.needsEnrichment);
    if (tier3Leads.length > 0) {
      console.log(`🔍 [PHASE 4.75] Enriching ${tier3Leads.length} Tier 3 leads (finding websites/socials)…`);

      let upgradedToTier1 = 0;
      let upgradedToTier2 = 0;

      await Promise.all(
        tier3Leads.map(async (item) => {
          const { website: foundWebsite, socialLinks } = await resolveWebsiteAndSocials(
            item.businessName,
            locationHint,
          );

          const ld = item.lead.lead_data;

          // Update website if found
          if (foundWebsite && !isRealBusinessWebsite(ld.website)) {
            ld.website  = foundWebsite;
            ld.best_link = ld.listing_url || foundWebsite || ld.source_url;

            // Update domain key to real website
            const newHost = safeHostname(foundWebsite);
            if (newHost) {
              item.lead.domain = newHost;
            }
          }

          // Update social media links if found
          if (socialLinks.length > 0) {
            // Merge with any existing (unlikely for Tier 3 but safe)
            const existing = ld.social_media_links ?? [];
            const merged   = [...new Set([...existing, ...socialLinks])];
            ld.social_media_links = merged;

            // Fill individual fields if empty
            for (const url of socialLinks) {
              if (!ld.instagram_url && url.includes("instagram.com")) ld.instagram_url = url;
              if (!ld.facebook_url && url.includes("facebook.com"))   ld.facebook_url = url;
              if (!ld.twitter_url && (url.includes("twitter.com") || url.includes("x.com"))) ld.twitter_url = url;
              if (!ld.youtube_url && url.includes("youtube.com"))     ld.youtube_url = url;
            }
          }

          // Re-classify tier after enrichment
          const allSocials = ld.social_media_links ?? [];
          const { tier: newTier, tierLabel: newLabel } = classifyLeadTier(ld.website, allSocials);

          if (newTier !== item.tier) {
            // Adjust score: remove old tier bonus, add new one
            item.score -= TIER_SCORE_BONUS[item.tier] ?? 0;
            item.score += TIER_SCORE_BONUS[newTier] ?? 0;

            if (newTier === TIER_WEBSITE) upgradedToTier1++;
            if (newTier === TIER_SOCIAL_MEDIA) upgradedToTier2++;

            console.log(`    ⬆️  "${item.businessName}" upgraded: ${item.tierLabel} → ${newLabel}`);
          }

          item.tier      = newTier;
          item.tierLabel  = newLabel;
          ld.tier         = newTier;
          ld.tier_label   = newLabel;
        })
      );

      console.log(`✅ [PHASE 4.75] Enrichment complete: ${upgradedToTier1} → Tier 1, ${upgradedToTier2} → Tier 2.`);
    }

    // ══════════════════════════════════════════════════════════
    // FINAL SORT — Tier first, then score within tier
    //
    // This ensures:
    //   1. All Tier 1 (website) leads appear first
    //   2. All Tier 2 (social media) leads appear next
    //   3. All Tier 3 (neither) leads appear last
    //   Within each tier, leads are sorted by data completeness.
    // ══════════════════════════════════════════════════════════
    allLeads.sort((a, b) => {
      // Primary: tier ranking (tier string sorts lexically: tier_1 < tier_2 < tier_3)
      if (a.tier !== b.tier) return a.tier.localeCompare(b.tier);
      // Secondary: score within same tier (higher is better)
      return b.score - a.score;
    });

    const finalLeads = allLeads.slice(0, FINAL_OUTPUT_SIZE).map((x) => x.lead);

    // Log tier breakdown
    const tier1Count = allLeads.filter((l) => l.tier === TIER_WEBSITE).length;
    const tier2Count = allLeads.filter((l) => l.tier === TIER_SOCIAL_MEDIA).length;
    const tier3Count = allLeads.filter((l) => l.tier === TIER_NONE).length;

    console.log(`📊 [RANKING] Tier breakdown:`);
    console.log(`   🥇 Tier 1 (Has Website):      ${tier1Count}`);
    console.log(`   🥈 Tier 2 (Has Social Media):  ${tier2Count}`);
    console.log(`   🥉 Tier 3 (Neither):           ${tier3Count}`);
    console.log(`✅ [FINAL] ${allLeads.length} extracted → top ${finalLeads.length} selected.`);

    // ══════════════════════════════════════════════════════════
    // PHASE 5 — SAVE TO DATABASE
    // ══════════════════════════════════════════════════════════
    // ══════════════════════════════════════════════════════════
// PHASE 5 — SAVE TO DATABASE
// ══════════════════════════════════════════════════════════
if (finalLeads.length > 0) {
  console.log("💾 [PHASE 5] Saving leads…");

  // Deduplicate by domain — keep the first (highest-scored) lead per domain key
  const domainSeen = new Set<string>();
  const dedupedLeads = finalLeads.filter((lead: any) => {
    const key = lead.domain;
    if (domainSeen.has(key)) return false;
    domainSeen.add(key);
    return true;
  });

  console.log(`  ${finalLeads.length} leads → ${dedupedLeads.length} after domain dedup.`);

  const { data: inserted, error: leadsError } = await supabase
    .from("leads")
    .upsert(dedupedLeads, { onConflict: "domain" })
    .select("id");

  if (leadsError) console.error("  Leads upsert error:", leadsError.message);

  // ... rest of junction insert stays the same

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
        tier_breakdown: {
          tier_1_website:      tier1Count,
          tier_2_social_media: tier2Count,
          tier_3_none:         tier3Count,
        },
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