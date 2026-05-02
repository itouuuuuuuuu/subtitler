<p align="center">
  <img src="assets/promo-1400x560.png" alt="subtitler — Japanese subtitles for English pages">
</p>

# subtitler

英語ページの各文の下に、字幕のように日本語訳を表示するトグル式の Chrome 拡張機能です。
原文はそのまま残り、訳文は文単位ですぐ下に挿入されるので、両方を並べて読めます。
翻訳は Chrome 組み込みの Translator API によりすべて端末内で実行され、外部サーバーには一切送信されません。

## 特長

- **ショートカットでオン／オフ切り替え** — ページをリロードせずに訳文の表示・非表示を即座に切り替え。
- **文単位での対応付け** — ページ末尾にまとめて表示するのではなく、英語の各文の直後に訳文を挿入。
- **`IntersectionObserver` による遅延翻訳** — ビューポートに入った文だけを翻訳するため、長いページでも軽快でモデル呼び出しも抑えられます。
- **同時実行数を絞った翻訳キュー** — 同時に翻訳される文は最大数件までに制限。
- **動的コンテンツ対応** — `MutationObserver` により SPA や無限スクロールで追加されたテキストにも追従。
- **UI ラベルのフィルタ** — `<button>` / `role="button"` / 単独の `<a>` / `<label>` / `<summary>` などの中の短いテキストはスキップし、ナビリンクやボタンのラベルが汚れないようにしています。リンクテキストが URL そのものの場合もスキップします。
- **インラインリンクを含む文への対応** — 文の途中にリンクがある場合（例: `For more information, visit the <a>EC2 M8i instance</a> page.`）でも、断片に分割せず一つの文として翻訳します。
- **オンデバイス翻訳** — Chrome の `Translator` API（`en` → `ja`）を使用。モデルは初回利用時に一度だけダウンロードされます。

## 動作要件

- Translator API が利用できる Chrome **138+**（または同等バージョンの Chromium 系ブラウザ）。
- `en` → `ja` の翻訳モデル。初回起動時にダウンロードを促され、以降はキャッシュされたモデルを使用します。

## インストール

[Chrome ウェブストア](https://chromewebstore.google.com/detail/subtitler/jopchjgompefkikmbcemcikfigailpjn)からインストールしてください。

## 使い方

- **キーボードショートカット**: 既定は `Alt+Shift+Y`（macOS では Option+Shift+Y）。1 回押すと現在のページを翻訳、もう一度押すと非表示、さらにもう一度押すと再表示します。`chrome://extensions/shortcuts`（Arc では `arc://extensions/shortcuts`）から任意のキーに変更できます。
- **ツールバーアイコン**: subtitler のアイコンをクリックするとショートカットと同じ動作をします。
- **初回ダウンロード**: 新しいプロファイルでの初回翻訳時には、翻訳モデルのダウンロードを確認するバナーが表示されます。**Download** をクリックするか、**Cancel** で中止できます。

### ダウンロード済み翻訳モデルの削除

ダウンロード済みの翻訳モデルを削除して再ダウンロードの挙動を確認したい場合は、`chrome://on-device-translation-internals/` を開き、`en` → `ja` のエントリで **Uninstall** をクリックします。次回トグル時に再びダウンロード確認バナーが表示されます。

### 動作しないページ

以下のページではコンテンツスクリプトを注入できません。

- `chrome://` / `arc://` / `about:` ページ
- Chrome ウェブストア
- PDF ビューア
- 注入スクリプトをブロックする厳格な CSP が設定されたページ

## プライバシー

- 翻訳はすべて Chrome の Translator API により端末内で行われます。
- 拡張機能から外部へのネットワークリクエストは行いません。
- `permissions` に関わる挙動は、`<all_urls>` でのコンテンツスクリプト注入のみで、これは閲覧中のページに翻訳をレンダリングするために必要です。

## サポート

本拡張機能は無料で配布されています。継続的な開発・メンテナンスを支援していただける方は、リポジトリ右上の **Sponsor** ボタン、または <https://github.com/sponsors/itouuuuuuuuu> から GitHub Sponsors 経由で寄付できます。

## 既知の制約

- 翻訳キャッシュはインメモリで、ページのライフタイム中は上限なく保持されます。
- 英語 → 日本語以外の言語は対応していません。
- **デスクトップビューポート前提**: 視覚的に隠された要素のスキップ判定で Tailwind の variant prefix（`md:sr-only`、`focus:not-sr-only` など）はクラス名のみで判断し、現在の breakpoint/状態は確認しません。デスクトップ幅では実用上問題ありませんが、ブラウザ幅を狭めて使用した場合に variant が一致しないクラスで判定が反転することがあります。

---

# 開発者向け

## ローカルインストール（unpacked）

```sh
# 1. リポジトリを clone
# 2. chrome://extensions/ を開いてデベロッパーモードを有効化
# 3. 「パッケージ化されていない拡張機能を読み込む」で extension/ を選択
```

## テスト

```sh
npm install
npm test
npm run test:watch
npm run test:coverage
```

## リリース

```sh
git checkout main && git pull
npm version patch       # minor / major も可
git push --follow-tags  # release.yml が ZIP をビルドし GitHub Release を公開
```

公開後、<https://chrome.google.com/webstore/devconsole> に ZIP をアップロード。

### GitHub Actions ワークフロー

| ワークフロー | トリガー | 内容 |
| --- | --- | --- |
| `ci.yml` | すべての PR と `main` への push | テスト実行、ZIP のビルド、artifact としてアップロード、`package.json` と `extension/manifest.json` のバージョン不一致は失敗扱い |
| `release.yml` | タグ push（`v*`）または手動（`workflow_dispatch`） | 対象タグからビルドし、`subtitler-X.Y.Z.zip` を添付した GitHub Release を公開 |
| `build-zip.yml` | 手動（`workflow_dispatch`） | 対象タグから ZIP のみをビルドし、ワークフローの artifact としてダウンロード可能にする（Release は作成しない） |

```sh
# Release を作らず ZIP のみ取得: Actions → Build ZIP → Run workflow
# Release 再作成:               Actions → Release → Run workflow
```
