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
    try {
      return typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
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
    if (!isContextValid()) {
      return { settings: { ...DEFAULT_SETTINGS }, downloadedOrderIds: [], panelPos: null };
    }
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(['amzSettings', 'downloadedOrderIds', 'panelPos'], (res) => {
          resolve({
            settings: { ...DEFAULT_SETTINGS, ...((res && res.amzSettings) || {}) },
            downloadedOrderIds: res && Array.isArray(res.downloadedOrderIds) ? res.downloadedOrderIds : [],
            panelPos: (res && res.panelPos) || null
          });
        });
      } catch (_) {
        resolve({ settings: { ...DEFAULT_SETTINGS }, downloadedOrderIds: [], panelPos: null });
      }
    });
  }

  function saveSettings(settings) {
    if (!isContextValid()) return;
    try {
      chrome.storage.local.set({ amzSettings: settings });
    } catch (_) {}
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
    const dateIso = item.dateIso || item.date;

    let name = (template || DEFAULT_SETTINGS.filenameTemplate)
      .replace(/\{date\}/g, item.date)
      .replace(/\{dateIso\}/g, dateIso)
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

  // パネル用スタイルを注入（ホバー・スクロールバー等のデザイン磨き込み）
  function injectPanelStyles() {
    if (document.getElementById('amz-invoice-style')) return;
    const style = document.createElement('style');
    style.id = 'amz-invoice-style';
    style.textContent = `
      #amz-invoice-panel * { box-sizing: border-box; }
      #amz-invoice-panel input:focus,
      #amz-invoice-panel select:focus {
        outline: none;
        border-color: #FF9900 !important;
        box-shadow: 0 0 0 2px rgba(255, 153, 0, 0.2);
      }
      #amz-invoice-panel .amz-primary-btn {
        background: linear-gradient(180deg, #ffae2b 0%, #ff9900 100%) !important;
        transition: filter 0.15s, transform 0.05s;
      }
      #amz-invoice-panel .amz-primary-btn:hover:not(:disabled) {
        filter: brightness(0.96);
      }
      #amz-invoice-panel .amz-primary-btn:active:not(:disabled) {
        transform: translateY(1px);
      }
      #amz-preview-list::-webkit-scrollbar { width: 6px; }
      #amz-preview-list::-webkit-scrollbar-thumb {
        background: #d1d5db; border-radius: 3px;
      }
      #amz-preview-list .amz-item-row:hover {
        background: #fffbeb;
      }
      @media print {
        #amz-invoice-panel {
          display: none !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  // 選択中の件数と合計金額をリアルタイム更新
  function updateSelectionSummary() {
    const listEl = document.getElementById('amz-preview-list');
    const countEl = document.getElementById('amz-selected-count');
    const totalEl = document.getElementById('amz-selected-total');
    const downloadBtn = document.getElementById('amz-download-selected-btn');
    if (!listEl) return;

    const checkedBoxes = Array.from(listEl.querySelectorAll('.amz-item-check:checked'));
    const totalYen = checkedBoxes.reduce((sum, cb) => {
      const idx = parseInt(cb.getAttribute('data-index'), 10);
      const item = scannedItems[idx];
      return sum + (item ? parseInt(item.priceNum || '0', 10) || 0 : 0);
    }, 0);

    if (countEl) countEl.textContent = String(checkedBoxes.length);
    if (totalEl) totalEl.textContent = `¥${totalYen.toLocaleString('ja-JP')}`;
    if (downloadBtn) {
      downloadBtn.disabled = checkedBoxes.length === 0;
      downloadBtn.style.opacity = checkedBoxes.length === 0 ? '0.5' : '1';
    }
  }

  // スキャン結果のチェックボックス一覧を描画
  function renderPreviewList(items) {
    const wrap = document.getElementById('amz-preview-wrap');
    const listEl = document.getElementById('amz-preview-list');
    const filterInput = document.getElementById('amz-filter-input');

    if (!wrap || !listEl) return;
    if (!items.length) {
      wrap.style.display = 'none';
      return;
    }

    if (filterInput) filterInput.value = '';

    listEl.innerHTML = items
      .map(
        (it, idx) => `
        <label class="amz-item-row" data-search="${escapeHtml((it.title + ' ' + it.orderId + ' ' + (it.dateIso || it.date)).toLowerCase())}" style="
          display:flex; align-items:flex-start; gap:6px; padding:5px 4px; border-bottom:1px solid #f0f0f0; cursor:pointer; font-size:11px;
        ">
          <input type="checkbox" class="amz-item-check" data-index="${idx}" checked style="margin-top:2px;" />
          <div style="flex:1; min-width:0;">
            <div style="display:flex; justify-content:space-between; font-weight:bold; color:#111;">
              <span>${escapeHtml(it.dateIso || it.date)}</span>
              <span>${escapeHtml(it.priceStr)}</span>
            </div>
            <div style="color:#555; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(it.title || it.orderId)}</div>
          </div>
        </label>`
      )
      .join('');

    listEl.querySelectorAll('.amz-item-check').forEach((cb) => {
      cb.addEventListener('change', updateSelectionSummary);
    });

    wrap.style.display = 'block';
    updateSelectionSummary();
  }

  // 操作パネルを画面左上に挿入
  async function injectControlUI() {
    if (document.getElementById('amz-invoice-panel')) return;
    injectPanelStyles();

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
            <label style="display:block; margin-bottom:3px; color:#444; font-size:11px;">ファイル名プリセット</label>
            <select id="amz-filename-preset" style="width:100%; padding:4px; border:1px solid #ccc; border-radius:4px; font-size:11.5px; margin-bottom:6px;">
              <option value="custom">カスタム（下の入力欄を編集）</option>
              <option value="{date}_{price}_Amazon_{orderId}">標準（日付_金額_Amazon_注文番号）</option>
              <option value="{year}/{year}-{month}/{date}_{price}_{orderId}">年/月別フォルダ分け</option>
              <option value="{dateIso}_Amazon_{title}_{price}">freee・MF向け（日付_商品名_金額）</option>
            </select>
            <label style="display:block; margin-bottom:3px; color:#444; font-size:11px;">ファイル名形式（{date} {dateIso} {price} {orderId} {title} {year}）</label>
            <input type="text" id="amz-filename-tpl" style="width:100%; padding:4px 6px; border:1px solid #ccc; border-radius:4px; font-size:11.5px; margin-bottom:8px;" />

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

        <div id="amz-preview-wrap" style="display:none; margin-bottom:8px; border:1px solid #ddd; border-radius:6px; padding:7px; background:#fff;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; font-size:11px;">
            <span style="font-weight:bold;">対象: <span id="amz-selected-count">0</span>件（<span id="amz-selected-total">¥0</span>）</span>
            <div>
              <button id="amz-select-all-btn" type="button" style="background:none; border:none; color:#0066c0; cursor:pointer; font-size:11px; padding:0 4px;">全選択</button>
              <button id="amz-deselect-all-btn" type="button" style="background:none; border:none; color:#0066c0; cursor:pointer; font-size:11px; padding:0 4px;">解除</button>
            </div>
          </div>
          <input type="text" id="amz-filter-input" placeholder="商品名・注文番号で絞り込み..." style="
            width:100%; padding:4px 6px; margin-bottom:5px; border:1px solid #ddd; border-radius:4px; font-size:11px;
          " />
          <div id="amz-preview-list" style="max-height:150px; overflow-y:auto; border-top:1px solid #eee;"></div>
          <button id="amz-download-selected-btn" type="button" class="amz-primary-btn" style="
            width:100%; margin-top:6px; color:#111; font-weight:bold;
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
          <button id="amz-scan-btn" class="amz-primary-btn" style="
            flex:1; color:#111; font-weight:bold;
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

    // プリセットドロップダウンとテキスト入力を同期
    const presetEl = document.getElementById('amz-filename-preset');
    const tplEl = document.getElementById('amz-filename-tpl');
    const matchPreset = Array.from(presetEl.options).some((opt) => opt.value === settings.filenameTemplate);
    presetEl.value = matchPreset ? settings.filenameTemplate : 'custom';

    renderLicenseUI(license);

    const syncSettings = () => {
      saveSettings({
        fetchDepth: document.getElementById('amz-fetch-depth').value,
        dateFrom: document.getElementById('amz-date-from').value,
        dateTo: document.getElementById('amz-date-to').value,
        filenameTemplate: tplEl.value.trim() || DEFAULT_SETTINGS.filenameTemplate,
        preferInvoicePdf: document.getElementById('amz-prefer-invoice').checked,
        skipDownloaded: document.getElementById('amz-skip-downloaded').checked,
        exportCsv: document.getElementById('amz-export-csv').checked
      });
    };

    presetEl.addEventListener('change', () => {
      if (presetEl.value !== 'custom') {
        tplEl.value = presetEl.value;
        syncSettings();
      }
    });

    tplEl.addEventListener('input', () => {
      const matched = Array.from(presetEl.options).some((opt) => opt.value === tplEl.value.trim());
      presetEl.value = matched ? tplEl.value.trim() : 'custom';
    });

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

    document.getElementById('amz-filter-input').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      document.querySelectorAll('#amz-preview-list .amz-item-row').forEach((row) => {
        const hay = row.getAttribute('data-search') || '';
        row.style.display = !q || hay.includes(q) ? 'flex' : 'none';
      });
    });

    document.getElementById('amz-select-all-btn').addEventListener('click', () => {
      document.querySelectorAll('#amz-preview-list .amz-item-row').forEach((row) => {
        if (row.style.display !== 'none') {
          const cb = row.querySelector('.amz-item-check');
          if (cb) cb.checked = true;
        }
      });
      updateSelectionSummary();
    });

    document.getElementById('amz-deselect-all-btn').addEventListener('click', () => {
      document.querySelectorAll('#amz-preview-list .amz-item-row').forEach((row) => {
        if (row.style.display !== 'none') {
          const cb = row.querySelector('.amz-item-check');
          if (cb) cb.checked = false;
        }
      });
      updateSelectionSummary();
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

  // カード内の直接PDFリンクまたはポップオーバーURLを同期取得
  function getInvoiceRefs(card) {
    const directPdf = card.querySelector('a[href*="/documents/download/"]');
    if (directPdf) {
      return {
        directPdfUrl: new URL(directPdf.getAttribute('href'), 'https://www.amazon.co.jp').href,
        popoverUrl: null
      };
    }

    const popoverTrigger = card.querySelector('[data-a-popover*="invoice"], [data-a-popover*="receipt"]');
    if (popoverTrigger) {
      try {
        const popoverData = JSON.parse(popoverTrigger.getAttribute('data-a-popover') || '{}');
        if (popoverData.url) {
          return {
            directPdfUrl: null,
            popoverUrl: new URL(popoverData.url, 'https://www.amazon.co.jp').href
          };
        }
      } catch (_) {}
    }
    return { directPdfUrl: null, popoverUrl: null };
  }

  // Amazon個人・Amazon Business 両対応の注文カード抽出
  function extractOrdersFromDoc(doc, { preferInvoicePdf, filenameTemplate }) {
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
      let popoverUrl = null;

      if (preferInvoicePdf) {
        const refs = getInvoiceRefs(card);
        if (refs.directPdfUrl) {
          url = refs.directPdfUrl;
          isDirectPdf = true;
        } else if (refs.popoverUrl) {
          popoverUrl = refs.popoverUrl;
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
        popoverUrl,
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

  // 次ページURLを複数のパターンから堅牢に検出
  function getNextPageUrl(doc, currentPage) {
    const selectors = [
      'ul.a-pagination li.a-last:not(.a-disabled) a',
      '.a-pagination .a-last:not(.a-disabled) a',
      'a[aria-label*="次へ"]',
      'a[aria-label*="Next"]'
    ];
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el) {
        const href = el.getAttribute('href');
        if (href && href !== '#' && !href.startsWith('javascript:')) {
          return new URL(href, 'https://www.amazon.co.jp').href;
        }
      }
    }

    // テキスト「次へ」または page=N+1 / startIndex=N*10 リンクを検索
    const nextPageNum = currentPage + 1;
    const nextStartIndex = currentPage * 10;
    const links = Array.from(doc.querySelectorAll('a[href]'));
    for (const a of links) {
      if (a.closest('.a-disabled')) continue;
      const href = a.getAttribute('href') || '';
      if (!href || href === '#' || href.startsWith('javascript:')) continue;

      const text = (a.textContent || '').trim();
      if (/^次へ/.test(text) || /次へ→?$/.test(text)) {
        return new URL(href, 'https://www.amazon.co.jp').href;
      }
      if (
        (href.includes('your-orders') || href.includes('order-history')) &&
        (href.includes(`page=${nextPageNum}`) || href.includes(`startIndex=${nextStartIndex}`))
      ) {
        return new URL(href, 'https://www.amazon.co.jp').href;
      }
    }

    return null;
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

  // スキャンステップ（実ページ遷移で確実に全ページ取得）
  async function runScanStep(state) {
    isCancelled = false;
    setRunningState(true);
    updateStatus(`スキャン中 (${state.currentPage}ページ目 / 現在 ${state.items.length}件)...`, 0);

    try {
      const downloadedSet = new Set(state.downloadedOrderIds || []);
      const pageOrders = extractOrdersFromDoc(document, {
        preferInvoicePdf: state.preferInvoicePdf,
        filenameTemplate: state.filenameTemplate
      });

      let datedCount = 0;
      let olderThanFromCount = 0;

      for (const order of pageOrders) {
        if (order.dateIso) {
          datedCount++;
          if (state.dateTo && order.dateIso > state.dateTo) continue;
          if (state.dateFrom && order.dateIso < state.dateFrom) {
            olderThanFromCount++;
            continue;
          }
        }

        if (state.skipDownloaded && downloadedSet.has(order.orderId)) {
          state.skippedCount++;
          continue;
        }

        if (!state.items.some((x) => x.orderId === order.orderId)) {
          state.items.push(order);
        }
      }

      // ページ内の日付付き注文が「すべて」開始日より古い場合のみ、以降のページ巡回を終了
      const allOlderThanFrom = Boolean(state.dateFrom) && datedCount > 0 && olderThanFromCount === datedCount;
      const nextUrl = getNextPageUrl(document, state.currentPage);
      if (!allOlderThanFrom && state.currentPage < state.maxPages && nextUrl && !isCancelled) {
        const nextState = {
          ...state,
          currentPage: state.currentPage + 1
        };
        updateStatus(`次ページへ移動中 (${state.currentPage}ページ目完了: ${state.items.length}件)...`, 0);
        chrome.storage.local.set({ amzScanState: nextState }, () => {
          setTimeout(() => {
            if (!isCancelled) {
              window.location.href = nextUrl;
            }
          }, 1000);
        });
        return;
      }

      // スキャン完了
      chrome.storage.local.remove('amzScanState');
      setRunningState(false);

      scannedItems = state.items;
      renderPreviewList(scannedItems);

      if (scannedItems.length === 0) {
        const msg = state.skippedCount > 0
          ? `新規対象の注文はありませんでした（取得済みスキップ: ${state.skippedCount}件）`
          : '条件に一致する注文が見つかりませんでした。';
        updateStatus(msg);
      } else {
        updateStatus(`${scannedItems.length}件見つかりました。対象を選んで保存を押してください。`);
      }
    } catch (err) {
      console.error('[Amazon領収書PDF] スキャンエラー:', err);
      chrome.storage.local.remove('amzScanState');
      setRunningState(false);
      updateStatus(`エラー: ${err.message}`);
    }
  }

  // ステップ1: 注文をスキャンしてチェックボックス一覧を表示
  async function scanOrdersProcess() {
    if (isProcessing) return;

    const dateFrom = document.getElementById('amz-date-from').value;
    const dateTo = document.getElementById('amz-date-to').value;
    if (dateFrom && dateTo && dateFrom > dateTo) {
      alert('開始日は終了日より前の日付を指定してください。');
      return;
    }

    lastFailedItems = [];
    document.getElementById('amz-retry-btn').style.display = 'none';

    const { downloadedOrderIds } = await loadSettings();
    const initialState = {
      isScanning: true,
      startedAt: Date.now(),
      currentPage: 1,
      maxPages: parseInt(document.getElementById('amz-fetch-depth').value, 10),
      dateFrom: document.getElementById('amz-date-from').value,
      dateTo: document.getElementById('amz-date-to').value,
      filenameTemplate: document.getElementById('amz-filename-tpl').value.trim() || DEFAULT_SETTINGS.filenameTemplate,
      preferInvoicePdf: document.getElementById('amz-prefer-invoice').checked,
      skipDownloaded: document.getElementById('amz-skip-downloaded').checked,
      downloadedOrderIds,
      skippedCount: 0,
      items: []
    };

    await runScanStep(initialState);
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
    setRunningState(false);
    updateStatus('中止しました');
    if (isContextValid()) {
      try {
        chrome.storage.local.remove('amzScanState');
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

  injectControlUI().then(() => {
    // 複数ページスキャン途中のページ遷移であれば自動で続きから再開（5分以上前の古い状態は破棄）
    if (!isContextValid()) return;
    chrome.storage.local.get(['amzScanState'], (res) => {
      const state = res && res.amzScanState;
      if (state && state.isScanning) {
        const isFresh = !state.startedAt || Date.now() - state.startedAt < 5 * 60 * 1000;
        if (isFresh) {
          setTimeout(() => runScanStep(state), 600);
        } else {
          chrome.storage.local.remove('amzScanState');
        }
      }
    });
  });
})();
