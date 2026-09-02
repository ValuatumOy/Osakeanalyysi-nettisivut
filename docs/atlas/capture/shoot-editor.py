# Two order-page states a plain screenshot cannot reach, driven over the
# DevTools protocol:
#   python3 shoot-editor.py editor  <out.png> <url>   the text editor open, one paragraph changed
#   python3 shoot-editor.py history <out.png> <url>   the version history, scrolled into view
import asyncio, json, subprocess, sys, time, urllib.request, base64, tempfile
mode, out, url = sys.argv[1], sys.argv[2], sys.argv[3]
PORT = 9334

async def main():
    import websockets
    chrome = subprocess.Popen(['google-chrome', '--headless=new', '--no-sandbox', '--disable-gpu',
        f'--remote-debugging-port={PORT}', '--window-size=1280,1150', '--hide-scrollbars',
        '--user-data-dir=' + tempfile.mkdtemp(), url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ws_url = None
    for _ in range(60):
        try:
            page = [t for t in json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json')) if t['type'] == 'page']
            if page: ws_url = page[0]['webSocketDebuggerUrl']; break
        except Exception: pass
        time.sleep(0.4)
    async with websockets.connect(ws_url, max_size=64*1024*1024) as ws:
        i = 0
        async def send(method, params=None):
            nonlocal i; i += 1
            await ws.send(json.dumps({'id': i, 'method': method, 'params': params or {}}))
            while True:
                m = json.loads(await ws.recv())
                if m.get('id') == i: return m.get('result', {})
        async def ev(expr):
            r = await send('Runtime.evaluate', {'expression': expr, 'returnByValue': True})
            return r.get('result', {}).get('value')
        async def scroll_to(selector, offset=90):
            await ev(f"window.scrollTo(0, document.querySelector('{selector}').getBoundingClientRect().top + window.scrollY - {offset})")
            await asyncio.sleep(0.4)

        await send('Runtime.enable'); await asyncio.sleep(3)
        if mode == 'editor':
            await ev("document.getElementById('editOpenBtn').click()")
            await asyncio.sleep(3)
            await scroll_to('#editorBox')
            # The report sits in a sandboxed frame the page cannot script, so
            # the edit is made the way a person makes it: click the second
            # paragraph, Ctrl+End to the end of it, type.
            box = await ev("(function(){var r=document.querySelector('#editorFrameWrap iframe').getBoundingClientRect();return [r.left,r.top,r.width]})()")
            scale = box[2] / 1280
            x, y = box[0] + 300 * scale, box[1] + 385 * scale
            for t in ('mousePressed', 'mouseReleased'):
                await send('Input.dispatchMouseEvent', {'type': t, 'x': x, 'y': y, 'button': 'left', 'clickCount': 1})
            await asyncio.sleep(0.3)
            await send('Input.dispatchKeyEvent', {'type': 'keyDown', 'key': 'End', 'code': 'End', 'windowsVirtualKeyCode': 35, 'modifiers': 2})
            await send('Input.dispatchKeyEvent', {'type': 'keyUp', 'key': 'End', 'code': 'End', 'windowsVirtualKeyCode': 35, 'modifiers': 2})
            await send('Input.insertText', {'text': ' Management guided for about 14% at the Q2 call, which we now adopt.'})
            await asyncio.sleep(0.8)
        else:
            await scroll_to('.revision-history', 40)
        r = await send('Page.captureScreenshot', {'format': 'png'})
        open(out, 'wb').write(base64.b64decode(r['data']))
    chrome.kill()
    print(out)

asyncio.run(main())
