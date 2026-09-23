"""HTTP Shortcuts / MacroDroid のインポート用ファイルを作る。

使い方:
    python build.py --shortcuts <HTTP Shortcutsのエクスポート(.zip か shortcuts.json)> \
                    --mdr <MacroDroidのエクスポート(.mdr)> [--out dist]

- 設定は config.json、共通関数は http_shortcuts/global.js。
- Notion トークンは環境変数 NOTION_TOKEN、無ければ入力の shortcuts.json から拾う。
  トークン入りの出力は dist/ に置く（.gitignore 済み。リポジトリには入れない）。
"""

import argparse
import copy
import datetime
import json
import os
import random
import re
import uuid
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOKEN_PLACEHOLDER = "__NOTION_TOKEN__"

# 既存ショートカットから引き継ぐ項目（見た目・起動方法）
KEEP_KEYS = (
    "iconName", "iconBackground", "quickSettingsTileShortcut",
    "secondaryLauncherShortcut", "launcherShortcut", "runInForegroundService",
    "description", "hidden", "section",
)
NEW_SHORTCUT_DEFAULTS = {
    "iconName": "flat_color_brightness_5",
    "quickSettingsTileShortcut": True,
    "secondaryLauncherShortcut": True,
    "runInForegroundService": True,
}


def load_shortcuts_export(path: Path) -> dict:
    if path.suffix == ".zip":
        with zipfile.ZipFile(path) as z:
            return json.loads(z.read("shortcuts.json").decode("utf-8"))
    return json.loads(path.read_text(encoding="utf-8"))


def find_token(export: dict) -> str:
    token = os.environ.get("NOTION_TOKEN")
    if token:
        return token
    text = json.dumps(export, ensure_ascii=False)
    m = re.search(r"ntn_[A-Za-z0-9]+|secret_[A-Za-z0-9]+", text)
    if not m:
        raise SystemExit("Notion トークンが見つからない。環境変数 NOTION_TOKEN で渡す")
    return m.group(0)


def build_shortcuts(config: dict, export: dict, global_code: str) -> dict:
    existing = {
        s["id"]: s
        for c in export.get("categories", [])
        for s in c.get("shortcuts", [])
    }
    category = next(
        (c for c in export.get("categories", []) if c.get("id") == config["category_id"]),
        {"id": config["category_id"], "name": "マイショートカット"},
    )
    shortcuts = []
    for item in config["shortcuts"]:
        sid = item["id"] or str(uuid.uuid4())
        item["id"] = sid
        old = existing.get(sid, NEW_SHORTCUT_DEFAULTS)
        s = {k: old[k] for k in KEEP_KEYS if k in old}
        s.update({
            "id": sid,
            "name": item["name"],
            "executionType": "scripting",
            "codeOnPrepare": item["code"],
            "responseHandling": {"successOutput": "none", "failureOutput": "none", "uiType": "toast"},
        })
        shortcuts.append(s)

    # config にない既存ショートカットは消さずに残す
    listed = {s["id"] for s in shortcuts}
    shortcuts += [s for sid, s in existing.items() if sid not in listed]

    out_category = {k: v for k, v in category.items() if k != "shortcuts"}
    out_category["shortcuts"] = shortcuts
    return {
        "categories": [out_category],
        "globalCode": global_code,
        "compatibilityVersion": export.get("compatibilityVersion", 90),
        "version": export.get("version", 91),
    }


class SiGuids:
    """MacroDroid の m_SIGUID / m_GUID を既存と被らないように振る"""

    def __init__(self, mdr: dict):
        self.used = set(int(x) for x in re.findall(r'"m_(?:SI)?GUID": (-?\d+)', json.dumps(mdr)))

    def new(self) -> int:
        while True:
            v = -random.randint(4 * 10**18, 9 * 10**18)
            if v not in self.used:
                self.used.add(v)
                return v


