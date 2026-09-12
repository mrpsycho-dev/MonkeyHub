#!/usr/bin/env python3
"""Loads dist/chrome as a real unpacked extension in headless Chromium and
checks that the service worker registers without errors, and that the
popup/dashboard pages load without console errors. Dev-tooling only."""
import os
import sys
import time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
EXT_PATH = os.path.join(ROOT, "dist", "chrome")


def main():
    errors = []
    with sync_playwright() as pw:
        user_data_dir = "/tmp/mh-ext-profile"
        context = pw.chromium.launch_persistent_context(
            user_data_dir,
            headless=False,
            args=[
                f"--disable-extensions-except={EXT_PATH}",
                f"--load-extension={EXT_PATH}",
                "--no-sandbox",
            ],
        )
        time.sleep(3)

        # Low-level check via CDP: list every target Chromium currently has,
        # regardless of what Playwright's higher-level service_workers
        # helper has noticed yet.
        cdp = context.new_cdp_session(context.pages[0] if context.pages else context.new_page())
        targets = cdp.send("Target.getTargets")
        for t in targets.get("targetInfos", []):
            print("target:", t.get("type"), t.get("url"))

        # Chromium exposes background service workers via context.service_workers
        workers = context.service_workers
        if not workers:
            # give it a bit more time
            time.sleep(1.5)
            workers = context.service_workers
        if not workers:
            errors.append("No service worker registered for the extension.")
        else:
            for w in workers:
                print("service worker url:", w.url)
            ext_id = workers[0].url.split("/")[2]
            print("extension id:", ext_id)

            def check_page(path, label):
                page = context.new_page()
                page_errors = []
                page.on("pageerror", lambda e: page_errors.append(str(e)))
                page.on("console", lambda m: page_errors.append(m.text) if m.type == "error" else None)
                page.goto(f"chrome-extension://{ext_id}/{path}")
                page.wait_for_timeout(1000)
                page.screenshot(path=os.path.join(ROOT, ".shots", f"live-{label}.png"))
                page.close()
                if page_errors:
                    errors.extend([f"{label}: {e}" for e in page_errors])
                else:
                    print(f"{label}: no console errors")

            check_page("popup/popup.html", "popup")
            check_page("dashboard/dashboard.html", "dashboard")

            # Exercise real chrome.storage.local persistence: change a
            # setting, reload the page fresh, confirm it stuck.
            page = context.new_page()
            page.goto(f"chrome-extension://{ext_id}/dashboard/dashboard.html")
            page.click("button[data-section='settings']")
            page.fill("#cfgRepo", "typing-journal")
            page.dispatch_event("#cfgRepo", "blur")
            page.wait_for_timeout(500)
            page.check("#cfgNotifyOnError")  # toggle a checkbox too (was already checked by default -> unchecks it)
            page.wait_for_timeout(500)
            page.close()

            page2 = context.new_page()
            page2.goto(f"chrome-extension://{ext_id}/dashboard/dashboard.html")
            page2.click("button[data-section='settings']")
            page2.wait_for_timeout(500)
            persisted_repo = page2.input_value("#cfgRepo")
            print("persisted repo name after reload:", persisted_repo)
            if persisted_repo != "typing-journal":
                errors.append(f"Setting did not persist through chrome.storage.local: got '{persisted_repo}'")
            page2.screenshot(path=os.path.join(ROOT, ".shots", "live-dashboard-settings-persisted.png"))
            page2.close()

            # Simulate content.js capturing a completed test and verify the
            # real background worker stores it, dedupes a repeat, and the
            # dashboard reflects it - the actual capture -> storage path,
            # exercised for real rather than mocked.
            page3 = context.new_page()
            page3.goto(f"chrome-extension://{ext_id}/dashboard/dashboard.html")
            fake_result = {
                "timestamp": int(time.time() * 1000),
                "wpm": 87.4, "rawWpm": 91.2, "acc": 96.5, "consistency": 78.3,
                "mode": "time", "mode2": "60", "language": "english",
                "punctuation": False, "numbers": False, "difficulty": "normal",
                "charStats": {"correct": 421, "incorrect": 8, "extra": 1, "missed": 2},
                "testDuration": 60, "source": "network",
            }
            resp1 = page3.evaluate(
                "(r) => chrome.runtime.sendMessage({ type: 'MH_RESULT_CAPTURED', result: r })", fake_result
            )
            resp2 = page3.evaluate(
                "(r) => chrome.runtime.sendMessage({ type: 'MH_RESULT_CAPTURED', result: r })", fake_result
            )
            print("first capture response:", resp1)
            print("duplicate capture response:", resp2)
            if resp1.get("deduped"):
                errors.append("First-ever capture was incorrectly marked as a duplicate.")
            if not resp2.get("deduped"):
                errors.append("Repeat capture with identical data was NOT deduplicated.")

            state = page3.evaluate("() => chrome.runtime.sendMessage({ type: 'MH_GET_STATE' })")
            total_tests = state["state"]["stats"]["totalTests"]
            print("totalTests after capture:", total_tests)
            if total_tests != 1:
                errors.append(f"Expected exactly 1 stored result after capture+dedup, got {total_tests}")
            page3.screenshot(path=os.path.join(ROOT, ".shots", "live-dashboard-after-capture.png"))
            page3.reload()
            page3.wait_for_timeout(800)
            page3.screenshot(path=os.path.join(ROOT, ".shots", "live-dashboard-after-capture-reloaded.png"))
            page3.close()

        context.close()

    if errors:
        print("\n--- ERRORS FOUND ---")
        for e in errors:
            print(" -", e)
        sys.exit(1)
    print("\nAll good - service worker registered, popup and dashboard loaded cleanly.")


if __name__ == "__main__":
    main()
