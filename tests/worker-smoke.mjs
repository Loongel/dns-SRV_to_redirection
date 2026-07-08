import worker from "../worker.js";

let port = 24467;
let txtWrites = 0;
let txtDeletes = 0;
const env = {
  DOMAINS: "*.s.example.com",
  PORTAL_DOMAIN: "s.example.com",
  CF_API_TOKEN: "token",
  CF_ZONE_ID: "zone",
  PORTAL_PASSWD: "secret",
  DEFAULT_REDIRECT_STATUS: "307",
};

function srvRecord() {
  return {
    id: "srv1",
    name: "_hy2._udp.hm-hy2.s.example.com",
    type: "SRV",
    created_on: "2026-05-26T00:00:00Z",
    modified_on: new Date(1760000000000 + port).toISOString(),
    data: {
      priority: 0,
      weight: 0,
      port,
      target: "n.example.com",
    },
  };
}

function webSrvRecord() {
  return {
    id: "srv-web",
    name: "_http._tls.web.s.example.com",
    type: "SRV",
    created_on: "2026-05-26T00:00:00Z",
    modified_on: "2026-05-26T00:01:00Z",
    data: {
      priority: 0,
      weight: 0,
      port: 2424,
      target: "web.n.example.com",
    },
  };
}

function portalSrvRecord() {
  return {
    id: "srv-portal",
    name: "_http._tls.portal.s.example.com",
    type: "SRV",
    created_on: "2026-05-26T00:00:00Z",
    modified_on: "2026-05-26T00:02:00Z",
    data: {
      priority: 0,
      weight: 0,
      port: 3434,
      target: "portal.n.example.com",
    },
  };
}

function vlessFallbackSrvRecord() {
  return {
    id: "srv-vless-fb",
    name: "_vless_FB._tcp.vless-fb.s.example.com",
    type: "SRV",
    created_on: "2026-05-26T00:00:00Z",
    modified_on: "2026-05-26T00:03:00Z",
    data: {
      priority: 0,
      weight: 0,
      port: 8443,
      target: "n.example.com",
    },
  };
}

function rdpSrvRecord() {
  return {
    id: "srv-rdp",
    name: "_rdp._tcp.z-rdp.s.example.com",
    type: "SRV",
    created_on: "2026-05-26T00:00:00Z",
    modified_on: "2026-05-26T00:04:00Z",
    data: {
      priority: 0,
      weight: 0,
      port: 3389,
      target: "n.example.com",
    },
  };
}

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.searchParams.get("type") === "SRV") {
    return Response.json({ success: true, result: [srvRecord(), webSrvRecord(), portalSrvRecord(), vlessFallbackSrvRecord(), rdpSrvRecord()], result_info: { page: 1, total_pages: 1 } });
  }
  if (u.searchParams.get("type") === "TXT") {
    return Response.json({ success: true, result: [{ id: "old-txt-1" }, { id: "old-txt-2" }] });
  }
  if (init.method === "DELETE") {
    txtDeletes += 1;
    return Response.json({ success: true, result: { id: u.pathname.split("/").pop() } });
  }
  if (init.method === "POST" || init.method === "PUT") {
    txtWrites += 1;
    const body = JSON.parse(init.body);
    if (body.type !== "TXT") throw new Error("refresh queue write must use TXT");
    if (!body.content.includes("hm-hy2.s.example.com")) throw new Error("refresh queue content missing domain");
    return Response.json({ success: true, result: { id: "txt1" } });
  }
  throw new Error(`unexpected fetch: ${url}`);
};

