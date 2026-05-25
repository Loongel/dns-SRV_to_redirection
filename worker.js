/** Cloudflare Worker - SRV redirect and responsive portal for natmap. */

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
    portalPasswd: (env.PORTAL_PASSWD || "11111111").trim(),
    debugMode: env.DEBUG_MODE === "true",
    defaultRedirectStatus: parseRedirectStatus(env.DEFAULT_REDIRECT_STATUS, 302),
    cacheTtl: parsePositiveInt(env.CACHE_TTL_SECONDS, 300),
    srvMaxAgeSeconds: parsePositiveInt(env.SRV_MAX_AGE_SECONDS, 0),
    refreshQueueName: (env.NATMAP_REFRESH_QUEUE_NAME || `_natmap-refresh.${portalDomain}`).trim().toLowerCase(),
    wildcardTemplateHostname: normalizeHostname(env.WILDCARD_TEMPLATE_HOSTNAME || `web.${portalDomain}`),
    wildcardTemplateTargetPrefixes: parseCsv(env.WILDCARD_TEMPLATE_TARGET_PREFIXES || "web,portal"),
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
  if (!globalThis.srvRecordsCache) {
    globalThis.srvRecordsCache = { data: [], fetchedAt: 0, sourceCount: 0, duplicateCount: 0, staleCount: 0, lastError: "" };
  }
}

function isRateLimited(key, limit, windowMs) {
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
  if (userPwd !== config.portalPasswd) return buildPasswordForm(config.debugMode);
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
  if (params.get("saved")) return `${params.get("saved")} 的跳转方式已保存。`;
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
  const { isWeb, scheme } = determineIfWebService(record.service, record.protocol);
  const link = isWeb ? `${scheme}://${record.target}:${record.port}` : getLocalSchemeLink(record.service, record.protocol, record.target, record.port);
  return { domain: record.hostname, service: record.service, protocol: record.protocol, target: record.target, port: record.port, link, isWeb, updatedAt: record.updatedAt, updatedIso: record.updatedAt ? new Date(record.updatedAt).toISOString() : "", updatedLabel: formatRecordTime(record.updatedAt), redirectStatus: globalThis.customRedirectModes[record.hostname] || config.defaultRedirectStatus, raw: config.debugMode ? record.raw : undefined };
}

