#!/usr/bin/env python3
"""Clicks around the built atlas with real mouse events and checks it responds.

    python3 -m http.server 8767          # from the repo root
    python3 docs/atlas/test-interactions.py

Real mouse events matter here: the canvas captures the pointer while dragging,
so a click arrives on the canvas rather than on the step under the cursor.
Synthetic events dispatched straight at an element hide that, and did once.

Checks: clicking a step selects it and lights its path, the dropdowns follow the
click, dragging pans without selecting, the wheel zooms, clicking an arrow opens
that transition, a screenshot opens and closes the lightbox, and the band
buttons switch journeys. Writes cdp-result.png and exits non-zero on failure.
"""
import asyncio, json, subprocess, sys, time, urllib.request, base64, os, tempfile

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8767/admin/atlas.html"
PORT = 9333

async def main():
    import websockets
    chrome = subprocess.Popen([
        "google-chrome", "--headless=new", "--no-sandbox", "--disable-gpu",
        f"--remote-debugging-port={PORT}", "--window-size=1900,1080",
        "--hide-scrollbars", "--user-data-dir=" + tempfile.mkdtemp(), URL],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ws_url = None
    for _ in range(60):
        try:
            tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
            page = [t for t in tabs if t["type"] == "page"]
            if page: ws_url = page[0]["webSocketDebuggerUrl"]; break
        except Exception: pass
        time.sleep(0.4)
    if not ws_url: print("could not reach chrome"); chrome.kill(); return 1

    fails = []
    async with websockets.connect(ws_url, max_size=200*1024*1024) as ws:
        i = 0
        async def send(method, params=None):
            nonlocal i
            i += 1
            await ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == i: return msg.get("result", {})

        async def ev(expr):
            r = await send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
            return r.get("result", {}).get("value")

        await send("Page.enable"); await send("Runtime.enable")
        await send("Page.addScriptToEvaluateOnNewDocument", {"source":
            "window.__errs=[];addEventListener('error',e=>__errs.push(e.message));"
            "addEventListener('unhandledrejection',e=>__errs.push('promise: '+e.reason));"})
        await send("Page.reload"); await asyncio.sleep(0.5)
        await asyncio.sleep(3.0)

        async def click_center_of(node_id, scroll=True):
            if scroll:
                # move the canvas so the step is on screen, the way a person would
                await ev(f"""(()=>{{const n=nodesById['{node_id}'], p=pos(n);
                  view.x = p.x + 104 - view.w/2; view.y = p.y - view.h/2 + 60; applyView();}})()""")
                await asyncio.sleep(0.25)
            box = await ev(f"""(()=>{{const e=document.getElementById('n-{node_id}');
              if(!e) return null; const r=e.getBoundingClientRect();
              const on = r.left>0 && r.right<innerWidth-420 && r.top>70 && r.bottom<innerHeight-40;
              return {{x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, on}};}})()""")
            if not box or box["w"] < 2 or not box["on"]: return None
            for t in ("mousePressed", "mouseReleased"):
                await send("Input.dispatchMouseEvent", {
                    "type": t, "x": box["x"], "y": box["y"], "button": "left",
                    "clickCount": 1, "buttons": 1 if t == "mousePressed" else 0})
                await asyncio.sleep(0.12)
            await asyncio.sleep(0.35)
            return True

        # 1. clicking a step selects it and switches the panel
        for node, expect in [("c_exhausted", "No rounds left"), ("c_free", "Reads the free PDF")]:
            if not await click_center_of(node): fails.append(f"{node}: not visible to click"); continue
            title = await ev("document.querySelector('#pane-detail h2')?.textContent || ''")
            tab = await ev("document.getElementById('t-detail').getAttribute('aria-selected')")
            lit = await ev(f"document.getElementById('n-{node}').classList.contains('active')")
            if expect not in (title or ""): fails.append(f"{node}: panel says {title!r}, expected {expect!r}")
            if tab != "true": fails.append(f"{node}: detail tab not selected")
            if not lit: fails.append(f"{node}: step not lit after click")

        # 2. clicking changed the dropdowns to a scenario that runs through it
        await click_center_of("c_exhausted")
        after = await ev("document.getElementById('c-after')?.value")
        if after != "revise_exhausted": fails.append(f"dropdown did not follow the click (after={after})")

        # 3. dragging pans and does NOT select
        before = await ev("document.getElementById('svg').getAttribute('viewBox')")
        await send("Input.dispatchMouseEvent", {"type":"mousePressed","x":700,"y":600,"button":"left","clickCount":1,"buttons":1})
        for dx in range(0, 260, 40):
            await send("Input.dispatchMouseEvent", {"type":"mouseMoved","x":700-dx,"y":600,"button":"left","buttons":1})
            await asyncio.sleep(0.03)
        await send("Input.dispatchMouseEvent", {"type":"mouseReleased","x":440,"y":600,"button":"left","clickCount":1,"buttons":0})
        await asyncio.sleep(0.3)
        moved = (await ev("document.getElementById('svg').getAttribute('viewBox')")) != before
        if not moved: fails.append("dragging did not pan the canvas")

        # 4. wheel zooms
        vb = await ev("document.getElementById('svg').getAttribute('viewBox')")
        await send("Input.dispatchMouseEvent", {"type":"mouseWheel","x":800,"y":500,"deltaX":0,"deltaY":-240})
        await asyncio.sleep(0.3)
        if (await ev("document.getElementById('svg').getAttribute('viewBox')")) == vb: fails.append("wheel did not zoom")

        # 5. clicking an arrow selects that transition
        await click_center_of("c_start")
        eid = await ev("""(()=>{const p=document.getElementById('eh-c5'); if(!p) return null;
          const r=p.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width};})()""")
        if eid and eid["w"] > 2:
            for t in ("mousePressed","mouseReleased"):
                await send("Input.dispatchMouseEvent", {"type":t,"x":eid["x"],"y":eid["y"],"button":"left","clickCount":1,"buttons":1 if t=="mousePressed" else 0})
                await asyncio.sleep(0.12)
            await asyncio.sleep(0.3)
            t2 = await ev("document.querySelector('#pane-detail h2')?.textContent || ''")
            if "→" not in t2: fails.append(f"clicking an arrow gave {t2!r}")

        # 6. a screenshot in the panel opens the lightbox
        await click_center_of("c_start")
        shot = await ev("""(()=>{const s=document.querySelector('#pane-detail .shot');
          if(!s) return null; const r=s.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};})()""")
        if shot:
            for t in ("mousePressed","mouseReleased"):
                await send("Input.dispatchMouseEvent", {"type":t,"x":shot["x"],"y":shot["y"],"button":"left","clickCount":1,"buttons":1 if t=="mousePressed" else 0})
                await asyncio.sleep(0.12)
            await asyncio.sleep(0.4)
            if await ev("document.getElementById('lightbox').hidden"): fails.append("clicking a screenshot did not open the lightbox")
            else:
                await send("Input.dispatchKeyEvent", {"type":"keyDown","key":"Escape","code":"Escape","windowsVirtualKeyCode":27})
                await send("Input.dispatchKeyEvent", {"type":"keyUp","key":"Escape","code":"Escape","windowsVirtualKeyCode":27})
                await asyncio.sleep(0.3)
                if not await ev("document.getElementById('lightbox').hidden"): fails.append("Escape did not close the lightbox")
        else:
            fails.append("no screenshot in the panel to click")

        # 7. every band button switches journeys, and a step in each one clicks
        for band, node, expect in [("member","m_signin_fail","Sign-in did not work"),
                                   ("analyst","a_fork","Builds on"),
                                   ("customer","c_edit","Edits the text")]:
            await ev(f"document.getElementById('bb-{band}').click()")
            await asyncio.sleep(0.4)
            if not await click_center_of(node):
                fails.append(f"{band}: {node} not clickable after switching band"); continue
            t3 = await ev("document.querySelector('#pane-detail h2')?.textContent || ''")
            if expect not in (t3 or ""): fails.append(f"{band}: clicking {node} gave {t3!r}")

        errs = await ev("window.__errs ? window.__errs.join(' | ') : ''")
        if errs: fails.append("page errors: " + errs)

        png = (await send("Page.captureScreenshot", {}))["data"]
        open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "cdp-result.png"), "wb").write(base64.b64decode(png))

    chrome.kill()
    print("FAILURES:" if fails else "all interaction checks passed")
    for f in fails: print("  -", f)
    return 1 if fails else 0

sys.exit(asyncio.run(main()))
