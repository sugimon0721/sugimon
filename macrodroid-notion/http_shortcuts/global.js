// ============================================================
// Notion記録 共通関数（HTTP Shortcuts の「グローバルスクリプト」）
//
// 各ショートカットは、下の関数を1行呼ぶだけにする。
//   notionCheck("ジム")                              … 今日の行のチェックボックスをON
//   notionCount("プロテイン回数")                     … 今日の行の数値を+1
//   notionTime("シャワー時刻", "シャワー時刻（グラフ用）") … 今の時刻を書く（HH:MM と 時の小数）
//   notionMemo("🛒 買う")                            … インボックスにメモを1件追加
//   notionTest()                                     … 接続テスト（何も書き換えない）
//
// 項目を増やすとき：ショートカットを複製して、1行だけ書き換える。
// 列名は Notion の列名と1文字でも違うとエラーになる（エラー内容はトーストに出る）。
// ============================================================

// ---- 設定 ----
var NOTION_TOKEN = "__NOTION_TOKEN__";
var NOTION_VERSION = "2025-09-03";
// データソースID（DBのIDとは別物）。Notion の DB 右上「…」→「データソースを管理」→「データソースIDをコピー」で確認できる
var DS_HEALTH = "33caaa32-686c-80c3-8ba9-000b5dea2539"; // 📊 実績管理 > 健康記録
var DS_INBOX = "30eaaa32-686c-811a-965c-000b9a236dfc";  // 📥 インボックス
var DATE_PROP = "（フィルタ用・非表示）日付";            // 健康記録で「今日の行」を探すための日付列

// ---- 共通部品 ----
function pad2(n) {
  return n < 10 ? "0" + n : "" + n;
}

function todayStr() {
  var d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

// 失敗したら理由をトーストに出して止める
function notionFail(message) {
  showToast("✗ Notion: " + message);
  abort();
}

function notionDone(message) {
  showToast("✓ " + message);
  vibrate("short");
}

// Notion API を呼んで、レスポンスJSONを返す。失敗時は notionFail で止まる
function notionApi(method, path, body) {
  var options = {
    method: method,
    headers: {
      "Authorization": "Bearer " + NOTION_TOKEN,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    }
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  var r = sendHttpRequest("https://api.notion.com/v1/" + path, options);
  if (r.status === "success") {
    return JSON.parse(r.response.body);
  }
  if (r.status === "networkError") {
    notionFail("通信エラー " + r.networkError);
  }
  var detail = "";
  try {
    detail = JSON.parse(r.response.body).message;
  } catch (e) {
    detail = String(r.response.body).substring(0, 150);
  }
  notionFail("HTTP " + r.response.statusCode + " " + detail);
}

// 健康記録の「今日の行」を返す。行は毎朝6時ごろ別スクリプトが作るので、それより前は見つからない
function getTodayPage() {
  var q = notionApi("POST", "data_sources/" + DS_HEALTH + "/query", {
    filter: { property: DATE_PROP, date: { equals: todayStr() } },
    page_size: 1
  });
  if (!q.results || q.results.length === 0) {
    notionFail("今日(" + todayStr() + ")の行がまだありません");
  }
  return q.results[0];
}

function updatePage(pageId, properties) {
  notionApi("PATCH", "pages/" + pageId, { properties: properties });
}

// ---- 呼び出す関数 ----
function notionCheck(column) {
  var page = getTodayPage();
  var props = {};
  props[column] = { checkbox: true };
  updatePage(page.id, props);
  notionDone(column + " ON");
}

function notionCount(column, step) {
  step = step || 1;
  var page = getTodayPage();
  var current = page.properties[column];
  if (!current) {
    notionFail("列が見つかりません: " + column);
  }
  var value = (current.number || 0) + step;
  var props = {};
  props[column] = { number: value };
  updatePage(page.id, props);
  notionDone(column + " " + value);
}

function notionTime(textColumn, numberColumn) {
  var d = new Date();
  var hhmm = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  var page = getTodayPage();
  var props = {};
  props[textColumn] = { rich_text: [{ text: { content: hhmm } }] };
  if (numberColumn) {
    props[numberColumn] = { number: Math.round((d.getHours() + d.getMinutes() / 60) * 100) / 100 };
  }
  updatePage(page.id, props);
  notionDone(textColumn + " " + hhmm);
}

function notionMemo(tag) {
  var text = prompt("メモを入力");
  if (!text) {
    abort();
  }
  var props = {
    "内容/タイトル": { title: [{ text: { content: text } }] }
  };
  if (tag) {
    props["クイックタグ"] = { select: { name: tag } };
  }
  notionApi("POST", "pages", {
    parent: { type: "data_source_id", data_source_id: DS_INBOX },
    properties: props
  });
  notionDone("メモ保存");
}

// トークン・権限・今日の行の有無をまとめて確認する。書き換えはしない
function notionTest() {
  var ds = notionApi("GET", "data_sources/" + DS_HEALTH);
  var q = notionApi("POST", "data_sources/" + DS_HEALTH + "/query", {
    filter: { property: DATE_PROP, date: { equals: todayStr() } },
    page_size: 1
  });
  var rowMsg = q.results && q.results.length > 0 ? "今日の行あり" : "今日の行なし（6時以降に再確認）";
  var name = ds.title && ds.title.length > 0 ? ds.title[0].plain_text : "健康記録";
  notionDone("接続OK " + name + " / " + rowMsg);
}