function buildPasswordForm(debugMode) {
  const debugMsg = debugMode ? `<p class="form-note">DEBUG: password missing or incorrect.</p>` : "";
  return htmlResponse(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>访问受限</title><style>${getModernCss()}</style></head><body class="auth-page"><main class="auth-shell"><section class="auth-card"><div class="brand-mark">SRV</div><h1>访问受限</h1><form method="POST" class="auth-form"><input type="password" name="pwd" placeholder="输入密码" required autocomplete="current-password"><button type="submit" class="btn btn-block">提交</button></form>${debugMsg}</section></main></body></html>`);
}
function buildPortalPageHTML(resources, config, userPwd, notice = "") {
  const cache = globalThis.srvRecordsCache || {};
  const warnings = [];
  if (!config.cfApiToken || !config.cfZoneId) warnings.push("缺少 Cloudflare API 配置，无法自动扫描 SRV。");
  if (cache.lastError) warnings.push(cache.lastError);
  const rows = resources.map((r) => buildResourceRow(r, userPwd)).join("");
  const cards = resources.map((r) => buildResourceCard(r, userPwd)).join("");
  const debug = config.debugMode ? buildDebugBlock(resources, config) : "";
  const emptyState = resources.length ? "" : `<section class="empty">未找到匹配的 SRV 记录。</section>`;
  return htmlResponse(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>资源门户</title><style>${getModernCss()}</style></head><body><main class="shell"><header class="topbar"><div class="title-block"><p class="eyebrow">NATMap SRV Portal</p><h1>资源门户</h1></div><div class="stats"><span><strong>${resources.length}</strong>可用</span><span><strong>${cache.duplicateCount || 0}</strong>折叠</span><span><strong>${formatCacheTime(cache.fetchedAt)}</strong>更新</span></div></header>${notice ? `<section class="notice">${escapeHtml(notice)}</section>` : ""}${warnings.map((w) => `<section class="alert">${escapeHtml(w)}</section>`).join("")}${emptyState}<section class="toolbar"><label class="search-box"><span>搜索</span><input id="resourceSearch" type="search" placeholder="输入域名、服务、端口或目标" autocomplete="off"></label></section><section class="table-panel"><table><colgroup><col class="col-domain"><col class="col-service"><col class="col-target"><col class="col-port"><col class="col-time"><col class="col-link"><col class="col-action"><col class="col-refresh"></colgroup><thead><tr><th>域名</th><th>服务</th><th>目标</th><th>端口</th><th>记录时间</th><th>链接</th><th>跳转</th><th>刷新</th></tr></thead><tbody>${rows}</tbody></table></section><section class="mobile-list">${cards}</section>${debug}<script>${getPortalScript()}</script></main></body></html>`);
}
function buildResourceRow(r, userPwd) {
  const search = `${r.domain} ${r.service} ${r.protocol} ${r.target} ${r.port}`.toLowerCase();
  return `<tr data-search="${escapeAttribute(search)}" data-domain="${escapeAttribute(r.domain)}" data-port="${r.port}"><td><span class="domain" title="${escapeAttribute(r.domain)}">${escapeHtml(r.domain)}</span></td><td><span class="service-pill">${escapeHtml(r.service.replace(/^_/, ""))}</span><span class="protocol">${escapeHtml(r.protocol)}</span></td><td><span class="host" title="${escapeAttribute(r.target)}">${escapeHtml(r.target)}</span></td><td><code>${r.port}</code></td><td><span class="time" data-time="${escapeAttribute(r.updatedIso)}">${escapeHtml(r.updatedLabel)}</span></td><td>${buildLinkHtml(r)}</td><td>${buildRedirectForm(r, userPwd)}</td><td>${buildRefreshForm(r, userPwd)}</td></tr>`;
}
function buildResourceCard(r, userPwd) {
  const search = `${r.domain} ${r.service} ${r.protocol} ${r.target} ${r.port}`.toLowerCase();
  return `<article class="resource-card" data-search="${escapeAttribute(search)}" data-domain="${escapeAttribute(r.domain)}" data-port="${r.port}"><div class="card-head"><div><h2>${escapeHtml(r.domain)}</h2><p>${escapeHtml(r.target)}:${r.port}</p></div><span class="service-pill">${escapeHtml(r.service.replace(/^_/, ""))}</span></div><dl><div><dt>协议</dt><dd>${escapeHtml(r.protocol)}</dd></div><div><dt>记录</dt><dd><span class="time" data-time="${escapeAttribute(r.updatedIso)}">${escapeHtml(r.updatedLabel)}</span></dd></div><div><dt>链接</dt><dd>${buildLinkHtml(r)}</dd></div></dl><div class="card-actions">${buildRedirectForm(r, userPwd)}${buildRefreshForm(r, userPwd)}</div></article>`;
}
function buildLinkHtml(r) { return r.link ? `<a class="link" href="${escapeAttribute(r.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.link)}</a>` : `<span class="muted">${escapeHtml(r.target)}:${r.port}</span>`; }
function buildRedirectForm(r, userPwd) {
  const options = [301, 302, 307, 308].map((code) => `<option value="${code}"${code === r.redirectStatus ? " selected" : ""}>${code}</option>`).join("");
  return `<form method="POST" class="redirect-form"><input type="hidden" name="pwd" value="${escapeAttribute(userPwd)}"><input type="hidden" name="domain" value="${escapeAttribute(r.domain)}"><select name="redirectStatus" aria-label="redirect status">${options}</select><button class="btn btn-sm" type="submit">保存</button></form>`;
}
function buildRefreshForm(r, userPwd) {
  return `<form method="POST" class="refresh-form"><input type="hidden" name="pwd" value="${escapeAttribute(userPwd)}"><input type="hidden" name="refreshDomain" value="${escapeAttribute(r.domain)}"><input type="hidden" name="currentPort" value="${r.port}"><button class="icon-btn" type="submit" title="请求 OpenWrt 为该资源重新打洞换端口" aria-label="刷新 ${escapeAttribute(r.domain)} 的端口">刷新</button></form>`;
}
function getPortalScript() {
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
    empty.className = 'empty search-empty';
    empty.textContent = '没有匹配的资源。';
    empty.hidden = true;
    document.querySelector('.shell').appendChild(empty);
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
    wrap.className = 'refresh-card';
    wrap.hidden = true;
    wrap.innerHTML = '<div class="spinner" aria-hidden="true"></div><div class="refresh-copy"><strong></strong><p></p></div><button type="button" class="refresh-close" aria-label="关闭">×</button>';
    document.body.appendChild(wrap);
    wrap.querySelector('button').addEventListener('click', () => { wrap.hidden = true; });
    return wrap;
  })();
  const showRefreshCard = (title, detail, done = false) => {
    refreshCard.querySelector('strong').textContent = title;
    refreshCard.querySelector('p').textContent = detail;
    refreshCard.classList.toggle('is-done', done);
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
  return `<section class="debug"><h2>DEBUG</h2><pre>${escapeHtml(JSON.stringify({ config: safeConfig, resources }, null, 2))}</pre></section>`;
}

