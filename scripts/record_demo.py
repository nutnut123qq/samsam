"""Quay video demo <=3 phut: chat RAG + Content Studio guardrail.

Chay khi app dang mo (python demo.py / streamlit run ...):
    .venv/Scripts/python.exe scripts/record_demo.py
Output: evidence/demo.webm (convert mp4 bang ffmpeg neu co).
"""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "evidence" / "demo_video"
URL = "http://localhost:8501"

OUT.mkdir(parents=True, exist_ok=True)


def pause(page, ms=1800):
    page.wait_for_timeout(ms)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    ctx = browser.new_context(
        record_video_dir=str(OUT), record_video_size={"width": 1280,
                                                      "height": 800},
        viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    page.goto(URL)
    page.wait_for_selector("text=Chat Sâm Sâm", timeout=20000)
    pause(page)

    # --- 1. Chat RAG: hoi gia -> tra loi kem nguon
    box = page.locator('[data-testid="stChatInputTextArea"]')
    box.fill("Saphraton giá bao nhiêu?")
    box.press("Enter")
    page.wait_for_selector("text=Nguồn:", timeout=60000)
    pause(page, 4000)

    # --- 2. Content Studio: brief -> draft qua guardrail (PASS)
    page.get_by_role("tab", name="Content Studio").click()
    pause(page, 1200)
    brief = page.get_by_role("textbox", name="Brief")
    brief.fill("Viết bài Facebook giới thiệu Sapentol cho người tiểu "
               "đường, nhấn công dụng đã công bố")
    brief.press("Control+Enter")
    pause(page, 800)
    page.get_by_test_id("stBaseButton-primary").click()
    page.wait_for_selector("text=Guardrail:", timeout=120000)
    pause(page, 4000)

    # --- 3. Check text vi pham -> flag do
    txt = page.get_by_role("textbox", name="Text cần check")
    txt.fill("Saphraton chữa khỏi tiểu đường, là thuốc đặc trị giúp "
             "điều trị bệnh hiệu quả nhất")
    txt.press("Control+Enter")
    pause(page, 800)
    page.get_by_test_id("stBaseButton-secondary").click()
    page.wait_for_selector("text=banned_word", timeout=15000)
    pause(page, 4000)

    ctx.close()
    browser.close()

vids = list(OUT.glob("*.webm"))
if not vids:
    sys.exit("[record] khong thay video output")
print("[record] video:", vids[0])
