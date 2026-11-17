importScripts('ExtPay.js');

// ExtensionPayで発行した拡張機能ID（スラッグ）を設定してください
const EXTPAY_EXTENSION_ID = 'amazon-invoice-pro-jp';
const FREE_MONTHLY_LIMIT = 10;

let isCancelled = false;
let isRunning = false;

const isExtPayConfigured = () =>
  EXTPAY_EXTENSION_ID && EXTPAY_EXTENSION_ID !== 'YOUR_EXTENSIONPAY_ID';

const extpay = isExtPayConfigured() ? ExtPay(EXTPAY_EXTENSION_ID) : null;
if (extpay) {
  extpay.startBackground();
}

// 現在の年月（YYYY-MM）を取得
function getCurrentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// 月間利用回数を取得
async function getMonthlyUsage() {
  const currentMonth = getCurrentMonthKey();
  return new Promise((resolve) => {
    chrome.storage.local.get(['monthlyUsage'], (res) => {
      const usage = res.monthlyUsage;
      if (usage && usage.month === currentMonth) {
        resolve({ month: currentMonth, count: usage.count || 0 });
      } else {
        const fresh = { month: currentMonth, count: 0 };
        chrome.storage.local.set({ monthlyUsage: fresh }, () => resolve(fresh));
      }
    });
  });
}

// 月間利用回数を加算
async function incrementMonthlyUsage(addedCount) {
  if (!addedCount) return;
  const usage = await getMonthlyUsage();
  const updated = { month: usage.month, count: usage.count + addedCount };
  return new Promise((resolve) => {
    chrome.storage.local.set({ monthlyUsage: updated }, () => resolve(updated));
  });
}

// ローカル開発版（ストア経由でない＝update_urlがない）か判定
const isUnpackedDev = () => !chrome.runtime.getManifest().update_url;

// 課金状態と無料枠残数を取得
async function getLicenseStatus() {
  let isPaid = false;
  const devMode = isUnpackedDev();

  if (devMode) {
    // 開発者モード読み込み時はデフォルトで無制限（切替ボタンで無料枠テストも可）
    const devPro = await new Promise((resolve) => {
      chrome.storage.local.get(['devProMode'], (res) => {
        resolve(res.devProMode === undefined ? true : Boolean(res.devProMode));
      });
    });
    if (devPro) {
      isPaid = true;
    }
  }

  if (!isPaid && extpay) {
    try {
      const user = await extpay.getUser();
      isPaid = Boolean(user && user.paid);
    } catch (err) {
      console.warn('[ExtPay] ユーザー状態取得エラー:', err);
    }
  }

  const usage = await getMonthlyUsage();
  const remaining = isPaid ? Infinity : Math.max(0, FREE_MONTHLY_LIMIT - usage.count);

  return {
    isPaid,
    isConfigured: isExtPayConfigured(),
    isUnpackedDev: devMode,
    monthlyUsed: usage.count,
    monthlyLimit: FREE_MONTHLY_LIMIT,
    remaining: isPaid ? null : remaining
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_LICENSE_STATUS') {
    getLicenseStatus().then((status) => sendResponse(status));
    return true;
  }

  if (message.action === 'OPEN_PAYMENT_PAGE') {
    if (extpay) {
      extpay.openPaymentPage();
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, reason: 'NOT_CONFIGURED' });
    }
    return false;
  }

  if (message.action === 'OPEN_LOGIN_PAGE') {
    if (extpay) {
      extpay.openLoginPage();
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, reason: 'NOT_CONFIGURED' });
    }
    return false;
  }

  if (message.action === 'TOGGLE_DEV_PRO') {
    if (!isUnpackedDev()) {
      sendResponse({ devProMode: false });
      return false;
    }
    chrome.storage.local.get(['devProMode'], (res) => {
      const current = res.devProMode === undefined ? true : Boolean(res.devProMode);
      const next = !current;
      chrome.storage.local.set({ devProMode: next }, () => {
        sendResponse({ devProMode: next });
      });
    });
    return true;
  }

  if (message.action === 'START_DOWNLOAD') {
    if (isRunning) return;
    const sourceTabId = sender.tab ? sender.tab.id : null;
    const { items, exportCsv } = message.payload;
    processPdfQueue(items, exportCsv, sourceTabId);
  } else if (message.action === 'CANCEL_DOWNLOAD') {
    isCancelled = true;
  }
});

// content.js へ進捗を通知
function notifyProgress(tabId, current, total, statusText, done = false, extra = {}) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, {
    action: 'PROGRESS_UPDATE',
    current,
    total,
    statusText,
    done,
    ...extra
  }).catch(() => {
    // タブが閉じられている場合などは無視
  });
}

// タブの読み込み完了を待機
function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('ページ読み込みがタイムアウトしました'));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Data URL を使ってファイルを保存
function downloadDataUrl(dataUrl, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: dataUrl,
        filename,
        saveAs: false,
        conflictAction: 'uniquify'
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}

