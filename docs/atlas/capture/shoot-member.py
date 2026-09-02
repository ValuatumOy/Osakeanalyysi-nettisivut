# Renders members.html once per role against the mocked sign-in in
# member-mock.html, then cuts each section out using the coordinates the
# page reports in its data-rects attribute.
#   python3 shoot-member.py <sub|analyst|noplan> <output dir>
import subprocess, json, html, sys, os, re
S=os.path.dirname(os.path.abspath(__file__))
from PIL import Image
def rects(variant):
    dom=subprocess.run(['google-chrome','--headless=new','--no-sandbox','--disable-gpu',
        '--hide-scrollbars','--window-size=1280,900','--virtual-time-budget=9000','--dump-dom',
        f'http://127.0.0.1:8766/member-mock.html?variant={variant}'],capture_output=True,text=True).stdout
    m=re.search(r'data-rects="([^"]*)"',dom)
    return json.loads(html.unescape(m.group(1)))
def shot(variant,path,h):
    subprocess.run(['google-chrome','--headless=new','--no-sandbox','--disable-gpu',
        '--hide-scrollbars',f'--window-size=1280,{h}','--virtual-time-budget=9000',
        f'--screenshot={path}',f'http://127.0.0.1:8766/member-mock.html?variant={variant}'],
        capture_output=True)
variant=sys.argv[1]
OUT=sys.argv[2] if len(sys.argv)>2 else S
r=rects(variant)
print(variant, json.dumps(r))
full=os.path.join(OUT,f'full-{variant}.png')
shot(variant, full, min(r['__page'][3]+40, 15000))
img=Image.open(full)
print('full size', img.size)
for name,(x,y,w,hh) in r.items():
    if name=='__page': continue
    box=(0,max(0,y-16),1280,min(img.size[1],y+hh+16))
    img.crop(box).save(os.path.join(OUT,f'crop-{variant}-{name}.png'))