def open_url_action(guids: SiGuids, url: str, comment: str) -> dict:
    return {
        "allowAnyCertificate": False,
        "blockNextAction": False,
        "m_disableUrlEncode": True,
        "m_httpGet": False,
        "m_urlToOpen": url,
        "disableLogging": False,
        "m_SIGUID": guids.new(),
        "m_classType": "OpenWebPageAction",
        "m_comment": comment,
        "m_constraintList": [],
        "m_isDisabled": False,
        "m_isOrCondition": False,
    }


def build_mdr(config: dict, mdr: dict) -> dict:
    mdr = copy.deepcopy(mdr)
    guids = SiGuids(mdr)
    by_name = {s["name"]: s["id"] for s in config["shortcuts"]}
    macros = {m["m_name"]: m for m in mdr["macroList"]}
    now_ms = int(datetime.datetime.now().timestamp() * 1000)

    def action_for(shortcut_name: str) -> dict:
        url = "http-shortcuts://" + by_name[shortcut_name]
        return open_url_action(guids, url, "Notion記録: " + shortcut_name + "（HTTP Shortcuts を呼ぶ）")

    for link in config["macrodroid"]["add_to_existing"]:
        macro = macros.get(link["macro"])
        if macro is None:
            raise SystemExit("マクロが見つからない: " + link["macro"])
        url = "http-shortcuts://" + by_name[link["shortcut"]]
        actions = macro["m_actionList"]
        if any(a.get("m_urlToOpen") == url for a in actions):
            continue  # 2回実行しても重複させない
        pos = len(actions)
        if link.get("before_class"):
            pos = next((i for i, a in enumerate(actions) if a["m_classType"] == link["before_class"]), pos)
        actions.insert(pos, action_for(link["shortcut"]))
        macro["lastEditedTimestamp"] = now_ms

    template = macros["ウォレット"]  # トリガーを持つ通常マクロの雛形
    for spec in config["macrodroid"]["new_macros"]:
        if spec["name"] in macros:
            continue
        m = {k: copy.deepcopy(v) for k, v in template.items()}
        m.update({
            "m_GUID": guids.new(),
            "m_name": spec["name"],
            "m_category": spec["category"],
            "m_description": "手動実行用（マクロ画面で「アクションをテスト」）。HTTP Shortcuts 経由で Notion への接続を確認する。書き換えはしない。",
            "m_enabled": True,
            "m_constraintList": [],
            "localVariables": [],
            "exportedActionBlocks": [],
            "lastEditedTimestamp": now_ms,
            "m_triggerList": [{
                "disableLogging": False,
                "m_SIGUID": guids.new(),
                "m_classType": "EmptyTrigger",
                "m_comment": "",
                "m_constraintList": [],
                "m_isDisabled": False,
                "m_isOrCondition": False,
            }],
            "m_actionList": [action_for(spec["shortcut"])],
        })
        mdr["macroList"].append(m)
    return mdr


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shortcuts", required=True, type=Path)
    ap.add_argument("--mdr", required=True, type=Path)
    ap.add_argument("--out", default=HERE / "dist", type=Path)
    args = ap.parse_args()

    config = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
    export = load_shortcuts_export(args.shortcuts)
    token = find_token(export)
    global_code = (HERE / "http_shortcuts" / "global.js").read_text(encoding="utf-8")
    global_code = global_code.replace(TOKEN_PLACEHOLDER, token)

    shortcuts = build_shortcuts(config, export, global_code)
    mdr = build_mdr(config, json.loads(args.mdr.read_text(encoding="utf-8")))

    args.out.mkdir(parents=True, exist_ok=True)
    today = datetime.date.today().strftime("%Y%m%d")
    zip_path = args.out / f"{today}_【設定】HTTPShortcuts_Notion記録.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("shortcuts.json", json.dumps(shortcuts, ensure_ascii=False, indent=2))
    mdr_path = args.out / f"{today}_【設定】MacroDroid_Notion連携.mdr"
    mdr_path.write_text(json.dumps(mdr, ensure_ascii=False), encoding="utf-8")
    (args.out / "global_code_with_token.js").write_text(global_code, encoding="utf-8")

    print(zip_path)
    print(mdr_path)
    for s in config["shortcuts"]:
        print(f"  http-shortcuts://{s['id']}  {s['name']}")


if __name__ == "__main__":
    main()