const portal = await worker.fetch(new Request("https://s.example.com/?pwd=secret"), env, {});
const html = await portal.text();
if (!html.includes("fastly.jsdelivr.net/npm/@tailwindcss/browser@4.1.13") || !html.includes("cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.13") || !html.includes("unpkg.com/@tailwindcss/browser@4.1.13")) throw new Error("portal should include three Tailwind CDN fallbacks");
const oldCdnPortal = await worker.fetch(new Request("https://s.example.com/?pwd=secret"), { ...env, TAILWIND_CDN_URL: "https://cdn.bootcdn.net/ajax/libs/tailwindcss-browser/4.1.13/index.global.min.js" }, {});
const oldCdnHtml = await oldCdnPortal.text();
if (oldCdnHtml.includes("cdn.bootcdn.net") || !oldCdnHtml.includes("fastly.jsdelivr.net/npm/@tailwindcss/browser@4.1.13") || !oldCdnHtml.includes("cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.13")) throw new Error("old BootCDN URL should be replaced by fallback chain");
const customCdnPortal = await worker.fetch(new Request("https://s.example.com/?pwd=secret"), { ...env, TAILWIND_CDN_URLS: "https://fast.example/tailwind.js,https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.13/dist/index.global.min.js" }, {});
const customCdnHtml = await customCdnPortal.text();
if (!customCdnHtml.includes("https://fast.example/tailwind.js") || customCdnHtml.indexOf("https://fast.example/tailwind.js") > customCdnHtml.indexOf("cdn.jsdelivr.net")) throw new Error("custom domestic CDN should keep first priority");
for (const needle of ["@tailwindcss/browser", "resourceSearch", "refresh-card", "copy-button", "copyToast", "manual-copy", "navigator.clipboard", "rdp-options", "动态分辨率", "自动缩放", "screenmodeid=i:", "screenwidth=i:", "复制完整 URL", "复制端口", "复制 Host Port", ">认证</a>", ">下载</a>", "download=\"z-rdp.s.example.com.rdp\"", "full%20address%3As%3Az-rdp.n.example.com%3A3389", "href=\"https://hm-hy2.s.example.com/\"", "data-copy=\"2424\"", "data-copy=\"web.n.example.com:2424\"", "rdp://full%20address=s:z-rdp.n.example.com:3389", "href=\"https://web.n.example.com:2424/\"", "href=\"https://hm-hy2.n.example.com:3434/\"", "浏览器时区", "data-time=\"2026-05-26T"]) {
  if (!html.includes(needle)) throw new Error(`portal missing ${needle}`);
}
if (html.includes("<style") || html.includes("style=")) throw new Error("portal should use Tailwind CDN without inline styles");
if (!html.includes("bg-zinc-950") || !html.includes("text-amber-") || !html.includes("redirect-confirm") || !html.includes("确认跳转状态")) {
  throw new Error("portal missing black-gold Tailwind UI or redirect confirmation");
}
if (html.includes("window.confirm")) throw new Error("redirect status should use the Tailwind confirmation overlay");
if (html.includes(">保存</button>")) throw new Error("redirect status should not render a save button");

const auth = await worker.fetch(new Request("https://s.example.com/"), env, {});
const authHtml = await auth.text();
if (!authHtml.includes("@tailwindcss/browser") || authHtml.includes("<style") || authHtml.includes("style=")) {
  throw new Error("auth page should use Tailwind CDN without inline styles");
}

const nonWeb = await worker.fetch(new Request("https://hm-hy2.s.example.com/"), env, {});
const nonWebHtml = await nonWeb.text();
if (!nonWebHtml.includes("@tailwindcss/browser") || nonWebHtml.includes("<style") || nonWebHtml.includes("style=")) {
  throw new Error("non-web page should use Tailwind CDN without inline styles");
}
for (const needle of ["复制 Host Port", "data-copy=\"hm-hy2.s.example.com\"", "data-copy=\"hm-hy2.n.example.com:24467\"", "href=\"https://hm-hy2.n.example.com:3434/\"", "浏览器限制剪贴板"]) {
  if (!nonWebHtml.includes(needle)) throw new Error(`non-web page missing ${needle}`);
}

const exactWeb = await worker.fetch(new Request("https://web.s.example.com/app?x=1"), env, {});
if (exactWeb.status !== 307 || exactWeb.headers.get("Location") !== "https://web.n.example.com:2424/app?x=1") {
  throw new Error("exact web SRV redirect mismatch");
}

const vlessFallback = await worker.fetch(new Request("https://vless-fb.s.example.com/fallback?x=1"), env, {});
if (vlessFallback.status !== 307 || vlessFallback.headers.get("Location") !== "https://vless-fb.n.example.com:8443/fallback?x=1") {
  throw new Error("vless_FB fallback redirect mismatch");
}

const wildcardWeb = await worker.fetch(new Request("https://newapi.s.example.com/path?q=1"), env, {});
if (wildcardWeb.status !== 307 || wildcardWeb.headers.get("Location") !== "https://newapi.n.example.com:2424/path?q=1") {
  throw new Error("wildcard portal subdomain redirect mismatch");
}

