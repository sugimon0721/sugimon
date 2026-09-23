// HTTP Shortcuts の実行環境（グローバルスクリプト → 各ショートカットのスクリプト）を再現し、
// 模擬 Notion API（実スキーマで検証）に対して全ショートカットを実行する。
//   node test/harness.js <生成した shortcuts.json>
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "notion_schema.json"), "utf8"));
const exportJson = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const shortcuts = exportJson.categories.flatMap((c) => c.shortcuts);
const globalCode = exportJson.globalCode;

function pad2(n) { return n < 10 ? "0" + n : "" + n; }
function today() {
  const d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

// ---- 模擬 Notion API ----
function makeNotion(opts) {
  const state = {
    rows: opts.hasTodayRow === false ? [] : [{ id: "page-today", date: today(), properties: Object.assign({}, opts.initial) }],
    created: [],
    calls: [],
  };
  const PROPTYPE_KEY = { checkbox: "checkbox", number: "number", rich_text: "rich_text", title: "title", select: "select" };

  function err(code, message) {
    return { status: "httpError", response: { statusCode: code, body: JSON.stringify({ object: "error", code: "validation_error", message }) } };
  }
  function ok(body) {
    return { status: "success", response: { statusCode: 200, body: JSON.stringify(body) } };
  }
  function checkProps(props, def) {
    for (const [name, value] of Object.entries(props)) {
      const type = def.properties[name];
      if (!type) return name + " is not a property that exists.";
      const key = PROPTYPE_KEY[type];
      if (!(key in value)) return name + " is expected to be " + type + ".";
      if (type === "checkbox" && typeof value.checkbox !== "boolean") return name + " checkbox must be boolean";
      if (type === "number" && typeof value.number !== "number") return name + " number must be number";
      if ((type === "rich_text" || type === "title") && !Array.isArray(value[key])) return name + " must be array";
      if (type === "select" && !(def.select_options[name] || []).includes(value.select.name)) return name + " unknown option";
    }
    return null;
  }

  function sendHttpRequest(url, options) {
    options = options || {};
    const method = options.method || "GET";
    const headers = options.headers || {};
    const body = options.body ? JSON.parse(options.body) : null;
    state.calls.push({ method, url, body });
    if (opts.networkError) return { status: "networkError", networkError: "timeout" };

    assert.ok(url.startsWith("https://api.notion.com/v1/"), "Notion 以外に送っている: " + url);
    assert.ok(/^Bearer ntn_/.test(headers.Authorization), "Authorization ヘッダが不正");
    assert.strictEqual(headers["Notion-Version"], "2025-09-03", "Notion-Version が古い");
    assert.ok(!url.includes("/databases/"), "旧エンドポイント /databases/ を使っている（複数データソースDBで失敗する）");
    const p = url.replace("https://api.notion.com/v1/", "");

    if (method === "GET" && p === "data_sources/" + schema.health.data_source_id) {
      return ok({ object: "data_source", title: [{ plain_text: "健康記録" }] });
    }
    if (method === "POST" && p === "data_sources/" + schema.health.data_source_id + "/query") {
      assert.strictEqual(body.filter.property, "（フィルタ用・非表示）日付");
      assert.strictEqual(body.filter.date.equals, today());
      const rows = state.rows.filter((r) => r.date === body.filter.date.equals);
      return ok({
        object: "list",
        results: rows.map((r) => ({
          object: "page",
          id: r.id,
          properties: Object.fromEntries(Object.entries(schema.health.properties).map(([n, t]) => {
            if (t === "number") return [n, { type: "number", number: r.properties[n] === undefined ? null : r.properties[n] }];
            if (t === "checkbox") return [n, { type: "checkbox", checkbox: !!r.properties[n] }];
            return [n, { type: t }];
          })),
        })),
      });
    }
    const m = /^pages\/(.+)$/.exec(p);
    if (method === "PATCH" && m) {
      const row = state.rows.find((r) => r.id === m[1]);
      if (!row) return err(404, "Could not find page");
      const e = checkProps(body.properties, schema.health);
      if (e) return err(400, e);
      for (const [n, v] of Object.entries(body.properties)) {
        row.properties[n] = "checkbox" in v ? v.checkbox : "number" in v ? v.number : v.rich_text[0].text.content;
      }
      return ok({ object: "page", id: row.id });
    }
    if (method === "POST" && p === "pages") {
      assert.deepStrictEqual(body.parent, { type: "data_source_id", data_source_id: schema.inbox.data_source_id });
      const e = checkProps(body.properties, schema.inbox);
      if (e) return err(400, e);
      state.created.push(body.properties);
      return ok({ object: "page", id: "new-page" });
    }
    return err(400, "unexpected request " + method + " " + p);
  }
  return { state, sendHttpRequest };
}

// ---- HTTP Shortcuts 実行環境（ScriptExecutor.kt の abort 実装に合わせる） ----
function runShortcut(shortcut, opts) {
  const notion = makeNotion(opts);
  const out = { toasts: [], vibrations: 0, aborted: false, notion };
  const ctx = vm.createContext({
    sendHttpRequest: notion.sendHttpRequest,
    showToast: (m) => out.toasts.push(String(m)),
    vibrate: (pattern) => {
      assert.ok(["", "short", "long", "0", "1", "2", "3", undefined].includes(pattern), "不正な振動パターン: " + pattern);
      out.vibrations++;
    },
    prompt: () => (opts.promptValue === undefined ? "牛乳" : opts.promptValue),
    abort: () => { out.aborted = true; throw "Abort"; },
    JSON, Math, Date, String,
  });
  try {
    vm.runInContext(globalCode, ctx);
    vm.runInContext(shortcut.codeOnPrepare, ctx);
  } catch (e) {
    if (e !== "Abort") throw e;
  }
  return out;
}

// ---- テスト ----
let failed = 0;
function test(name, fn) {
  try { fn(); console.log("OK  " + name); }
  catch (e) { failed++; console.log("NG  " + name + "\n    " + (e && e.message ? e.message : e)); }
}
const byName = Object.fromEntries(shortcuts.map((s) => [s.name, s]));

assert.ok(globalCode.includes("ntn_"), "トークンが埋め込まれていない");
assert.ok(!globalCode.includes("__NOTION_TOKEN__"));

for (const s of shortcuts) {
  test("構文・種別: " + s.name, () => {
    assert.strictEqual(s.executionType, "scripting");
    new vm.Script(s.codeOnPrepare);
  });
}

const checks = { "ジムON": "ジム", "バイクON": "バイク", "ゴルフON": "ゴルフ", "ゴミ捨てON": "ゴミ捨て",
  "除湿機の水替えON": "除湿機の水替え", "ルンバの水替えON": "ルンバの水替え", "CPAP乾燥ON": "CPAP乾燥", "CPAP装着ON": "CPAP装着" };
for (const [sc, col] of Object.entries(checks)) {
  test("チェック " + sc + " → " + col + " が true", () => {
    const r = runShortcut(byName[sc], {});
    assert.strictEqual(r.notion.state.rows[0].properties[col], true, r.toasts.join(" / "));
    assert.strictEqual(r.aborted, false);
    assert.deepStrictEqual(r.toasts, ["✓ " + col + " ON"]);
    assert.strictEqual(r.vibrations, 1);
  });
}

for (const [sc, col] of Object.entries({ "2L飲料+1": "2L飲料", "冷凍弁当+1": "冷凍弁当", "プロテイン回数+1": "プロテイン回数" })) {
  test("カウント " + sc + " 空欄→1", () => {
    const r = runShortcut(byName[sc], {});
    assert.strictEqual(r.notion.state.rows[0].properties[col], 1, r.toasts.join(" / "));
  });
}

test("カウント 既存値2→3", () => {
  const r = runShortcut(byName["プロテイン回数+1"], { initial: { "プロテイン回数": 2 } });
  assert.strictEqual(r.notion.state.rows[0].properties["プロテイン回数"], 3);
  assert.deepStrictEqual(r.toasts, ["✓ プロテイン回数 3"]);
});

test("シャワー時刻 → テキスト HH:MM とグラフ用数値", () => {
  const r = runShortcut(byName["シャワー時刻"], {});
  const p = r.notion.state.rows[0].properties;
  assert.match(p["シャワー時刻"], /^\d\d:\d\d$/, r.toasts.join(" / "));
  assert.ok(typeof p["シャワー時刻（グラフ用）"] === "number" && p["シャワー時刻（グラフ用）"] < 24);
});

test("買い物メモ → インボックスに1件（データソース親・🛒 買う）", () => {
  const r = runShortcut(byName["買い物メモ"], { promptValue: "牛乳" });
  assert.strictEqual(r.notion.state.created.length, 1, r.toasts.join(" / "));
  assert.strictEqual(r.notion.state.created[0]["内容/タイトル"].title[0].text.content, "牛乳");
  assert.strictEqual(r.notion.state.created[0]["クイックタグ"].select.name, "🛒 買う");
  // 旧コードの残骸（冷凍弁当+1）が混ざっていないこと
  assert.strictEqual(r.notion.state.calls.filter((c) => c.method === "PATCH").length, 0);
});

test("買い物メモ 入力キャンセル → 何も送らない", () => {
  const r = runShortcut(byName["買い物メモ"], { promptValue: "" });
  assert.strictEqual(r.aborted, true);
  assert.strictEqual(r.notion.state.calls.length, 0);
});

test("接続テスト → 書き換えなし・OK表示", () => {
  const r = runShortcut(byName["Notion接続テスト"], {});
  assert.ok(r.toasts[0].startsWith("✓ 接続OK 健康記録 / 今日の行あり"), r.toasts.join(" / "));
  assert.strictEqual(r.notion.state.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/query")).length, 0);
});

test("今日の行が無い → 理由をトーストして中断", () => {
  const r = runShortcut(byName["ジムON"], { hasTodayRow: false });
  assert.strictEqual(r.aborted, true);
  assert.match(r.toasts[0], /今日\(\d{4}-\d\d-\d\d\)の行がまだありません/);
});

test("通信エラー → 理由をトーストして中断", () => {
  const r = runShortcut(byName["ジムON"], { networkError: true });
  assert.strictEqual(r.aborted, true);
  assert.match(r.toasts[0], /通信エラー/);
});

test("存在しない列名 → Notion のエラー文をトースト", () => {
  const bad = { name: "bad", codeOnPrepare: 'notionCheck("ジムx");' };
  const r = runShortcut(bad, {});
  assert.strictEqual(r.aborted, true);
  assert.match(r.toasts[0], /HTTP 400 ジムx is not a property that exists/);
});

console.log(failed === 0 ? "\n全テスト合格" : "\n" + failed + " 件失敗");
process.exit(failed === 0 ? 0 : 1);
