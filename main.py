import io
import re
import time
import uuid
import asyncio
from urllib.parse import urljoin, quote
import httpx
import img2pdf
from PIL import Image
from bs4 import BeautifulSoup
from pydantic import BaseModel
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

app = FastAPI()

# 允許你嘅 GitHub Pages 網頁跨網域連線
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

TASKS = {}  # 暫存任務狀態與成品（保留 1 小時）

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
}

class TaskRequest(BaseModel):
    query: str

def sanitize_filename(name: str) -> str:
    clean = re.sub(r'[\\/*?:"<>|\r\n]+', "_", name).strip()
    return clean[:100] if clean else "manga"

def cleanup_old_tasks():
    now = time.time()
    expired = [tid for tid, t in TASKS.items() if now - t["created_at"] > 3600]
    for tid in expired:
        del TASKS[tid]

# --- 網站 1：nhentai 解析 ---
async def parse_nhentai(client: httpx.AsyncClient, code: str):
    url = f"https://nhentai.net/g/{code}/"
    res = await client.get(url, headers={**HEADERS, "Referer": "https://nhentai.net/"})
    if res.status_code != 200:
        raise Exception(f"nhentai 讀取失敗 (狀態碼 {res.status_code})")
    
    html = res.text
    soup = BeautifulSoup(html, "html.parser")
    h1 = soup.select_one("h1.title")
    title = h1.get_text(strip=True) if h1 else code

    ext_map = {"j": "jpg", "p": "png", "g": "gif", "w": "webp"}
    servers = ["https://i.nhentai.net", "https://i2.nhentai.net", "https://i3.nhentai.net"]
    urls = []

    m = re.search(r'window\._gallery\s*=\s*JSON\.parse\("(.+?)"\);', html)
    if m:
        import json
        data = json.loads(json.loads(f'"{m.group(1)}"'))
        title = data.get("title", {}).get("japanese") or data.get("title", {}).get("english") or title
        pages = data.get("images", {}).get("pages", [])
        media_id = data.get("media_id")
        for idx, p in enumerate(pages):
            ext = ext_map.get(p.get("t"), "jpg")
            urls.append(f"{servers[idx % len(servers)]}/galleries/{media_id}/{idx + 1}.{ext}")
    else:
        for idx, img in enumerate(soup.select(".thumb-container img")):
            src = img.get("data-src") or img.get("src") or ""
            match = re.search(r"/galleries/(\d+)/(\d+)t\.(jpg|png|gif|webp)", src, re.I)
            if match:
                urls.append(f"{servers[idx % len(servers)]}/galleries/{match.group(1)}/{match.group(2)}.{match.group(3)}")

    if not urls:
        raise Exception("無法從 nhentai 頁面找到圖片")
    return title, urls, "https://nhentai.net/"

# --- 網站 2：MyReadingManga 解析 ---
async def parse_mrm(client: httpx.AsyncClient, url: str):
    res = await client.get(url, headers={**HEADERS, "Referer": "https://myreadingmanga.info/"})
    if res.status_code != 200:
        raise Exception(f"MyReadingManga 讀取失敗 (狀態碼 {res.status_code})")
    
    soup = BeautifulSoup(res.text, "html.parser")
    h1 = soup.select_one("h1.entry-title")
    title = h1.get_text(strip=True) if h1 else "MyReadingManga"

    urls = []
    for img in soup.select(".entry-content img"):
        src = img.get("data-src") or img.get("data-lazy-src") or img.get("src") or ""
        if src.startswith("//"):
            src = "https:" + src
        if src.startswith("http") and not any(x in src.lower() for x in ["avatar", "logo", "icon", "blank.gif", "data:image"]):
            if src not in urls:
                urls.append(src)

    if not urls:
        raise Exception("無法在該頁面找到漫畫圖片（可能受 Cloudflare 阻擋）")
    return title, urls, url

# --- 網站 3：E-Hentai 解析 ---
async def parse_ehentai(client: httpx.AsyncClient, url: str, task_id: str):
    # 加上 nw=always 自動跳過內容警告頁
    base_url = url.split("?")[0]
    if not base_url.endswith("/"):
        base_url += "/"
    
    eh_headers = {**HEADERS, "Referer": "https://e-hentai.org/", "Cookie": "nw=1"}
    res = await client.get(f"{base_url}?nw=always", headers=eh_headers)
    if res.status_code != 200:
        raise Exception(f"E-Hentai 讀取失敗 (狀態碼 {res.status_code})")

    soup = BeautifulSoup(res.text, "html.parser")
    gj = soup.select_one("h1#gj")
    gn = soup.select_one("h1#gn")
    title = (gj.get_text(strip=True) if gj and gj.get_text(strip=True) else (gn.get_text(strip=True) if gn else "EHentai"))

    # 計算目錄總共有幾頁 (p=0, 1, 2...)
    max_page = 0
    for td in soup.select("table.ptt td"):
        txt = td.get_text(strip=True)
        if txt.isdigit():
            max_page = max(max_page, int(txt) - 1)

    reader_links = []
    for p in range(max_page + 1):
        TASKS[task_id]["progress"] = f"正在掃描 E-Hentai 目錄第 {p + 1}/{max_page + 1} 頁..."
        page_soup = soup if p == 0 else BeautifulSoup((await client.get(f"{base_url}?p={p}&nw=always", headers=eh_headers)).text, "html.parser")
        for a in page_soup.select('a[href*="/s/"]'):
            href = a.get("href")
            if href and href not in reader_links:
                reader_links.append(href)

    if not reader_links:
        raise Exception("找不到 E-Hentai 閱讀頁面連結")

    # 逐頁進入閱讀頁抽出真實圖片網址
    img_urls = []
    total = len(reader_links)
    for idx, r_link in enumerate(reader_links):
        TASKS[task_id]["progress"] = f"正在解析原圖網址 ({idx + 1}/{total} 頁)..."
        r_res = await client.get(r_link, headers=eh_headers)
        r_soup = BeautifulSoup(r_res.text, "html.parser")
        img_tag = r_soup.select_one("img#img")
        if img_tag and img_tag.get("src"):
            img_urls.append(img_tag.get("src"))
        await asyncio.sleep(0.15)

    if not img_urls:
        raise Exception("無法取得 E-Hentai 原圖網址")
    return title, img_urls, "https://e-hentai.org/"

