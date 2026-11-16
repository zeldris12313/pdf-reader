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

// 附帶 8 秒超時保護嘅 fetch，防止死等卡住
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function smartFetch(targetUrl, referer = "https://nhentai.net/") {
  try {
    const directRes = await fetchWithTimeout(
      targetUrl,
      { headers: { ...HEADERS, Referer: referer } },
      8000
    );
    if (directRes.ok) return directRes;
    if (directRes.status !== 429 && directRes.status !== 403) return directRes;
  } catch (_) {}

  const encoded = encodeURIComponent(targetUrl);
  const fallbacks = [
    `https://corsproxy.io/?${encoded}`,
    `https://api.allorigins.win/raw?url=${encoded}`,
  ];

  let lastRes = null;
  for (const proxyUrl of fallbacks) {
    try {
      const res = await fetchWithTimeout(
        proxyUrl,
        { headers: { "User-Agent": HEADERS["User-Agent"] } },
        8000
      );
      if (res.ok) return res;
      lastRes = res;
    } catch (_) {}
  }
  return lastRes || new Response("連線超時或被目標網站限制 (429/403)", { status: 502 });
}

// 解析 nhentai
async function parseNhentai(code) {
  const res = await smartFetch(`https://nhentai.net/g/${code}/`, "https://nhentai.net/");
  if (!res.ok) throw new Error(`nhentai 讀取失敗 (${res.status})`);
  const html = await res.text();

  const ogMatch =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  const h2Match = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const pageTitleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);

  let title = "";
  if (ogMatch && ogMatch[1].trim()) title = ogMatch[1];
  else if (h2Match && h2Match[1].replace(/<[^>]+>/g, "").trim()) title = h2Match[1];
  else if (h1Match && h1Match[1].replace(/<[^>]+>/g, "").trim()) title = h1Match[1];
  else if (pageTitleMatch) title = pageTitleMatch[1].replace(/\s*-\s*nhentai.*$/i, "");
  else title = code;

  const extMap = { j: "jpg", p: "png", g: "gif", w: "webp" };
  const servers = ["https://i.nhentai.net", "https://i2.nhentai.net", "https://i3.nhentai.net"];
  const urls = [];

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
  return { title: sanitize(title), urls, referer: "https://nhentai.net/" };
}

// 解析 MyReadingManga
async function parseMRM(url) {
  const res = await smartFetch(url, "https://myreadingmanga.info/");
  if (!res.ok) throw new Error(`MyReadingManga 讀取失敗 (${res.status})`);
  const html = await res.text();
  const h1Match = html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  const pageTitleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const title = h1Match
    ? h1Match[1]
    : pageTitleMatch
    ? pageTitleMatch[1].replace(/\s*[-|]\s*MyReadingManga.*$/i, "")
    : "MyReadingManga";

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
  if (urls.length === 0) throw new Error("找不到 MyReadingManga 圖片（可能受防護盾阻擋）");
  return { title: sanitize(title), urls, referer: url };
}

// 解析 E-Hentai（先回傳閱讀頁連結，由前端逐頁解析原圖，避免 Worker 超時）
async function parseEHentai(url) {
  let base = url.split("?")[0];
  if (!base.endsWith("/")) base += "/";
  const ehHeaders = { ...HEADERS, Referer: "https://e-hentai.org/", Cookie: "nw=1" };

  const res = await fetchWithTimeout(`${base}?nw=always`, { headers: ehHeaders }, 10000);
  if (!res.ok) throw new Error(`E-Hentai 讀取失敗 (${res.status})`);
  const html = await res.text();

  const gj = html.match(/<h1 id="gj">([\s\S]*?)<\/h1>/i);
  const gn = html.match(/<h1 id="gn">([\s\S]*?)<\/h1>/i);
  const title = (gj && gj[1].trim()) || (gn && gn[1].trim()) || "EHentai";

  let maxPage = 0;
  const pageMatches = [...html.matchAll(/\?p=(\d+)/g)];
  pageMatches.forEach((m) => {
    maxPage = Math.max(maxPage, parseInt(m[1], 10));
  });

  const readerLinks = [];
  for (let p = 0; p <= maxPage; p++) {
    const pHtml =
      p === 0
        ? html
        : await (await fetchWithTimeout(`${base}?p=${p}&nw=always`, { headers: ehHeaders }, 10000)).text();
    const sRegex = /https:\/\/e-hentai\.org\/s\/[a-z0-9]+\/\d+-\d+/gi;
    let sm;
    while ((sm = sRegex.exec(pHtml)) !== null) {
      if (!readerLinks.includes(sm[0])) readerLinks.push(sm[0]);
    }
  }
  if (readerLinks.length === 0) throw new Error("找不到 E-Hentai 閱讀連結");
  return { title: sanitize(title), urls: readerLinks, referer: "https://e-hentai.org/", mode: "eh_pages" };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    // 即時解析作品目錄並直接回傳清單
    if (url.pathname === "/api/parse" && request.method === "POST") {
      try {
        const { query } = await request.json();
        const q = (query || "").trim();
        let data;
        if (/^\d+$/.test(q)) {
          data = await parseNhentai(q);
        } else if (q.includes("nhentai.net/g/")) {
          const m = q.match(/\/g\/(\d+)/);
          data = await parseNhentai(m[1]);
        } else if (q.includes("myreadingmanga.info")) {
          data = await parseMRM(q);
        } else if (q.includes("e-hentai.org/g/") || q.includes("exhentai.org/g/")) {
          data = await parseEHentai(q.replace("exhentai.org", "e-hentai.org"));
        } else {
          throw new Error("請輸入 nhentai 番號、MyReadingManga 或 E-Hentai 網址");
        }
        return new Response(JSON.stringify({ ok: true, ...data }), {
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
          status: 400,
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }
    }

    // 單張圖片或 E-Hentai 單頁解析中轉
    const targetUrl = url.searchParams.get("url");
    const referer = url.searchParams.get("ref") || "https://nhentai.net/";
    if (!targetUrl) return new Response("Missing url", { status: 400, headers: CORS });

    try {
      // 若為 E-Hentai 單頁閱讀網址，自動抽出真實原圖並下載
      if (targetUrl.includes("e-hentai.org/s/")) {
        const pageRes = await fetchWithTimeout(
          targetUrl,
          { headers: { ...HEADERS, Referer: "https://e-hentai.org/", Cookie: "nw=1" } },
          10000
        );
        const pageHtml = await pageRes.text();
        const imgMatch = pageHtml.match(/<img id="img"[^>]+src=["']([^"']+)["']/i);
        if (!imgMatch) return new Response("無法解析 E-Hentai 原圖", { status: 502, headers: CORS });
        const imgRes = await fetchWithTimeout(
          imgMatch[1],
          { headers: { ...HEADERS, Referer: targetUrl } },
          12000
        );
        const newHeaders = new Headers(imgRes.headers);
        Object.entries(CORS).forEach(([k, v]) => newHeaders.set(k, v));
        return new Response(imgRes.body, { status: imgRes.status, headers: newHeaders });
      }

      const response = await smartFetch(targetUrl, referer);
      const newHeaders = new Headers(response.headers);
      Object.entries(CORS).forEach(([k, v]) => newHeaders.set(k, v));
      return new Response(response.body, { status: response.status, headers: newHeaders });
    } catch (err) {
      return new Response(err.message, { status: 500, headers: CORS });
    }
  },
};