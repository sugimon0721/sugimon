# MacroDroid × HTTP Shortcuts × Notion 記録

## 仕組み

```
[きっかけ]                      [書き込み役]                       [記録先]
MacroDroid（NFC・手動など） ──→ HTTP Shortcuts ────────────────→ Notion 健康記録（今日の行）
クイック設定タイル        ──→   ├ グローバルスクリプト＝共通関数     Notion 📥 インボックス
                                └ 各ショートカット＝関数を1行呼ぶ
```

- MacroDroid は「Webサイトを開く」アクションで `http-shortcuts://<ショートカットID>` を開くだけ。
- Notion への書き込みは全部 HTTP Shortcuts のグローバルスクリプト（`http_shortcuts/global.js`）に集約。

## 直したこと（2026-09-23）

| 症状 | 原因 | 対応 |
|---|---|---|
| 6/1 以降、チェック・カウントが1件も記録されていない | 健康記録DBに2つ目のデータソース（空の「新しいデータソース」）が追加され、旧API版（2022-06-28）の `databases/{id}/query` が失敗するようになった（Notion公式の移行ガイドに明記） | API版を `2025-09-03` にし、`data_sources/{id}/query` を使う形に変更 |
| 買い物メモが保存されない | データソースIDを `database_id` として渡していた。さらに冷凍弁当+1のコードが後ろに残っていて、メモ後に冷凍弁当も+1される作り | `parent: {data_source_id}` に変更し、残骸を削除 |
| 成功後にエラーが出ることがある | `vibrate(200)` は存在しない振動パターン名 | `vibrate("short")` に変更 |
| 失敗理由が分からない | コードが12か所にコピーされ、エラー処理がばらばら | 共通関数に集約し、失敗理由（HTTPコードとNotionのメッセージ）をトーストに出す |

## 導入手順

1. **HTTP Shortcuts**：メニュー →「インポート/エクスポート」→「インポート」→ `yyyymmdd_【設定】HTTPShortcuts_Notion記録.zip`（「統合」でよい）
2. HTTP Shortcuts：設定 →「グローバルスクリプト」に `notionCheck` などの関数が入っていることを確認
   - 既にグローバルスクリプトに何か書いてあった場合、統合インポートでは上書きされない（アプリの仕様）。その場合は `global_code_with_token.js` の中身を貼り付ける
3. HTTP Shortcuts：「Notion接続テスト」をタップ →「✓ 接続OK 健康記録 / 今日の行あり」と出れば完了
   - `HTTP 401` → トークンが無効。`HTTP 404` → インテグレーションが健康記録DBに接続されていない（DBの「…」→「接続」で追加）
4. **MacroDroid**：「エクスポート/インポート」→ インポート →「ストレージ」→ `yyyymmdd_【設定】MacroDroid_Notion連携.mdr`
   - .mdr のインポートは**全マクロの置き換え**。中身は 2026-09-23 18:52 のバックアップに下記の変更を足したもの。これ以降にマクロを変えていたら、先に手元をエクスポートしてから `build.py` で作り直す
   - 「インポート時に変数をリセット」はOFF
5. MacroDroid：マクロ「Notion接続テスト」を開き「アクションをテスト」→ 手順3と同じトーストが出れば、MacroDroid → HTTP Shortcuts の経路も通っている

### MacroDroid 側の変更点

| マクロ | 追加したアクション | Notion に書く内容 |
|---|---|---|
| シャワー（NFC） | 末尾に「Webサイトを開く: http-shortcuts://…」 | シャワー時刻（HH:MM）とグラフ用数値 |
| ジム準備完了&体重計起動（NFC） | 体重計アプリ起動の直前に同上 | ジム ✓ |
| Notion接続テスト（新規・手動実行用） | 同上 | 書き換えなし（確認のみ） |

## 項目を増やすとき

例：「振り返り」チェックを増やす。

1. HTTP Shortcuts で既存のショートカット（例：ジムON）を長押し →「複製（Duplicate）」
2. 名前を「振り返りON」にし、スクリプトを1行だけ書き換える：`notionCheck("振り返り");`
3. MacroDroid から呼ぶなら：ショートカットを長押し →「情報を表示（Show Info）」で出る `http-shortcuts://…` を、MacroDroid のアクション「Webサイトを開く / HTTP GET」に貼る（HTTP GET はOFF）

使える関数（`http_shortcuts/global.js`）

| 関数 | 用途 | 列の型 |
|---|---|---|
| `notionCheck("列名")` | 今日の行のチェックをON | チェックボックス |
| `notionCount("列名")` / `notionCount("列名", 2)` | 今日の行の数値を+1（+2） | 数値 |
| `notionTime("文字列の列", "数値の列")` | 今の時刻を書く（数値の列は省略可） | テキスト／数値 |
| `notionMemo("タグ名")` | 入力欄を出してインボックスに1件追加 | — |
| `notionTest()` | 接続確認（書き換えなし） | — |

列名は Notion と1文字でも違うと「HTTP 400 ○○ is not a property that exists」と出る。

## ファイルを作り直す（PC 作業）

`config.json` と `global.js` がすべての元。ここを変えて：

```
python build.py --shortcuts <HTTP Shortcutsのエクスポート.zip> --mdr <MacroDroidのエクスポート.mdr>
node test/harness.js <展開した shortcuts.json>
```

- トークンは入力の shortcuts.json から自動で拾う（環境変数 `NOTION_TOKEN` でも可）。出力先 `dist/` は Git に入れない
- `test/harness.js` は HTTP Shortcuts の実行順（グローバル → 各ショートカット）を再現し、模擬 Notion API（実スキーマ `test/notion_schema.json`）に対して全ショートカットを実行する

## 台帳との対応（2026-11-03 追加）

| ショートカット | 台帳のノード | 中身 |
|---|---|---|
| 気がかりメモ | 頭の中の気がかり ＞ 寝る前に気がかりを1行ずつ書く（仮） | 入力欄を出し、インボックスにタグ「なし」で1件追加（`notionMemo("なし")`） |

- 呼び出しはクイック設定タイル／ランチャーから手動。MacroDroid のマクロは足さない（台帳の方針：MacroDroid/NFC は減らす。寝る前の催促は通常の通知で行う）。
- 列は増やしていない（インボックスの既存の列だけ）。

## 既知の制約

- 健康記録の「今日の行」は別スクリプトが毎朝6時ごろ作る。0〜6時に押すと「今日の行がまだありません」で止まる（行は作らない。二重作成を避けるため）
- 空の「新しいデータソース」は今回の修正で影響しなくなったが、不要なら Notion 側で削除してよい
