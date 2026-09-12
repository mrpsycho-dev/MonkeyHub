#!/usr/bin/env python3
"""Renders popup.html / dashboard.html in headless Chromium with a mocked
`chrome` runtime so we can capture real, on-brand preview screenshots
without an actual browser extension host. Dev-tooling only - not shipped.
"""
import json
import os
import time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "src")
OUT = os.path.join(ROOT, ".shots")
os.makedirs(OUT, exist_ok=True)

NOW = int(time.time() * 1000)  # real "now" so the heatmap/streak line up with the browser's actual Date.now()

def make_results():
    import random
    random.seed(7)
    results = []
    modes = [("time", "15"), ("time", "30"), ("time", "60"), ("time", "120"), ("words", "25"), ("words", "50")]
    base = NOW - 200 * 86400000
    rid = 0
    for day in range(0, 200, 2):
        if random.random() < 0.55:
            continue
        n = random.choice([1, 1, 1, 2])
        for _ in range(n):
            mode, mode2 = random.choice(modes)
            skill = 60 + day * 0.18 + random.uniform(-4, 6)
            rid += 1
            results.append({
                "id": f"r{rid}",
                "timestamp": base + day * 86400000 + random.randint(0, 80000),
                "wpm": round(skill, 1),
                "rawWpm": round(skill + random.uniform(2, 6), 1),
                "acc": round(min(100, 92 + random.uniform(0, 7)), 1),
                "consistency": round(65 + random.uniform(0, 25), 1),
                "mode": mode,
                "mode2": mode2,
                "language": "english",
                "punctuation": random.random() < 0.3,
                "numbers": random.random() < 0.15,
                "difficulty": "normal",
                "charStats": {"correct": 400, "incorrect": 4, "extra": 0, "missed": 1},
                "testDuration": float(mode2) if mode == "time" else 20.0,
                "source": random.choice(["dom", "network"]),
            })
    # ensure a strong recent streak
    for day in range(0, 6):
        rid += 1
        results.append({
            "id": f"streak{rid}",
            "timestamp": NOW - day * 86400000 - 3600000,
            "wpm": round(118 + random.uniform(-3, 4), 1),
            "rawWpm": round(124, 1),
            "acc": 97.2,
            "consistency": 81.4,
            "mode": "time",
            "mode2": "60",
            "language": "english",
            "punctuation": False,
            "numbers": False,
            "difficulty": "normal",
            "charStats": {"correct": 590, "incorrect": 5, "extra": 0, "missed": 1},
            "testDuration": 60.0,
            "source": "network",
        })
    return sorted(results, key=lambda r: r["timestamp"])


def compute_state(page):
    results = make_results()
    stats = page.evaluate("(results) => MH.computeStats(results)", results)
    state = {
        "auth": {"connected": True, "mode": "oauth", "login": "octoteal", "name": "Teal Octocat", "avatarUrl": ""},
        "config": {
            "owner": "", "repo": "monkeytype-stats", "branch": "main",
            "dataPath": "data/results.json", "readmePath": "README.md",
            "autoSync": True, "createIfMissing": True, "visibility": "public",
            "proxyUrl": "https://monkeyhub-oauth-proxy.octoteal.workers.dev",
            "oauthClientId": "Iv1.9f8a7b6c5d4e3f2a", "notifyOnError": True,
        },
        "stats": stats,
        "syncState": {
            "status": "idle", "lastSyncAt": NOW - 90 * 1000, "lastSha": "a1b2c3d",
            "lastReadmeSha": "e4f5g6h", "consecutiveFailures": 0, "lastError": None,
        },
        "log": [
            {"type": "sync_success", "message": "Synced 214 results to octoteal/monkeytype-stats.", "at": NOW - 90 * 1000},
            {"type": "capture", "message": "Captured 60s - 121.4 wpm / 97.2% (network)", "at": NOW - 95 * 1000},
            {"type": "sync_error", "message": "forbidden_secondary_rate_limit: GitHub asked MonkeyHub to slow down. Retrying shortly with backoff.", "at": NOW - 3600 * 1000},
            {"type": "sync_success", "message": "Synced 213 results to octoteal/monkeytype-stats.", "at": NOW - 3500 * 1000},
            {"type": "branch_adjusted", "message": 'Using the repo\'s default branch "main".', "at": NOW - 9 * 86400000},
            {"type": "repo_created", "message": "Created repository octoteal/monkeytype-stats.", "at": NOW - 9 * 86400000},
        ],
        "resultCount": len(results),
    }
    return state


MOCK_JS_TEMPLATE = """
window.__MH_STATE__ = %s;
window.chrome = {
  runtime: {
    sendMessage: (msg) => {
      if (msg.type === 'MH_GET_STATE') return Promise.resolve({ ok: true, state: window.__MH_STATE__ });
      if (msg.type === 'MH_SYNC_NOW') return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true });
    },
    getURL: (p) => p,
    onMessage: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
  },
  tabs: { create: () => {} },
  action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  notifications: { create: () => {} },
  storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
};
"""


def shoot(pw, url, viewport, out_path, state, full_page=False, settle_ms=250, click_selector=None):
    browser = pw.chromium.launch()
    page = browser.new_page(viewport=viewport, device_scale_factor=2)
    # compute stats using the page's own MH.computeStats once libs are loaded,
    # by first loading a blank page with just the lib scripts.
    page.goto("about:blank")
    for rel in ["lib/constants.js", "lib/browser-api.js", "lib/util.js", "lib/stats.js"]:
        page.add_script_tag(path=os.path.join(SRC, rel))
    page.evaluate("() => { window.chrome = {}; }")  # placeholder so browser-api.js's earlier MH.ext isn't reused oddly
    computed_state = compute_state(page)

    mock_js = MOCK_JS_TEMPLATE % json.dumps(computed_state)
    page.add_init_script(mock_js)
    page.goto(url)
    page.wait_for_timeout(settle_ms)
    if click_selector:
        page.click(click_selector)
        page.wait_for_timeout(settle_ms)
    page.screenshot(path=out_path, full_page=full_page)
    browser.close()
    print("wrote", out_path)


def main():
    with sync_playwright() as pw:
        popup_url = f"file://{SRC}/popup/popup.html"
        dash_url = f"file://{SRC}/dashboard/dashboard.html"

        shoot(pw, popup_url, {"width": 380, "height": 640}, os.path.join(OUT, "popup-status.png"), None)
        shoot(pw, popup_url, {"width": 380, "height": 640}, os.path.join(OUT, "popup-settings.png"), None,
              click_selector="button[data-tab='settings']")
        shoot(pw, dash_url, {"width": 1180, "height": 1000}, os.path.join(OUT, "dashboard-overview.png"), None,
              full_page=True)
        shoot(pw, dash_url, {"width": 1180, "height": 900}, os.path.join(OUT, "dashboard-settings.png"), None,
              full_page=True, click_selector="button[data-section='settings']")


if __name__ == "__main__":
    main()
