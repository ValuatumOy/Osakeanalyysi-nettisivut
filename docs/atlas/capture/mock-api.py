import json, http.server, os, sys
from urllib.parse import urlparse, parse_qs
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'..','..','..'))
PDF='https://files.aiequityreports.com/reports/pdfs/StoraEnsoOyj_01092026_2.pdf'
def order(status, used=0, allowed=2, history=None, err=None):
    o={'status':status,'companyName':'Stora Enso Oyj','ticker':'STERV','revisionsAllowed':allowed,'revisionsUsed':used}
    if status=='DELIVERED': o['pdfUrl']=PDF; o['editable']=True; o['currentVersion']=len(history) if history else 1
    if history: o['revisionHistory']=history
    if err: o['revisionError']=err
    return o
HIST=[{'version':2,'completedAt':'2026-09-01T10:12:00Z','pdfUrl':PDF,'comments':'Please raise the 2027 EBITDA margin assumption to 14% — the new pulp mill ramp-up should be reflected.','changes':{'headline':{'targetPrice':{'before':14.2,'after':15.1,'currency':'EUR'},'rating':{'before':'HOLD','after':'BUY'}},'differences':{'summary':'The 2027 EBITDA margin was lifted from 12.5% to 14.0%, flowing through to a higher target price.','items':[{'area':'Forecasts','what':'2027E EBITDA +€180m; margin 12.5% → 14.0%.'},{'area':'Valuation','what':'Target price €14.20 → €15.10.'}],'unchanged':'Revenue growth, capex and dividend assumptions.'}}},{'original':True,'completedAt':'2026-09-01T09:40:00Z','pdfUrl':PDF}]
# A version the customer wrote by hand: the paragraph before and after, and
# what the engine noticed about it.
EDIT_HIST=[{'version':2,'kind':'edit','authorship':'analyst','editedBy':'Maria Lindqvist','editedFrom':1,'completedAt':'2026-09-01T10:03:00Z','pdfUrl':PDF,
  'edits':[{'pointer':'investmentThesis/prose/1','before':'The new Oulu pulp mill should reach full capacity during 2027, which we expect to lift group EBITDA margin towards 13%.','after':'The new Oulu pulp mill should reach full capacity during 2027. Management guided for a margin of about 14% at the Q2 call, which we now adopt.'},
           {'pointer':'risks/prose/0','before':'Pulp prices remain the largest single swing factor for earnings.','after':'Pulp prices remain the largest single swing factor for earnings, and the 2026 Chinese import tariff adds a second one.'}],
  'editWarnings':{'changedNumbers':{'investmentThesis/prose/1':{'retained':False,'added':['14%']}}},'fit':{'pages':[]}},
 {'original':True,'completedAt':'2026-09-01T09:40:00Z','pdfUrl':PDF}]
