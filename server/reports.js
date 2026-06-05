// Report catalog — add new reports here as they're published.
// pdfUrl: the public URL on files.valuatum.com after upload.

const REPORTS_BASE = 'https://files.valuatum.com/reports/pdfs';

const REPORT_CATALOG = {
  'tesla-01062026': {
    name: 'Tesla, Inc.',
    ticker: 'TSLA',
    exchange: 'NASDAQ',
    reportDate: '1 June 2026',
    pdfUrl: `${REPORTS_BASE}/Tesla_01062026.pdf`,
  },
  'storaenso-01062026': {
    name: 'Stora Enso Oyj',
    ticker: 'STERV.HE',
    exchange: 'Helsinki',
    reportDate: '1 June 2026',
    pdfUrl: `${REPORTS_BASE}/StoraEnso_01062026.pdf`,
  },
  'oriola-01062026': {
    name: 'Oriola Oyj',
    ticker: 'ORIH.HE',
    exchange: 'Helsinki',
    reportDate: '1 June 2026',
    pdfUrl: `${REPORTS_BASE}/Oriola_01062026.pdf`,
  },
  'nuholdings-02062026': {
    name: 'Nu Holdings Ltd.',
    ticker: 'NU',
    exchange: 'NYSE',
    reportDate: '2 June 2026',
    pdfUrl: `${REPORTS_BASE}/NuHoldings_02062026.pdf`,
  },
  'recursion-02062026': {
    name: 'Recursion Pharmaceuticals',
    ticker: 'RXRX',
    exchange: 'NASDAQ',
    reportDate: '2 June 2026',
    pdfUrl: `${REPORTS_BASE}/RecursionPharmaceuticals_02062026.pdf`,
  },
};

module.exports = { REPORT_CATALOG };
