/**
 * Cloudflare Worker - SRV 跳转 + 资源汇总门户 + 泛域名扫描（升级版）
 *
 * 环境变量:
 *   1) DOMAINS             =>  逗号分隔的域名列表, 允许通配符: "*.nat.example.com,d1.example.com"
 *   2) PORTAL_DOMAIN       =>  门户域名(若为空, 取DOMAINS中的第一个通配符的顶层域)
 *   3) CF_API_TOKEN        =>  用于调用Cloudflare API的Token（可为空，若为空则不主动扫描所有SRV）
 *   4) CF_ZONE_ID          =>  用于调用Cloudflare API的Zone ID（同上，如为空则不主动扫描SRV）
 *   5) PORTAL_PASSWD       =>  门户页面密码（若为空则默认11111111）
 *   6) DEBUG_MODE          =>  是否启用调试模式 (默认 false, 设置为 true 显示详细调试信息)
 *   7) DEFAULT_REDIRECT_STATUS => 所有域名的默认跳转方式，可选301/302/307/308，默认为302
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
      // 若未手动设置, 从domainList中找第一个含'*.'的,去除前缀
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
  
    // === 新增/修改 ===
    // 读取默认跳转方式，若非法/未设置则默认302
    let parsedStatus = parseInt(env.DEFAULT_REDIRECT_STATUS, 10);
    if (isNaN(parsedStatus) || ![301, 302, 307, 308].includes(parsedStatus)) {
      parsedStatus = 302;
    }
  
    // 额外新增一个 customRedirectModes 用于存储用户在门户页面对特定域名/服务的自定义跳转值
    if (!globalThis.customRedirectModes) {
      globalThis.customRedirectModes = {};
    }
  
    return {
      domainList,
      portalDomain,
      cfApiToken: env.CF_API_TOKEN || "",
      cfZoneId: env.CF_ZONE_ID || "",
      cacheTtl: 300,
      portalPasswd,
      debugMode,
      defaultRedirectStatus: parsedStatus, // === 新增字段 ===
    };
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
        console.log("[DEBUG] [ensureSrvRecordsCache] 缓存过期, 开始调用 fetchAllSrvRecords...");
      }
      const records = await fetchAllSrvRecords(config.cfApiToken, config.cfZoneId, config.debugMode);
      if (records && records.length > 0) {
        globalThis.srvRecordsCache.data = records;
        globalThis.srvRecordsCache.fetchedAt = now;
      }
    } else {
      if (config.debugMode) {
        console.log("[DEBUG] [ensureSrvRecordsCache] 缓存未过期,无需更新");
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
      console.warn("[WARN] 缺少 CF_API_TOKEN 或 CF_ZONE_ID，跳过自动扫描SRV。");
      return [];
    }
  
    const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=SRV&per_page=100`;
    let allRecords = [];
    let page = 1;
  
    while (true) {
      const pageUrl = `${url}&page=${page}`;
      if (debugMode) {
        console.log("[DEBUG] [fetchAllSrvRecords] 请求地址=", pageUrl);
      }
  
      const resp = await fetch(pageUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cfApiToken}`,
          "Content-Type": "application/json",
        },
      });
      if (!resp.ok) {
        console.error("[ERROR] Cloudflare API 失败:", resp.status, await resp.text());
        break;
      }
      const json = await resp.json();
      if (!json.success) {
        console.error("[ERROR] Cloudflare API返回不成功:", json.errors);
        break;
      }
  
      const result = json.result || [];
      allRecords = allRecords.concat(result);
  
      if (json.result_info.page >= json.result_info.total_pages) {
        break;
      }
      page++;
    }
  
    // 解析SRV记录：额外通过 parseSrvName(r.name) 获取 service/protocol/hostname
    const parsed = allRecords.map((r) => {
      const { service, protocol, hostname } = parseSrvName(r.name);
      return {
        id: r.id,
        originalName: r.name,
        service,
        protocol,
        hostname,
        port: r.data?.port || 0,
        priority: r.data?.priority || 0,
        weight: r.data?.weight || 0,
        target: (r.data?.target || "").replace(/\.$/, ""),
        raw: r,
      };
    });
    return parsed;
  }
  
  /**
   * 将 _http._tls.dav.nat.example.com 解析为 { service:'_http', protocol:'_tls', hostname:'dav.nat.example.com' }
   */
  function parseSrvName(name) {
    const parts = name.split(".");
    if (parts.length < 2) {
      return { service: "", protocol: "", hostname: name };
    }
    const service = parts[0]; // _http
    const protocol = parts[1]; // _tls / _tcp...
    const hostname = parts.slice(2).join(".");
    return { service, protocol, hostname };
  }
  
  /**
   * Step D: 门户页面
   */
  async function handlePortalPageWithAuth(request, env, config) {
    // 1) 检查密码
    let userPwd = "";
    let domainToUpdate = "";
    let newRedirectStatus = "";
  
    if (request.method === "POST") {
      // 读取 formData
      const formData = await request.formData();
      userPwd = formData.get("pwd") || "";
      // === 新增/修改 ===
      // 若传入 domain & redirectStatus，则表示用户想修改某条域名的跳转方式
      domainToUpdate = formData.get("domain") || "";
      newRedirectStatus = formData.get("redirectStatus") || "";
    } else {
      // GET请求也可兼容
      const url = new URL(request.url);
      userPwd = url.searchParams.get("pwd") || "";
    }
  
    // 如果没输入/或错误，就弹出密码输入表单
    if (userPwd !== config.portalPasswd) {
      return buildPasswordForm(config.debugMode);
    }
  
    // === 新增/修改 ===
    // 如果传入了 domainToUpdate & newRedirectStatus，则更新 globalThis.customRedirectModes
    if (domainToUpdate && newRedirectStatus) {
      const parsedStatus = parseInt(newRedirectStatus, 10);
      if (![301, 302, 307, 308].includes(parsedStatus)) {
        // 若非法，则忽略
        if (config.debugMode) {
          console.log("[DEBUG] [handlePortalPageWithAuth] 非法的跳转状态:", newRedirectStatus);
        }
      } else {
        globalThis.customRedirectModes[domainToUpdate] = parsedStatus;
        if (config.debugMode) {
          console.log(
            `[DEBUG] [handlePortalPageWithAuth] 已更新 ${domainToUpdate} 的跳转状态为 ${parsedStatus}`
          );
        }
      }
    }
  
    // 2) 查询 SRV
    const allSrvRecords = globalThis.srvRecordsCache?.data || [];
    const matchedRecords = allSrvRecords.filter((rec) =>
      config.domainList.some((pattern) => {
        const regex = wildcardToRegex(pattern);
        return regex.test(rec.hostname);
      })
    );
  
    // 3) 构造资源列表
    const resources = matchedRecords.map((rec) => {
      const domain = rec.hostname;
      const { isWeb, scheme } = determineIfWebService(rec.service, rec.protocol);
  
      // 当前记录的跳转方式(若有自定义则用自定义, 否则用默认)
      let currentRedirectStatus =
        globalThis.customRedirectModes[domain] || config.defaultRedirectStatus;
  
      // 构建一个超链接(无论web或非web，都尝试给)
      if (isWeb) {
        //  http(s)://target:port
        const webUrl = `${scheme}://${rec.target}:${rec.port}`;
        return {
          domain,
          service: rec.service,
          protocol: rec.protocol,
          target: rec.target,
          port: rec.port,
          link: webUrl, // 用于门户点击
          redirectStatus: currentRedirectStatus, // === 新增，用于展示
          raw: config.debugMode ? rec.raw : undefined,
        };
      } else {
        // 非Web => 尝试 ssh://, sftp://, rdp://, vnc://
        const localLink = getLocalSchemeLink(rec.service, rec.protocol, rec.target, rec.port);
        return {
          domain,
          service: rec.service,
          protocol: rec.protocol,
          target: rec.target,
          port: rec.port,
          link: localLink || "",
          redirectStatus: currentRedirectStatus, // === 新增，用于展示
          raw: config.debugMode ? rec.raw : undefined,
        };
      }
    });
  
    // 4) 构造HTML返回
    return buildPortalPageHTML(resources, config, userPwd);
  }
  
  /**
   * 如果未输入密码/错误 => 显示一个密码输入表单
   */
  function buildPasswordForm(debugMode) {
    let debugMsg = "";
    if (debugMode) {
      debugMsg = `<div style="margin-top: 10px; color: #999;">[DEBUG] 未输入或密码不正确</div>`;
    }
  
    const html = `
  <html>
  <head>
    <meta charset="utf-8">
    <title>请输入密码</title>
    <style>${getModernCss()}</style>
  </head>
  <body>
    <div class="container narrow">
      <h1>访问受限</h1>
      <p>请在下方输入密码:</p>
      <form method="POST">
        <input type="password" name="pwd" placeholder="密码" required />
        <button type="submit" class="btn">提交</button>
      </form>
      ${debugMsg}
    </div>
  </body>
  </html>`;
    return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  }
  
  /**
   * 构造门户页面的HTML
   */
  function buildPortalPageHTML(resources, config, userPwd) {
    // warnings
    const warnings = [];
    if (!config.domainList || config.domainList.length === 0) {
      warnings.push("警告：环境变量 DOMAINS 未正确配置，未能匹配任何域名。");
    }
    if (!config.cfApiToken || !config.cfZoneId) {
      warnings.push("提示：缺少 CF_API_TOKEN 或 CF_ZONE_ID，无法自动扫描 SRV。");
    }
  
    // 门户页面HTML
    let html = `
  <html>
  <head>
    <meta charset="utf-8">
    <title>资源汇总门户</title>
    <style>${getModernCss()}</style>
  </head>
  <body>
    <div class="container">
      <h1>资源汇总门户</h1>
      <p>以下列出的记录属于受管控域名 (DOMAINS) 对应的 SRV 服务。</p>
  `;
  
    // 显示警告
    for (const w of warnings) {
      html += `<div class="alert alert-warn">${w}</div>`;
    }
  
    // 如果处于调试模式，显示资源原始
    if (config.debugMode) {
      html += `
      <div class="card debug">
        <h2>DEBUG: 配置信息</h2>
        <pre>${escapeHtml(JSON.stringify(config, null, 2))}</pre>
        <h2>DEBUG: 资源列表</h2>
        <pre>${escapeHtml(JSON.stringify(resources, null, 2))}</pre>
      </div>
      `;
    }
  
    html += `
      <table class="table">
        <thead>
          <tr>
            <th>域名(子域名)</th>
            <th>服务类型</th>
            <th>协议</th>
            <th>目标主机</th>
            <th>端口</th>
            <th>链接</th>
            <th>跳转方式</th> <!-- 新增列 -->
          </tr>
        </thead>
        <tbody>
    `;
  
    for (const r of resources) {
      // 无论web或非web，只要存在链接就给超链；否则显示“目标+端口”
      let linkTd = `${escapeHtml(r.target)}:${r.port}`;
      if (r.link) {
        linkTd = `<a href="${r.link}" target="_blank">${escapeHtml(r.link)}</a>`;
      }
  
      // === 新增/修改 ===
      // 下拉框（301/302/307/308），默认选中 r.redirectStatus
      const selectHtml = `
        <form method="POST" style="display:inline-block; margin:0; padding:0;">
          <input type="hidden" name="pwd" value="${escapeHtml(config.portalPasswd)}"/>
          <input type="hidden" name="domain" value="${escapeHtml(r.domain)}"/>
          <select name="redirectStatus">
            ${[301, 302, 307, 308]
              .map((code) => {
                const sel = code === r.redirectStatus ? "selected" : "";
                return `<option value="${code}" ${sel}>${code}</option>`;
              })
              .join("")}
          </select>
          <button class="btn btn-sm" type="submit">保存</button>
        </form>
      `;
  
      html += `
        <tr>
          <td>${escapeHtml(r.domain)}</td>
          <td>${escapeHtml(r.service)}</td>
          <td>${escapeHtml(r.protocol)}</td>
          <td>${escapeHtml(r.target)}</td>
          <td>${r.port}</td>
          <td>${linkTd}</td>
          <td>${selectHtml}</td>
        </tr>
      `;
  
      // 调试模式显示原始记录
      if (config.debugMode && r.raw) {
        html += `
        <tr class="debug-row">
          <td colspan="7">
            <pre>${escapeHtml(JSON.stringify(r.raw, null, 2))}</pre>
          </td>
        </tr>`;
      }
    }
  
    html += `
        </tbody>
      </table>
    </div>
  </body>
  </html>`;
  
    return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  }
  
  /**
   * Step E: 处理其他域名 => SRV 跳转
   * 在此实现真实业务逻辑：根据请求域名匹配 SRV 记录，
   * 若找到且为 Web 服务 => 按设置的跳转方式跳转;
   * 若非Web => 返回HTML, 展示服务信息 + 可选本地调用链接
   */
  async function handleSrvRedirect(request, env, config) {
    const url = new URL(request.url);
    const hostname = url.hostname;
    const allSrvRecords = globalThis.srvRecordsCache?.data || [];
  
    // 只匹配 domainList
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
      // 新增门户子域名处理逻辑
      const portalSubdomain = handlePortalSubdomainFallback(
        hostname,
        config.portalDomain,
        allSrvRecords,
        config
      );
      
      if (portalSubdomain) {
        const { scheme, target, port } = portalSubdomain;
        const pathAndQuery = url.pathname + url.search;
        const redirectUrl = `${scheme}://${target}:${port}${pathAndQuery}`;
        const customStatus = globalThis.customRedirectModes[hostname] || config.defaultRedirectStatus;

        if (config.debugMode) {
          console.log("[DEBUG] [portalSubdomain] 动态生成跳转地址:", redirectUrl);
        }

        return new Response(null, {
          status: customStatus,
          headers: {
            Location: redirectUrl,
            "Cache-Control": "max-age=600"
          }
        });
      }

      return new Response(`未找到与 ${hostname} 对应的 SRV 记录。`, {
        status: 404,
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
      });
    }
  
    // 在这里可根据 priority / weight 来排序/选优，这里简单取第一个
    const bestSrv = matchedForHostname[0];
    const { isWeb, scheme } = determineIfWebService(bestSrv.service, bestSrv.protocol);
  
    if (!isWeb) {
        // 返回一个HTML，显示服务信息 + 可选链接
        return buildNonWebResponse(bestSrv, config.debugMode);
      } else {
        // Web => 根据 customRedirectModes / defaultRedirectStatus 进行重定向
        const customStatus = globalThis.customRedirectModes[hostname] || config.defaultRedirectStatus;
        const pathAndQuery = url.pathname + url.search;
        const redirectUrl = `${scheme}://${bestSrv.target}:${bestSrv.port}${pathAndQuery}`;
      
        if (config.debugMode) {
          console.log("[DEBUG] [handleSrvRedirect] 准备跳转到 =>", redirectUrl, "状态码=", customStatus);
        }
      
        // 设置缓存最大限制为10分钟的头
        return new Response(null, {
            status: customStatus,
            headers: {
              Location: redirectUrl,
              "Cache-Control": "max-age=600"
            }
          });
      }
      
  }
  
  /**
   * 非web => 返回HTML，显示信息 + 可选链接
   */
  function buildNonWebResponse(srv, debugMode) {
    const domain = srv.hostname;
    const service = srv.service;
    const protocol = srv.protocol;
    const target = srv.target;
    const port = srv.port;
    const localLink = getLocalSchemeLink(service, protocol, target, port);
  
    const linkPart = localLink
      ? `<a href="${localLink}" target="_blank">${escapeHtml(localLink)}</a>`
      : `${escapeHtml(target)}:${port}`;
  
    let debugInfo = "";
    if (debugMode && srv.raw) {
      debugInfo = `
      <div class="card debug">
        <h3>原始记录</h3>
        <pre>${escapeHtml(JSON.stringify(srv.raw, null, 2))}</pre>
      </div>`;
    }
  
    const html = `
  <html>
  <head>
    <meta charset="utf-8">
    <title>非Web服务信息</title>
    <style>${getModernCss()}</style>
  </head>
  <body>
    <div class="container">
      <h1>非Web服务信息</h1>
      <div class="card">
        <p><strong>域名(子域名):</strong> ${escapeHtml(domain)}</p>
        <p><strong>服务:</strong> ${escapeHtml(service)}</p>
        <p><strong>协议:</strong> ${escapeHtml(protocol)}</p>
        <p><strong>目标主机:</strong> ${escapeHtml(target)}</p>
        <p><strong>端口:</strong> ${port}</p>
        <p><strong>可用链接:</strong> ${linkPart}</p>
      </div>
      ${debugInfo}
    </div>
  </body>
  </html>`;
    return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
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
   * 根据service / protocol / target / port 返回可用的本地协议
   * 例如: _ssh => ssh://target:port, _sftp => sftp://...
   * 可自行扩展
   */
  function getLocalSchemeLink(service, protocol, target, port) {
    const s = (service || "").toLowerCase();
    // 例如 SSH
    if (s.includes("_ssh")) {
      return `ssh://${target}:${port}`;
    }
    // SFTP
    if (s.includes("_sftp")) {
      return `sftp://${target}:${port}`;
    }
    // RDP
    if (s.includes("_rdp")) {
      return `rdp://${target}:${port}`;
    }
    // VNC
    if (s.includes("_vnc")) {
      return `vnc://${target}:${port}`;
    }
    // ...可再扩展
    return "";
  }
  
  /**
   * 处理门户子域名动态替换逻辑
   */
  function handlePortalSubdomainFallback(hostname, portalDomain, allSrvRecords, config) {
    // 增强域名验证逻辑
    const domainPattern = new RegExp(`^(.+)\\.${portalDomain.replace(/\./g, '\\.')}$`);
    const match = hostname.match(domainPattern);
    
    if (!match || match[1].includes('.')) {
      if (config.debugMode) {
        console.log(`[DEBUG] [portalSubdomain] 无效域名格式: ${hostname}`);
      }
      return null;
    }
    const subdomain = match[1];

    // 构造web门户子域名
    const webHostname = `web.${portalDomain}`;
    
    // 查找web门户的SRV记录
    const webSrv = allSrvRecords.find(r =>
      r.hostname === webHostname &&
      r.service.startsWith('_http')
    );

    if (!webSrv) {
      if (config.debugMode) {
        console.log(`[DEBUG] [portalSubdomain] 未找到${webHostname}的SRV记录`);
      }
      return null;
    }

    // 增强目标替换逻辑（支持多种前缀格式）
    const targetRegex = /^(?:web|portal)\./i;
    if (!targetRegex.test(webSrv.target)) {
      if (config.debugMode) {
        console.log(`[DEBUG] [portalSubdomain] 目标格式不匹配: ${webSrv.target}`);
      }
      return null;
    }
    const newTarget = webSrv.target.replace(targetRegex, `${subdomain}.`);
    const { scheme } = determineIfWebService(webSrv.service, webSrv.protocol);

    if (config.debugMode) {
      console.log(`[DEBUG] [portalSubdomain] 动态生成目标: ${scheme}://${newTarget}:${webSrv.port}`);
      console.log(`[DEBUG] [portalSubdomain] 原始目标: ${webSrv.target} 替换规则: web->${subdomain}`);
    }

    return {
      scheme,
      target: newTarget,
      port: webSrv.port
    };
  }

  /**
   * 通配符域名 转换为 正则表达式
   */
  function wildcardToRegex(wildcard) {
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
   * 简易CSS：让UI更现代一些 + 一些主流视觉
   */
  function getModernCss() {
    return `
  body {
    margin: 0;
    padding: 0;
    font-family: "Segoe UI", Arial, sans-serif;
    background: #f7f9fa;
    color: #333;
  }
  .container {
    max-width: 1100px;
    margin: 30px auto;
    padding: 0 20px;
  }
  .container.narrow {
    max-width: 500px;
  }
  h1, h2, h3 {
    margin-bottom: 1rem;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 20px 0;
    background: #fff;
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 0 2px 5px rgba(0,0,0,0.1);
  }
  thead {
    background: #f3f4f6;
  }
  th, td {
    padding: 12px 15px;
    border-bottom: 1px solid #ececec;
  }
  tr:last-child td {
    border-bottom: none;
  }
  .card {
    background: #fff;
    padding: 20px;
    margin: 20px 0;
    border-radius: 6px;
    box-shadow: 0 2px 5px rgba(0,0,0,0.1);
  }
  .debug {
    color: #555;
    font-size: 0.9rem;
    background: #f9f9f9;
  }
  .debug-row td {
    background: #f9f9f9;
    font-size: 0.85rem;
  }
  .alert {
    padding: 15px;
    margin: 10px 0;
    border-radius: 6px;
  }
  .alert-warn {
    background-color: #fff4e5;
    border: 1px solid #ffecb2;
    color: #8b5e34;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  input[type=password] {
    padding: 8px;
    font-size: 1rem;
    border-radius: 4px;
    border: 1px solid #ccc;
  }
  button.btn {
    background: #4c9af0;
    color: #fff;
    padding: 10px 15px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }
  button.btn:hover {
    background: #3c8add;
  }
  button.btn-sm {
    padding: 5px 10px;
    font-size: 0.9rem;
    margin-left: 6px;
  }
  select {
    border: 1px solid #ccc;
    border-radius: 4px;
    padding: 5px;
  }
  `;
  }
  
  /**
   * 转义HTML
   */
  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }   