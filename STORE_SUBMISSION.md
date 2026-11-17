# Chrome Web Store 公開・審査申請ガイド

## 1. 公開前の必須チェックリスト
- [ ] [ExtensionPay](https://extensionpay.com/) で拡張機能IDを作成し、`background.js` 4行目の `EXTPAY_EXTENSION_ID` を本番IDに書き換える
- [ ] `docs/privacy.html` 内の連絡先を自分のメールアドレス等に変更し、GitHub Pages / Netlify 等に公開してURLを取得する
- [ ] スクリーンショット（1280×800 または 640×400、PNG/JPEG）を2〜3枚用意する（操作パネル表示画面、保存されたPDFフォルダ画面など）
- [ ] Chrome Web Store デベロッパーアカウント登録（初回のみ登録料 $5）

---

## 2. ストア掲載用テキスト（コピペ用）

### タイトル
`Amazon領収書一括ダウンローダー - インボイスPDF・CSV出力`

### 概要（132文字以内）
`Amazon.co.jpの注文履歴から領収書・適格請求書をPDFで一括保存！日付・金額での自動リネーム、期間指定、注文一覧CSV出力に対応し、確定申告や経理作業を効率化します。`

### 詳細説明
```text
確定申告や月次経理、経費精算で毎回Amazonの注文履歴から領収書を1枚ずつ開いて印刷・保存する作業をワンクリックで自動化します。

【主な機能】
■ 領収書・適格請求書（インボイス）のPDF一括保存
・指定したページ数や期間（開始日〜終了日）の注文を自動巡回し、A4サイズのPDFとして一括保存します。
・適格請求書（インボイス）の原本PDFリンクがある注文は原本PDFを優先して取得します。

■ 会計ソフト向けにファイル名を自動リネーム
・「20261117_3980円_Amazon_注文番号.pdf」のように日付・金額・注文番号を含めたファイル名で自動整理されます。
・{date} {price} {orderId} {title} {year} などの変数で自由な命名ルール・年別フォルダ分けが可能です。

■ 取得済み注文のスキップ機能
・一度保存した注文番号を記録し、毎月の経理作業で同じ領収書を重複ダウンロードするのを防ぎます。

■ 注文一覧CSVの同時出力（Proプラン）
・保存した全注文の「注文日・注文番号・金額・商品名・保存ファイル名」をまとめたUTF-8（BOM付き）CSVファイルを出力します。Excelで文字化けせずそのまま開けます。

【料金プラン】
・無料プラン：月10件までPDF一括保存が可能
・Proプラン：PDF保存無制限 ＋ 注文一覧CSV出力

【プライバシーとセキュリティ】
・注文履歴や領収書データはすべてお客様のブラウザ内のみで処理され、外部サーバーへ送信・保存されることは一切ありません。
```

---

## 3. 審査フォーム用回答テンプレート（権限・単一目的）

Chrome Web Store の「プライバシー」タブで各権限の理由を英語（または日本語）で求められます。そのまま使える文面です。

### Single purpose description（単一目的の説明）
> **English:**
> Batch-collects order receipts and invoices from Amazon.co.jp order history pages, converts them into PDF files with customizable filenames, and optionally exports a summary CSV for bookkeeping.
>
> **日本語:**
> Amazon.co.jpの注文履歴ページから領収書・請求書を一括収集し、指定のファイル名でPDF保存（および経理用CSV出力）を行うための拡張機能です。

### Permission justifications（各権限の理由）
- **`downloads`**
  - Used to save generated receipt PDF files and the summary CSV file directly into the user's Downloads folder with formatted filenames.
- **`storage`**
  - Used to persist user preferences (filename template, date filters), downloaded order IDs to prevent duplicates, and monthly free-tier usage count locally.
- **`tabs`**
  - Used to open receipt print pages sequentially in a background tab so they can be rendered and exported as PDFs.
- **`debugger`**
  - Used solely to invoke the `Page.printToPDF` Chrome DevTools Protocol command on the temporary background receipt tab to generate clean A4 PDFs without triggering interactive print dialogs. The debugger is detached immediately after processing and never inspects or transmits user browsing data.
- **`notifications`**
  - Used to notify the user when a batch PDF download job completes or encounters an error.
- **`host_permissions` (`https://www.amazon.co.jp/*`)**
  - Required to read order metadata (date, order ID, price, receipt URL) from Amazon.co.jp order history pages and fetch receipt/invoice documents using the user's authenticated session.

---

## 4. ストア提出用 ZIP の作成コマンド（PowerShell）

ドキュメント類（`docs/` や `STORE_SUBMISSION.md`）を除外し、拡張機能の動作に必要なファイルだけを `amazon-invoice-downloader.zip` に固めるコマンドです。

```powershell
$src = "C:\Users\r-nuimura\.gemini\antigravity\scratch\amazon-invoice-downloader"
$zip = "C:\Users\r-nuimura\.gemini\antigravity\scratch\amazon-invoice-downloader.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path "$src\manifest.json", "$src\background.js", "$src\content.js", "$src\popup.html", "$src\popup.js", "$src\ExtPay.js", "$src\icons" -DestinationPath $zip
```