async function enqueueNatmapRefresh(domain, config) {
  if (!config.cfApiToken || !config.cfZoneId) return { ok: false, error: "缺少 Cloudflare API 配置" };
  const content = `${domain}|${Date.now()}|${crypto.randomUUID()}`;
  const apiBase = `https://api.cloudflare.com/client/v4/zones/${config.cfZoneId}/dns_records`;
  const headers = { Authorization: `Bearer ${config.cfApiToken}`, "Content-Type": "application/json" };
  const listUrl = `${apiBase}?type=TXT&name=${encodeURIComponent(config.refreshQueueName)}&per_page=100`;
  const listResp = await fetch(listUrl, { headers });
  if (!listResp.ok) return { ok: false, error: `Cloudflare TXT 查询失败 ${listResp.status}` };
  const listJson = await listResp.json();
  if (!listJson.success) return { ok: false, error: "Cloudflare TXT 查询失败" };
  const existing = (listJson.result || [])[0];
  const body = JSON.stringify({ type: "TXT", name: config.refreshQueueName, content, ttl: 60, proxied: false });
  const saveResp = await fetch(existing ? `${apiBase}/${existing.id}` : apiBase, { method: existing ? "PUT" : "POST", headers, body });
  if (!saveResp.ok) return { ok: false, error: `Cloudflare TXT 写入失败 ${saveResp.status}` };
  const saveJson = await saveResp.json();
  return saveJson.success ? { ok: true } : { ok: false, error: "Cloudflare TXT 写入失败" };
}

