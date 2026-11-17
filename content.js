(() => {
  let isProcessing = false;
  let isCancelled = false;
  let scannedItems = [];
  let lastFailedItems = [];
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

  // 拡張機能コンテキストが有効か確認して安全にメッセージ送信
  function isContextValid() {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.id);
  }

  function handleInvalidContext() {
    alert('拡張機能が更新されました。このページを再読み込み（F5）してからもう一度お試しください。');
  }

  function fetchLicenseStatus() {
    if (!isContextValid()) {
      return Promise.resolve(currentLicense);
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: 'GET_LICENSE_STATUS' }, (res) => {
          if (chrome.runtime.lastError) {
            resolve(currentLicense);
            return;
          }
          if (res) currentLicense = res;
          resolve(currentLicense);
        });
      } catch (_) {
        resolve(currentLicense);
      }
    });
  }

  function openUpgradePage() {
    if (!isContextValid()) {
      handleInvalidContext();
      return;
    }
    try {
      chrome.runtime.sendMessage({ action: 'OPEN_PAYMENT_PAGE' }, (res) => {
        if (chrome.runtime.lastError) {
          handleInvalidContext();
          return;
        }
        if (res && !res.ok && res.reason === 'NOT_CONFIGURED') {
          alert('ExtensionPay ID が未設定です。拡張機能アイコンから設定・テストしてください。');
        }
      });
    } catch (_) {
      handleInvalidContext();
    }
  }

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

  async function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['amzSettings', 'downloadedOrderIds', 'panelPos'], (res) => {
        resolve({
          settings: { ...DEFAULT_SETTINGS, ...(res.amzSettings || {}) },
          downloadedOrderIds: Array.isArray(res.downloadedOrderIds) ? res.downloadedOrderIds : [],
          panelPos: res.panelPos || null
        });
      });
    });
  }

  function saveSettings(settings) {
    chrome.storage.local.set({ amzSettings: settings });
  }

  function sanitizeFilePart(str) {
    return String(str || '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }

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

  // パネルのドラッグ移動を設定
  function enableDrag(panel, handle) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth - 8);
      const maxTop = Math.max(0, window.innerHeight - 60);
      const left = Math.max(8, Math.min(maxLeft, e.clientX - offsetX));
      const top = Math.max(8, Math.min(maxTop, e.clientY - offsetY));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      chrome.storage.local.set({
        panelPos: {
          top: parseInt(panel.style.top, 10) || 64,
          left: parseInt(panel.style.left, 10) || 16
        }
      });
    });
  }

  // HTMLエスケープ
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // スキャン結果のチェックボックス一覧を描画
  function renderPreviewList(items) {
    const wrap = document.getElementById('amz-preview-wrap');
    const listEl = document.getElementById('amz-preview-list');
    const countEl = document.getElementById('amz-selected-count');
    const downloadBtn = document.getElementById('amz-download-selected-btn');

    if (!wrap || !listEl) return;
    if (!items.length) {
      wrap.style.display = 'none';
      return;
    }

    listEl.innerHTML = items
      .map(
        (it, idx) => `
        <label style="display:flex; align-items:flex-start; gap:6px; padding:4px 2px; border-bottom:1px solid #f0f0f0; cursor:pointer; font-size:11px;">
          <input type="checkbox" class="amz-item-check" data-index="${idx}" checked style="margin-top:2px;" />
          <div style="flex:1; min-width:0;">
            <div style="font-weight:bold; color:#111;">${escapeHtml(it.dateIso || it.date)} / ${escapeHtml(it.priceStr)}</div>
            <div style="color:#555; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(it.title || it.orderId)}</div>
          </div>
        </label>`
      )
      .join('');

    const updateSelectedCount = () => {
      const checked = listEl.querySelectorAll('.amz-item-check:checked').length;
      if (countEl) countEl.textContent = String(checked);
      if (downloadBtn) {
        downloadBtn.disabled = checked === 0;
        downloadBtn.style.opacity = checked === 0 ? '0.5' : '1';
      }
    };

    listEl.querySelectorAll('.amz-item-check').forEach((cb) => {
      cb.addEventListener('change', updateSelectedCount);
    });

    wrap.style.display = 'block';
    updateSelectedCount();
  }

  // 操作パネルを画面左上に挿入
  async function injectControlUI() {
    if (document.getElementById('amz-invoice-panel')) return;

    const [{ settings, downloadedOrderIds, panelPos }, license] = await Promise.all([
      loadSettings(),
      fetchLicenseStatus()
    ]);

    const initTop = panelPos ? Math.min(window.innerHeight - 80, Math.max(8, panelPos.top)) : 64;
    const initLeft = panelPos ? Math.min(window.innerWidth - 310, Math.max(8, panelPos.left)) : 16;

    const panel = document.createElement('div');
    panel.id = 'amz-invoice-panel';
    panel.style.cssText = `
      position: fixed;
      top: ${initTop}px;
      left: ${initLeft}px;
      z-index: 999999;
      width: 300px;
      padding: 12px 14px;
      background: #ffffff;
      border: 2px solid #FF9900;
      border-radius: 8px;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
      font-family: "Segoe UI", "Hiragino Sans", sans-serif;
      font-size: 12.5px;
      color: #111;
    `;

    panel.innerHTML = `
      <div id="amz-drag-handle" title="ドラッグで移動" style="
        display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; cursor:move;
      ">
        <span style="font-weight:bold; font-size:13.5px;">⠿ 領収書PDF一括取得</span>
        <button id="amz-toggle-btn" title="最小化" style="
          background:none; border:none; cursor:pointer; font-size:14px; color:#555; padding:0 4px;
        ">－</button>
      </div>

      <div id="amz-panel-body">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:8px;">
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

        <details id="amz-advanced-details" style="margin-bottom:8px; border:1px solid #eee; border-radius:4px; padding:6px 8px; background:#fafafa;">
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

        <div id="amz-preview-wrap" style="display:none; margin-bottom:8px; border:1px solid #ddd; border-radius:4px; padding:6px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; font-size:11px;">
            <span style="font-weight:bold;">対象注文（<span id="amz-selected-count">0</span>件選択中）</span>
            <div>
              <button id="amz-select-all-btn" type="button" style="background:none; border:none; color:#0066c0; cursor:pointer; font-size:11px; padding:0 4px;">全選択</button>
              <button id="amz-deselect-all-btn" type="button" style="background:none; border:none; color:#0066c0; cursor:pointer; font-size:11px; padding:0 4px;">解除</button>
            </div>
          </div>
          <div id="amz-preview-list" style="max-height:140px; overflow-y:auto; border-top:1px solid #eee;"></div>
          <button id="amz-download-selected-btn" type="button" style="
            width:100%; margin-top:6px; background:#FF9900; color:#111; font-weight:bold;
            border:1px solid #a88734; padding:7px 10px; border-radius:4px; cursor:pointer;
          ">選択した注文をPDF保存</button>
        </div>

        <div id="amz-progress-wrap" style="display:none; margin-bottom:8px;">
          <div style="width:100%; height:6px; background:#eee; border-radius:3px; overflow:hidden;">
            <div id="amz-progress-bar" style="width:0%; height:100%; background:#FF9900; transition:width 0.2s;"></div>
          </div>
        </div>

        <div id="amz-status-text" style="color:#555; font-size:11.5px; margin-bottom:8px; min-height:18px; line-height:1.4;">待機中</div>

        <div style="display:flex; gap:6px;">
          <button id="amz-scan-btn" style="
            flex:1; background:#FF9900; color:#111; font-weight:bold;
            border:1px solid #a88734; padding:7px 10px; border-radius:4px; cursor:pointer;
          ">注文をスキャン</button>
          <button id="amz-cancel-btn" style="
            display:none; background:#f3f3f3; color:#333;
            border:1px solid #ccc; padding:7px 10px; border-radius:4px; cursor:pointer;
          ">中止</button>
        </div>

        <button id="amz-retry-btn" type="button" style="
          display:none; width:100%; margin-top:6px; background:#fff3cd; color:#856404;
          border:1px solid #ffeeba; padding:6px 10px; border-radius:4px; font-weight:bold; cursor:pointer; font-size:11.5px;
        ">失敗した注文を再取得</button>
      </div>
    `;

    document.body.appendChild(panel);
    enableDrag(panel, document.getElementById('amz-drag-handle'));

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

    document.getElementById('amz-select-all-btn').addEventListener('click', () => {
      document.querySelectorAll('#amz-preview-list .amz-item-check').forEach((cb) => (cb.checked = true));
      document.getElementById('amz-selected-count').textContent = String(scannedItems.length);
      document.getElementById('amz-download-selected-btn').disabled = scannedItems.length === 0;
      document.getElementById('amz-download-selected-btn').style.opacity = scannedItems.length === 0 ? '0.5' : '1';
    });

    document.getElementById('amz-deselect-all-btn').addEventListener('click', () => {
      document.querySelectorAll('#amz-preview-list .amz-item-check').forEach((cb) => (cb.checked = false));
      document.getElementById('amz-selected-count').textContent = '0';
      document.getElementById('amz-download-selected-btn').disabled = true;
      document.getElementById('amz-download-selected-btn').style.opacity = '0.5';
    });

    document.getElementById('amz-scan-btn').addEventListener('click', scanOrdersProcess);
    document.getElementById('amz-download-selected-btn').addEventListener('click', startDownloadSelected);
    document.getElementById('amz-cancel-btn').addEventListener('click', cancelBatchProcess);
    document.getElementById('amz-retry-btn').addEventListener('click', retryFailedItems);

    chrome.storage.onChanged.addListener((changes) => {
      if (changes.devProMode || changes.monthlyUsage) {
        fetchLicenseStatus().then(renderLicenseUI);
      }
    });
  }

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

  // Amazon個人・Amazon Business 両対応の注文カード抽出
  async function extractOrdersFromDoc(doc, { preferInvoicePdf, filenameTemplate }) {
    let cards = doc.querySelectorAll(
      '.order-card, [data-component-type="order-card"], .js-order-card, .a-box-group.order, .ab-order-card'
    );
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

  function getNextPageUrl(doc) {
    const nextLink = doc.querySelector('ul.a-pagination li.a-last:not(.a-disabled) a');
    if (!nextLink) return null;
    const href = nextLink.getAttribute('href');
    if (!href || href === '#') return null;
    return new URL(href, 'https://www.amazon.co.jp').href;
  }

  function setRunningState(running) {
    isProcessing = running;
    const scanBtn = document.getElementById('amz-scan-btn');
    const dlBtn = document.getElementById('amz-download-selected-btn');
    const cancelBtn = document.getElementById('amz-cancel-btn');
    const progressWrap = document.getElementById('amz-progress-wrap');

    scanBtn.disabled = running;
    scanBtn.style.opacity = running ? '0.6' : '1';
    if (dlBtn) {
      dlBtn.disabled = running;
      dlBtn.style.opacity = running ? '0.6' : '1';
    }
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

  // ステップ1: 注文をスキャンしてチェックボックス一覧を表示
  async function scanOrdersProcess() {
    if (isProcessing) return;

    isCancelled = false;
    lastFailedItems = [];
    document.getElementById('amz-retry-btn').style.display = 'none';
    setRunningState(true);

    const { downloadedOrderIds } = await loadSettings();
    const downloadedSet = new Set(downloadedOrderIds);

    const maxPages = parseInt(document.getElementById('amz-fetch-depth').value, 10);
    const dateFrom = document.getElementById('amz-date-from').value;
    const dateTo = document.getElementById('amz-date-to').value;
    const filenameTemplate = document.getElementById('amz-filename-tpl').value.trim() || DEFAULT_SETTINGS.filenameTemplate;
    const preferInvoicePdf = document.getElementById('amz-prefer-invoice').checked;
    const skipDownloaded = document.getElementById('amz-skip-downloaded').checked;

    const allItems = [];
    let skippedCount = 0;
    let currentDoc = document;
    let currentPage = 1;

    try {
      while (currentPage <= maxPages && !isCancelled) {
        updateStatus(`注文一覧をスキャン中 (${currentPage}ページ目)...`, 0);

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

      setRunningState(false);

      if (isCancelled) {
        updateStatus('スキャンを中止しました');
        return;
      }

      scannedItems = allItems;
      renderPreviewList(scannedItems);

      if (scannedItems.length === 0) {
        const msg = skippedCount > 0
          ? `新規対象の注文はありませんでした（取得済みスキップ: ${skippedCount}件）`
          : '条件に一致する注文が見つかりませんでした。';
        updateStatus(msg);
      } else {
        updateStatus(`${scannedItems.length}件見つかりました。対象を選んで保存を押してください。`);
      }
    } catch (err) {
      console.error('[Amazon領収書PDF] スキャンエラー:', err);
      updateStatus(`エラー: ${err.message}`);
      setRunningState(false);
    }
  }

  // ステップ2: チェックされた注文のみPDF保存を開始
  async function startDownloadSelected() {
    if (isProcessing) return;

    const checkedIndices = Array.from(document.querySelectorAll('#amz-preview-list .amz-item-check:checked'))
      .map((cb) => parseInt(cb.getAttribute('data-index'), 10));
    const selectedItems = checkedIndices.map((idx) => scannedItems[idx]).filter(Boolean);

    if (!selectedItems.length) {
      alert('保存する注文を1件以上選択してください。');
      return;
    }

    await launchDownload(selectedItems);
  }

  async function retryFailedItems() {
    if (isProcessing || !lastFailedItems.length) return;
    await launchDownload([...lastFailedItems]);
  }

  async function launchDownload(itemsToDownload) {
    if (!isContextValid()) {
      handleInvalidContext();
      return;
    }

    const license = await fetchLicenseStatus();
    renderLicenseUI(license);

    if (!license.isPaid && license.remaining <= 0) {
      if (confirm(`今月の無料枠（${license.monthlyLimit}件）を使い切りました。\nProプランにアップグレードしますか？`)) {
        openUpgradePage();
      }
      return;
    }

    let targetItems = itemsToDownload;
    if (!license.isPaid && itemsToDownload.length > license.remaining) {
      const proceed = confirm(
        `選択された注文は ${itemsToDownload.length}件 ですが、今月の無料枠は残り ${license.remaining}件 です。\n` +
        `OK: 最初の ${license.remaining}件 のみ保存する\n` +
        `キャンセル: Proプラン（無制限）の案内を開く`
      );
      if (!proceed) {
        openUpgradePage();
        return;
      }
      targetItems = itemsToDownload.slice(0, license.remaining);
    }

    lastFailedItems = [];
    document.getElementById('amz-retry-btn').style.display = 'none';
    isCancelled = false;
    setRunningState(true);
    updateStatus(`${targetItems.length}件のPDF生成を開始します...`, 0);

    const exportCsv = license.isPaid && document.getElementById('amz-export-csv').checked;
    try {
      chrome.runtime.sendMessage({
        action: 'START_DOWNLOAD',
        payload: { items: targetItems, exportCsv }
      });
    } catch (_) {
      setRunningState(false);
      handleInvalidContext();
    }
  }

  function cancelBatchProcess() {
    isCancelled = true;
    updateStatus('中止しています...');
    if (isContextValid()) {
      try {
        chrome.runtime.sendMessage({ action: 'CANCEL_DOWNLOAD' });
      } catch (_) {}
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'PROGRESS_UPDATE') {
      const { current, total, statusText, done, historyCount, licenseStatus, failedItems } = message;
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
        if (Array.isArray(failedItems) && failedItems.length > 0) {
          lastFailedItems = failedItems;
          const retryBtn = document.getElementById('amz-retry-btn');
          retryBtn.textContent = `失敗した ${failedItems.length}件 を再取得する`;
          retryBtn.style.display = 'block';
        }
      }
    }
  });

  injectControlUI();
})();