# What the engine shows in the editor: the report as it will print, every
# editable paragraph marked with data-pointer. A short stand-in for the real
# ~1.6 MB document.
PREVIEW='''<!doctype html><html><head><meta charset="utf-8"><style>
body{font:15px/1.55 Georgia,serif;color:#1a2420;margin:0;padding:40px 56px;max-width:820px}
h1{font:600 26px system-ui,sans-serif;margin:0 0 4px}.k{color:#5b6b64;font:13px system-ui,sans-serif;margin-bottom:28px}
h2{font:600 15px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:#22705a;margin:28px 0 8px}
table{border-collapse:collapse;font:13px system-ui,sans-serif;margin:8px 0 4px}td,th{border-bottom:1px solid #dde;padding:4px 12px 4px 0;text-align:right}th:first-child,td:first-child{text-align:left}
</style></head><body>
<h1 data-pointer="chrome:title">Stora Enso Oyj — AI Equity Report</h1>
<div class="k">STERV.HE · 1 September 2026 · Rating HOLD · Target €15.10</div>
<h2>Investment thesis</h2>
<p data-pointer="investmentThesis/prose/0">Stora Enso is midway through a shift from paper towards packaging and wood products, and the balance sheet has room for the remaining capex. We see the shares as fairly valued at current pulp prices.</p>
<p data-pointer="investmentThesis/prose/1">The new Oulu pulp mill should reach full capacity during 2027, which we expect to lift group EBITDA margin towards 13%.</p>
<h2>Key figures</h2>
<table data-derived="1"><tr><th>EURm</th><th>2025</th><th>2026E</th><th>2027E</th></tr><tr><td>Revenue</td><td>9,050</td><td>9,320</td><td>9,700</td></tr><tr><td>EBITDA</td><td>1,010</td><td>1,150</td><td>1,260</td></tr><tr><td>EBITDA margin</td><td>11.2%</td><td>12.3%</td><td>13.0%</td></tr></table>
<h2>Risks</h2>
<p data-pointer="risks/prose/0">Pulp prices remain the largest single swing factor for earnings.</p>
<p data-pointer="risks/prose/1">The packaging ramp-up depends on European consumer demand recovering, which has been slower than we assumed a year ago.</p>
</body></html>'''
ORDERS={
 'prog':order('RENDERING'),
 'deliv':order('DELIVERED'),
 'revising':order('REVISING',used=0),
 'revised':order('DELIVERED',used=1,history=HIST),
 'exhausted':order('DELIVERED',used=2,history=HIST),
 'failed':{'status':'FAILED'},
 'edited':order('DELIVERED',used=0,history=EDIT_HIST),
 'revfail':order('DELIVERED',used=0,err='The revision could not be generated. Your round has not been used — please try again.'),
}
LINKS={
 'ready':{'type':'existing','reportName':'Stora Enso Oyj','ticker':'STERV','reportDate':'1 Sep 2026','downloadUrl':PDF,'email':'buyer@example.com','orderUrl':None},
 'readyrev':{'type':'existing','reportName':'Stora Enso Oyj','ticker':'STERV','reportDate':'1 Sep 2026','downloadUrl':PDF,'email':'buyer@example.com','orderUrl':'/order/index.html?session_id=deliv'},
 'fresh':{'type':'fresh','company':'Stora Enso Oyj','email':'buyer@example.com','orderUrl':'/order/index.html?session_id=prog'},
 'freerev':{'type':'existing','reportName':'Stora Enso Oyj','ticker':'STERV','reportDate':'1 Sep 2026','downloadUrl':PDF,'email':'buyer@example.com','orderUrl':'/order/index.html?session_id=deliv','revisionsOnly':True,'revisionsAllowed':3},
 'freshnorev':{'type':'fresh','company':'Stora Enso Oyj','email':'buyer@example.com','orderUrl':None},
}
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s,*a,**k): super().__init__(*a,directory=ROOT,**k)
    def log_message(s,*a): pass
    def do_GET(s):
        u=urlparse(s.path); q=parse_qs(u.query); sid=(q.get('session_id') or [''])[0]
        if u.path=='/api/order-status' and q.get('preview'):
            b=PREVIEW.encode(); s.send_response(200); s.send_header('Content-Type','text/html; charset=utf-8'); s.send_header('Content-Length',len(b)); s.end_headers(); s.wfile.write(b); return
        if u.path=='/api/order-status': return s.j(ORDERS.get(sid,{'error':'nf'}), 200 if sid in ORDERS else 404)
        if u.path=='/api/get-report-link': return s.j(LINKS.get(sid,{'error':'nf'}), 200 if sid in LINKS else 404)
        if u.path=='/api/pricing': return s.j({'reportPriceEur':20,'freshPriceEur':20})
        if u.path=='/api/reports': return s.j([])
        return super().do_GET()
    def j(s,obj,code=200):
        b=json.dumps(obj).encode(); s.send_response(code); s.send_header('Content-Type','application/json'); s.send_header('Content-Length',len(b)); s.end_headers(); s.wfile.write(b)
http.server.ThreadingHTTPServer(('127.0.0.1',8765),H).serve_forever()