// ArrayBuffer を Base64 文字列へ変換
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// UTF-8文字列（BOM付き）をBase64エンコード
function encodeUtf8BomBase64(text) {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const body = new TextEncoder().encode(text);
  const merged = new Uint8Array(bom.length + body.length);
  merged.set(bom, 0);
  merged.set(body, bom.length);
  return arrayBufferToBase64(merged.buffer);
}

// CSVフィールドのエスケープ
function escapeCsv(val) {
  const str = String(val ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// 取得済み注文IDをストレージに保存
async function recordDownloadedOrderIds(newIds) {
  if (!newIds.length) return null;
  return new Promise((resolve) => {
    chrome.storage.local.get(['downloadedOrderIds'], (res) => {
      const existing = Array.isArray(res.downloadedOrderIds) ? res.downloadedOrderIds : [];
      const merged = Array.from(new Set([...existing, ...newIds]));
      chrome.storage.local.set({ downloadedOrderIds: merged }, () => {
        resolve(merged.length);
      });
    });
  });
}

// ポップオーバーHTMLから適格請求書（原本PDF）URLを抽出
async function resolvePopoverInvoiceUrl(popoverUrl) {
  try {
    const res = await fetch(popoverUrl, { credentials: 'include' });
    if (!res.ok) return null;
    const html = await res.text();
    // 適格請求書やインボイス付近、または /documents/download/ を含むリンクを正規表現で抽出
    const matches = Array.from(html.matchAll(/href=["']([^"']*\/documents\/download\/[^"']*)["']/gi));
    if (!matches.length) return null;
    const rawHref = matches[0][1].replace(/&amp;/g, '&');
    return rawHref.startsWith('http') ? rawHref : `https://www.amazon.co.jp${rawHref}`;
  } catch (_) {
    return null;
  }
}

// 直接PDFリンク（適格請求書など）をフェッチして保存
async function downloadDirectPdf(url, filename) {
  const res = await fetch(url, { credentials: 'include' });
  if (res.url && res.url.includes('/ap/signin')) {
    throw new Error('Amazonのログインセッションが切れました。再ログインしてください。');
  }
  if (!res.ok) {
    throw new Error(`PDF取得失敗 (HTTP ${res.status})`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('pdf') && !contentType.includes('octet-stream')) {
    throw new Error('直接PDF以外のレスポンスが返されました');
  }
  const buffer = await res.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  await downloadDataUrl(`data:application/pdf;base64,${base64}`, filename);
}

// タブを使って印刷用ページからPDFを生成・保存
async function printTabToPdf(tabId, item) {
  const loadPromise = waitForTabComplete(tabId);
  await chrome.tabs.update(tabId, { url: item.url });
  const updatedTab = await loadPromise;

  if (updatedTab.url && updatedTab.url.includes('/ap/signin')) {
    throw new Error('Amazonのログインセッションが切れました。再ログインしてください。');
  }

  await new Promise((r) => setTimeout(r, 800));
  if (isCancelled) return false;

  const pdfResult = await chrome.debugger.sendCommand({ tabId }, 'Page.printToPDF', {
    printBackground: true,
    preferCSSPageSize: true,
    paperWidth: 8.27,
    paperHeight: 11.69,
    marginTop: 0.4,
    marginBottom: 0.4,
    marginLeft: 0.4,
    marginRight: 0.4
  });

  const pdfDataUrl = `data:application/pdf;base64,${pdfResult.data}`;
  await downloadDataUrl(pdfDataUrl, item.filename);
  return true;
}

// PDF一括生成メイン処理
async function processPdfQueue(rawItems, exportCsv, sourceTabId) {
  isRunning = true;
  isCancelled = false;

  let workerTab = null;
  let debuggerAttached = false;
  let successCount = 0;
  const completedItems = [];
  const failedItems = [];

  try {
    // サーバー側（background）でもライセンス・無料枠を厳密チェック
    const license = await getLicenseStatus();
    if (!license.isPaid && license.remaining <= 0) {
      notifyProgress(
        sourceTabId,
        0,
        rawItems.length,
        `今月の無料枠（${FREE_MONTHLY_LIMIT}件）に達しました。Proプランで無制限になります。`,
        true,
        { licenseStatus: license }
      );
      return;
    }

    const items = license.isPaid ? rawItems : rawItems.slice(0, license.remaining);
    const allowCsv = Boolean(exportCsv && license.isPaid);

    const needsTabPrint = items.some((it) => !it.isDirectPdf);
    if (needsTabPrint) {
      workerTab = await chrome.tabs.create({ url: 'about:blank', active: false });
      await chrome.debugger.attach({ tabId: workerTab.id }, '1.3');
      debuggerAttached = true;

      await chrome.debugger.sendCommand({ tabId: workerTab.id }, 'Page.enable');
      await chrome.debugger.sendCommand({ tabId: workerTab.id }, 'Page.addScriptToEvaluateOnNewDocument', {
        source: 'window.print = function() {};'
      });
    }

    for (let i = 0; i < items.length; i++) {
      if (isCancelled) break;

      const item = items[i];
      notifyProgress(
        sourceTabId,
        i,
        items.length,
        `PDF保存中 (${i + 1}/${items.length}): ${item.orderId}`
      );

      let saved = false;

      if (item.popoverUrl && !item.isDirectPdf) {
        const directUrl = await resolvePopoverInvoiceUrl(item.popoverUrl);
        if (directUrl) {
          item.url = directUrl;
          item.isDirectPdf = true;
        }
      }

      if (item.isDirectPdf) {
        try {
          await downloadDirectPdf(item.url, item.filename);
          saved = true;
          item.pdfType = '原本PDF';
        } catch (err) {
          if (err.message.includes('ログインセッション')) {
            notifyProgress(sourceTabId, i, items.length, err.message, true);
            return;
          }
          console.warn(`[直接PDF失敗→印刷ページへフォールバック] ${item.orderId}:`, err.message);
          item.url = `https://www.amazon.co.jp/gp/css/summary/print.html?ie=UTF8&orderID=${item.orderId}`;
          item.isDirectPdf = false;
          if (!workerTab) {
            workerTab = await chrome.tabs.create({ url: 'about:blank', active: false });
            await chrome.debugger.attach({ tabId: workerTab.id }, '1.3');
            debuggerAttached = true;
            await chrome.debugger.sendCommand({ tabId: workerTab.id }, 'Page.enable');
            await chrome.debugger.sendCommand({ tabId: workerTab.id }, 'Page.addScriptToEvaluateOnNewDocument', {
              source: 'window.print = function() {};'
            });
          }
        }
      }

      if (!saved && workerTab) {
        // 一時的なネットワークエラー等に備えて最大2回（初回＋リトライ1回）試行
        for (let attempt = 1; attempt <= 2; attempt++) {
          if (isCancelled) break;
          try {
            const ok = await printTabToPdf(workerTab.id, item);
            if (ok) {
              saved = true;
              item.pdfType = '印刷生成PDF';
            }
            break;
          } catch (err) {
            console.error(`[PDF生成失敗 attempt=${attempt}] ${item.orderId}:`, err);
            if (err.message.includes('ログインセッション')) {
              notifyProgress(sourceTabId, i, items.length, err.message, true);
              return;
            }
            if (attempt < 2) {
              await new Promise((r) => setTimeout(r, 1200));
            }
          }
        }
      }

      if (saved) {
        successCount++;
        completedItems.push(item);
      } else if (!isCancelled) {
        failedItems.push(item);
      }

      if (i < items.length - 1 && !isCancelled) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    // 無料プランの場合は月間利用件数を更新
    if (!license.isPaid && successCount > 0) {
      await incrementMonthlyUsage(successCount);
    }

    const historyCount = await recordDownloadedOrderIds(completedItems.map((it) => it.orderId));
    const latestLicense = await getLicenseStatus();

    // ProプランのみCSVサマリー出力
    if (!isCancelled && allowCsv && completedItems.length > 0) {
      const header = ['注文日', '注文番号', '金額(円)', '商品名', 'PDF種別', '保存ファイル名', '領収書URL'];
      const rows = completedItems.map((it) => [
        it.dateIso || it.date,
        it.orderId,
        it.priceNum,
        it.title,
        it.pdfType || '',
        it.filename,
        it.url
      ]);
      const csvText = [header, ...rows]
        .map((row) => row.map(escapeCsv).join(','))
        .join('\r\n');

      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const csvDataUrl = `data:text/csv;charset=utf-8;base64,${encodeUtf8BomBase64(csvText)}`;
      await downloadDataUrl(csvDataUrl, `Amazon領収書/${today}_Amazon領収書一覧.csv`);
    }

    const finalMsg = isCancelled
      ? `中止しました (${successCount}/${items.length}件 保存済み)`
      : failedItems.length > 0
        ? `完了: ${successCount}/${items.length}件保存（失敗: ${failedItems.length}件）`
        : `完了: ${successCount}/${items.length}件のPDFを保存しました`;

    notifyProgress(sourceTabId, items.length, items.length, finalMsg, true, {
      historyCount,
      licenseStatus: latestLicense,
      failedItems
    });

    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Amazon領収書一括ダウンローダー',
      message: finalMsg
    });
  } catch (err) {
    console.error('[Amazon領収書PDF] 致命的エラー:', err);
    notifyProgress(sourceTabId, 0, rawItems.length, `エラー: ${err.message}`, true);
  } finally {
    if (debuggerAttached && workerTab) {
      try {
        await chrome.debugger.detach({ tabId: workerTab.id });
      } catch (_) {}
    }
    if (workerTab) {
      try {
        await chrome.tabs.remove(workerTab.id);
      } catch (_) {}
    }
    isRunning = false;
  }
}
