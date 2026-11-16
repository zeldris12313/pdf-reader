const TASKS = new Map();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
};

function decodeHtml(str) {
  return (str || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec));
}

function sanitize(name) {
  const clean = decodeHtml(name)
    .replace(/<[^>]+>/g, "")
    .replace(/[\\/*?:"<>|\r\n]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? clean.slice(0, 110) : "manga";
}

// 解析 nhentai（加強多層標題抓取）
async function parseNhentai(code) {
  const res = await fetch(`https://nhentai.net/g/${code}/`, { headers: { ...HEADERS, Referer: "https://nhentai.net/" } });
  if (!res.ok) throw new Error(`nhentai 讀取失敗 (${res.status})`);
  const html = await res.text();

  // 依序嘗試：日文副標題(h2) -> 主標題(h1) -> 網頁 <title> -> 番號
  const h2Match = html.match(/<h2[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i);
  const h1Match = html.match(/<h1[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  const pageTitleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);

  let title = "";
  if (h2Match && h2Match[1].replace(/<[^>]+>/g, "").trim()) {
    title = h2Match[1];
  } else if (h1Match && h1Match[1].replace(/<[^>]+>/g, "").trim()) {
    title = h1Match[1];
  } else if (pageTitleMatch) {
    title = pageTitleMatch[1].replace(/\s*-\s*nhentai.*$/i, "");
  } else {
    title = code;
  }

  const extMap = { j: "jpg", p: "png", g: "gif", w: "webp" };
  const servers = ["https://i.nhentai.net", "https://i2.nhentai.net", "https://i3.nhentai.net"];
  const urls = [];

  // 支援單引號或雙引號嘅 _gallery JSON
  const jsonMatch = html.match(/window\._gallery\s*=\s*JSON\.parse\((['"])(.+?)\1\)/);
  if (jsonMatch) {
    try {
      const raw = jsonMatch[1] === "'" ? jsonMatch[2].replace(/\\'/g, "'") : JSON.parse(`"${jsonMatch[2]}"`);
      const data = JSON.parse(raw);
      title = (data.title && (data.title.japanese || data.title.english || data.title.pretty)) || title;
      const pages = (data.images && data.images.pages) || [];
      pages.forEach((p, idx) => {
        const ext = extMap[p.t] || "jpg";
        urls.push(`${servers[idx % servers.length]}/galleries/${data.media_id}/${idx + 1}.${ext}`);
      });
    } catch (_) {}
  }

  if (urls.length === 0) {
    const regex = /\/galleries\/(\d+)\/(\d+)t\.(jpg|png|gif|webp)/gi;
    let m;
    while ((m = regex.exec(html)) !== null) {
      const u = `${servers[urls.length % servers.length]}/galleries/${m[1]}/${m[2]}.${m[3]}`;
      if (!urls.includes(u)) urls.push(u);
    }
  }
  if (urls.length === 0) throw new Error("找不到 nhentai 圖片");
  return { title, urls, referer: "https://nhentai.net/" };
}

// 解析 MyReadingManga
async function parseMRM(url) {
  const res = await fetch(url, { headers: { ...HEADERS, Referer: "https://myreadingmanga.info/" } });
  if (!res.ok) throw new Error(`MyReadingManga 讀取失敗 (${res.status})`);
  const html = await res.text();
  const h1Match = html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  const pageTitleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const title = h1Match ? h1Match[1] : (pageTitleMatch ? pageTitleMatch[1].replace(/\s*[-|]\s*MyReadingManga.*$/i, "") : "MyReadingManga");

  const urls = [];
  const imgRegex = /<img[^>]+(?:data-src|data-lazy-src|src)=["']([^"']+)["']/gi;
  let m;
  while ((m = imgRegex.exec(html)) !== null) {
    let src = m[1];
    if (src.startsWith("//")) src = "https:" + src;
    if (src.startsWith("http") && !/avatar|logo|icon|blank\.gif|gravatar|wp-includes/i.test(src)) {
      if (!urls.includes(src)) urls.push(src);
    }
  }
  if (urls.length === 0) throw new Error("找不到 MyReadingManga 圖片（可能受 Cloudflare 阻擋）");
  return { title, urls, referer: url };
}

// 解析 E-Hentai
async function parseEHentai(url, task) {
  let base = url.split("?")[0];
  if (!base.endsWith("/")) base += "/";
  const ehHeaders = { ...HEADERS, Referer: "https://e-hentai.org/", Cookie: "nw=1" };

  const res = await fetch(`${base}?nw=always`, { headers: ehHeaders });
  if (!res.ok) throw new Error(`E-Hentai 讀取失敗 (${res.status})`);
  const html = await res.text();

  const gj = html.match(/<h1 id="gj">([\s\S]*?)<\/h1>/i);
  const gn = html.match(/<h1 id="gn">([\s\S]*?)<\/h1>/i);
  const title = (gj && gj[1].trim()) || (gn && gn[1].trim()) || "EHentai";

  let maxPage = 0;
  const pageMatches = [...html.matchAll(/\?p=(\d+)/g)];
  pageMatches.forEach(m => { maxPage = Math.max(maxPage, parseInt(m[1], 10)); });

  const readerLinks = [];
  for (let p = 0; p <= maxPage; p++) {
    task.progress = `正在掃描 E-Hentai 目錄 (${p + 1}/${maxPage + 1})...`;
    const pHtml = p === 0 ? html : await (await fetch(`${base}?p=${p}&nw=always`, { headers: ehHeaders })).text();
    const sRegex = /https:\/\/e-hentai\.org\/s\/[a-z0-9]+\/\d+-\d+/gi;
    let sm;
    while ((sm = sRegex.exec(pHtml)) !== null) {
      if (!readerLinks.includes(sm[0])) readerLinks.push(sm[0]);
    }
  }
  if (readerLinks.length === 0) throw new Error("找不到 E-Hentai 閱讀連結");

  const urls = [];
  for (let i = 0; i < readerLinks.length; i++) {
    task.progress = `正在解析 E-Hentai 原圖網址 (${i + 1}/${readerLinks.length})...`;
    const rHtml = await (await fetch(readerLinks[i], { headers: ehHeaders })).text();
    const imgMatch = rHtml.match(/<img id="img"[^>]+src=["']([^"']+)["']/i);
    if (imgMatch) urls.push(imgMatch[1]);
  }
  if (urls.length === 0) throw new Error("無法取得 E-Hentai 原圖網址");
  return { title, urls, referer: "https://e-hentai.org/" };
}

async function processTask(taskId, query) {
  const task = TASKS.get(taskId);
  try {
    const q = query.trim();
    task.progress = "正在識別網站並抓取原圖清單...";
    let info;
    if (/^\d+$/.test(q)) {
      info = await parseNhentai(q);
    } else if (q.includes("nhentai.net/g/")) {
      const m = q.match(/\/g\/(\d+)/);
      info = await parseNhentai(m[1]);
    } else if (q.includes("myreadingmanga.info")) {
      info = await parseMRM(q);
    } else if (q.includes("e-hentai.org/g/") || q.includes("exhentai.org/g/")) {
      info = await parseEHentai(q.replace("exhentai.org", "e-hentai.org"), task);
    } else {
      throw new Error("請輸入 nhentai 番號、MyReadingManga 或 E-Hentai 網址");
    }

    task.title = sanitize(info.title);
    task.urls = info.urls;
    task.referer = info.referer;
    task.status = "done";
    task.progress = `解析完成！共 ${info.urls.length} 頁原圖`;
  } catch (e) {
    task.status = "error";
    task.progress = e.message;
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === "/api/create" && request.method === "POST") {
      const { query } = await request.json();
      const taskId = crypto.randomUUID().slice(0, 8);
      TASKS.set(taskId, { status: "running", progress: "已加入後台排程...", title: "", urls: [], referer: "" });
      ctx.waitUntil(processTask(taskId, query));
      return new Response(JSON.stringify({ task_id: taskId }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    if (url.pathname.startsWith("/api/status/")) {
      const taskId = url.pathname.split("/").pop();
      const task = TASKS.get(taskId);
      if (!task) return new Response(JSON.stringify({ status: "error", progress: "任務已過期或節點已重置，請重新輸入" }), { headers: { ...CORS, "Content-Type": "application/json" } });
      return new Response(JSON.stringify(task), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    const targetUrl = url.searchParams.get("url");
    const referer = url.searchParams.get("ref") || "https://nhentai.net/";
    if (!targetUrl) return new Response("Missing url", { status: 400, headers: CORS });

    try {
      const response = await fetch(targetUrl, { headers: { ...HEADERS, Referer: referer } });
      const newHeaders = new Headers(response.headers);
      Object.entries(CORS).forEach(([k, v]) => newHeaders.set(k, v));
      return new Response(response.body, { status: response.status, headers: newHeaders });
    } catch (err) {
      return new Response(err.message, { status: 500, headers: CORS });
    }
  }
};