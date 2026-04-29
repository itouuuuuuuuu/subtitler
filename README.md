<p align="center">
  <img src="assets/promo-1400x560.png" alt="subtitler — Japanese subtitles for English pages">
</p>

# subtitler

英語ページの各文の下に、字幕のように日本語訳を表示するトグル式の Chrome 拡張機能です。原文はそのまま残り、訳文は文単位ですぐ下に挿入されるので、両方を並べて読めます。

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

## インストール（unpacked）

1. このリポジトリを clone するかダウンロードします。
2. `chrome://extensions/`（Arc の場合は `arc://extensions/`）を開きます。
3. **デベロッパーモード**を有効にします。
4. **パッケージ化されていない拡張機能を読み込む** をクリックし、`extension/` ディレクトリを選択します。

## 使い方

- **キーボードショートカット**: 既定は `Alt+Shift+Y`（macOS では Option+Shift+Y）。`chrome://extensions/shortcuts` から任意のキーに変更できます。1 回押すと現在のページを翻訳、もう一度押すと非表示、さらにもう一度押すと再表示します。
- **ツールバーアイコン**: subtitler のアイコンをクリックするとショートカットと同じ動作をします。
- 新しいプロファイルでの初回翻訳時には、翻訳モデルのダウンロードを確認するバナーが表示されます。**Download** をクリックするか、**Cancel** で中止できます。

### ショートカットのカスタマイズ

`chrome://extensions/shortcuts`（Arc では `arc://extensions/shortcuts`）からショートカットを変更できます。

> **Arc 利用者向け**: 本拡張は意図的に `chrome.commands` での登録に加えて、`window` 上の `keydown` でページ内でもショートカットをキャプチャしています。Arc では `chrome.commands` のイベントが拡張の service worker に届かないことがあるためです。`arc://extensions/shortcuts` でショートカットを変更した場合は、`extension/content.js` 内の `IS_MAC` / `isToggleShortcut` 定数も合わせて更新してください。さもないと、新しいキーではツールバーアイコンしか動作しません。

### 動作しないページ

以下のページではコンテンツスクリプトを注入できません。

- `chrome://` / `arc://` / `about:` ページ
- Chrome ウェブストア
- PDF ビューア
- 注入スクリプトをブロックする厳格な CSP が設定されたページ

## 仕組み

1. トグル時、コンテンツスクリプトは `en` → `ja` の `Translator` インスタンスがあることを確認します。モデル未ダウンロードの場合は、ユーザー操作によるダウンロード開始を促すバナーを表示します。
2. `document.body` をブロック単位（`<p>`, `<li>`, `<div>` など）で走査し、`<script>`, `<style>`, `<code>`, `<pre>`、contenteditable 領域、すでに注入済みのノードはスキップします。
3. 各ブロック内では、隣接するテキストノードとインライン要素（`<a>`, `<em>` など）のテキストを連結したフラットなストリームを `Intl.Segmenter` で文に分割します。UI ラベルらしき文（ボタン内の短いテキスト、単独で短いリンク、ラベル類）や、リンクテキストが URL そのものの文は除外します。
4. 残った文の直後に `<span class="subtitler-loading">Translating...</span>` のプレースホルダを挿入します。
5. 各プレースホルダを `IntersectionObserver` で監視し、ビューポートに入った（200px のマージン付き）時点で翻訳キューに投入します。
6. 同時実行数の上限を 4 とした小さなキューが処理を行い、翻訳結果が返るとプレースホルダを `<span class="subtitler-ja">…</span>` に置き換えます。
7. `MutationObserver` により後から追加された DOM ノード（SPA のページ遷移、遅延読み込みされたセクションなど）を捕捉し、同じパイプラインで処理します。自身が注入したノードは `WeakSet` で記録してフィードバックループを防ぎます。
8. 表示のオン／オフ切り替えは、注入済みの全要素のインライン `display` を反転するだけで済み、再翻訳は行いません。

## ファイル構成

```
extension/
  manifest.json   # MV3 マニフェスト、commands、content_scripts
  background.js   # service worker: ショートカットとツールバークリックを中継
  content.js      # メインロジック: 収集・翻訳・各種 observer
  styles.css      # 字幕、ローディング、バナーのスタイル
tests/
  setup.mjs       # ブラウザ API のモック (chrome.*, Translator, IntersectionObserver, requestIdleCallback)
  content.test.mjs
  background.test.mjs
```

## テスト

本拡張には Vitest + jsdom によるテストスイートが含まれており、純粋な
ヘルパー（`hasLatinLetter`, `isToggleShortcut`, `shouldTranslate`）、DOM
パイプライン（`processTextNode`, `collectAndInject`, `collectFromTextNode`,
`replaceLoadingWithTranslation`, `setVisibility`）、トグルの状態遷移
（`handleToggle`）、`IntersectionObserver` による遅延翻訳フロー、
インメモリの翻訳キャッシュ、`<option>` のスキップルール、SPA が翻訳済み
サブツリーを再配置した際の重複字幕を防ぐべき再走査の冪等性などをカバー
しています。

