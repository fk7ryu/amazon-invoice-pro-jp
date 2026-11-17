(() => {
  let isProcessing = false;
  let isCancelled = false;
  let currentLicense = { isPaid: false, isConfigured: false, monthlyUsed: 0, monthlyLimit: 10, remaining: 10 };

  const DEFAULT_SETTINGS = {
    fetchDepth: '3',
    dateFrom: '',
    dateTo: '',
    filenameTemplate: '{date}_{price}_Amazon_{orderId}',
    preferInvoicePdf: true,
    skipDownloaded: false,
    exportCsv: true
  };

  // ライセンス状態を background.js から取得
  function fetchLicenseStatus() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'GET_LICENSE_STATUS' }, (res) => {
        if (res) {
          currentLicense = res;
        }
        resolve(currentLicense);
      });
    });
  }

  // 決済ページを開く（未設定時は案内）
  function openUpgradePage() {
    chrome.runtime.sendMessage({ action: 'OPEN_PAYMENT_PAGE' }, (res) => {
      if (res && !res.ok && res.reason === 'NOT_CONFIGURED') {
        alert(
          'ExtensionPay ID（EXTPAY_EXTENSION_ID）がまだ設定されていません。\n' +
          'テスト確認する場合は、ブラウザ右上の拡張機能アイコンをクリックし、「[開発用] Pro/Free 切替」を押してください。'
        );
      }
    });
  }

  // プランバッジの表示を更新
  function renderLicenseUI(license) {
    currentLicense = license;
    const badgeEl = document.getElementById('amz-plan-badge');
    const upgradeBtn = document.getElementById('amz-upgrade-inline-btn');
    const csvCheckbox = document.getElementById('amz-export-csv');
    const csvLabel = document.getElementById('amz-csv-label');

    if (!badgeEl) return;

    if (license.isPaid) {
      badgeEl.textContent = '✨ Proプラン（無制限）';
      badgeEl.style.background = '#e6f4ea';
      badgeEl.style.color = '#137333';
      badgeEl.style.borderColor = '#ceead6';
      if (upgradeBtn) upgradeBtn.style.display = 'none';
      if (csvCheckbox) csvCheckbox.disabled = false;
      if (csvLabel) csvLabel.textContent = '注文一覧CSVも同時に保存';
    } else {
      badgeEl.textContent = `無料枠: 今月あと ${license.remaining}/${license.monthlyLimit}件`;
      badgeEl.style.background = '#fff8e1';
      badgeEl.style.color = '#8d6e00';
      badgeEl.style.borderColor = '#ffe082';
      if (upgradeBtn) upgradeBtn.style.display = 'inline-block';
      if (csvCheckbox) {
        csvCheckbox.checked = false;
        csvCheckbox.disabled = true;
      }
      if (csvLabel) csvLabel.textContent = '注文一覧CSVも同時に保存 (Pro限定)';
    }
  }

  // 設定の読み込み
  async function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['amzSettings', 'downloadedOrderIds'], (res) => {
        resolve({
          settings: { ...DEFAULT_SETTINGS, ...(res.amzSettings || {}) },
          downloadedOrderIds: Array.isArray(res.downloadedOrderIds) ? res.downloadedOrderIds : []
        });
      });
    });
  }

  // 設定の保存
  function saveSettings(settings) {
    chrome.storage.local.set({ amzSettings: settings });
  }

  // ファイル名に使える安全な文字列へ変換
  function sanitizeFilePart(str) {
    return String(str || '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // テンプレートから保存先パスを生成
  function buildFilename(template, item) {
    const safeTitle = sanitizeFilePart(item.title || '商品');
    const year = item.date !== '不明日付' ? item.date.slice(0, 4) : '不明年';
    const month = item.date !== '不明日付' ? item.date.slice(4, 6) : '00';

    let name = (template || DEFAULT_SETTINGS.filenameTemplate)
      .replace(/\{date\}/g, item.date)
      .replace(/\{year\}/g, year)
      .replace(/\{month\}/g, month)
      .replace(/\{price\}/g, item.priceStr)
      .replace(/\{priceNum\}/g, item.priceNum)
      .replace(/\{orderId\}/g, item.orderId)
      .replace(/\{title\}/g, safeTitle.slice(0, 40));

    name = name
      .split('/')
      .map((seg) => sanitizeFilePart(seg))
      .filter(Boolean)
      .join('/');

    if (!name.toLowerCase().endsWith('.pdf')) {
      name += '.pdf';
    }
    return `Amazon領収書/${name}`;
  }

  // 操作パネルを画面左上に挿入
  async function injectControlUI() {
    if (document.getElementById('amz-invoice-panel')) return;

    const [{ settings, downloadedOrderIds }, license] = await Promise.all([
      loadSettings(),
      fetchLicenseStatus()
    ]);

    const panel = document.createElement('div');
    panel.id = 'amz-invoice-panel';
    panel.style.cssText = `
      position: fixed;
      top: 64px;
      left: 16px;
      z-index: 999999;
      width: 290px;
      padding: 14px 16px;
      background: #ffffff;
      border: 2px solid #FF9900;
      border-radius: 8px;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
      font-family: "Segoe UI", "Hiragino Sans", sans-serif;
      font-size: 12.5px;
      color: #111;
    `;

    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <span style="font-weight:bold; font-size:13.5px;">領収書PDF一括取得</span>
        <button id="amz-toggle-btn" title="最小化" style="
          background:none; border:none; cursor:pointer; font-size:14px; color:#555; padding:0 4px;
        ">－</button>
      </div>

      <div id="amz-panel-body">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:10px;">
          <span id="amz-plan-badge" style="
            font-size:11px; font-weight:bold; padding:3px 7px; border-radius:4px; border:1px solid #ffe082;
          ">確認中...</span>
          <button id="amz-upgrade-inline-btn" type="button" style="
            display:none; background:#111; color:#fff; border:none; border-radius:4px;
            padding:3px 8px; font-size:11px; font-weight:bold; cursor:pointer;
          ">Proへ</button>
        </div>

        <div style="margin-bottom:8px;">
          <label style="display:block; margin-bottom:3px; color:#444; font-size:11.5px;">取得対象ページ数</label>
          <select id="amz-fetch-depth" style="width:100%; padding:5px; border:1px solid #ccc; border-radius:4px;">
            <option value="1">このページのみ</option>
            <option value="3">3ページ分巡回</option>
            <option value="5">5ページ分巡回</option>
            <option value="99">表示中の年を全ページ巡回</option>
          </select>
        </div>

        <div style="display:flex; gap:6px; margin-bottom:8px;">
          <div style="flex:1;">
            <label style="display:block; margin-bottom:2px; color:#444; font-size:11px;">開始日</label>
            <input type="date" id="amz-date-from" style="width:100%; box-sizing:border-box; padding:4px; border:1px solid #ccc; border-radius:4px; font-size:11.5px;" />
          </div>
          <div style="flex:1;">
            <label style="display:block; margin-bottom:2px; color:#444; font-size:11px;">終了日</label>
            <input type="date" id="amz-date-to" style="width:100%; box-sizing:border-box; padding:4px; border:1px solid #ccc; border-radius:4px; font-size:11.5px;" />
          </div>
        </div>

        <details id="amz-advanced-details" style="margin-bottom:10px; border:1px solid #eee; border-radius:4px; padding:6px 8px; background:#fafafa;">
          <summary style="cursor:pointer; font-size:11.5px; color:#333; font-weight:bold;">詳細設定（ファイル名・インボイス等）</summary>
          <div style="margin-top:8px;">
            <label style="display:block; margin-bottom:3px; color:#444; font-size:11px;">ファイル名形式（変数: {date} {price} {orderId} {title} {year}）</label>
            <input type="text" id="amz-filename-tpl" style="width:100%; box-sizing:border-box; padding:4px 6px; border:1px solid #ccc; border-radius:4px; font-size:11.5px; margin-bottom:8px;" />

            <label style="display:flex; align-items:center; gap:6px; margin-bottom:6px; font-size:11.5px; cursor:pointer;">
              <input type="checkbox" id="amz-prefer-invoice" />
              <span>適格請求書(PDF原本)があれば優先取得</span>
            </label>

            <label style="display:flex; align-items:center; gap:6px; margin-bottom:6px; font-size:11.5px; cursor:pointer;">
              <input type="checkbox" id="amz-skip-downloaded" />
              <span>取得済みの注文をスキップ (<span id="amz-history-count">${downloadedOrderIds.length}</span>件)</span>
            </label>

            <label style="display:flex; align-items:center; gap:6px; margin-bottom:6px; font-size:11.5px; cursor:pointer;">
              <input type="checkbox" id="amz-export-csv" />
              <span id="amz-csv-label">注文一覧CSVも同時に保存</span>
            </label>

            <button id="amz-clear-history-btn" type="button" style="
              background:#fff; border:1px solid #ccc; border-radius:4px; padding:3px 8px; font-size:11px; color:#555; cursor:pointer;
            ">取得済み履歴をリセット</button>
          </div>
        </details>

        <div id="amz-progress-wrap" style="display:none; margin-bottom:8px;">
          <div style="width:100%; height:6px; background:#eee; border-radius:3px; overflow:hidden;">
            <div id="amz-progress-bar" style="width:0%; height:100%; background:#FF9900; transition:width 0.2s;"></div>
          </div>
        </div>

        <div id="amz-status-text" style="color:#555; font-size:11.5px; margin-bottom:10px; min-height:18px; line-height:1.4;">待機中</div>

        <div style="display:flex; gap:6px;">
          <button id="amz-start-btn" style="
            flex:1; background:#FF9900; color:#111; font-weight:bold;
            border:1px solid #a88734; padding:7px 10px; border-radius:4px; cursor:pointer;
          ">PDF取得開始</button>
          <button id="amz-cancel-btn" style="
            display:none; background:#f3f3f3; color:#333;
            border:1px solid #ccc; padding:7px 10px; border-radius:4px; cursor:pointer;
          ">中止</button>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    document.getElementById('amz-fetch-depth').value = settings.fetchDepth;
    document.getElementById('amz-date-from').value = settings.dateFrom;
    document.getElementById('amz-date-to').value = settings.dateTo;
    document.getElementById('amz-filename-tpl').value = settings.filenameTemplate;
    document.getElementById('amz-prefer-invoice').checked = settings.preferInvoicePdf;
    document.getElementById('amz-skip-downloaded').checked = settings.skipDownloaded;
    document.getElementById('amz-export-csv').checked = settings.exportCsv;

    renderLicenseUI(license);

    const syncSettings = () => {
      saveSettings({
        fetchDepth: document.getElementById('amz-fetch-depth').value,
        dateFrom: document.getElementById('amz-date-from').value,
        dateTo: document.getElementById('amz-date-to').value,
        filenameTemplate: document.getElementById('amz-filename-tpl').value.trim() || DEFAULT_SETTINGS.filenameTemplate,
        preferInvoicePdf: document.getElementById('amz-prefer-invoice').checked,
        skipDownloaded: document.getElementById('amz-skip-downloaded').checked,
        exportCsv: document.getElementById('amz-export-csv').checked
      });
    };

    [
      'amz-fetch-depth',
      'amz-date-from',
      'amz-date-to',
      'amz-filename-tpl',
      'amz-prefer-invoice',
      'amz-skip-downloaded',
      'amz-export-csv'
    ].forEach((id) => {
      document.getElementById(id).addEventListener('change', syncSettings);
    });

    document.getElementById('amz-upgrade-inline-btn').addEventListener('click', openUpgradePage);

    document.getElementById('amz-toggle-btn').addEventListener('click', () => {
      const body = document.getElementById('amz-panel-body');
      const toggleBtn = document.getElementById('amz-toggle-btn');
      const isHidden = body.style.display === 'none';
      body.style.display = isHidden ? 'block' : 'none';
      toggleBtn.textContent = isHidden ? '－' : '＋';
    });

    document.getElementById('amz-clear-history-btn').addEventListener('click', () => {
      if (confirm('取得済みの注文履歴記録をリセットしますか？')) {
        chrome.storage.local.set({ downloadedOrderIds: [] }, () => {
          document.getElementById('amz-history-count').textContent = '0';
          updateStatus('取得済み履歴をリセットしました');
        });
      }
    });

    document.getElementById('amz-start-btn').addEventListener('click', startBatchProcess);
    document.getElementById('amz-cancel-btn').addEventListener('click', cancelBatchProcess);

    // ストレージ変更（ポップアップからのテスト切替など）を即時反映
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.devProMode || changes.monthlyUsage) {
        fetchLicenseStatus().then(renderLicenseUI);
      }
    });
  }

  // カード内の領収書ポップオーバーから適格請求書PDFリンクを取得
  async function resolveInvoicePdfUrl(card) {
    const directPdf = card.querySelector('a[href*="/documents/download/"]');
    if (directPdf) {
      return new URL(directPdf.getAttribute('href'), 'https://www.amazon.co.jp').href;
    }

    const popoverTrigger = card.querySelector('[data-a-popover*="invoice"], [data-a-popover*="receipt"]');
    if (popoverTrigger) {
      try {
        const popoverData = JSON.parse(popoverTrigger.getAttribute('data-a-popover') || '{}');
        if (popoverData.url) {
          const popoverUrl = new URL(popoverData.url, 'https://www.amazon.co.jp').href;
          const res = await fetch(popoverUrl, { credentials: 'include' });
          if (res.ok) {
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const links = Array.from(doc.querySelectorAll('a[href]'));
            const invoicePdfLink =
              links.find((a) => /適格請求書|インボイス/i.test(a.textContent) && a.getAttribute('href').includes('/documents/download/')) ||
              links.find((a) => a.getAttribute('href').includes('/documents/download/'));
            if (invoicePdfLink) {
              return new URL(invoicePdfLink.getAttribute('href'), 'https://www.amazon.co.jp').href;
            }
          }
        }
      } catch (_) {}
    }
    return null;
  }

  // ドキュメントから注文情報を抽出
  async function extractOrdersFromDoc(doc, { preferInvoicePdf, filenameTemplate }) {
    let cards = doc.querySelectorAll('.order-card, [data-component-type="order-card"], .js-order-card, .a-box-group.order');
    if (cards.length === 0) {
      cards = doc.querySelectorAll('.a-box-group');
    }

    const items = [];
    for (const card of cards) {
      const text = card.innerText || card.textContent || '';
      const orderIdMatch = text.match(/(\d{3}-\d{7}-\d{7})/);
      if (!orderIdMatch) continue;

      const orderId = orderIdMatch[1];
      if (items.some((x) => x.orderId === orderId)) continue;

      const dateMatch = text.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
      const priceMatch = text.match(/[￥¥]\s*([0-9,]+)/);

      const dateStr = dateMatch
        ? `${dateMatch[1]}${dateMatch[2].padStart(2, '0')}${dateMatch[3].padStart(2, '0')}`
        : '不明日付';
      const dateIso = dateMatch
        ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
        : '';
      const priceNum = priceMatch ? priceMatch[1].replace(/,/g, '') : '0';
      const priceStr = `${priceNum}円`;

      let itemTitle = '';
      const productLinks = card.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"], .yohtmlc-product-title a');
      for (const link of productLinks) {
        const t = (link.textContent || '').trim().replace(/\s+/g, ' ');
        if (t) {
          itemTitle = t.slice(0, 80);
          break;
        }
      }

      let url = `https://www.amazon.co.jp/gp/css/summary/print.html?ie=UTF8&orderID=${orderId}`;
      let isDirectPdf = false;

      if (preferInvoicePdf) {
        const directPdfUrl = await resolveInvoicePdfUrl(card);
        if (directPdfUrl) {
          url = directPdfUrl;
          isDirectPdf = true;
        }
      }

      if (!isDirectPdf) {
        const directPrintLink = card.querySelector('a[href*="print.html"]');
        const digitalLink = card.querySelector('a[href*="/gp/digital/your-account/order-summary.html"]');
        if (directPrintLink) {
          url = new URL(directPrintLink.getAttribute('href'), 'https://www.amazon.co.jp').href;
        } else if (digitalLink) {
          url = `https://www.amazon.co.jp/gp/digital/your-account/order-summary.html?ie=UTF8&orderID=${orderId}&print=1`;
        }
      }

      const baseItem = {
        orderId,
        url,
        isDirectPdf,
        date: dateStr,
        dateIso,
        priceNum,
        priceStr,
        title: itemTitle
      };
      baseItem.filename = buildFilename(filenameTemplate, baseItem);

      items.push(baseItem);
    }

    return items;
  }

  // 次ページURLを取得
  function getNextPageUrl(doc) {
    const nextLink = doc.querySelector('ul.a-pagination li.a-last:not(.a-disabled) a');
    if (!nextLink) return null;
    const href = nextLink.getAttribute('href');
    if (!href || href === '#') return null;
    return new URL(href, 'https://www.amazon.co.jp').href;
  }

  function setRunningState(running) {
    isProcessing = running;
    const startBtn = document.getElementById('amz-start-btn');
    const cancelBtn = document.getElementById('amz-cancel-btn');
    const progressWrap = document.getElementById('amz-progress-wrap');

    startBtn.disabled = running;
    startBtn.style.opacity = running ? '0.6' : '1';
    cancelBtn.style.display = running ? 'block' : 'none';
    progressWrap.style.display = running ? 'block' : 'none';
  }

  function updateStatus(text, percent = null) {
    const statusEl = document.getElementById('amz-status-text');
    const barEl = document.getElementById('amz-progress-bar');
    if (statusEl) statusEl.textContent = text;
    if (barEl && percent !== null) {
      barEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }
  }

  // 一括取得開始
  async function startBatchProcess() {
    if (isProcessing) return;

    const license = await fetchLicenseStatus();
    renderLicenseUI(license);

    if (!license.isPaid && license.remaining <= 0) {
      if (confirm(`今月の無料枠（${license.monthlyLimit}件）を使い切りました。\nProプランにアップグレードしますか？`)) {
        openUpgradePage();
      }
      return;
    }

    isCancelled = false;
    setRunningState(true);

    const { downloadedOrderIds } = await loadSettings();
    const downloadedSet = new Set(downloadedOrderIds);

    const maxPages = parseInt(document.getElementById('amz-fetch-depth').value, 10);
    const dateFrom = document.getElementById('amz-date-from').value;
    const dateTo = document.getElementById('amz-date-to').value;
    const filenameTemplate = document.getElementById('amz-filename-tpl').value.trim() || DEFAULT_SETTINGS.filenameTemplate;
    const preferInvoicePdf = document.getElementById('amz-prefer-invoice').checked;
    const skipDownloaded = document.getElementById('amz-skip-downloaded').checked;
    const exportCsv = license.isPaid && document.getElementById('amz-export-csv').checked;

    const allItems = [];
    let skippedCount = 0;
    let currentDoc = document;
    let currentPage = 1;

    try {
      while (currentPage <= maxPages && !isCancelled) {
        updateStatus(`注文一覧を解析中 (${currentPage}ページ目)...`, 0);

        const pageOrders = await extractOrdersFromDoc(currentDoc, {
          preferInvoicePdf,
          filenameTemplate
        });

        let reachedBeforeDateFrom = false;

        for (const order of pageOrders) {
          if (order.dateIso) {
            if (dateTo && order.dateIso > dateTo) continue;
            if (dateFrom && order.dateIso < dateFrom) {
              reachedBeforeDateFrom = true;
              continue;
            }
          }

          if (skipDownloaded && downloadedSet.has(order.orderId)) {
            skippedCount++;
            continue;
          }

          if (!allItems.some((x) => x.orderId === order.orderId)) {
            allItems.push(order);
          }
        }

        const nextUrl = getNextPageUrl(currentDoc);
        if (reachedBeforeDateFrom || currentPage >= maxPages || !nextUrl || isCancelled) {
          break;
        }

        await new Promise((r) => setTimeout(r, 1500));
        if (isCancelled) break;

        const res = await fetch(nextUrl, { credentials: 'include' });
        if (!res.ok) {
          throw new Error(`ページ取得に失敗しました (HTTP ${res.status})`);
        }
        const html = await res.text();
        currentDoc = new DOMParser().parseFromString(html, 'text/html');
        currentPage++;
      }

      if (isCancelled) {
        updateStatus('処理を中止しました');
        setRunningState(false);
        return;
      }

      if (allItems.length === 0) {
        const msg = skippedCount > 0
          ? `新規対象の注文はありませんでした（取得済みスキップ: ${skippedCount}件）`
          : '条件に一致する注文が見つかりませんでした。';
        alert(msg);
        updateStatus(msg);
        setRunningState(false);
        return;
      }

      let targetItems = allItems;
      if (!license.isPaid && allItems.length > license.remaining) {
        const proceed = confirm(
          `対象注文が ${allItems.length}件 見つかりましたが、今月の無料枠は残り ${license.remaining}件 です。\n` +
          `OK: 最初の ${license.remaining}件 のみ保存する\n` +
          `キャンセル: Proプラン（無制限）の案内を開く`
        );
        if (!proceed) {
          openUpgradePage();
          updateStatus('待機中');
          setRunningState(false);
          return;
        }
        targetItems = allItems.slice(0, license.remaining);
      }

      updateStatus(`${targetItems.length}件のPDF生成を開始します...`, 0);
      chrome.runtime.sendMessage({
        action: 'START_DOWNLOAD',
        payload: { items: targetItems, exportCsv }
      });
    } catch (err) {
      console.error('[Amazon領収書PDF] 収集エラー:', err);
      updateStatus(`エラー: ${err.message}`);
      setRunningState(false);
    }
  }

  function cancelBatchProcess() {
    isCancelled = true;
    updateStatus('中止しています...');
    chrome.runtime.sendMessage({ action: 'CANCEL_DOWNLOAD' });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'PROGRESS_UPDATE') {
      const { current, total, statusText, done, historyCount, licenseStatus } = message;
      const percent = total > 0 ? Math.round((current / total) * 100) : 0;
      updateStatus(statusText, percent);
      if (typeof historyCount === 'number') {
        const countEl = document.getElementById('amz-history-count');
        if (countEl) countEl.textContent = String(historyCount);
      }
      if (licenseStatus) {
        renderLicenseUI(licenseStatus);
      }
      if (done) {
        setRunningState(false);
      }
    }
  });

  injectControlUI();
})();