# --- 核心後台下載與合成任務 ---
async def run_download_task(task_id: str, query: str):
    try:
        q = query.strip()
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            TASKS[task_id]["progress"] = "正在識別網站與讀取目錄..."
            
            if q.isdigit():
                title, img_urls, referer = await parse_nhentai(client, q)
            elif "nhentai.net/g/" in q:
                m = re.search(r"/g/(\d+)", q)
                title, img_urls, referer = await parse_nhentai(client, m.group(1))
            elif "myreadingmanga.info" in q:
                title, img_urls, referer = await parse_mrm(client, q)
            elif "e-hentai.org/g/" in q or "exhentai.org/g/" in q:
                eh_url = q.replace("exhentai.org", "e-hentai.org")
                title, img_urls, referer = await parse_ehentai(client, eh_url, task_id)
            else:
                raise Exception("不支援的網址格式，請輸入 nhentai 番號、MyReadingManga 或 E-Hentai 網址")

            safe_title = sanitize_filename(title)
            TASKS[task_id]["title"] = safe_title
            total = len(img_urls)
            jpeg_pages = []
            cover_png_bytes = None

            for idx, img_url in enumerate(img_urls):
                TASKS[task_id]["progress"] = f"背景下載原圖中 ({idx + 1} / {total} 頁)..."
                img_res = await client.get(img_url, headers={**HEADERS, "Referer": referer})
                if img_res.status_code != 200:
                    raise Exception(f"第 {idx + 1} 頁下載失敗 (狀態碼 {img_res.status_code})")

                im = Image.open(io.BytesIO(img_res.content)).convert("RGB")
                
                # 第 1 頁額外儲存獨立 PNG 封面
                if idx == 0:
                    png_buf = io.BytesIO()
                    im.save(png_buf, format="PNG")
                    cover_png_bytes = png_buf.getvalue()

                # 統一轉為標準 JPEG 供 img2pdf 無損合併
                jpg_buf = io.BytesIO()
                im.save(jpg_buf, format="JPEG", quality=92)
                jpeg_pages.append(jpg_buf.getvalue())

            TASKS[task_id]["progress"] = "正在合成 PDF 檔案..."
            pdf_bytes = img2pdf.convert(jpeg_pages)

            TASKS[task_id]["pdf_bytes"] = pdf_bytes
            TASKS[task_id]["png_bytes"] = cover_png_bytes
            TASKS[task_id]["status"] = "done"
            TASKS[task_id]["progress"] = f"完成！共 {total} 頁"
    except Exception as e:
        TASKS[task_id]["status"] = "error"
        TASKS[task_id]["progress"] = str(e)

@app.get("/")
def health():
    return {"status": "ok"}

@app.post("/api/create")
async def create_task(req: TaskRequest):
    cleanup_old_tasks()
    task_id = str(uuid.uuid4())[:8]
    TASKS[task_id] = {
        "status": "running",
        "progress": "已加入後台排程...",
        "title": "",
        "pdf_bytes": None,
        "png_bytes": None,
        "created_at": time.time(),
    }
    asyncio.create_task(run_download_task(task_id, req.query))
    return {"task_id": task_id}

@app.get("/api/status/{task_id}")
def get_status(task_id: str):
    task = TASKS.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="找不到該任務（可能已過期）")
    return {
        "status": task["status"],
        "progress": task["progress"],
        "title": task["title"],
    }

@app.get("/api/file/{task_id}/{file_type}")
def download_file(task_id: str, file_type: str):
    task = TASKS.get(task_id)
    if not task or task["status"] != "done":
        raise HTTPException(status_code=404, detail="檔案尚未就緒或已過期")

    if file_type == "pdf":
        data = task["pdf_bytes"]
        filename = f"{task['title']}.pdf"
        media_type = "application/pdf"
    elif file_type == "png":
        data = task["png_bytes"]
        filename = f"{task['title']}_封面.png"
        media_type = "image/png"
    else:
        raise HTTPException(status_code=400, detail="無效的檔案類型")

    encoded_name = quote(filename)
    return Response(
        content=data,
        media_type=media_type,
        headers={
            "Content-Disposition": f"attachment; filename=\"download.{file_type}\"; filename*=UTF-8''{encoded_name}"
        },
    )