```sh
npm install         # 初回のみ
npm test            # スイートを 1 回実行
npm run test:watch  # ファイル変更で再実行
npm run test:coverage
```

ブラウザのグローバル（`chrome.*`, `Translator`, `IntersectionObserver`,
`requestIdleCallback`）は `tests/setup.mjs` でモック化しています。テストは
実際の `extension/content.js` と `extension/background.js` モジュールを
読み込みます。両ファイルとも `typeof module` でガードした CommonJS の
`module.exports` ブロックを公開しており、ブラウザでは何もしませんが、
これにより vitest からソースをそのまま利用できます。

## Chrome ウェブストアへのリリース

リリースパイプラインは GitHub Actions で完全に駆動されています。ワークフローは関心事ごとに分離されています。

| ワークフロー | トリガー | 内容 |
| --- | --- | --- |
| `ci.yml` | すべての PR と `main` への push | テスト実行、ZIP のビルド、artifact としてアップロード、`package.json` と `extension/manifest.json` のバージョン不一致は失敗扱い |
| `prepare-release.yml` | 手動（`workflow_dispatch`） | バージョンを bump（未指定なら次の patch、または明示的な `x.y.z`）、`scripts/sync-version.mjs` で `manifest.json` を同期、`release/vX.Y.Z` PR を作成 |
| `tag-after-merge.yml` | リリース PR がマージ | `main` に `vX.Y.Z` を自動タグ付けし、`release.yml` を `workflow_dispatch` 経由で起動 |
| `release.yml` | タグ push または手動（`workflow_dispatch`） | 既存タグからビルドし、`subtitler-X.Y.Z.zip` を添付した GitHub Release を公開 |
| `build-zip.yml` | 手動（`workflow_dispatch`） | 既存タグから ZIP のみをビルドし、ワークフローの artifact としてダウンロード可能にする（GitHub Release は作成しない） |

> `tag-after-merge.yml` がタグ push 後に `release.yml` を明示的に dispatch するのは、`GITHUB_TOKEN` が push したタグでは下流ワークフローが起動しないという GitHub Actions の仕様を回避するためです。

### リリース手順

1. **Actions → Prepare release → Run workflow** を選びます。`version` は空のままなら次の patch、または `1.2.3` のような明示的な値を指定できます。
2. 自動で開く `Release vX.Y.Z` PR を確認してマージします。
3. `tag-after-merge.yml` と `release.yml` の完了まで数十秒〜1 分待ちます。
4. 新しい GitHub Release から `subtitler-X.Y.Z.zip` をダウンロードし、<https://chrome.google.com/webstore/devconsole> にアップロードします。
5. ストア情報は [`STORE_LISTING.md`](STORE_LISTING.md) を、プライバシーポリシーは [`PRIVACY.md`](PRIVACY.md) を参照して入力します。

### 既存バージョンの ZIP を取得する

リリースを作らずに ZIP だけ欲しい場合は **Actions → Build ZIP → Run workflow** で対象バージョン（例: `0.1.1`）を指定して実行します。完了後、ワークフロー実行ページの **Artifacts** から ZIP をダウンロードできます。

### 既存タグからリリースを再作成する

何らかの理由で `release.yml` が走らなかった、もしくは Release を作り直したい場合は **Actions → Release → Run workflow** で対象バージョンを指定して手動実行できます。タグは事前に存在している必要があります。

### ローカルでのフォールバック

GitHub Actions を使わずにリリースを切る必要がある場合は次のとおりです。

```sh
npm version patch       # または minor / major — sync-version.mjs も実行され manifest.json が staged になります
git push --follow-tags  # bump コミットと新しいタグを push
```

push されたタグで `release.yml` が起動します（この方法は `main` に直接コミットするため、上記のワークフローを優先してください）。

### プロモアセット

`assets/` 配下に既に生成済みです。

- `assets/promo-440x280.png` — 小サイズのプロモタイル（ウェブストアで必須）。
- `assets/promo-1400x560.png` — マーキータイル（任意。注目枠への掲載に使用）。

## プライバシー

- 翻訳はすべて Chrome の Translator API により端末内で行われます。
- 拡張機能から外部へのネットワークリクエストは行いません。
- `permissions` に関わる挙動は、`<all_urls>` でのコンテンツスクリプト注入のみで、これは閲覧中のページに翻訳をレンダリングするために必要です。

## 既知の制約

- 翻訳キャッシュはインメモリで、ページのライフタイム中は上限なく保持されます。
- 英語 → 日本語以外の言語は対応していません。
