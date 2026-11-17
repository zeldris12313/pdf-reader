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

// 解析 nhentai（主站遇 403/429 自動輪換同源鏡像站）
async function parseNhentai(code) {
  const sources = [
    { page: `https://nhentai.net/g/${code}/`, ref: "https://nhentai.net/" },
    { page: `https://nhentai.to/g/${code}/`, ref: "https://nhentai.to/" },
    { page: `https://nhentai.xxx/g/${code}/`, ref: "https://nhentai.xxx/" },
    { page: `https://nhentai.website/g/${code}/`, ref: "https://nhentai.website/" },
  ];

  let html = "";
  let activeRef = "https://nhentai.net/";
  let lastStatus = 403;

  for (const src of sources) {
    try {
      const res = await fetchWithTimeout(
        src.page,
        { headers: { ...HEADERS, Referer: src.ref } },
        8000
      );
      lastStatus = res.status;
      if (res.ok) {
        const text = await res.text();
        if (text.includes("/galleries/")) {
          html = text;
          activeRef = src.ref;
          break;
        }
      }
    } catch (_) {}
  }

  if (!html) {
    throw new Error(`nhentai 所有路線均被限制 (最後狀態碼 ${lastStatus})`);
  }

  // 多層書名提取
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
  else if (pageTitleMatch) title = pageTitleMatch[1];
  else title = code;

  title = title.replace(/\s*[-|]\s*nhentai.*$/i, "").trim() || code;

  const extMap = { j: "jpg", p: "png", g: "gif", w: "webp" };
  const servers = ["https://i.nhentai.net", "https://i2.nhentai.net", "https://i3.nhentai.net"];
  const urls = [];

  // 優先嘗試解析內嵌 JSON
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

  // 從縮圖網址還原原圖清單（兼容主站與所有鏡像站格式）
  if (urls.length === 0) {
    const thumbRegex = /(?:data-src|src)=["']((?:https?:)?\/\/[^"']+\/galleries\/(\d+)\/(\d+)t\.(jpg|png|gif|webp))["']/gi;
    let m;
    const seenPages = new Set();
    while ((m = thumbRegex.exec(html)) !== null) {
      let fullThumb = m[1];
      if (fullThumb.startsWith("//")) fullThumb = "https:" + fullThumb;
      const mediaId = m[2];
      const pageNum = m[3];
      const ext = m[4];
      if (seenPages.has(pageNum)) continue;
      seenPages.add(pageNum);

      // 將鏡像站縮圖轉為對應原圖網址（例如 t3.nhentai.xxx/1t.jpg -> i3.nhentai.xxx/1.jpg）
      const mirrorFull = fullThumb
        .replace(/\/\/t(\d*\.)/i, "//i$1")
        .replace(/(\/\d+)t\.(jpg|png|gif|webp)$/i, "$1.$2");

      // 若是 i.nhentai.net 則輪流分散負載，否則直接用鏡像站高速 CDN
      if (mirrorFull.includes("nhentai.net")) {
        urls.push(`${servers[urls.length % servers.length]}/galleries/${mediaId}/${pageNum}.${ext}`);
      } else {
        urls.push(mirrorFull);
      }
    }
  }

  if (urls.length === 0) throw new Error("無法從頁面解析出圖片列表");
  return { title: sanitize(title), urls, referer: activeRef };
}

// 解析 MyReadingManga
async function parseMRM(url) {
  const res = await fetchWithTimeout(
    url,
    { headers: { ...HEADERS, Referer: "https://myreadingmanga.info/" } },
    10000
  );
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
        } else if (q.includes("nhentai") && /\/g\/(\d+)/.test(q)) {
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

      // 下載單張原圖（若鏡像站失敗，自動嘗試官方圖片節點備援）
      let imgRes = await fetchWithTimeout(
        targetUrl,
        { headers: { ...HEADERS, Referer: referer } },
        10000
      );

      if (!imgRes.ok && targetUrl.includes("/galleries/")) {
        const gMatch = targetUrl.match(/\/galleries\/(\d+\/\d+\.(?:jpg|png|gif|webp))/i);
        if (gMatch) {
          imgRes = await fetchWithTimeout(
            `https://i.nhentai.net/galleries/${gMatch[1]}`,
            { headers: { ...HEADERS, Referer: "https://nhentai.net/" } },
            10000
          );
        }
      }

      const newHeaders = new Headers(imgRes.headers);
      Object.entries(CORS).forEach(([k, v]) => newHeaders.set(k, v));
      return new Response(imgRes.body, { status: imgRes.status, headers: newHeaders });
    } catch (err) {
      return new Response(err.message, { status: 500, headers: CORS });
    }
  },
};