function handlePortalSubdomainFallback(hostname, config, records) {
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
  const { isWeb, scheme } = determineIfWebService(bestSrv.service, bestSrv.protocol);
  if (!isWeb) return buildNonWebResponse(bestSrv, config.debugMode);
  const status = globalThis.customRedirectModes[hostname] || config.defaultRedirectStatus;
  return new Response(null, { status, headers: { Location: `${scheme}://${bestSrv.target}:${bestSrv.port}${url.pathname}${url.search}`, "Cache-Control": "no-store" } });
}
function compareSrvForRedirect(a, b) {
  const aWeb = determineIfWebService(a.service, a.protocol).isWeb ? 0 : 1;
  const bWeb = determineIfWebService(b.service, b.protocol).isWeb ? 0 : 1;
  return aWeb - bWeb || a.priority - b.priority || b.weight - a.weight || compareSrvFreshness(a, b);
}
function buildNonWebResponse(srv, debugMode) {
  const localLink = getLocalSchemeLink(srv.service, srv.protocol, srv.target, srv.port);
  const linkPart = localLink ? `<a class="link" href="${escapeAttribute(localLink)}" target="_blank" rel="noopener noreferrer">${escapeHtml(localLink)}</a>` : `<span>${escapeHtml(srv.target)}:${srv.port}</span>`;
  const debugInfo = debugMode && srv.raw ? `<section class="debug"><h2>DEBUG</h2><pre>${escapeHtml(JSON.stringify(srv.raw, null, 2))}</pre></section>` : "";
  return htmlResponse(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>服务信息</title><style>${getModernCss()}</style></head><body><main class="shell shell-narrow"><section class="panel"><p class="eyebrow">Non-Web Service</p><h1>${escapeHtml(srv.hostname)}</h1><dl class="detail-list"><div><dt>服务</dt><dd>${escapeHtml(srv.service)}</dd></div><div><dt>协议</dt><dd>${escapeHtml(srv.protocol)}</dd></div><div><dt>目标</dt><dd>${escapeHtml(srv.target)}</dd></div><div><dt>端口</dt><dd><code>${srv.port}</code></dd></div><div><dt>链接</dt><dd>${linkPart}</dd></div></dl></section>${debugInfo}</main></body></html>`);
}

function determineIfWebService(service, protocol) {
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

function getModernCss() {
  return `
:root {
  color-scheme: light;
  --bg: #f6f8fb;
  --surface: #ffffff;
  --surface-soft: #f9fbfd;
  --text: #172033;
  --muted: #667085;
  --line: #dbe3ec;
  --line-soft: #edf1f6;
  --accent: #0f766e;
  --accent-strong: #0b5f59;
  --accent-soft: #e7f5f3;
  --blue-soft: #eef6ff;
  --warn-bg: #fff8e6;
  --warn-text: #7a5200;
  --shadow: 0 14px 36px rgba(20, 31, 48, 0.08);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background: radial-gradient(circle at 20% 0%, #ffffff 0, #f6f8fb 34%, #eef3f8 100%);
  color: var(--text);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  letter-spacing: 0;
}
a { color: var(--accent-strong); }
.shell { width: min(1180px, calc(100% - 48px)); margin: 0 auto; padding: 30px 0 36px; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
.eyebrow { margin: 0 0 5px; color: var(--accent-strong); font-size: 0.74rem; font-weight: 760; text-transform: uppercase; }
h1 { margin: 0; font-size: 2.35rem; line-height: 1.08; font-weight: 780; }
h2 { margin: 0; font-size: 1rem; line-height: 1.3; }
.stats { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.stats span { display: inline-flex; align-items: baseline; gap: 4px; min-height: 34px; padding: 7px 11px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,0.82); color: var(--muted); box-shadow: 0 4px 14px rgba(20,31,48,0.04); white-space: nowrap; }
.stats strong { color: var(--text); font-weight: 760; }
.table-panel, .resource-card, .auth-card, .debug, .empty, .alert { border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,0.9); box-shadow: var(--shadow); }
.alert, .debug, .empty, .notice { padding: 14px 16px; margin: 12px 0; }
.alert { background: var(--warn-bg); color: var(--warn-text); border-color: #f0ddaa; }
.notice { border: 1px solid #b8e1d9; border-radius: 8px; background: #ecfdf9; color: #075e54; box-shadow: 0 8px 22px rgba(20,31,48,0.05); }
.toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 0 0 12px; }
.search-box { flex: 1; display: grid; grid-template-columns: auto minmax(220px, 420px); justify-content: end; align-items: center; gap: 10px; color: var(--muted); }
.search-box input { min-height: 40px; border: 1px solid var(--line); border-radius: 8px; padding: 0 13px; font: inherit; color: var(--text); background: rgba(255,255,255,0.92); outline: none; }
.search-box input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(15,118,110,0.12); }
.table-panel { overflow-x: auto; overflow-y: hidden; }
table { width: 100%; min-width: 1060px; border-collapse: collapse; table-layout: fixed; }
.col-domain { width: 16%; }
.col-service { width: 10%; }
.col-target { width: 14%; }
.col-port { width: 7%; }
.col-time { width: 13%; }
.col-link { width: 16%; }
.col-action { width: 14%; }
.col-refresh { width: 10%; }
th, td { border-bottom: 1px solid var(--line-soft); text-align: left; vertical-align: middle; }
th { height: 46px; padding: 0 14px; background: #f1f5f9; color: #475467; font-size: 0.78rem; font-weight: 740; }
td { height: 68px; padding: 10px 14px; font-size: 0.94rem; }
tbody tr { background: rgba(255,255,255,0.72); }
tbody tr:hover { background: #fbfdff; }
tbody tr:last-child td { border-bottom: 0; }
.domain, .host, .link { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.domain { font-weight: 720; color: #111827; }
.host { color: #243246; }
.link { font-weight: 680; text-decoration-thickness: 1px; text-underline-offset: 3px; }
.service-pill { display: inline-flex; align-items: center; height: 28px; padding: 0 10px; border: 1px solid #cfd9e6; border-radius: 999px; background: var(--blue-soft); color: #344054; font-size: 0.9rem; white-space: nowrap; }
.protocol { margin-left: 7px; color: var(--muted); white-space: nowrap; }
code { display: inline-flex; align-items: center; height: 24px; padding: 0 7px; border-radius: 7px; background: #eef3f7; color: #172033; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.93rem; }
.time, .muted { color: var(--muted); }
.redirect-form { display: grid; grid-template-columns: minmax(62px, 1fr) 44px; gap: 6px; align-items: center; }
.refresh-form { margin: 0; }
select, input[type="password"] { min-height: 38px; width: 100%; border: 1px solid #cfd9e6; border-radius: 8px; background: #fff; color: var(--text); font: inherit; outline: none; }
select { padding: 0 9px; }
input[type="password"] { padding: 0 12px; }
select:focus, input[type="password"]:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(15,118,110,0.12); }
.btn { min-height: 38px; border: 0; border-radius: 8px; padding: 0 14px; background: var(--accent); color: #fff; font: inherit; font-weight: 720; cursor: pointer; }
.btn:hover { background: var(--accent-strong); }
.btn:disabled, .icon-btn:disabled { opacity: 0.58; cursor: wait; }
.btn-sm { min-height: 36px; padding: 0 8px; }
.icon-btn { min-height: 36px; width: 100%; border: 1px solid #b8e1d9; border-radius: 8px; background: #ecfdf9; color: var(--accent-strong); font: inherit; font-weight: 720; cursor: pointer; }
.icon-btn:hover { background: #d9f8f1; }
.btn-block { width: 100%; }
.mobile-list { display: none; }
.resource-card { padding: 14px; }
.card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.card-head p { margin: 5px 0 0; color: var(--muted); overflow-wrap: anywhere; }
dl { margin: 14px 0 0; display: grid; gap: 8px; }
dl div { display: grid; grid-template-columns: 54px minmax(0,1fr); gap: 10px; }
dt { color: var(--muted); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.card-actions { margin-top: 14px; }
.debug pre { margin: 10px 0 0; white-space: pre-wrap; overflow: auto; }
.refresh-card { position: fixed; right: 22px; bottom: 22px; z-index: 20; display: grid; grid-template-columns: 34px minmax(0, 1fr) 28px; gap: 12px; align-items: center; width: min(420px, calc(100vw - 32px)); padding: 14px; border: 1px solid #b8e1d9; border-radius: 8px; background: rgba(255,255,255,0.96); box-shadow: 0 18px 46px rgba(20,31,48,0.18); }
.refresh-card[hidden] { display: none; }
.refresh-copy strong { display: block; font-size: 0.98rem; }
.refresh-copy p { margin: 4px 0 0; color: var(--muted); line-height: 1.45; }
.refresh-close { width: 28px; height: 28px; border: 0; border-radius: 7px; background: #f1f5f9; color: var(--muted); font-size: 1.2rem; line-height: 1; cursor: pointer; }
.spinner { width: 28px; height: 28px; border: 3px solid #d9f8f1; border-top-color: var(--accent); border-radius: 50%; animation: spin 0.9s linear infinite; }
.refresh-card.is-done .spinner { animation: none; border-color: var(--accent); background: var(--accent-soft); }
@keyframes spin { to { transform: rotate(360deg); } }
.auth-page { background: #f5f7fa; }
.auth-shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
.auth-card { width: min(360px, 100%); padding: 24px; }
.brand-mark { display: inline-flex; align-items: center; justify-content: center; height: 34px; min-width: 48px; margin-bottom: 14px; border-radius: 8px; background: var(--accent-soft); color: var(--accent-strong); font-weight: 800; }
.auth-card h1 { font-size: 1.85rem; }
.auth-form { display: grid; gap: 12px; margin-top: 18px; }
.form-note { margin: 12px 0 0; color: var(--muted); }
@media (max-width: 1040px) {
  .shell { width: min(100% - 24px, 1180px); }
  .col-time { width: 13%; }
  .col-link { width: 15%; }
  .col-action { width: 12%; }
  .col-refresh { width: 9%; }
  th, td { padding-left: 10px; padding-right: 10px; }
}
@media (max-width: 980px) {
  .shell { width: min(100% - 28px, 680px); padding-top: 20px; }
  .topbar { align-items: flex-start; flex-direction: column; }
  h1 { font-size: 2rem; }
  .stats { justify-content: flex-start; }
  .table-panel { display: none; }
  .mobile-list { display: grid; gap: 12px; }
  .toolbar { display: block; }
  .search-box { grid-template-columns: 1fr; justify-content: stretch; }
  .search-box input { width: 100%; }
  .redirect-form { grid-template-columns: minmax(0,1fr) 64px; }
  .card-actions { display: grid; grid-template-columns: minmax(0,1fr) 88px; gap: 10px; align-items: center; }
  .refresh-card { left: 14px; right: 14px; bottom: 14px; width: auto; }
}
`;
}
