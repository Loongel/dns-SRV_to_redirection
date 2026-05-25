import worker from "../worker.js";

let port = 24467;
let txtWrites = 0;
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

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.searchParams.get("type") === "SRV") {
    return Response.json({ success: true, result: [srvRecord()], result_info: { page: 1, total_pages: 1 } });
  }
  if (u.searchParams.get("type") === "TXT") {
    return Response.json({ success: true, result: [] });
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
for (const needle of ["resourceSearch", "refresh-card", "浏览器时区", "data-time=\"2026-05-26T"]) {
  if (!html.includes(needle)) throw new Error(`portal missing ${needle}`);
}

const api1 = await worker.fetch(new Request("https://s.example.com/api/resources?pwd=secret&force=1"), env, {});
const json1 = await api1.json();
if (!json1.ok || json1.resources[0].port !== 24467) throw new Error("initial resource API mismatch");

const refresh = await worker.fetch(new Request("https://s.example.com/api/refresh", {
  method: "POST",
  headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.1.1.1" },
  body: JSON.stringify({ pwd: "secret", domain: "hm-hy2.s.example.com", currentPort: 24467 }),
}), env, {});
const refreshJson = await refresh.json();
if (!refreshJson.ok || txtWrites !== 1) throw new Error("refresh API did not queue TXT");

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
