import json, http.server, os, sys
from urllib.parse import urlparse, parse_qs
ROOT='/home/niklas/repos/Osakeanalyysi-nettisivut'
PDF='https://files.aiequityreports.com/reports/pdfs/StoraEnsoOyj_01092026_2.pdf'
def order(status, used=0, allowed=2, history=None, err=None):
    o={'status':status,'companyName':'Stora Enso Oyj','ticker':'STERV','revisionsAllowed':allowed,'revisionsUsed':used}
    if status=='DELIVERED': o['pdfUrl']=PDF
    if history: o['revisionHistory']=history
    if err: o['revisionError']=err
    return o
HIST=[{'version':2,'completedAt':'2026-09-01T10:12:00Z','pdfUrl':PDF,'comments':'Please raise the 2027 EBITDA margin assumption to 14% — the new pulp mill ramp-up should be reflected.','changes':{'headline':{'targetPrice':{'before':14.2,'after':15.1,'currency':'EUR'},'rating':{'before':'HOLD','after':'BUY'}},'differences':{'summary':'The 2027 EBITDA margin was lifted from 12.5% to 14.0%, flowing through to a higher target price.','items':[{'area':'Forecasts','what':'2027E EBITDA +€180m; margin 12.5% → 14.0%.'},{'area':'Valuation','what':'Target price €14.20 → €15.10.'}],'unchanged':'Revenue growth, capex and dividend assumptions.'}}},{'original':True,'completedAt':'2026-09-01T09:40:00Z','pdfUrl':PDF}]
ORDERS={
 'prog':order('RENDERING'),
 'deliv':order('DELIVERED'),
 'revising':order('REVISING',used=0),
 'revised':order('DELIVERED',used=1,history=HIST),
 'exhausted':order('DELIVERED',used=2,history=HIST),
 'failed':{'status':'FAILED'},
 'revfail':order('DELIVERED',used=0,err='The revision could not be generated. Your round has not been used — please try again.'),
}
LINKS={
 'ready':{'type':'existing','reportName':'Stora Enso Oyj','ticker':'STERV','reportDate':'1 Sep 2026','downloadUrl':PDF,'email':'buyer@example.com','orderUrl':None},
 'readyrev':{'type':'existing','reportName':'Stora Enso Oyj','ticker':'STERV','reportDate':'1 Sep 2026','downloadUrl':PDF,'email':'buyer@example.com','orderUrl':'/order/index.html?session_id=deliv'},
 'fresh':{'type':'fresh','company':'Stora Enso Oyj','email':'buyer@example.com','orderUrl':'/order/index.html?session_id=prog'},
 'freshnorev':{'type':'fresh','company':'Stora Enso Oyj','email':'buyer@example.com','orderUrl':None},
}
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s,*a,**k): super().__init__(*a,directory=ROOT,**k)
    def log_message(s,*a): pass
    def do_GET(s):
        u=urlparse(s.path); q=parse_qs(u.query); sid=(q.get('session_id') or [''])[0]
        if u.path=='/api/order-status': return s.j(ORDERS.get(sid,{'error':'nf'}), 200 if sid in ORDERS else 404)
        if u.path=='/api/get-report-link': return s.j(LINKS.get(sid,{'error':'nf'}), 200 if sid in LINKS else 404)
        if u.path=='/api/pricing': return s.j({'reportPriceEur':20,'freshPriceEur':20})
        if u.path=='/api/reports': return s.j([])
        return super().do_GET()
    def j(s,obj,code=200):
        b=json.dumps(obj).encode(); s.send_response(code); s.send_header('Content-Type','application/json'); s.send_header('Content-Length',len(b)); s.end_headers(); s.wfile.write(b)
http.server.ThreadingHTTPServer(('127.0.0.1',8765),H).serve_forever()
