/**
 * Cloudflare Worker - SRV 跳转 + 资源汇总门户 + 泛域名扫描（升级版）
 *
 * 环境变量:
 *   1) DOMAINS       =>  逗号分隔的域名列表, 允许通配符: "*.nat.example.com,d1.example.com"
 *   2) PORTAL_DOMAIN =>  门户域名(若为空, 取DOMAINS中的第一个通配符的顶层域)
 *   3) CF_API_TOKEN  =>  用于调用Cloudflare API的Token（可为空，若为空则不主动扫描所有SRV）
 *   4) CF_ZONE_ID    =>  用于调用Cloudflare API的Zone ID（同上，如为空则不主动扫描SRV）
 *   5) PORTAL_PASSWD =>  门户页面密码（若为空则默认11111111）
 *   6) DEBUG_MODE    =>  是否启用调试模式 (默认 false, 设置为 true 显示详细调试信息)
 */

export default {
    async fetch(request, env, ctx) {
      // --- A0. 进入顶层函数时的调试日志 ---
      if (env.DEBUG_MODE === "true") {
        console.log("[DEBUG] [fetch] 函数入口, request.url=", request.url);
      }
  
      // 1. 初始化配置
      const config = initConfig(env);
  
      // 2. 检查配置是否完整
      if (!config.domainList || config.domainList.length === 0 || !config.portalDomain) {
        const msg =
          "初始化问题：请检查以下环境变量是否正确配置:\n" +
          "1. DOMAINS - 应为逗号分隔的域名列表，支持通配符。\n" +
          "2. PORTAL_DOMAIN - 门户域名（若为空，将自动取DOMAINS中的第一个通配符的顶层域）。";
        if (config.debugMode) {
          console.error("[DEBUG] [fetch] 配置不完整, msg=", msg);
        }
        return new Response(msg, {
          status: 500,
          headers: { "Content-Type": "text/plain; charset=UTF-8" },
        });
      }
  
      // 3. 更新全局 SRV 缓存（若 token/zoneId 存在才调用API）
      if (config.cfApiToken && config.cfZoneId) {
        await ensureSrvRecordsCache(env, ctx, config);
      } else {
        // 如果缺失 Token/ZoneId，则跳过自动扫描，只保留空的SRV缓存或后续可通过手动配置
        initSrvCacheIfEmpty();
      }
  
      // 4. 分发请求
      const url = new URL(request.url);
      if (url.hostname === config.portalDomain) {
        // -- 门户页面，需要密码访问 --
        return handlePortalPageWithAuth(request, env, config);
      } else {
        // 其他域名 => 尝试 SRV 跳转
        return handleSrvRedirect(request, env, config);
      }
    },
  };
  
  /**
   * Step A: 初始化配置 (从环境变量中加载DOMAINS, PORTAL_DOMAIN等)
   */
  function initConfig(env) {
    const domainsRaw = (env.DOMAINS || "").trim();
    const domainList = domainsRaw
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
  
    // 若为空，给出警告
    if (domainList.length === 0) {
      console.warn("警告：未从环境变量 DOMAINS 中解析到任何域名！请检查配置。");
    }
  
    // 若 portalDomain 未手动设置, 则自动从 domainList 中获取第一个通配符, 去掉 '*.' 部分
    let portalDomain = (env.PORTAL_DOMAIN || "").trim();
    if (!portalDomain) {
      const foundWildcard = domainList.find((d) => d.includes("*."));
      if (foundWildcard) {
        portalDomain = foundWildcard.replace("*.", "");
      } else if (domainList.length > 0) {
        portalDomain = domainList[0];
      } else {
        portalDomain = "portal.example.com";
      }
    }
  
    const portalPasswd = (env.PORTAL_PASSWD || "11111111").trim();
    const debugMode = env.DEBUG_MODE === "true";
  
    // 返回配置对象
    const config = {
      domainList,                           // 受管控的域名(含通配符)
      portalDomain,                         // 门户域名
      cfApiToken: env.CF_API_TOKEN || "",   // Cloudflare API Token（可能为空）
      cfZoneId: env.CF_ZONE_ID || "",       // Cloudflare Zone ID（可能为空）
      cacheTtl: 300,                        // 缓存多少秒后重新调用API
      portalPasswd,                         // 门户访问密码
      debugMode,                            // 调试模式
    };
  
    if (debugMode) {
      console.log("[DEBUG] [initConfig] 解析得到的配置信息: ", JSON.stringify(config, null, 2));
    }
    return config;
  }
  
  /**
   * 初始化全局 SRV 缓存（若未初始化）
   */
  function initSrvCacheIfEmpty() {
    if (!globalThis.srvRecordsCache) {
      globalThis.srvRecordsCache = {
        data: [],
        fetchedAt: 0,
      };
    }
  }
  
  /**
   * Step B: 确保全局缓存中有最新的SRV记录列表
   * 若 cache 为空或过期, 则调用Cloudflare API获取所有DNS记录(type=SRV), 并缓存
   */
  async function ensureSrvRecordsCache(env, ctx, config) {
    initSrvCacheIfEmpty();
  
    const now = Date.now() / 1000;
    const cacheAge = now - globalThis.srvRecordsCache.fetchedAt;
    if (cacheAge > config.cacheTtl) {
      if (config.debugMode) {
        console.log("[DEBUG] [ensureSrvRecordsCache] 缓存过期或为空, 开始调用 fetchAllSrvRecords...");
      }
      const records = await fetchAllSrvRecords(config.cfApiToken, config.cfZoneId, config.debugMode);
      if (records && records.length > 0) {
        globalThis.srvRecordsCache.data = records;
        globalThis.srvRecordsCache.fetchedAt = now;
        if (config.debugMode) {
          console.log("[DEBUG] [ensureSrvRecordsCache] 成功获取 SRV 记录数=", records.length);
        }
      } else {
        console.warn("从 Cloudflare API 未获取到任何 SRV 记录，保持使用旧缓存。");
      }
    } else {
      if (config.debugMode) {
        console.log(`[DEBUG] [ensureSrvRecordsCache] 缓存还未过期, 剩余 ${config.cacheTtl - cacheAge} 秒`);
      }
    }
  }
  
  /**
   * Step C: 调用Cloudflare API获取所有 type=SRV 的 DNS记录
   * 并返回解析后的数组
   *
   * 需要注意：Cloudflare返回的SRV记录中，通常并不包含 "service" 或 "proto" 字段
   * 因此我们需要自行从 name 上做解析，例如 "_http._tls.dav.nat.example.com"
   */
  async function fetchAllSrvRecords(cfApiToken, zoneId, debugMode) {
    if (!cfApiToken || !zoneId) {
      console.warn("缺少 CF_API_TOKEN 或 CF_ZONE_ID，跳过自动扫描SRV。");
      return [];
    }
  
    const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=SRV&per_page=100`;
    let allRecords = [];
    let page = 1;
  
    // 简易分页循环
    while (true) {
      const pageUrl = `${url}&page=${page}`;
      if (debugMode) {
        console.log("[DEBUG] [fetchAllSrvRecords] 即将请求:", pageUrl);
      }
  
      const resp = await fetch(pageUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cfApiToken}`,
          "Content-Type": "application/json",
        },
      });
  
      if (!resp.ok) {
        const txt = await resp.text();
        console.error("调用 Cloudflare API 失败:", resp.status, txt);
        break;
      }
      const json = await resp.json();
      if (!json.success) {
        console.error("Cloudflare API 返回失败:", json.errors);
        break;
      }
      const result = json.result || [];
      allRecords = allRecords.concat(result);
  
      if (debugMode) {
        console.log(`[DEBUG] [fetchAllSrvRecords] 第 ${page} 页获取到 SRV 记录数=`, result.length);
      }
  
      if (json.result_info.page >= json.result_info.total_pages) {
        break;
      }
      page++;
    }
  
    // 解析SRV记录：额外通过 parseSrvName(r.name) 获取 service/protocol/hostname
    const parsed = allRecords.map((r) => {
      const { service, protocol, hostname } = parseSrvName(r.name);
  
      return {
        // 将记录中的 key 全部汇总到这里
        id: r.id,
        zone_id: r.zone_id,
        zone_name: r.zone_name,
        originalName: r.name, // 记录未拆分前的原始 name
        // 解析得到
        service,
        protocol,
        hostname, // dav.nat.example.com
        priority: r.data?.priority || 0,
        weight: r.data?.weight || 0,
        port: r.data?.port || 0,
        target: (r.data?.target || "").replace(/\.$/, ""), // 移除末尾点
        content: r.content || "",
        raw: r  // 原始记录（调试用）
      };
    });
  
    if (debugMode) {
      console.log("[DEBUG] [fetchAllSrvRecords] 完成全部分页获取, 最终SRV记录总数=", parsed.length);
    }
    return parsed;
  }
  
  /**
   * 解析 SRV 记录名，例如 "_http._tls.dav.nat.example.com"
   * 返回 { service, protocol, hostname }
   */
  function parseSrvName(name) {
    // 按 '.' 分割
    const parts = name.split(".");
    // 一般格式: [0]=_http, [1]=_tls, 剩下部分拼回真正的域名
    if (parts.length < 2) {
      return { service: "", protocol: "", hostname: name };
    }
    const service = parts[0];     // _http
    const protocol = parts[1];    // _tls / _tcp / _udp ...
    const hostname = parts.slice(2).join("."); // dav.nat.example.com
    return { service, protocol, hostname };
  }
  
  /**
   * Step D: 门户页面 + 简易密码校验
   */
  async function handlePortalPageWithAuth(request, env, config) {
    const url = new URL(request.url);
    const userPwd = url.searchParams.get("pwd") || "";
  
    // 密码不正确直接返回 401
    if (userPwd !== config.portalPasswd) {
      if (config.debugMode) {
        console.warn("[DEBUG] [handlePortalPageWithAuth] 密码错误或未提供, userPwd=", userPwd);
      }
      return new Response("未授权：密码错误或未提供。请在URL中使用 ?pwd=xxx", {
        status: 401,
        headers: { "Content-Type": "text/plain; charset=UTF-8" },
      });
    }
  
    // 收集 SRV 记录
    const allSrvRecords = globalThis.srvRecordsCache?.data || [];
    if (config.debugMode) {
      console.log("[DEBUG] [handlePortalPageWithAuth] 命中 SRV 缓存记录数=", allSrvRecords.length);
    }
  
    // 筛选只属于 config.domainList 中的记录
    const matchedRecords = allSrvRecords.filter((rec) =>
      config.domainList.some((pattern) => {
        const regex = wildcardToRegex(pattern);
        // 用 rec.hostname 做匹配
        return regex.test(rec.hostname);
      })
    );
  
    if (config.debugMode) {
      console.log("[DEBUG] [handlePortalPageWithAuth] 筛选后记录数=", matchedRecords.length);
    }
  
    // 转换为资源列表, 并做可选的 web 健康检查
    const resources = [];
    for (const rec of matchedRecords) {
      const domain = rec.hostname; 
      const { isWeb, scheme } = determineIfWebService(rec.service, rec.protocol);
      let status = "N/A";
      let accessibleUrl = "";
  
      if (isWeb) {
        // 若是web，测试其在线性
        const testUrl = `${scheme}://${rec.target}:${rec.port}/`;
        const health = await checkHealth(testUrl, 2000);
        status = health.ok ? "Online" : "Offline";
        accessibleUrl = health.ok ? testUrl : "";
      } else {
        // 对于非web，可尝试构建一个本地协议链接
        // (例如 _ssh => ssh://target:port)
        const localLink = getLocalSchemeLink(rec.service, rec.protocol, rec.target, rec.port);
        if (localLink) {
          accessibleUrl = localLink;
          status = "Service";
        } else {
          status = "Service";
        }
      }
  
      resources.push({
        domain,
        service: rec.service,
        protocol: rec.protocol,
        target: rec.target,
        port: rec.port,
        isWeb,
        status,
        accessibleUrl,
        raw: config.debugMode ? rec.raw : undefined,
      });
    }
  
    // 收集警告信息
    const warnings = [];
    if (!config.domainList || config.domainList.length === 0) {
      warnings.push("警告：环境变量 DOMAINS 未正确配置，未能匹配任何域名。");
    }
    if (!config.cfApiToken || !config.cfZoneId) {
      warnings.push("提示：由于缺少 CF_API_TOKEN 或 CF_ZONE_ID，无法自动扫描全部 SRV 记录。只能使用本地缓存或空列表。");
    }
  
    // 生成 HTML
    let html = `
  <html>
  <head>
    <meta charset="utf-8">
    <title>资源汇总门户</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 20px; }
      table { width: 100%; border-collapse: collapse; margin-top: 20px; }
      th, td { border: 1px solid #ccc; padding: 8px 12px; }
      th { background: #f9f9f9; }
      .offline { color: red; }
      .online { color: green; }
      .warning { margin: 10px 0; padding: 10px; background: #ffefc0; border: 1px solid #ffdd80; }
      .debug { font-size: 12px; color: #555; }
    </style>
  </head>
  <body>
    <h1>资源汇总门户</h1>
  `;
  
    // 若处于调试模式，显示当前配置信息
    if (config.debugMode) {
      html += `
      <div class="debug">
        <h2>调试信息: 当前配置</h2>
        <pre>${escapeHtml(JSON.stringify(config, null, 2))}</pre>
        <h2>调试信息: 全部 SRV 记录 (含解析后的 service/protocol/hostname)</h2>
        <pre>${escapeHtml(JSON.stringify(allSrvRecords, null, 2))}</pre>
        <h2>调试信息: 筛选后记录 (matchedRecords)</h2>
        <pre>${escapeHtml(JSON.stringify(matchedRecords, null, 2))}</pre>
      </div>`;
    }
  
    // 显示警告信息
    if (warnings.length > 0) {
      for (const w of warnings) {
        html += `<div class="warning">${w}</div>`;
      }
    }
  
    html += `
    <p>下表列出了系统中所有匹配 <strong>DOMAINS</strong> (含通配符) 且类型为 <code>SRV</code> 的记录。</p>
    <table>
      <thead>
        <tr>
          <th>域名(子域名)</th>
          <th>服务类型</th>
          <th>协议</th>
          <th>目标主机</th>
          <th>端口</th>
          <th>状态</th>
          <th>访问方式</th>
        </tr>
      </thead>
      <tbody>
    `;
  
    for (const r of resources) {
      const statusClass = (r.status === "Online") ? "online" 
                          : (r.status === "Offline") ? "offline" 
                          : "";
      let accessCell = "无可用方式";
  
      // 若 r.accessibleUrl 不为空，就给它加超链
      if (r.accessibleUrl) {
        accessCell = `<a href="${r.accessibleUrl}" target="_blank">${r.accessibleUrl}</a>`;
      } else {
        // 如果是 Web 服务但离线，或是其他服务无法映射
        if (r.isWeb) {
          // Web但离线
          accessCell = "当前离线";
        } else {
          // 非web, 并没有映射
          accessCell = `协议：${r.protocol} / 地址：${r.target}:${r.port}`;
        }
      }
  
      html += `
        <tr>
          <td>${escapeHtml(r.domain)}</td>
          <td>${escapeHtml(r.service)}</td>
          <td>${escapeHtml(r.protocol)}</td>
          <td>${escapeHtml(r.target)}</td>
          <td>${r.port}</td>
          <td class="${statusClass}">${r.status}</td>
          <td>${accessCell}</td>
        </tr>
      `;
  
      // 若调试模式显示SRV原始记录
      if (config.debugMode && r.raw) {
        html += `
        <tr class="debug">
          <td colspan="7">
            原始记录：<pre>${escapeHtml(JSON.stringify(r.raw, null, 2))}</pre>
          </td>
        </tr>`;
      }
    }
  
    html += `
      </tbody>
    </table>
  </body>
  </html>`;
  
    return new Response(html, {
      headers: { "Content-Type": "text/html;charset=UTF-8" },
    });
  }
  
  /**
   * Step E: 处理其他域名 => SRV 跳转
   * 在此实现真实业务逻辑：根据请求域名匹配 SRV 记录，
   * 若找到且为 Web 服务 => 302 跳转;
   * 若非Web => 返回HTML, 展示服务信息 + 可选本地调用链接
   */
  async function handleSrvRedirect(request, env, config) {
    const url = new URL(request.url);
    const hostname = url.hostname;
  
    if (config.debugMode) {
      console.log("[DEBUG] [handleSrvRedirect] 开始对域名进行 SRV 查找, hostname=", hostname);
    }
  
    const allSrvRecords = globalThis.srvRecordsCache?.data || [];
  
    // 只匹配属于 config.domainList 的记录
    const matchedRecords = allSrvRecords.filter((rec) =>
      config.domainList.some((pattern) => {
        const regex = wildcardToRegex(pattern);
        return regex.test(rec.hostname);
      })
    );
  
    // 只保留 rec.hostname === hostname
    const matchedForHostname = matchedRecords.filter((rec) => rec.hostname === hostname);
  
    if (config.debugMode) {
      console.log("[DEBUG] [handleSrvRedirect] 对应域名的 SRV 记录数=", matchedForHostname.length);
      console.log("[DEBUG] [handleSrvRedirect] matchedForHostname=", JSON.stringify(matchedForHostname, null, 2));
    }
  
    if (matchedForHostname.length === 0) {
      // 未找到 SRV 记录 => 返回 404 或者自定义消息
      if (config.debugMode) {
        console.warn("[DEBUG] [handleSrvRedirect] 未找到可用的 SRV 记录, 无法跳转。");
      }
      return new Response(`未找到与 ${hostname} 对应的 SRV 记录，无法继续。`, {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=UTF-8" },
      });
    }
  
    // 在这里可根据 priority / weight 来排序/选优，这里简单取第一个
    const bestSrv = matchedForHostname[0];
    const { isWeb, scheme } = determineIfWebService(bestSrv.service, bestSrv.protocol);
  
    if (isWeb) {
      // Web => 302 跳转
      const pathAndQuery = url.pathname + url.search;
      const redirectUrl = `${scheme}://${bestSrv.target}:${bestSrv.port}${pathAndQuery}`;
      if (config.debugMode) {
        console.log("[DEBUG] [handleSrvRedirect] 准备跳转到 =>", redirectUrl);
      }
      return Response.redirect(redirectUrl, 302);
    } else {
      // 非Web => 返回HTML，显示服务信息 + 可选本地调用链接
      return buildNonWebResponse(bestSrv, config.debugMode);
    }
  }
  
  /**
   * 对非Web服务，生成一个简易HTML展示页
   *   显示: 域名, 服务, 协议, 目标主机, 端口, 以及可选的本地链接
   */
  function buildNonWebResponse(srv, debugMode) {
    const domain = srv.hostname;
    const service = srv.service;
    const protocol = srv.protocol;
    const target = srv.target;
    const port = srv.port;
    const localLink = getLocalSchemeLink(service, protocol, target, port);
  
    let localLinkHtml = "无可用链接";
    if (localLink) {
      localLinkHtml = `<a href="${localLink}" target="_blank">${localLink}</a>`;
    }
  
    let debugInfo = "";
    if (debugMode && srv.raw) {
      debugInfo = `
      <h3>原始记录</h3>
      <pre>${escapeHtml(JSON.stringify(srv.raw, null, 2))}</pre>
      `;
    }
  
    const html = `
  <html>
  <head>
    <meta charset="utf-8">
    <title>非Web服务信息</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 20px; }
      .info { margin: 10px 0; }
      .debug { background: #f9f9f9; border: 1px solid #ccc; padding: 10px; }
    </style>
  </head>
  <body>
    <h1>非Web服务信息</h1>
    <div class="info">
      <p><strong>域名:</strong> ${escapeHtml(domain)}</p>
      <p><strong>服务:</strong> ${escapeHtml(service)}</p>
      <p><strong>协议:</strong> ${escapeHtml(protocol)}</p>
      <p><strong>目标主机:</strong> ${escapeHtml(target)}</p>
      <p><strong>端口:</strong> ${port}</p>
      <p><strong>本地调用:</strong> ${localLinkHtml}</p>
    </div>
    ${debugInfo}
  </body>
  </html>`;
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  }
  
  /**
   * 根据 SRV 的 service / protocol 判断是否 http/https
   */
  function determineIfWebService(service, protocol) {
    const sLower = (service || "").toLowerCase();
    let scheme = "http";
    let isWeb = false;
  
    // 只要 service 以 _http 或 _https 开头，就算是 web 服务
    if (sLower.startsWith("_http") || sLower.startsWith("_https")) {
      isWeb = true;
      // 若 protocol 或 service 中含 "_tls" => https
      if (protocol.toLowerCase().includes("tls") || sLower.includes("._tls")) {
        scheme = "https";
      }
      if (sLower.startsWith("_https")) {
        scheme = "https";
      }
    }
    return { isWeb, scheme };
  }
  
  /**
   * 为非web服务生成本地协议链接(如果支持)
   * 示例：_ssh => ssh://target:port, _rdp => rdp://target:port
   * 你可根据需求扩展更多
   */
  function getLocalSchemeLink(service, protocol, target, port) {
    const s = (service || "").toLowerCase();
  
    // 简单示例：若是ssh
    if (s.includes("_ssh")) {
      return `ssh://${target}:${port}`;
    }
    // 若是rdp
    if (s.includes("_rdp")) {
      return `rdp://${target}:${port}`;
    }
    // ...可在此补充更多本地协议映射...
    return "";
  }
  
  /**
   * 通配符域名 转换为 正则表达式
   */
  function wildcardToRegex(wildcard) {
    // "*.nat.example.com" => /^.*\.nat\.example\.com$/
    const escaped = wildcard.replace(/\./g, "\\.").replace(/\*/g, ".*");
    return new RegExp("^" + escaped + "$");
  }
  
  /**
   * 简易健康检查 (适用于HTTP/HTTPS)
   */
  async function checkHealth(testUrl, timeoutMs = 3000) {
    let controller;
    let timeout;
    try {
      controller = new AbortController();
      const signal = controller.signal;
      timeout = setTimeout(() => controller.abort(), timeoutMs);
  
      const resp = await fetch(testUrl, { method: "GET", signal });
      if (resp.ok) {
        return { ok: true };
      }
      return { ok: false };
    } catch (err) {
      return { ok: false };
    } finally {
      clearTimeout(timeout);
    }
  }
  
  /**
   * 将HTML中可能的特殊字符进行转义
   */
  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  