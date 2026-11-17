# 集客・プロモーション用テンプレート

ストア審査通過後にそのまま使える告知文と記事構成です。

- **Chrome Web Store URL**: `https://chromewebstore.google.com/detail/olhecjlhnjdpdbfieddmcckhniklia`
- **公式サイト（LP）URL**: `https://fk7ryu.github.io/amazon-invoice-pro-jp/`

---

## 1. X（旧Twitter）告知ポスト案

### パターンA：課題共感＋デモ動画向け（最も伸びやすい）
```text
確定申告や毎月の経費精算で、Amazonの領収書を1枚ずつ開いてPDF保存・リネームする作業がしんどすぎたので、ワンクリックで一括保存できるChrome拡張機能を作りました。

✅ 適格請求書(インボイス)PDF優先取得
✅ 「日付_金額_Amazon_注文番号.pdf」へ自動リネーム
✅ 期間指定＆取得済みスキップ
✅ 注文一覧CSVも同時出力

月10件まで無料でお試しできます👇
https://chromewebstore.google.com/detail/olhecjlhnjdpdbfieddmcckhniklia
```

### パターンB：個人開発ストーリー向け
```text
個人開発で「Amazon領収書一括ダウンローダー」をChromeウェブストアに公開しました！

・外部サーバー送信なし（ブラウザ内で完結）
・A4 PDFとして綺麗に保存
・freeeやマネーフォワード向けの自動リネーム対応

経理作業をラクにしたい方はぜひ使ってみてください🙏
詳細：https://fk7ryu.github.io/amazon-invoice-pro-jp/
```

---

## 2. note / Zenn 記事構成案

### タイトル案
- `【確定申告】Amazonの領収書・インボイスを一括でPDF保存＆自動リネームするChrome拡張を作った話`
- `毎月のAmazon領収書ダウンロードを10秒で終わらせるChrome拡張機能`

### 見出し構成
1. **はじめに（なぜ作ったか）**
   - 確定申告や月次経理で「注文履歴から1件ずつ開く→印刷→PDF保存→日付と金額にリネーム」の苦痛
2. **できること（スクリーンショット付きで紹介）**
   - 期間指定で対象注文だけをスキャン＆チェック選択
   - インボイス（適格請求書）原本PDFの優先取得
   - `YYYYMMDD_金額_Amazon_注文番号.pdf` への自動リネーム
   - Excelで文字化けしないBOM付きCSVサマリー
3. **セキュリティとプライバシー**
   - 注文データは一切外部サーバーへ送らず、ローカルブラウザ内だけで動く仕組み
4. **料金と導入リンク**
   - 月10件まで無料、たくさん使う方向けに月額490円 / 買い切り2,980円
   - Chrome Web Store へのリンク