const nestedWildcard = await worker.fetch(new Request("https://deep.newapi.s.example.com/path"), env, {});
if (nestedWildcard.status !== 404) throw new Error("nested wildcard fallback should not trigger");

const customTemplate = await worker.fetch(new Request("https://console.s.example.com/ui"), {
  ...env,
  WILDCARD_TEMPLATE_HOSTNAME: "portal.s.example.com",
  WILDCARD_TEMPLATE_TARGET_PREFIXES: "portal",
}, {});
if (customTemplate.status !== 307 || customTemplate.headers.get("Location") !== "https://console.n.example.com:3434/ui") {
  throw new Error("custom wildcard template redirect mismatch");
}

const api1 = await worker.fetch(new Request("https://s.example.com/api/resources?pwd=secret&force=1"), env, {});
const json1 = await api1.json();
if (!json1.ok || json1.resources[0].port !== 24467) throw new Error("initial resource API mismatch");
const hy2Resource = json1.resources.find((r) => r.domain === "hm-hy2.s.example.com");
const webResource = json1.resources.find((r) => r.domain === "web.s.example.com");
const vlessFbResource = json1.resources.find((r) => r.domain === "vless-fb.s.example.com");
const rdpResource = json1.resources.find((r) => r.domain === "z-rdp.s.example.com");
if (hy2Resource.hostPort !== "hm-hy2.n.example.com:24467" || hy2Resource.authUrl !== "https://hm-hy2.n.example.com:3434/") throw new Error("UDP auth fallback or hostPort mismatch");
if (webResource.hostPort !== "web.n.example.com:2424" || webResource.authUrl !== "https://web.n.example.com:2424/") throw new Error("web auth URL mismatch");
if (vlessFbResource.hostPort !== "vless-fb.n.example.com:8443" || vlessFbResource.authUrl !== "https://vless-fb.n.example.com:8443/") throw new Error("vless_fb auth URL mismatch");
if (rdpResource.hostPort !== "z-rdp.n.example.com:3389" || rdpResource.link !== "rdp://full%20address=s:z-rdp.n.example.com:3389") throw new Error("RDP URI mismatch");
if (rdpResource.rdpFileName !== "z-rdp.s.example.com.rdp" || !rdpResource.rdpFileUrl.includes("full%20address%3As%3Az-rdp.n.example.com%3A3389") || !rdpResource.rdpFileUrl.includes("dynamic%20resolution%3Ai%3A1")) throw new Error("RDP download metadata mismatch");

const refresh = await worker.fetch(new Request("https://s.example.com/api/refresh", {
  method: "POST",
  headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.1.1.1" },
  body: JSON.stringify({ pwd: "secret", domain: "hm-hy2.s.example.com", currentPort: 24467 }),
}), env, {});
const refreshJson = await refresh.json();
if (!refreshJson.ok || txtWrites !== 1 || txtDeletes !== 2) throw new Error("refresh API did not replace TXT queue cleanly");

port = 25555;
const api2 = await worker.fetch(new Request("https://s.example.com/api/resources?pwd=secret&force=1"), env, {});
const json2 = await api2.json();
if (json2.resources[0].port !== 25555) throw new Error("forced API did not fetch new port");

let limited = false;
for (let i = 0; i < 26; i += 1) {
  const resp = await worker.fetch(new Request("https://s.example.com/api/resources?pwd=secret&force=1", {
    headers: { "CF-Connecting-IP": "9.9.9.9" },
  }), env, {});
  if (resp.status === 429) {
    limited = true;
    break;
  }
}
if (!limited) throw new Error("force API rate limit did not trigger");

globalThis.portalRateLimits = new Map();
const form = new FormData();
form.set("pwd", "secret");
form.set("refreshDomain", "hm-hy2.s.example.com");
const fallback = await worker.fetch(new Request("https://s.example.com/", {
  method: "POST",
  body: form,
  headers: { "CF-Connecting-IP": "2.2.2.2" },
}), env, {});
if (fallback.status !== 303) throw new Error("POST fallback should use 303");
if (!fallback.headers.get("Location")?.includes("refreshQueued=hm-hy2.s.example.com")) {
  throw new Error("POST fallback location missing refreshQueued marker");
}

console.log("worker smoke ok");
