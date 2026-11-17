const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// 僅針對官方目標網址抓取值，遇 IP 限制時改用中繼節點讀取同一網址（確保番號 100% 一致）
async function fetchTargetPage(targetUrl, referer) {
  try {
    const directRes = await fetchWithTimeout(
      targetUrl,
      { headers: { ...HEADERS, Referer: referer } },
      8000
    );
    if (directRes.ok) return directRes;
    if (directRes.status !== 403 && directRes.status !== 429) return directRes;
  } catch (_) {}

  const encoded = encodeURIComponent(targetUrl);
  const relays = [
    `https://api.allorigins.win/raw?url=${encoded}`,
    `https://corsproxy.io/?${encoded}`,
  ];

  let lastRes = null;
  for (const relay of relays) {
    try {
      const res = await fetchWithTimeout(
        relay,
        { headers: { "User-Agent": HEADERS["User-Agent"] } },
        9000
      );
      if (res.ok) return res;
      lastRes = res;
    } catch (_) {}
  }
  return lastRes || new Response("無法連線至目標網頁 (403/429)", { status: 502 });
}

// 解析 nhentai（嚴格鎖定官方番號與主縮圖區塊）
async function parseNhentai(code) {
  const officialUrl = `https://nhentai.net/g/${code}/`;
  const res = await fetchTargetPage(officialUrl, "https://nhentai.net/");
  if (!res.ok) throw new Error(`nhentai 讀取失敗 (${res.status})`);
  const html = await res.text();

  // 驗證頁面確實屬於該番號
  if (!html.includes(`/g/${code}/`) && !html.includes(`#${code}`)) {
    throw new Error(`回傳頁面與番號 ${code} 不符（可能觸發驗證頁）`);
  }

  // 提取書名（優先取日文副標題 h2，其次主標題 h1 或 og:title）
  const h2Match = html.match(/<h2[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i);
  const h1Match = html.match(/<h1[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  const ogMatch =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);

  let title = "";
  if (h2Match && h2Match[1].replace(/<[^>]+>/g, "").trim()) title = h2Match[1];
  else if (h1Match && h1Match[1].replace(/<[^>]+>/g, "").trim()) title = h1Match[1];
  else if (ogMatch && ogMatch[1].trim()) title = ogMatch[1];
  else title = code;

  title = title.replace(/\s*[-|]\s*nhentai.*$/i, "").trim() || code;

  const extMap = { j: "jpg", p: "png", g: "gif", w: "webp" };
  const servers = ["https://i.nhentai.net", "https://i2.nhentai.net", "https://i3.nhentai.net"];
  const urls = [];

  // 1. 優先解析內嵌 _gallery JSON
  const jsonMatch = html.match(/window\._gallery\s*=\s*JSON\.parse\((['"])(.+?)\1\)/);
  if (jsonMatch) {
    try {
      const raw = jsonMatch[1] === "'" ? jsonMatch[2].replace(/\\'/g, "'") : JSON.parse(`"${jsonMatch[2]}"`);
      const data = JSON.parse(raw);
      if (String(data.id) === String(code)) {
        title = (data.title && (data.title.japanese || data.title.english || data.title.pretty)) || title;
        const pages = (data.images && data.images.pages) || [];
        pages.forEach((p, idx) => {
          const ext = extMap[p.t] || "jpg";
          urls.push(`${servers[idx % servers.length]}/galleries/${data.media_id}/${idx + 1}.${ext}`);
        });
      }
    } catch (_) {}
  }

  // 2. 後備：只截取 #thumbnail-container 至 #related-container 之間嘅主縮圖，絕不掃描底部推薦區
  if (urls.length === 0) {
    const startIdx = html.indexOf('id="thumbnail-container"');
    const endIdx = html.indexOf('id="related-container"');
    const mainSection =
      startIdx !== -1
        ? html.slice(startIdx, endIdx > startIdx ? endIdx : startIdx + 150000)
        : "";

    const thumbRegex = /\/galleries\/(\d+)\/(\d+)t\.(jpg|png|gif|webp)/gi;
    let m;
    let lockedMediaId = null;
    const seenPages = new Set();

    while ((m = thumbRegex.exec(mainSection)) !== null) {
      const mediaId = m[1];
      const pageNum = m[2];
      const ext = m[3];

      if (!lockedMediaId) lockedMediaId = mediaId;
      if (mediaId !== lockedMediaId) continue; // 鎖定單一 media_id，防止混入其他作品
      if (seenPages.has(pageNum)) continue;
      seenPages.add(pageNum);

      urls.push(`${servers[urls.length % servers.length]}/galleries/${mediaId}/${pageNum}.${ext}`);
    }
  }

  if (urls.length === 0) throw new Error(`無法從番號 ${code} 主縮圖區解析圖片`);
  return { title: sanitize(title), urls, referer: "https://nhentai.net/" };
}

// 解析 MyReadingManga
async function parseMRM(url) {
  const res = await fetchTargetPage(url, "https://myreadingmanga.info/");
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
  if (urls.length === 0) throw new Error("找不到 MyReadingManga 圖片");
  return { title: sanitize(title), urls, referer: url };
}

// 解析 E-Hentai
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
  return { title: sanitize(title), urls: readerLinks, referer: "https://e-hentai.org/" };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === "/api/parse" && request.method === "POST") {
      try {
        const { query } = await request.json();
        const q = (query || "").trim();
        let data;
        if (/^\d+$/.test(q)) {
          data = await parseNhentai(q);
        } else if (q.includes("nhentai.net/g/") && /\/g\/(\d+)/.test(q)) {
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

    const targetUrl = url.searchParams.get("url");
    const referer = url.searchParams.get("ref") || "https://nhentai.net/";
    if (!targetUrl) return new Response("Missing url", { status: 400, headers: CORS });

    try {
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

      const imgRes = await fetchTargetPage(targetUrl, referer);
      const newHeaders = new Headers(imgRes.headers);
      Object.entries(CORS).forEach(([k, v]) => newHeaders.set(k, v));
      return new Response(imgRes.body, { status: imgRes.status, headers: newHeaders });
    } catch (err) {
      return new Response(err.message, { status: 500, headers: CORS });
    }
  },
};