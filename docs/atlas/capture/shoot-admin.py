# Renders admin-mock.html once per tab against the stubbed sign-in, sizing the
# window from the page height the mock reports in its data-rects attribute.
#   python3 shoot-admin.py <out.png> <url>
import subprocess, json, html, sys, os, re
from PIL import Image

def dom(url):
    return subprocess.run(['google-chrome', '--headless=new', '--no-sandbox', '--disable-gpu',
        '--hide-scrollbars', '--window-size=1280,900', '--virtual-time-budget=9000', '--dump-dom',
        url], capture_output=True, text=True).stdout

def shot(url, path, h):
    subprocess.run(['google-chrome', '--headless=new', '--no-sandbox', '--disable-gpu',
        '--hide-scrollbars', f'--window-size=1280,{h}', '--virtual-time-budget=9000',
        f'--screenshot={path}', url], capture_output=True)

out, url = sys.argv[1], sys.argv[2]
d = dom(url)
m = re.search(r'data-rects="([^"]*)"', d)
h = 1400
if m:
    h = min(json.loads(html.unescape(m.group(1)))['__page'][3] + 20, 6000)
else:
    print('  ! no data-rects for', url)
shot(url, out, h)
print(out, Image.open(out).size)
