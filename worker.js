<!DOCTYPE html>
<html lang="zh-HK">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <title>全能漫畫轉 PDF</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #121212; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 16px; box-sizing: border-box; }
        .card { background: #1e1e1e; padding: 1.8rem; border-radius: 16px; width: 100%; max-width: 420px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.6rem; }
        h2 { margin: 0; font-size: 1.3rem; }
        .sub { font-size: 0.8rem; color: #888; margin-bottom: 1.2rem; line-height: 1.4; }
        .gear-btn { background: #2c2c2c; border: none; color: #fff; padding: 8px 12px; border-radius: 8px; font-size: 0.85rem; cursor: pointer; }
        input { width: 100%; padding: 14px; font-size: 1rem; border-radius: 10px; border: 1px solid #333; background: #2c2c2c; color: #fff; box-sizing: border-box; margin-bottom: 1rem; }
        button.primary { width: 100%; padding: 14px; font-size: 1.05rem; font-weight: bold; border-radius: 10px; border: none; background: #ed2553; color: white; cursor: pointer; }
        button.primary:disabled { background: #555; }
        #status { margin-top: 1rem; font-size: 0.9rem; color: #bbb; text-align: center; min-height: 1.4rem; line-height: 1.5; word-break: break-word; white-space: pre-line; }
        #result-box { display: none; margin-top: 1.2rem; padding: 1rem; background: #262626; border-radius: 12px; border: 1px solid #383838; }
        .book-title { font-size: 0.95rem; font-weight: bold; color: #fff; margin-bottom: 0.9rem; line-height: 1.4; word-break: break-word; }
        .dl-btn { width: 100%; padding: 12px; font-size: 1rem; font-weight: bold; border-radius: 10px; border: none; color: #fff; cursor: pointer; margin-bottom: 0.6rem; display: flex; justify-content: center; align-items: center; gap: 6px; }
        .dl-pdf { background: #2ea043; }
        .dl-png { background: #1f6feb; margin-bottom: 0; }
        #settings-panel { display: none; margin-top: 1.2rem; padding-top: 1.2rem; border-top: 1px solid #333; }
        label { display: block; font-size: 0.85rem; color: #bbb; margin-bottom: 6px; }
    </style>
</head>
<body>
    <div class="card">
        <div class="header">
            <h2>全能漫畫轉 PDF</h2>
            <button class="gear-btn" onclick="toggleSettings()">⚙️ 設定中轉站</button>
        </div>
        <div class="sub">支援：nhentai 番號 / MyReadingManga / E-Hentai 網址</div>

        <input type="text" id="query" placeholder="輸入 6 位番號 或 貼上完整作品網址">
        <button class="primary" id="btn" onclick="startProcess()">開始讀取並製作檔案</button>
        <div id="status">準備就緒，請輸入番號或網址</div>

        <div id="result-box">
            <div class="book-title" id="display-title"></div>
            <button class="dl-btn dl-pdf" onclick="saveFile('pdf')">📄 儲存／下載 PDF</button>
            <button class="dl-btn dl-png" onclick="saveFile('png')">🖼️ 儲存／下載封面 PNG</button>
        </div>

        <div id="settings-panel">
            <label>Cloudflare Worker 中轉站網址</label>
            <input type="url" id="worker-url" placeholder="https://tight-brook-0a4c.zeldris12313.workers.dev">
            <button class="primary" style="background:#2ea043;" onclick="saveSettings()">儲存網址</button>
        </div>
    </div>

    <script>
        const DEFAULT_WORKER = "https://tight-brook-0a4c.zeldris12313.workers.dev";
        let readyFiles = { pdf: null, png: null };
        let wakeLock = null;
        let isRunning = false;

        function cleanWorkerUrl(raw) {
            let u = (raw || "").replace(/\s+/g, "").trim();
            if (!u) return DEFAULT_WORKER;
            if (!/^https?:\/\//i.test(u)) u = "https://" + u;
            return u.replace(/\/+$/, "");
        }

        window.onload = () => {
            const saved = cleanWorkerUrl(localStorage.getItem('worker_url'));
            localStorage.setItem('worker_url', saved);
            document.getElementById('worker-url').value = saved;
        };

        function toggleSettings() {
            const p = document.getElementById('settings-panel');
            p.style.display = (p.style.display === 'none' || !p.style.display) ? 'block' : 'none';
        }

        function saveSettings() {
            const cleaned = cleanWorkerUrl(document.getElementById('worker-url').value);
            localStorage.setItem('worker_url', cleaned);
            document.getElementById('worker-url').value = cleaned;
            alert('✅ 已儲存！');
            document.getElementById('settings-panel').style.display = 'none';
        }

        async function requestWakeLock() {
            try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
        }

        function processImageBlob(blob, isCover) {
            return new Promise((resolve, reject) => {
                const url = URL.createObjectURL(blob);
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    URL.revokeObjectURL(url);

                    const baseResult = {
                        dataUrl: canvas.toDataURL('image/jpeg', 0.92),
                        width: img.naturalWidth,
                        height: img.naturalHeight,
                        coverPngBlob: null
                    };
                    if (isCover) {
                        canvas.toBlob((pngBlob) => { baseResult.coverPngBlob = pngBlob; resolve(baseResult); }, 'image/png');
                    } else {
                        resolve(baseResult);
                    }
                };
                img.onerror = () => reject(new Error('圖片解碼失敗（可能回傳了網頁而非圖片）'));
                img.src = url;
            });
        }

        async function saveFile(type) {
            const item = readyFiles[type];
            if (!item) return;
            const file = new File([item.blob], item.filename, { type: item.mime });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
            }
            const url = URL.createObjectURL(item.blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = item.filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        }

        async function startProcess() {
            if (isRunning) return;
            const workerUrl = cleanWorkerUrl(localStorage.getItem('worker_url'));
            const query = document.getElementById('query').value.trim();
            if (!query) return alert('請輸入番號或網址');

            const btn = document.getElementById('btn');
            const status = document.getElementById('status');
            isRunning = true;
            btn.disabled = true;
            document.getElementById('result-box').style.display = 'none';
            status.innerText = '1/3 正在識別網站並讀取目錄...';
            await requestWakeLock();

            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 15000);
                const res = await fetch(`${workerUrl}/api/parse`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query }),
                    signal: controller.signal
                });
                clearTimeout(timer);

                // 先用純文字讀取回應，避免 Safari 解析非 JSON 時拋出 pattern 錯誤
                const rawText = await res.text();
                let data = null;
                try {
                    data = JSON.parse(rawText);
                } catch (_) {
                    throw new Error(`後端回應異常 (${res.status})：${rawText.slice(0, 80)}`);
                }

                if (!res.ok || !data.ok) {
                    throw new Error(data.error || `讀取失敗 (${res.status})`);
                }

                const { title, urls, referer } = data;
                const total = urls.length;
                const { jsPDF } = window.jspdf;
                let pdf = null;
                let coverPngBlob = null;

                for (let i = 0; i < total; i++) {
                    const pageNum = i + 1;
                    status.innerText = `2/3 《${title}》\n正在下載原圖 (${pageNum} / ${total} 頁)...`;
                    const imgUrl = `${workerUrl}?url=${encodeURIComponent(urls[i])}&ref=${encodeURIComponent(referer)}`;
                    const imgRes = await fetch(imgUrl);
                    if (!imgRes.ok) throw new Error(`第 ${pageNum} 頁下載失敗 (${imgRes.status})`);

                    const blob = await imgRes.blob();
                    const isCover = (i === 0);
                    const imgInfo = await processImageBlob(blob, isCover);
                    if (isCover) coverPngBlob = imgInfo.coverPngBlob;

                    const orientation = imgInfo.width > imgInfo.height ? 'l' : 'p';
                    if (i === 0) {
                        pdf = new jsPDF({ orientation, unit: 'px', format: [imgInfo.width, imgInfo.height] });
                    } else {
                        pdf.addPage([imgInfo.width, imgInfo.height], orientation);
                    }
                    pdf.addImage(imgInfo.dataUrl, 'JPEG', 0, 0, imgInfo.width, imgInfo.height);
                }

                status.innerText = '3/3 正在打包檔案...';
                readyFiles.pdf = { blob: pdf.output('blob'), filename: `${title}.pdf`, mime: 'application/pdf' };
                if (coverPngBlob) {
                    readyFiles.png = { blob: coverPngBlob, filename: `${title}_封面.png`, mime: 'image/png' };
                }

                document.getElementById('display-title').innerText = `📚 ${title}（共 ${total} 頁）`;
                document.getElementById('result-box').style.display = 'block';
                status.innerText = '✅ 製作完成！請按下方按鈕儲存：';
            } catch (err) {
                const msg = err.name === 'AbortError' ? '連線超時（超過 15 秒未回應），請重試' : err.message;
                status.innerText = `❌ 錯誤：${msg}`;
            } finally {
                isRunning = false;
                btn.disabled = false;
                if (wakeLock) { wakeLock.release(); wakeLock = null; }
            }
        }
    </script>
</body>
</html>