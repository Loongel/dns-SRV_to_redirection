/**
 * Cloudflare Worker - SRV 跳转 + 资源汇总门户 + 泛域名扫描
 * 
 * 环境变量:
 *   1) DOMAINS       =>  逗号分隔的域名列表, 允许通配符: "*.nat.example.com,d1.example.com"
 *   2) PORTAL_DOMAIN =>  门户域名(若为空, 取DOMAINS中的第一个通配符的顶层域, 如 *.nat.example.com => nat.example.com)
 *   3) CF_API_TOKEN  =>  用于调用Cloudflare API的Token
 *   4) CF_ZONE_ID    =>  用于调用Cloudflare API的Zone ID
 */

export default {
    async fetch(request, env, ctx) {
      // 1. 初始化配置
      const config = initConfig(env);
  
      // 2. 若缓存的 SRV 列表过期或为空, 调用Cloudflare API更新
      await ensureSrvRecordsCache(env, ctx, config);
  
      // 3. 请求分发
      const url = new URL(request.url);
      if (url.hostname === config.portalDomain) {
        // 访问门户域名 => 展示资源汇总页面
        return handlePortalPage(request, env, config);
      } else {
        // 其他域名 => SRV 跳转或 404
        return handleSrvRedirect(request, env, config);
      }
    },
  };
  
  /**
   * Step A: 初始化配置 (从环境变量中加载DOMAINS,PORTAL_DOMAIN等)
   */
  function initConfig(env) {
    const domainsRaw = (env.DOMAINS || "").trim();
    const domainList = domainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
  
    // 若 portalDomain 未手动设置, 则自动从 domainList 中获取第一个通配符, 去掉 '*.' 部分
    // 如 '*.nat.example.com' => 'nat.example.com'
    let portalDomain = (env.PORTAL_DOMAIN || "").trim();
    if (!portalDomain) {
      // 简单找第一个包含 '*.' 的域名
      const foundWildcard = domainList.find((d) => d.includes("*."));
      if (foundWildcard) {
        portalDomain = foundWildcard.replace("*.", "");
      } else if (domainList.length > 0) {
        // 若没有通配符, 用第一个域名
        portalDomain = domainList[0];
      }
    }
  
    return {
      domainList,                           // 受管控的域名(含通配符)
      portalDomain,                         // 门户域名
      cfApiToken: env.CF_API_TOKEN || "",   // Cloudflare API Token
      cfZoneId: env.CF_ZONE_ID || "",       // Cloudflare Zone ID
      cacheTtl: 300,                        // 缓存多少秒后重新调用API (可根据实际需要调节)
    };
  }
  
  /**
   * Step B: 确保全局缓存中有最新的SRV记录列表
   * 若 cache 为空或过期, 则调用Cloudflare API获取所有DNS记录(type=SRV), 并缓存
   */
  async function ensureSrvRecordsCache(env, ctx, config) {
    if (!globalThis.srvRecordsCache) {
      globalThis.srvRecordsCache = {
        data: [],
        fetchedAt: 0,
      };
    }
  
    const now = Date.now() / 1000;
    if ((now - globalThis.srvRecordsCache.fetchedAt) > config.cacheTtl) {
      // 调用Cloudflare API获取SRV记录
      const records = await fetchAllSrvRecords(config.cfApiToken, config.cfZoneId);
      globalThis.srvRecordsCache.data = records;
      globalThis.srvRecordsCache.fetchedAt = now;
    }
  }
  
  /**
   * Step C: 调用Cloudflare API获取所有 type=SRV 的 DNS记录
   * 并返回解析后的数组
   */
  async function fetchAllSrvRecords(cfApiToken, zoneId) {
    if (!cfApiToken || !zoneId) {
      console.warn("缺少CF_API_TOKEN或CF_ZONE_ID, 无法扫描SRV记录.");
      return [];
    }
  
    const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=SRV&per_page=100`;
    let allRecords = [];
    let page = 1;
  
    // 简易分页循环
    while (true) {
      const resp = await fetch(`${url}&page=${page}`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${cfApiToken}`,
          "Content-Type": "application/json",
        },
      });
      if (!resp.ok) {
        console.error("调用Cloudflare API失败:", resp.status, await resp.text());
        break;
      }
      const json = await resp.json();
      if (!json.success) {
        console.error("Cloudflare API返回失败:", json.errors);
        break;
      }
      const result = json.result || [];
      allRecords = allRecords.concat(result);
  
      if (json.result_info.page >= json.result_info.total_pages) {
        break;
      }
      page++;
    }
  
    // 解析SRV记录
    return allRecords.map((r) => {
      // r -> { name, content, service, proto, data... }
      // content示例: "0 0 8080 target.example.com."
      // Cloudflare也会在 r.data 中存储 SRV的详细字段
      // 例如 r.data = { priority, weight, port, target, proto, service }
      return {
        name: r.name,                                // 例如 "test.nat.example.com"
        service: r.data?.service || "",              // "_http"
        protocol: r.data?.proto || "",               // "_tcp" / "_udp" / "_tls" ...
        priority: r.data?.priority || 0,
        weight: r.data?.weight || 0,
        port: r.data?.port || 0,
        target: r.data?.target?.replace(/\.$/, ""),  // 移除末尾的 .
      };
    });
  }
  
  /**
   * Step D: 资源汇总页面
   *   1) 遍历全局缓存中的SRV记录
   *   2) 根据DOMAINS匹配, 只展示属于受管控域名的记录
   *   3) 对web服务(http/https)做健康检查(可选)
   *   4) 返回HTML表格
   */
  async function handlePortalPage(request, env, config) {
    const allSrvRecords = globalThis.srvRecordsCache?.data || [];
  
    // 筛选只属于 config.domainList 中域名的记录
    // 例如 if record.name = "abc.nat.example.com", 需要匹配到 "*.nat.example.com"
    const matchedRecords = allSrvRecords.filter((rec) =>
      config.domainList.some((pattern) => {
        // 把通配符转换成正则, 比较 rec.name
        // 注意这里 rec.name 包含完整子域名, e.g. "abc.nat.example.com"
        const regex = wildcardToRegex(pattern);
        return regex.test(rec.name);
      })
    );
  
    // 对 matchedRecords 逐条生成 { domain, fullName, service, protocol, port, target, isWeb, status, ... }
    const resources = [];
    for (const rec of matchedRecords) {
      const domain = rec.name;  // SRV记录对应的域名(子域)
      // 判断是否web服务
      const isWeb = (rec.service === "_http" || rec.service === "_https");
      // 做健康检查(仅限web服务)
      let status = "N/A";
      let accessibleUrl = "";
      if (isWeb) {
        const scheme = (rec.service === "_https") ? "https" : "http";
        const testUrl = `${scheme}://${rec.target}:${rec.port}/`;
        const health = await checkHealth(testUrl, 2000);
        status = health.ok ? "Online" : "Offline";
        accessibleUrl = health.ok ? testUrl : "";
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
      });
    }
  
    // 生成HTML
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
    </style>
  </head>
  <body>
    <h1>资源汇总门户</h1>
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
      const statusClass = (r.status === "Online") ? "online" : "offline";
      let accessCell = "非Web服务，需手动连接";
      if (r.isWeb) {
        if (r.accessibleUrl) {
          accessCell = `<a href="${r.accessibleUrl}" target="_blank">${r.accessibleUrl}</a>`;
        } else {
          accessCell = "当前离线";
        }
      } else {
        // 非web服务，显示目标+端口
        accessCell = `协议：${r.protocol} / 地址：${r.target}:${r.port}`;
      }
      html += `
        <tr>
          <td>${r.domain}</td>
          <td>${r.service}</td>
          <td>${r.protocol}</td>
          <td>${r.target}</td>
          <td>${r.port}</td>
          <td class="${statusClass}">${r.status}</td>
          <td>${accessCell}</td>
        </tr>
      `;
    }
  
    html += `
      </tbody>
    </table>
  </body>
  </html>`;
    return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  }
  
  /**
   * Step E: 处理对非门户域名的请求 (SRV解析 -> 302跳转)
   */
  async function handleSrvRedirect(request, env, config) {
    const hostname = new URL(request.url).hostname;
    const allSrvRecords = globalThis.srvRecordsCache?.data || [];
  
    // 在 SRV 列表中找到与 hostname 匹配的记录
    // 这里仅示例匹配 "_http._tcp" 或 "_https._tcp"
    // 若要进一步区分 webdav/ftp/... 可再做处理
    const rec = allSrvRecords.find((r) => {
      // 先看 r.name 是否匹配 hostname
      if (r.name !== hostname) {
        return false;
      }
      // 再看 service/protocol是否web(示例只处理http/https)
      return (r.service === "_http" || r.service === "_https");
    });
  
    if (!rec) {
      return new Response("未找到对应SRV记录或该服务不是HTTP(S)。", { status: 404 });
    }
  
    // 302跳转
    const scheme = (rec.service === "_https") ? "https" : "http";
    const originalUrl = new URL(request.url);
    const targetUrl = `${scheme}://${rec.target}:${rec.port}${originalUrl.pathname}${originalUrl.search}`;
    return Response.redirect(targetUrl, 302);
  }
  
  /**
   * 辅助函数: 判断通配符域名 (如 "*.nat.example.com") 是否匹配实际域名
   */
  function wildcardToRegex(wildcard) {
    // 例如 "*.nat.example.com" => /^.*\.nat\.example\.com$/ 
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
  