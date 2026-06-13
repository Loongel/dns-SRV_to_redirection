/**
 * 项目：dns-SRV_to_redirection / NATMap SRV Portal
 * 版本：0.2.0
 *
 * 项目介绍：
 * - 部署在 Cloudflare Worker，用 Cloudflare DNS 中的 SRV 记录作为“服务入口目录”。
 * - 访问受管 Web 域名时，按 SRV 记录重定向到真实目标域名和端口。
 * - 访问门户域名时，展示资源列表、搜索、跳转状态切换、端口刷新按钮。
 * - 端口刷新通过写入一个 Cloudflare TXT 队列记录通知 OpenWrt；OpenWrt 侧由 natmap 自定义脚本轮询该 TXT。
 * - 支持泛域名模板跳转：例如 newapi.s.example.com 可复用 web.s.example.com 的 SRV 端口，并把目标前缀替换为 newapi。
 * - 支持 _vless_fb 服务类型：表示 VLESS fallback，浏览器访问时按独立 HTTPS fallback 规则重定向。
 *
 * 环境变量说明：
 * - DOMAINS：受管域名匹配列表，逗号分隔，支持通配符；例：*.s.example.com
 * - PORTAL_DOMAIN：门户域名；例：s.example.com
 * - PORTAL_PASSWD：门户/API 密码；建议显式配置，不依赖代码默认值
 * - DEFAULT_REDIRECT_STATUS：默认跳转状态码，仅允许 301/302/307/308；默认 302
 * - CACHE_TTL_SECONDS：Cloudflare SRV 记录缓存秒数；默认 300
 * - SRV_MAX_AGE_SECONDS：可选，过滤过旧 SRV 记录；0 表示不过滤
 * - NATMAP_REFRESH_QUEUE_NAME：端口刷新 TXT 队列名；默认 _natmap-refresh.<PORTAL_DOMAIN>
 * - WILDCARD_TEMPLATE_HOSTNAME：泛域名跳转模板 SRV 主机名；默认 web.<PORTAL_DOMAIN>
 * - WILDCARD_TEMPLATE_TARGET_PREFIXES：允许替换的模板目标前缀；默认 web,portal
 * - TAILWIND_CDN_URL：门户 UI 使用的 Tailwind CDN 地址，默认 BootCDN
 * - DEBUG_MODE：true 时在页面展示脱敏调试信息
 *
 * Secret 示例：
 * - wrangler secret put CF_API_TOKEN
 * - wrangler secret put CF_ZONE_ID
 * - wrangler secret put PORTAL_PASSWD
 *
 * wrangler.toml 示例：
 * [vars]
 * DOMAINS = "*.s.example.com"
 * PORTAL_DOMAIN = "s.example.com"
 * DEFAULT_REDIRECT_STATUS = "302"
 * CACHE_TTL_SECONDS = "300"
 * NATMAP_REFRESH_QUEUE_NAME = "_natmap-refresh.s.example.com"
 * WILDCARD_TEMPLATE_HOSTNAME = "web.s.example.com"
 * WILDCARD_TEMPLATE_TARGET_PREFIXES = "web,portal"
 * TAILWIND_CDN_URL = "https://cdn.bootcdn.net/ajax/libs/tailwindcss-browser/4.1.13/index.global.min.js"
 */

export default {
  async fetch(request, env, ctx) {
    const config = initConfig(env);
    if (!config.domainList.length || !config.portalDomain) {
      return textResponse("Configuration error: DOMAINS and PORTAL_DOMAIN are required.", 500);
    }
    if (config.cfApiToken && config.cfZoneId) await ensureSrvRecordsCache(config);
    else initSrvCacheIfEmpty();

    const url = new URL(request.url);
    return url.hostname === config.portalDomain
      ? handlePortalPageWithAuth(request, config)
      : handleSrvRedirect(request, config);
  },
};

function initConfig(env) {
  // 统一解析 Worker 环境变量；这里不做远程 IO，便于每个请求快速构造配置。
  const domainList = (env.DOMAINS || "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  let portalDomain = (env.PORTAL_DOMAIN || "").trim().toLowerCase();
  if (!portalDomain) {
    const wildcard = domainList.find((d) => d.includes("*."));
    portalDomain = wildcard ? wildcard.replace("*.", "") : domainList[0] || "";
  }
  if (!globalThis.customRedirectModes) globalThis.customRedirectModes = {};
  return {
    domainList,
    portalDomain,
    cfApiToken: env.CF_API_TOKEN || "",
    cfZoneId: env.CF_ZONE_ID || "",
    portalPasswd: (env.PORTAL_PASSWD || "ABCCBA").trim(),
    debugMode: env.DEBUG_MODE === "true",
    defaultRedirectStatus: parseRedirectStatus(env.DEFAULT_REDIRECT_STATUS, 302),
    cacheTtl: parsePositiveInt(env.CACHE_TTL_SECONDS, 300),
    srvMaxAgeSeconds: parsePositiveInt(env.SRV_MAX_AGE_SECONDS, 0),
    refreshQueueName: (env.NATMAP_REFRESH_QUEUE_NAME || `_natmap-refresh.${portalDomain}`).trim().toLowerCase(),
    wildcardTemplateHostname: normalizeHostname(env.WILDCARD_TEMPLATE_HOSTNAME || `web.${portalDomain}`),
    wildcardTemplateTargetPrefixes: parseCsv(env.WILDCARD_TEMPLATE_TARGET_PREFIXES || "web,portal"),
    tailwindCdnUrl: (env.TAILWIND_CDN_URL || "https://cdn.bootcdn.net/ajax/libs/tailwindcss-browser/4.1.13/index.global.min.js").trim(),
  };
}

function parseRedirectStatus(value, fallback) {
  const status = parseInt(value, 10);
  return [301, 302, 307, 308].includes(status) ? status : fallback;
}
function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function normalizeHostname(value) {
  return String(value || "").trim().replace(/\.$/, "").toLowerCase();
}
function parseCsv(value) {
  return String(value || "").split(",").map((item) => item.trim().replace(/\.+$/, "").toLowerCase()).filter(Boolean);
}
function initSrvCacheIfEmpty() {
  // Cloudflare Worker isolate 可复用 globalThis，因此缓存放这里减少 API 调用。
  if (!globalThis.srvRecordsCache) {
    globalThis.srvRecordsCache = { data: [], fetchedAt: 0, sourceCount: 0, duplicateCount: 0, staleCount: 0, lastError: "" };
  }
}

function isRateLimited(key, limit, windowMs) {
  // 轻量内存限速：保护强制拉取和端口刷新 API，避免门户被刷爆 Cloudflare API。
  if (!globalThis.portalRateLimits) globalThis.portalRateLimits = new Map();
  const now = Date.now();
  const hits = (globalThis.portalRateLimits.get(key) || []).filter((ts) => now - ts < windowMs);
  if (hits.length >= limit) {
    globalThis.portalRateLimits.set(key, hits);
    return true;
  }
  hits.push(now);
  globalThis.portalRateLimits.set(key, hits);
  if (globalThis.portalRateLimits.size > 2000) {
    for (const [storedKey, storedHits] of globalThis.portalRateLimits) {
      if (!storedHits.some((ts) => now - ts < 300000)) globalThis.portalRateLimits.delete(storedKey);
      if (globalThis.portalRateLimits.size <= 1500) break;
    }
  }
  return false;
}
function clientKey(request) {
  return (request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown").split(",")[0].trim() || "unknown";
}
function canForceFetchSrv(request) {
  return !isRateLimited(`force-srv:${clientKey(request)}`, 25, 60000);
}
function canQueueRefresh(request, domain) {
  const client = clientKey(request);
  return !isRateLimited(`refresh-ip:${client}`, 10, 300000) && !isRateLimited(`refresh-domain:${domain}`, 1, 60000);
}

async function ensureSrvRecordsCache(config, options = {}) {
  // 读取并规范化 SRV 记录；force=true 时绕过 TTL，用于用户刷新或前端自动轮询。
  initSrvCacheIfEmpty();
  const now = Math.floor(Date.now() / 1000);
  if (!options.force && now - globalThis.srvRecordsCache.fetchedAt <= config.cacheTtl) return;
  const records = await fetchAllSrvRecords(config);
  if (!records) {
    globalThis.srvRecordsCache.lastError = "Cloudflare API request failed";
    return;
  }
  const normalized = normalizeSrvRecords(records, config);
  globalThis.srvRecordsCache = {
    data: normalized.records,
    fetchedAt: now,
    sourceCount: records.length,
    duplicateCount: normalized.duplicateCount,
    staleCount: normalized.staleCount,
    lastError: "",
  };
}

async function fetchAllSrvRecords(config) {
  const baseUrl = `https://api.cloudflare.com/client/v4/zones/${config.cfZoneId}/dns_records?type=SRV&per_page=100`;
  const allRecords = [];
  let page = 1;
  while (true) {
    const resp = await fetch(`${baseUrl}&page=${page}`, { method: "GET", headers: { Authorization: `Bearer ${config.cfApiToken}`, "Content-Type": "application/json" } });
    if (!resp.ok) return null;
    const json = await resp.json();
    if (!json.success) return null;
    allRecords.push(...(json.result || []));
    const info = json.result_info || {};
    if (!info.total_pages || info.page >= info.total_pages) break;
    page++;
  }
  return allRecords;
}

function normalizeSrvRecords(records, config) {
  // 同一个 hostname/service/protocol 只保留最新记录，避免 DDNS 异常留下重复 SRV。
  const now = Date.now();
  const newestByName = new Map();
  let staleCount = 0;
  let duplicateCount = 0;
  records.forEach((record, index) => {
    const parsed = parseCloudflareSrvRecord(record, index);
    if (!parsed || !matchesManagedDomain(parsed.hostname, config.domainList)) return;
    if (config.srvMaxAgeSeconds > 0 && parsed.updatedAt > 0) {
      const ageSeconds = Math.floor((now - parsed.updatedAt) / 1000);
      if (ageSeconds > config.srvMaxAgeSeconds) { staleCount++; return; }
    }
    const key = `${parsed.hostname}|${parsed.service}|${parsed.protocol}`;
    const current = newestByName.get(key);
    if (!current || compareSrvFreshness(parsed, current) < 0) {
      if (current) duplicateCount++;
      newestByName.set(key, parsed);
    } else duplicateCount++;
  });
  return { records: Array.from(newestByName.values()).sort(compareSrvDisplay), staleCount, duplicateCount };
}

function parseCloudflareSrvRecord(record, index) {
  const { service, protocol, hostname } = parseSrvName(record.name || "");
  const port = Number(record.data?.port || 0);
  const target = String(record.data?.target || "").replace(/\.$/, "").toLowerCase();
  if (!service || !protocol || !hostname || !target || !port) return null;
  const createdAt = Date.parse(record.created_on || "") || 0;
  const modifiedAt = Date.parse(record.modified_on || "") || 0;
  return { id: record.id || "", originalName: record.name || "", service, protocol, hostname: hostname.toLowerCase(), port, priority: Number(record.data?.priority || 0), weight: Number(record.data?.weight || 0), target, createdAt, modifiedAt, updatedAt: Math.max(createdAt, modifiedAt), order: index, raw: record };
}
function parseSrvName(name) {
  const parts = String(name).toLowerCase().split(".");
  if (parts.length < 3) return { service: "", protocol: "", hostname: name };
  return { service: parts[0], protocol: parts[1], hostname: parts.slice(2).join(".") };
}
function compareSrvFreshness(a, b) { return b.updatedAt - a.updatedAt || b.modifiedAt - a.modifiedAt || b.createdAt - a.createdAt || a.order - b.order; }
function compareSrvDisplay(a, b) { return a.hostname.localeCompare(b.hostname) || a.service.localeCompare(b.service) || a.protocol.localeCompare(b.protocol) || a.priority - b.priority || b.weight - a.weight; }

async function handlePortalPageWithAuth(request, config) {
  // 门户页兼容 GET 展示、表单 POST 更新跳转状态、表单 POST 触发端口刷新。
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return handlePortalApi(request, config);
  let userPwd = "";
  let domainToUpdate = "";
  let newRedirectStatus = "";
  let refreshDomain = "";
  let notice = "";
  if (request.method === "POST") {
    const formData = await request.formData();
    userPwd = String(formData.get("pwd") || "");
    domainToUpdate = String(formData.get("domain") || "");
    newRedirectStatus = String(formData.get("redirectStatus") || "");
    refreshDomain = String(formData.get("refreshDomain") || "").trim().toLowerCase();
  } else userPwd = url.searchParams.get("pwd") || "";
  if (userPwd !== config.portalPasswd) return buildPasswordForm(config);
  if (request.method === "GET") {
    notice = getPortalNotice(url.searchParams);
    if (url.searchParams.get("force") === "1" && canForceFetchSrv(request)) await ensureSrvRecordsCache(config, { force: true });
  }
  if (domainToUpdate && newRedirectStatus) {
    const status = parseRedirectStatus(newRedirectStatus, 0);
    if (status) {
      globalThis.customRedirectModes[domainToUpdate] = status;
      return redirectToPortal(url, userPwd, { saved: domainToUpdate });
    }
  }
  if (refreshDomain) {
    if (!canQueueRefresh(request, refreshDomain) || !canForceFetchSrv(request)) return redirectToPortal(url, userPwd, { refreshError: "操作太频繁，请稍后再试。" });
    await ensureSrvRecordsCache(config, { force: true });
    const managedRecords = getManagedSrvRecords(config);
    const exists = managedRecords.some((record) => record.hostname === refreshDomain);
    if (!exists) return redirectToPortal(url, userPwd, { refreshError: `未找到 ${refreshDomain} 对应的受管资源。` });
    const queued = await enqueueNatmapRefresh(refreshDomain, config);
    return redirectToPortal(url, userPwd, queued.ok ? { refreshQueued: refreshDomain } : { refreshError: `端口刷新请求提交失败：${queued.error}` });
  }
  const managedRecords = getManagedSrvRecords(config);
  return buildPortalPageHTML(managedRecords.map((r) => buildResource(r, config)), config, userPwd, notice);
}
async function handlePortalApi(request, config) {
  // 前端异步接口：资源轮询只读，端口刷新写 TXT 队列，二者都必须带门户密码。
  const url = new URL(request.url);
  if (url.pathname === "/api/resources" && request.method === "GET") {
    const pwd = url.searchParams.get("pwd") || "";
    if (pwd !== config.portalPasswd) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    const force = url.searchParams.get("force") === "1";
    if (force && !canForceFetchSrv(request)) return jsonResponse({ ok: false, error: "rate limited" }, 429);
    await ensureSrvRecordsCache(config, { force });
    const resources = getManagedSrvRecords(config).map((r) => buildResource(r, config));
    const cache = globalThis.srvRecordsCache || {};
    return jsonResponse({ ok: true, resources, cache: { fetchedAt: cache.fetchedAt || 0, duplicateCount: cache.duplicateCount || 0, staleCount: cache.staleCount || 0, lastError: cache.lastError || "" } });
  }
  if (url.pathname === "/api/refresh" && request.method === "POST") {
    const payload = await readRequestPayload(request);
    const pwd = String(payload.pwd || "");
    if (pwd !== config.portalPasswd) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    const domain = String(payload.domain || payload.refreshDomain || "").trim().toLowerCase();
    if (!domain) return jsonResponse({ ok: false, error: "missing domain" }, 400);
    if (!canQueueRefresh(request, domain)) return jsonResponse({ ok: false, error: "rate limited" }, 429);
    if (!canForceFetchSrv(request)) return jsonResponse({ ok: false, error: "rate limited" }, 429);
    await ensureSrvRecordsCache(config, { force: true });
    const record = getManagedSrvRecords(config).find((r) => r.hostname === domain);
    if (!record) return jsonResponse({ ok: false, error: "未找到对应的受管资源" }, 404);
    const queued = await enqueueNatmapRefresh(domain, config);
    if (!queued.ok) return jsonResponse({ ok: false, error: queued.error }, 502);
    return jsonResponse({ ok: true, domain, oldPort: record.port, queuedAt: new Date().toISOString() });
  }
  return jsonResponse({ ok: false, error: "not found" }, 404);
}
async function readRequestPayload(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) return request.json();
  const formData = await request.formData();
  return Object.fromEntries(formData.entries());
}
function getPortalNotice(params) {
  if (params.get("saved")) return `${params.get("saved")} 的跳转方式已更新。`;
  if (params.get("refreshQueued")) return `${params.get("refreshQueued")} 的端口刷新请求已提交。页面会自动检查新端口。`;
  if (params.get("refreshError")) return params.get("refreshError");
  return "";
}
function redirectToPortal(url, pwd, params = {}) {
  const dest = new URL(url.origin + url.pathname);
  dest.searchParams.set("pwd", pwd);
  Object.entries(params).forEach(([key, value]) => {
    if (value) dest.searchParams.set(key, value);
  });
  return new Response(null, { status: 303, headers: { Location: dest.toString(), "Cache-Control": "no-store" } });
}
function getManagedSrvRecords(config) { return (globalThis.srvRecordsCache?.data || []).filter((r) => matchesManagedDomain(r.hostname, config.domainList)); }
function matchesManagedDomain(hostname, domainList) { return domainList.some((pattern) => wildcardToRegex(pattern).test(hostname)); }
function buildResource(record, config) {
  // 将 SRV 原始记录转换成门户直接渲染的数据结构。
  const web = getWebServiceRedirect(record, config);
  const vlessFallback = getVlessFallbackRedirect(record, config);
  const redirect = web.isWeb ? web : vlessFallback;
  const target = redirect.canRedirect ? redirect.target : record.target;
  const link = redirect.canRedirect ? `${redirect.scheme}://${target}:${record.port}` : getLocalSchemeLink(record.service, record.protocol, record.target, record.port);
  return { domain: record.hostname, service: record.service, protocol: record.protocol, target, port: record.port, link, isWeb: web.isWeb, isVlessFallback: vlessFallback.canRedirect, updatedAt: record.updatedAt, updatedIso: record.updatedAt ? new Date(record.updatedAt).toISOString() : "", updatedLabel: formatRecordTime(record.updatedAt), redirectStatus: globalThis.customRedirectModes[record.hostname] || config.defaultRedirectStatus, raw: config.debugMode ? record.raw : undefined };
}

function getPageHead(title, config = {}) {
  // UI 只使用 Tailwind CDN，不内联自定义 CSS，方便 Worker 单文件部署。
  const tailwind = config.tailwindCdnUrl
    ? `<script src="${escapeAttribute(config.tailwindCdnUrl)}"></script>`
    : "";
  return `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>${tailwind}</head>`;
}

function buildPasswordForm(config = {}) {
  const debugMsg = config.debugMode ? `<p class="mt-3 text-sm text-amber-200/60">DEBUG: password missing or incorrect.</p>` : "";
  return htmlResponse(`<!doctype html><html lang="zh-CN">${getPageHead("访问受限", config)}<body class="min-h-screen bg-zinc-950 text-zinc-100 antialiased"><main class="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top,rgba(251,191,36,0.16),transparent_34%)] px-4 py-8"><section class="w-full max-w-sm rounded-2xl border border-amber-300/20 bg-zinc-950/85 p-6 shadow-2xl shadow-black/70 ring-1 ring-amber-100/5 backdrop-blur"><div class="mb-5 inline-flex h-10 min-w-14 items-center justify-center rounded-xl border border-amber-300/25 bg-amber-300/10 px-3 text-sm font-black text-amber-300">SRV</div><h1 class="text-2xl font-bold tracking-tight text-zinc-50">访问受限</h1><form method="POST" class="mt-6 grid gap-3"><input class="h-11 rounded-xl border border-amber-300/20 bg-black/35 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-amber-300/70 focus:ring-4 focus:ring-amber-300/10" type="password" name="pwd" placeholder="输入密码" required autocomplete="current-password"><button type="submit" class="h-11 rounded-xl bg-amber-300 px-4 text-sm font-semibold text-zinc-950 transition hover:bg-amber-200 focus:outline-none focus:ring-4 focus:ring-amber-300/20">提交</button></form>${debugMsg}</section></main></body></html>`);
}
function buildPortalPageHTML(resources, config, userPwd, notice = "") {
  const cache = globalThis.srvRecordsCache || {};
  const warnings = [];
  if (!config.cfApiToken || !config.cfZoneId) warnings.push("缺少 Cloudflare API 配置，无法自动扫描 SRV。");
  if (cache.lastError) warnings.push(cache.lastError);
  const rows = resources.map((r) => buildResourceRow(r, userPwd)).join("");
  const cards = resources.map((r) => buildResourceCard(r, userPwd)).join("");
  const debug = config.debugMode ? buildDebugBlock(resources, config) : "";
  const emptyState = resources.length ? "" : `<section class="rounded-2xl border border-dashed border-amber-300/25 bg-zinc-900/60 px-5 py-10 text-center text-sm text-zinc-400">未找到匹配的 SRV 记录。</section>`;
  const warningHtml = warnings.map((w) => `<section class="rounded-2xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">${escapeHtml(w)}</section>`).join("");
  const noticeHtml = notice ? `<section class="rounded-2xl border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-sm font-medium text-amber-100">${escapeHtml(notice)}</section>` : "";
  return htmlResponse(`<!doctype html><html lang="zh-CN">${getPageHead("资源门户", config)}<body class="min-h-screen bg-zinc-950 text-zinc-100 antialiased"><main class="mx-auto flex w-full max-w-7xl flex-col gap-5 bg-[radial-gradient(circle_at_top_left,rgba(251,191,36,0.12),transparent_32%)] px-4 py-5 sm:px-6 lg:px-8"><header class="flex flex-col gap-5 rounded-3xl border border-amber-300/20 bg-zinc-950/80 p-5 shadow-2xl shadow-black/50 ring-1 ring-amber-100/5 backdrop-blur sm:flex-row sm:items-end sm:justify-between"><div class="min-w-0"><p class="text-xs font-semibold uppercase tracking-wider text-amber-300">NATMap SRV Portal</p><h1 class="mt-1 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">资源门户</h1></div><div class="grid grid-cols-3 gap-2 text-center sm:min-w-80"><span class="rounded-2xl border border-amber-300/20 bg-black/30 px-3 py-2"><strong class="block text-lg font-bold text-amber-200">${resources.length}</strong><span class="text-xs text-zinc-500">可用</span></span><span class="rounded-2xl border border-amber-300/20 bg-black/30 px-3 py-2"><strong class="block text-lg font-bold text-amber-200">${cache.duplicateCount || 0}</strong><span class="text-xs text-zinc-500">折叠</span></span><span class="rounded-2xl border border-amber-300/20 bg-black/30 px-3 py-2"><strong class="block text-lg font-bold text-amber-200">${formatCacheTime(cache.fetchedAt)}</strong><span class="text-xs text-zinc-500">更新</span></span></div></header>${noticeHtml}${warningHtml}${emptyState}<section class="rounded-2xl border border-amber-300/15 bg-zinc-950/70 p-4 shadow-lg shadow-black/30 ring-1 ring-white/5"><label class="flex w-full flex-col gap-2 md:max-w-2xl"><span class="text-xs font-semibold text-zinc-500">搜索</span><input id="resourceSearch" class="h-11 rounded-xl border border-amber-300/20 bg-black/35 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-amber-300/70 focus:ring-4 focus:ring-amber-300/10" type="search" placeholder="输入域名、服务、端口或目标" autocomplete="off"></label></section><section class="hidden overflow-hidden rounded-2xl border border-amber-300/15 bg-zinc-950/75 shadow-2xl shadow-black/40 ring-1 ring-white/5 xl:block"><div class="overflow-x-auto"><table class="w-full min-w-[1120px] table-fixed border-collapse"><colgroup><col class="w-[18%]"><col class="w-[10%]"><col class="w-[15%]"><col class="w-[7%]"><col class="w-[12%]"><col class="w-[17%]"><col class="w-[11%]"><col class="w-[10%]"></colgroup><thead class="bg-black/45 text-xs font-semibold uppercase tracking-wide text-zinc-500"><tr><th class="px-4 py-3 text-left">域名</th><th class="px-4 py-3 text-left">服务</th><th class="px-4 py-3 text-left">目标</th><th class="px-4 py-3 text-left">端口</th><th class="px-4 py-3 text-left">记录时间</th><th class="px-4 py-3 text-left">链接</th><th class="px-4 py-3 text-left">跳转</th><th class="px-4 py-3 text-left">刷新</th></tr></thead><tbody class="divide-y divide-amber-300/10 text-sm">${rows}</tbody></table></div></section><section class="grid gap-3 md:grid-cols-2 xl:hidden">${cards}</section>${debug}<script>${getPortalScript()}</script></main></body></html>`);
}
function buildResourceRow(r, userPwd) {
  const search = `${r.domain} ${r.service} ${r.protocol} ${r.target} ${r.port}`.toLowerCase();
  return `<tr class="bg-zinc-900/70 transition hover:bg-zinc-800/80" data-search="${escapeAttribute(search)}" data-domain="${escapeAttribute(r.domain)}" data-port="${r.port}"><td class="px-4 py-3 align-middle"><span class="block truncate font-semibold text-zinc-50" title="${escapeAttribute(r.domain)}">${escapeHtml(r.domain)}</span></td><td class="px-4 py-3 align-middle"><div class="flex items-center gap-2"><span class="inline-flex h-7 items-center rounded-full border border-amber-300/25 bg-amber-300/10 px-2.5 text-xs font-semibold text-amber-200">${escapeHtml(r.service.replace(/^_/, ""))}</span><span class="text-xs text-zinc-500">${escapeHtml(r.protocol)}</span></div></td><td class="px-4 py-3 align-middle"><span class="block truncate text-zinc-300" title="${escapeAttribute(r.target)}">${escapeHtml(r.target)}</span></td><td class="px-4 py-3 align-middle"><code class="rounded-lg border border-amber-300/15 bg-black/30 px-2 py-1 font-mono text-sm font-semibold text-amber-200">${r.port}</code></td><td class="px-4 py-3 align-middle"><span class="time text-sm text-zinc-500" data-time="${escapeAttribute(r.updatedIso)}">${escapeHtml(r.updatedLabel)}</span></td><td class="px-4 py-3 align-middle">${buildLinkHtml(r)}</td><td class="px-4 py-3 align-middle">${buildRedirectForm(r, userPwd)}</td><td class="px-4 py-3 align-middle">${buildRefreshForm(r, userPwd)}</td></tr>`;
}
function buildResourceCard(r, userPwd) {
  const search = `${r.domain} ${r.service} ${r.protocol} ${r.target} ${r.port}`.toLowerCase();
  return `<article class="rounded-2xl border border-amber-300/15 bg-zinc-950/75 p-4 shadow-lg shadow-black/30 ring-1 ring-white/5" data-search="${escapeAttribute(search)}" data-domain="${escapeAttribute(r.domain)}" data-port="${r.port}"><div class="flex items-start justify-between gap-3"><div class="min-w-0"><h2 class="truncate text-base font-bold text-zinc-50">${escapeHtml(r.domain)}</h2><p class="mt-1 break-all text-sm text-zinc-500">${escapeHtml(r.target)}:${r.port}</p></div><span class="shrink-0 rounded-full border border-amber-300/25 bg-amber-300/10 px-2.5 py-1 text-xs font-semibold text-amber-200">${escapeHtml(r.service.replace(/^_/, ""))}</span></div><dl class="mt-4 grid gap-2 text-sm"><div class="grid grid-cols-[4rem_minmax(0,1fr)] gap-2"><dt class="text-zinc-500">协议</dt><dd class="min-w-0 text-zinc-300">${escapeHtml(r.protocol)}</dd></div><div class="grid grid-cols-[4rem_minmax(0,1fr)] gap-2"><dt class="text-zinc-500">记录</dt><dd class="min-w-0 text-zinc-300"><span class="time" data-time="${escapeAttribute(r.updatedIso)}">${escapeHtml(r.updatedLabel)}</span></dd></div><div class="grid grid-cols-[4rem_minmax(0,1fr)] gap-2"><dt class="text-zinc-500">链接</dt><dd class="min-w-0">${buildLinkHtml(r)}</dd></div></dl><div class="mt-4 grid grid-cols-[minmax(0,1fr)_6rem] gap-2">${buildRedirectForm(r, userPwd)}${buildRefreshForm(r, userPwd)}</div></article>`;
}
function buildLinkHtml(r) { return r.link ? `<a class="block truncate text-sm font-semibold text-amber-200 underline decoration-amber-300/50 underline-offset-4 hover:text-amber-100" href="${escapeAttribute(r.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.link)}</a>` : `<span class="block truncate text-sm text-zinc-500">${escapeHtml(r.target)}:${r.port}</span>`; }
function buildRedirectForm(r, userPwd) {
  const labels = { 301: "301 永久", 302: "302 临时", 307: "307 临时", 308: "308 永久" };
  const current = Number(r.redirectStatus);
  const options = [301, 302, 307, 308].map((code) => `<option value="${code}"${code === current ? " selected" : ""}>${labels[code]}</option>`).join("");
  return `<form method="POST" class="redirect-form"><input type="hidden" name="pwd" value="${escapeAttribute(userPwd)}"><input type="hidden" name="domain" value="${escapeAttribute(r.domain)}"><select class="h-9 w-full min-w-0 rounded-xl border border-amber-300/25 bg-black/40 px-2 text-sm font-semibold text-amber-100 outline-none transition focus:border-amber-300/70 focus:ring-4 focus:ring-amber-300/10" name="redirectStatus" data-current="${current}" aria-label="redirect status">${options}</select></form>`;
}
function buildRefreshForm(r, userPwd) {
  return `<form method="POST" class="refresh-form"><input type="hidden" name="pwd" value="${escapeAttribute(userPwd)}"><input type="hidden" name="refreshDomain" value="${escapeAttribute(r.domain)}"><input type="hidden" name="currentPort" value="${r.port}"><button class="h-9 w-full rounded-xl border border-amber-300/30 bg-amber-300/10 px-2 text-xs font-semibold text-amber-200 transition hover:bg-amber-300/20 disabled:cursor-wait disabled:opacity-60" type="submit" title="请求 OpenWrt 为该资源重新打洞换端口" aria-label="刷新 ${escapeAttribute(r.domain)} 的端口">刷新</button></form>`;
}
function getPortalScript() {
  // 门户前端逻辑：本地时区显示、搜索过滤、端口刷新轮询、跳转状态确认。
  return `(() => {
  const renderLocalTimes = () => {
    const formatter = new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
    const labelFor = (date) => {
      const parts = Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
      return parts.year + '-' + parts.month + '-' + parts.day + ' ' + parts.hour + ':' + parts.minute;
    };
    document.querySelectorAll('.time[data-time]').forEach((el) => {
      const raw = el.dataset.time;
      if (!raw) return;
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) return;
      el.textContent = labelFor(date);
      el.title = '浏览器时区：' + zone + '；原始时间：' + raw;
    });
  };
  renderLocalTimes();

  const input = document.getElementById('resourceSearch');
  const items = Array.from(document.querySelectorAll('[data-search]'));
  if (input) {
    const empty = document.createElement('section');
    empty.className = 'search-empty rounded-2xl border border-dashed border-amber-300/25 bg-zinc-900/60 px-5 py-10 text-center text-sm text-zinc-500';
    empty.textContent = '没有匹配的资源。';
    empty.hidden = true;
    document.querySelector('main').appendChild(empty);
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      for (const item of items) {
        const ok = !q || item.dataset.search.includes(q);
        item.hidden = !ok;
        if (ok) shown += 1;
      }
      empty.hidden = shown !== 0;
    });
  }

  const getPwd = () => {
    const hidden = document.querySelector('input[name="pwd"]');
    return hidden ? hidden.value : new URLSearchParams(location.search).get('pwd') || '';
  };
  const resourceSignature = (resources) => resources.map((r) => r.domain + ':' + r.port).sort().join('|');
  let pageSignature = resourceSignature(Array.from(document.querySelectorAll('[data-domain]')).map((el) => ({ domain: el.dataset.domain, port: el.dataset.port, updatedIso: '' })));
  let activeRefresh = null;

  const buildApiUrl = (path, extra = {}) => {
    const url = new URL(path, location.origin);
    url.searchParams.set('pwd', getPwd());
    Object.entries(extra).forEach(([key, value]) => url.searchParams.set(key, value));
    return url;
  };
  const refreshCard = (() => {
    const wrap = document.createElement('section');
    wrap.className = 'refresh-card fixed inset-x-4 bottom-4 z-20 grid max-w-md grid-cols-[2rem_minmax(0,1fr)_1.75rem] items-center gap-3 rounded-2xl border border-amber-300/25 bg-zinc-900/95 p-4 shadow-2xl shadow-black/40 ring-1 ring-white/5 sm:left-auto sm:right-6 sm:bottom-6 sm:w-[26rem]';
    wrap.hidden = true;
    wrap.innerHTML = '<div class="refresh-spinner h-7 w-7 animate-spin rounded-full border-[3px] border-amber-300/20 border-t-amber-300 text-[10px] font-bold leading-7 text-amber-200" aria-hidden="true"></div><div class="min-w-0"><strong class="block text-sm font-semibold text-zinc-50"></strong><p class="mt-1 text-sm leading-5 text-zinc-400"></p></div><button type="button" class="grid h-7 w-7 place-items-center rounded-lg bg-white/10 text-lg leading-none text-zinc-400 transition hover:bg-white/15 hover:text-zinc-100" aria-label="关闭">×</button>';
    document.body.appendChild(wrap);
    wrap.querySelector('button').addEventListener('click', () => { wrap.hidden = true; });
    return wrap;
  })();
  const showRefreshCard = (title, detail, done = false) => {
    refreshCard.querySelector('strong').textContent = title;
    refreshCard.querySelector('p').textContent = detail;
    const spinner = refreshCard.querySelector('.refresh-spinner');
    if (spinner) {
      spinner.textContent = done ? 'OK' : '';
      spinner.className = done
        ? 'refresh-spinner grid h-7 w-7 place-items-center rounded-full border border-amber-300/30 bg-amber-300/10 text-[10px] font-bold text-amber-200'
        : 'refresh-spinner h-7 w-7 animate-spin rounded-full border-[3px] border-amber-300/20 border-t-amber-300 text-[10px] font-bold leading-7 text-amber-200';
    }
    refreshCard.hidden = false;
  };
  const pollResources = async () => {
    const resp = await fetch(buildApiUrl('/api/resources', { force: '1', t: Date.now() }), { cache: 'no-store' });
    const json = await resp.json();
    if (!resp.ok || !json.ok) throw new Error(json.error || '资源列表刷新失败');
    return json.resources || [];
  };
  const pollForPortChange = async (domain, oldPort) => {
    const started = Date.now();
    const tick = async () => {
      try {
        const resources = await pollResources();
        const current = resources.find((r) => r.domain === domain);
        if (current && String(current.port) !== String(oldPort)) {
          showRefreshCard('端口已更新', domain + ' 已切换到 ' + current.port + '，页面正在更新。', true);
          window.setTimeout(() => location.replace(location.pathname + '?pwd=' + encodeURIComponent(getPwd()) + '&force=1'), 700);
          return;
        }
        const elapsed = Math.floor((Date.now() - started) / 1000);
        const left = Math.max(0, 45 - elapsed);
        if (elapsed >= 45) {
          showRefreshCard('已提交刷新请求', 'OpenWrt 可能仍在处理，页面会继续自动检查新数据。', true);
          activeRefresh = null;
          return;
        }
        showRefreshCard('等待 OpenWrt 换端口', domain + ' 正在轮询新 SRV 记录，约 ' + left + ' 秒内完成。');
        activeRefresh = window.setTimeout(tick, 3000);
      } catch (err) {
        showRefreshCard('检查失败', err.message || '请稍后再查看。', true);
        activeRefresh = null;
      }
    };
    activeRefresh = window.setTimeout(tick, 2500);
  };
  const queuedFromUrl = new URLSearchParams(location.search).get('refreshQueued');
  if (queuedFromUrl) {
    const current = items.find((el) => el.dataset.domain === queuedFromUrl);
    const oldPort = current ? current.dataset.port : '';
    showRefreshCard('等待 OpenWrt 换端口', queuedFromUrl + ' 的端口刷新请求已提交，正在检查新 SRV 记录。');
    pollForPortChange(queuedFromUrl, oldPort);
  }

  const redirectConfirm = (() => {
    const overlay = document.createElement('section');
    overlay.className = 'redirect-confirm fixed inset-0 z-30 hidden items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center';
    overlay.innerHTML = '<div class="w-full max-w-md rounded-2xl border border-amber-300/25 bg-zinc-950 p-5 shadow-2xl shadow-black/70 ring-1 ring-amber-100/10"><div class="flex items-start justify-between gap-4"><div class="min-w-0"><p class="text-xs font-semibold uppercase tracking-wider text-amber-300">Redirect Mode</p><h2 class="mt-1 text-lg font-bold text-zinc-50">确认跳转状态</h2></div><button type="button" class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/10 text-lg leading-none text-zinc-400 transition hover:bg-white/15 hover:text-zinc-100" data-cancel aria-label="关闭">×</button></div><p class="mt-4 break-all text-sm leading-6 text-zinc-300" data-message></p><div class="mt-5 grid grid-cols-2 gap-2"><button type="button" class="h-10 rounded-xl border border-amber-300/20 bg-black/30 px-3 text-sm font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-zinc-100" data-cancel>取消</button><button type="button" class="h-10 rounded-xl bg-amber-300 px-3 text-sm font-semibold text-zinc-950 transition hover:bg-amber-200 focus:outline-none focus:ring-4 focus:ring-amber-300/20" data-confirm>确认更新</button></div></div>';
    document.body.appendChild(overlay);
    const message = overlay.querySelector('[data-message]');
    const confirmButton = overlay.querySelector('[data-confirm]');
    let pending = null;
    const close = (restore) => {
      if (restore && pending) pending.select.value = pending.previous;
      pending = null;
      overlay.classList.add('hidden');
      overlay.classList.remove('flex');
    };
    overlay.querySelectorAll('[data-cancel]').forEach((button) => button.addEventListener('click', () => close(true)));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(true);
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !overlay.classList.contains('hidden')) close(true);
    });
    confirmButton.addEventListener('click', () => {
      if (!pending) return;
      const { form, select, next } = pending;
      select.dataset.current = next;
      pending = null;
      overlay.classList.add('hidden');
      overlay.classList.remove('flex');
      form.requestSubmit ? form.requestSubmit() : form.submit();
    });
    return {
      open(nextPending) {
        pending = nextPending;
        message.textContent = '将 ' + pending.domain + ' 的跳转状态改为 ' + pending.label + '。';
        overlay.classList.remove('hidden');
        overlay.classList.add('flex');
        confirmButton.focus();
      }
    };
  })();

  document.querySelectorAll('.redirect-form select').forEach((select) => {
    select.addEventListener('change', () => {
      const form = select.form;
      const domain = form.querySelector('input[name="domain"]').value;
      const previous = select.dataset.current || select.defaultValue;
      const next = select.value;
      if (next === previous) return;
      const label = select.options[select.selectedIndex] ? select.options[select.selectedIndex].textContent : next;
      redirectConfirm.open({ form, select, domain, previous, next, label });
    });
  });

  document.querySelectorAll('.refresh-form').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (activeRefresh) window.clearTimeout(activeRefresh);
      const button = form.querySelector('button');
      const domain = form.querySelector('input[name="refreshDomain"]').value;
      const currentPort = form.querySelector('input[name="currentPort"]').value;
      button.disabled = true;
      showRefreshCard('正在提交刷新', domain + ' 当前端口 ' + currentPort + '，等待 OpenWrt 下一轮轮询。');
      try {
        const resp = await fetch('/api/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pwd: getPwd(), domain, currentPort }),
          cache: 'no-store'
        });
        const json = await resp.json();
        if (!resp.ok || !json.ok) throw new Error(json.error || '提交失败');
        pollForPortChange(domain, currentPort);
      } catch (err) {
        showRefreshCard('提交失败', err.message || '请稍后重试。', true);
      } finally {
        window.setTimeout(() => { button.disabled = false; }, 1200);
      }
    });
  });
  window.setInterval(async () => {
    if (document.hidden || activeRefresh) return;
    try {
      const resources = await pollResources();
      const nextSignature = resourceSignature(resources);
      if (nextSignature && pageSignature && nextSignature !== pageSignature) location.replace(location.pathname + '?pwd=' + encodeURIComponent(getPwd()) + '&force=1');
    } catch (_) {}
  }, 60000);
})();`;
}
function buildDebugBlock(resources, config) {
  const safeConfig = { ...config, cfApiToken: config.cfApiToken ? "***" : "", portalPasswd: config.portalPasswd ? "***" : "" };
  return `<section class="rounded-2xl border border-amber-300/15 bg-zinc-900/90 p-4 shadow-lg shadow-black/20"><h2 class="text-sm font-semibold text-amber-200">DEBUG</h2><pre class="mt-3 max-h-96 overflow-auto rounded-xl border border-amber-300/10 bg-black/60 p-4 text-xs leading-5 text-zinc-300">${escapeHtml(JSON.stringify({ config: safeConfig, resources }, null, 2))}</pre></section>`;
}

async function enqueueNatmapRefresh(domain, config) {
  // 写入单条 TXT 队列记录；OpenWrt 侧轮询 DNS TXT 后执行对应 natmap section 的随机端口刷新。
  if (!config.cfApiToken || !config.cfZoneId) return { ok: false, error: "缺少 Cloudflare API 配置" };
  const content = `${domain}|${Date.now()}|${crypto.randomUUID()}`;
  const apiBase = `https://api.cloudflare.com/client/v4/zones/${config.cfZoneId}/dns_records`;
  const headers = { Authorization: `Bearer ${config.cfApiToken}`, "Content-Type": "application/json" };
  const listUrl = `${apiBase}?type=TXT&name=${encodeURIComponent(config.refreshQueueName)}&per_page=100`;
  const listResp = await fetch(listUrl, { headers });
  if (!listResp.ok) return { ok: false, error: `Cloudflare TXT 查询失败 ${listResp.status}` };
  const listJson = await listResp.json();
  if (!listJson.success) return { ok: false, error: "Cloudflare TXT 查询失败" };
  const existingRecords = listJson.result || [];
  for (const record of existingRecords) {
    const deleteResp = await fetch(`${apiBase}/${record.id}`, { method: "DELETE", headers });
    if (!deleteResp.ok) return { ok: false, error: `Cloudflare TXT 清理失败 ${deleteResp.status}` };
    const deleteJson = await deleteResp.json();
    if (!deleteJson.success) return { ok: false, error: "Cloudflare TXT 清理失败" };
  }
  const body = JSON.stringify({ type: "TXT", name: config.refreshQueueName, content, ttl: 60, proxied: false });
  const saveResp = await fetch(apiBase, { method: "POST", headers, body });
  if (!saveResp.ok) return { ok: false, error: `Cloudflare TXT 写入失败 ${saveResp.status}` };
  const saveJson = await saveResp.json();
  return saveJson.success ? { ok: true } : { ok: false, error: "Cloudflare TXT 写入失败" };
}

function handlePortalSubdomainFallback(hostname, config, records) {
  // 泛域名模板逻辑：无精确 SRV 时，用模板 SRV 的端口，把目标域名前缀替换成当前子域名。
  const portalDomain = String(config.portalDomain || "").toLowerCase();
  if (!portalDomain || !hostname.endsWith(`.${portalDomain}`)) return null;

  const subdomain = hostname.slice(0, -(portalDomain.length + 1));
  if (!subdomain || subdomain.includes(".")) return null;

  const templateHostname = config.wildcardTemplateHostname || `web.${portalDomain}`;
  const templateSrv = records
    .filter((record) => record.hostname === templateHostname && determineIfWebService(record.service, record.protocol).isWeb)
    .sort(compareSrvForRedirect)[0];
  if (!templateSrv) return null;

  const prefixes = config.wildcardTemplateTargetPrefixes?.length ? config.wildcardTemplateTargetPrefixes : ["web", "portal"];
  const targetPrefix = new RegExp(`^(?:${prefixes.map(escapeRegExp).join("|")})\\.`, "i");
  if (!targetPrefix.test(templateSrv.target)) return null;

  const { scheme } = determineIfWebService(templateSrv.service, templateSrv.protocol);
  return {
    scheme,
    target: templateSrv.target.replace(targetPrefix, `${subdomain}.`),
    port: templateSrv.port,
  };
}

async function handleSrvRedirect(request, config) {
  // 非门户域名入口：优先精确 SRV，找不到时尝试单层子域名的模板跳转。
  const url = new URL(request.url);
  const hostname = url.hostname.toLowerCase();
  const managedRecords = getManagedSrvRecords(config);
  const records = managedRecords.filter((r) => r.hostname === hostname).sort(compareSrvForRedirect);
  if (!records.length) {
    const fallback = handlePortalSubdomainFallback(hostname, config, managedRecords);
    if (!fallback) return textResponse(`No SRV record found for ${hostname}.`, 404);
    const status = globalThis.customRedirectModes[hostname] || config.defaultRedirectStatus;
    return new Response(null, {
      status,
      headers: {
        Location: `${fallback.scheme}://${fallback.target}:${fallback.port}${url.pathname}${url.search}`,
        "Cache-Control": "no-store",
      },
    });
  }
  const bestSrv = records[0];
  const web = getWebServiceRedirect(bestSrv, config);
  const vlessFallback = getVlessFallbackRedirect(bestSrv, config);
  const redirect = web.isWeb ? web : vlessFallback;
  if (!redirect.canRedirect) return buildNonWebResponse(bestSrv, config);
  const status = globalThis.customRedirectModes[hostname] || config.defaultRedirectStatus;
  return new Response(null, { status, headers: { Location: `${redirect.scheme}://${redirect.target}:${bestSrv.port}${url.pathname}${url.search}`, "Cache-Control": "no-store" } });
}
function compareSrvForRedirect(a, b) {
  return getSrvRedirectPriority(a) - getSrvRedirectPriority(b) || a.priority - b.priority || b.weight - a.weight || compareSrvFreshness(a, b);
}
function buildNonWebResponse(srv, config = {}) {
  const localLink = getLocalSchemeLink(srv.service, srv.protocol, srv.target, srv.port);
  const linkPart = localLink ? `<a class="break-all text-sm font-semibold text-amber-200 underline decoration-amber-300/50 underline-offset-4 hover:text-amber-100" href="${escapeAttribute(localLink)}" target="_blank" rel="noopener noreferrer">${escapeHtml(localLink)}</a>` : `<span class="break-all text-zinc-200">${escapeHtml(srv.target)}:${srv.port}</span>`;
  const debugInfo = config.debugMode && srv.raw ? `<section class="rounded-2xl border border-amber-300/15 bg-zinc-900/90 p-4 shadow-lg shadow-black/20"><h2 class="text-sm font-semibold text-amber-200">DEBUG</h2><pre class="mt-3 max-h-96 overflow-auto rounded-xl border border-amber-300/10 bg-black/60 p-4 text-xs leading-5 text-zinc-300">${escapeHtml(JSON.stringify(srv.raw, null, 2))}</pre></section>` : "";
  return htmlResponse(`<!doctype html><html lang="zh-CN">${getPageHead("服务信息", config)}<body class="min-h-screen bg-zinc-950 text-zinc-100 antialiased"><main class="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-4 px-4 py-8"><section class="rounded-3xl border border-amber-300/20 bg-zinc-900/90 p-6 shadow-2xl shadow-black/50 ring-1 ring-white/5"><p class="text-xs font-semibold uppercase tracking-wider text-amber-300">Non-Web Service</p><h1 class="mt-2 break-all text-2xl font-bold tracking-tight text-zinc-50">${escapeHtml(srv.hostname)}</h1><dl class="mt-6 grid gap-3 text-sm"><div class="grid grid-cols-[4rem_minmax(0,1fr)] gap-3"><dt class="text-zinc-500">服务</dt><dd class="font-medium text-zinc-100">${escapeHtml(srv.service)}</dd></div><div class="grid grid-cols-[4rem_minmax(0,1fr)] gap-3"><dt class="text-zinc-500">协议</dt><dd class="font-medium text-zinc-100">${escapeHtml(srv.protocol)}</dd></div><div class="grid grid-cols-[4rem_minmax(0,1fr)] gap-3"><dt class="text-zinc-500">目标</dt><dd class="break-all font-medium text-zinc-100">${escapeHtml(srv.target)}</dd></div><div class="grid grid-cols-[4rem_minmax(0,1fr)] gap-3"><dt class="text-zinc-500">端口</dt><dd><code class="rounded-lg border border-amber-300/15 bg-black/30 px-2 py-1 font-mono text-sm font-semibold text-amber-200">${srv.port}</code></dd></div><div class="grid grid-cols-[4rem_minmax(0,1fr)] gap-3"><dt class="text-zinc-500">链接</dt><dd class="min-w-0">${linkPart}</dd></div></dl></section>${debugInfo}</main></body></html>`);
}

function getWebServiceRedirect(record, config) {
  const { isWeb, scheme } = determineIfWebService(record.service, record.protocol);
  if (!isWeb) return { canRedirect: false, isWeb: false, scheme, target: record.target };
  return { canRedirect: true, isWeb: true, scheme, target: record.target };
}

function getVlessFallbackRedirect(record, config) {
  if (!isVlessFallbackService(record.service)) return { canRedirect: false, scheme: "https", target: record.target };
  return {
    canRedirect: true,
    scheme: "https",
    target: resolveVlessFallbackTarget(record.hostname, record.target, config),
  };
}

function getSrvRedirectPriority(record) {
  if (determineIfWebService(record.service, record.protocol).isWeb) return 0;
  if (isVlessFallbackService(record.service)) return 1;
  return 2;
}

function resolveVlessFallbackTarget(hostname, target, config) {
  const portalDomain = String(config.portalDomain || "").toLowerCase();
  const normalizedHostname = normalizeHostname(hostname);
  const normalizedTarget = normalizeHostname(target);
  if (!portalDomain || !normalizedHostname.endsWith(`.${portalDomain}`)) return normalizedTarget;

  const subdomain = normalizedHostname.slice(0, -(portalDomain.length + 1));
  if (!subdomain || subdomain.includes(".") || normalizedTarget.startsWith(`${subdomain}.`)) return normalizedTarget;

  const parentDomain = portalDomain.split(".").slice(1).join(".");
  if (!parentDomain || !normalizedTarget.endsWith(`.${parentDomain}`)) return normalizedTarget;

  const targetPrefix = normalizedTarget.slice(0, -(parentDomain.length + 1));
  return targetPrefix && !targetPrefix.includes(".") ? `${subdomain}.${normalizedTarget}` : normalizedTarget;
}

function isVlessFallbackService(service) {
  return (service || "").toLowerCase() === "_vless_fb";
}

function determineIfWebService(service, protocol) {
  // 只识别真正的 HTTP/HTTPS SRV；VLESS fallback 由独立分支处理。
  const s = (service || "").toLowerCase();
  const p = (protocol || "").toLowerCase();
  let scheme = "http";
  let isWeb = false;
  if (s.startsWith("_http") || s.startsWith("_https")) { isWeb = true; if (p.includes("tls") || s.startsWith("_https")) scheme = "https"; }
  return { isWeb, scheme };
}
function getLocalSchemeLink(service, protocol, target, port) {
  const s = (service || "").toLowerCase();
  if (s.includes("_ssh")) return `ssh://${target}:${port}`;
  if (s.includes("_sftp")) return `sftp://${target}:${port}`;
  if (s.includes("_ftp")) return `ftp://${target}:${port}`;
  if (s.includes("_rdp")) return `rdp://${target}:${port}`;
  if (s.includes("_vnc")) return `vnc://${target}:${port}`;
  return "";
}
function wildcardToRegex(wildcard) {
  const escaped = wildcard.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}
function escapeRegExp(value) {
  return String(value).replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
function formatRecordTime(timestamp) {
  if (!timestamp) return "未知";
  const d = new Date(timestamp), p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function formatCacheTime(fetchedAt) {
  if (!fetchedAt) return "未缓存";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - fetchedAt);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}
function htmlResponse(html, status = 200) { return new Response(html, { status, headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store" } }); }
function jsonResponse(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" } }); }
function textResponse(text, status = 200) { return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store" } }); }
function escapeAttribute(value) { return escapeHtml(String(value || "")); }
function escapeHtml(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
