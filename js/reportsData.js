// Report catalog fallback.
// The reports page lists companies that have both a company page and a ready PDF report.

var REPORTS_CATALOG = [
  {
    "slug": "nvidia-equity-report",
    "companyName": "NVIDIA",
    "ticker": "NVDA",
    "exchange": "NASDAQ",
    "country": "US",
    "sector": "Technology",
    "reportDate": "2026-07-13",
    "reportDateLabel": "13 July 2026",
    "fileName": "Nvidia_13072026.pdf",
    "pdfUrl": "reports/pdfs/Nvidia_13072026.pdf",
    "description": "Free AI equity report on NVIDIA's accelerated computing, data center AI platform, GPU ecosystem, valuation assumptions, risks, catalysts, and financial outlook.",
    "tags": [
      "Free Report",
      "AI Equity Report",
      "AI Infrastructure",
      "PDF"
    ],
    "id": "nvidia-13072026",
    "reportType": "free",
    "availability": "available",
    "price": 0,
    "priceLabel": "Free report",
    "creditCost": 0,
    "isFree": true
  },
  {
    "id": "intel-05062026",
    "slug": "intel-equity-report",
    "companyName": "Intel",
    "ticker": "INTC",
    "exchange": "NASDAQ",
    "country": "US",
    "sector": "Technology",
    "reportDate": "2026-07-13",
    "fileName": "Intel_13072026.pdf",
    "pdfUrl": "reports/pdfs/Intel_13072026.pdf",
    "reportType": "free",
    "availability": "available",
    "price": 0,
    "priceLabel": "Free report",
    "isFree": true,
    "description": "Free AI equity report on Intel's client, data center, foundry, manufacturing strategy, valuation assumptions, risks, catalysts, and financial outlook.",
    "tags": [
      "Free Report",
      "AI Equity Report",
      "Semiconductors",
      "PDF"
    ],
    "reportDateLabel": "13 July 2026",
    "creditCost": 0
  },
  {
    "id": "kesko-05062026",
    "slug": "kesko-equity-report",
    "companyName": "Kesko",
    "ticker": "KESKOB.HE",
    "exchange": "Helsinki",
    "country": "FI",
    "sector": "Consumer Staples",
    "reportDate": "2026-07-14",
    "fileName": "Kesko_14072026.pdf",
    "pdfUrl": "reports/pdfs/Kesko_14072026.pdf",
    "reportType": "free",
    "availability": "available",
    "price": 0,
    "priceLabel": "Free report",
    "isFree": true,
    "description": "Free AI equity report on Kesko's grocery, building and technical trade businesses, valuation assumptions, risks, catalysts, and financial outlook.",
    "tags": [
      "Free Report",
      "AI Equity Report",
      "Nordic",
      "PDF"
    ],
    "reportDateLabel": "14 July 2026",
    "creditCost": 0
  },
  {
    "id": "amd-05062026",
    "slug": "advanced-micro-devices-equity-report",
    "companyName": "Advanced Micro Devices",
    "ticker": "AMD",
    "exchange": "NASDAQ",
    "country": "US",
    "sector": "Technology",
    "reportDate": "2026-06-05",
    "fileName": "AMD.pdf",
    "pdfUrl": "reports/pdfs/AMD.pdf",
    "reportType": "existing",
    "availability": "available",
    "price": 20,
    "priceLabel": "Ready report",
    "isFree": false,
    "description": "Advanced Micro Devices (AMD) stock analysis and AI equity report covering valuation, segment value analysis, reverse valuation, financials, risks and catalysts.",
    "tags": [
      "AI Equity Report",
      "Semiconductors",
      "Ready Report",
      "PDF"
    ]
  },
  {
    "id": "nokia-05062026",
    "slug": "nokia-equity-report",
    "companyName": "Nokia",
    "ticker": "NOKIA.HE",
    "exchange": "Helsinki",
    "country": "FI",
    "sector": "Technology",
    "reportDate": "2026-06-05",
    "fileName": "Nokia.pdf",
    "pdfUrl": "reports/pdfs/Nokia.pdf",
    "reportType": "existing",
    "availability": "available",
    "price": 20,
    "priceLabel": "Ready report",
    "isFree": false,
    "description": "Nokia (NOKIA.HE) stock analysis and AI equity report covering valuation, segment value analysis, reverse valuation, financials, risks and catalysts.",
    "tags": [
      "AI Equity Report",
      "Nordic",
      "Ready Report",
      "PDF"
    ]
  },
  {
    "id": "recursion-02062026",
    "slug": "recursion-pharmaceuticals-equity-report",
    "companyName": "Recursion Pharmaceuticals",
    "ticker": "RXRX",
    "exchange": "NASDAQ",
    "country": "US",
    "sector": "Health Care",
    "reportDate": "2026-06-02",
    "fileName": "RecursionPharmaceuticals_02062026.pdf",
    "pdfUrl": "reports/pdfs/RecursionPharmaceuticals_02062026.pdf",
    "reportType": "existing",
    "availability": "available",
    "price": 20,
    "priceLabel": "Ready report",
    "isFree": false,
    "description": "Recursion Pharmaceuticals (RXRX) stock analysis and AI equity report covering valuation, segment value analysis, reverse valuation, financials, risks and catalysts.",
    "tags": [
      "AI Equity Report",
      "Biotech",
      "Ready Report",
      "PDF"
    ]
  },
  {
    "id": "storaenso-03072026",
    "slug": "stora-enso-equity-report",
    "companyName": "Stora Enso",
    "ticker": "STERV.HE",
    "exchange": "Helsinki",
    "country": "FI",
    "sector": "Materials",
    "reportDate": "2026-07-03",
    "fileName": "StoraEnso_03072026.pdf",
    "pdfUrl": "reports/pdfs/StoraEnso_03072026.pdf",
    "reportType": "existing",
    "availability": "available",
    "price": 20,
    "priceLabel": "Ready report",
    "isFree": false,
    "description": "Stora Enso (STERV.HE) financial overview and AI equity report covering revenue, EBIT, net earnings, book value, share price and market capitalisation.",
    "tags": [
      "AI Equity Report",
      "Nordic",
      "Materials",
      "PDF"
    ]
  },
  {
    "id": "tesla-01062026",
    "slug": "tesla-equity-report",
    "companyName": "Tesla",
    "ticker": "TSLA",
    "exchange": "NASDAQ",
    "country": "US",
    "sector": "Consumer Discretionary",
    "reportDate": "2026-06-01",
    "fileName": "Tesla_01062026.pdf",
    "pdfUrl": "reports/pdfs/Tesla_01062026.pdf",
    "reportType": "existing",
    "availability": "available",
    "price": 20,
    "priceLabel": "Ready report",
    "isFree": false,
    "description": "Tesla (TSLA) financial overview and AI equity report covering revenue, EBIT, net earnings, book value, share price and market capitalisation.",
    "tags": [
      "AI Equity Report",
      "EV",
      "Ready Report",
      "PDF"
    ]
  },
  {
    "id": "oriola-01062026",
    "slug": "oriola-equity-report",
    "companyName": "Oriola",
    "ticker": "ORIOLA.HE",
    "exchange": "Helsinki",
    "country": "FI",
    "sector": "Health Care",
    "reportDate": "2026-06-01",
    "fileName": "Oriola_01062026.pdf",
    "pdfUrl": "reports/pdfs/Oriola_01062026.pdf",
    "reportType": "existing",
    "availability": "available",
    "price": 20,
    "priceLabel": "Ready report",
    "isFree": false,
    "description": "Oriola (ORIOLA.HE) financial overview and AI equity report covering revenue, EBIT, net earnings, book value, share price and market capitalisation.",
    "tags": [
      "AI Equity Report",
      "Nordic",
      "Health Care",
      "PDF"
    ]
  },
  {
    "id": "wartsila-05062026",
    "slug": "wartsila-equity-report",
    "companyName": "Wärtsilä Oyj Abp",
    "ticker": "WRT1V.HE",
    "exchange": "Helsinki",
    "country": "FI",
    "sector": "Industrials",
    "reportDate": "2026-06-05",
    "fileName": "Wärtsilä.pdf",
    "pdfUrl": "reports/pdfs/Wärtsilä.pdf",
    "reportType": "existing",
    "availability": "available",
    "price": 20,
    "priceLabel": "Ready report",
    "isFree": false,
    "description": "Wärtsilä Oyj Abp (WRT1V.HE) stock analysis and AI equity report covering valuation, segment value analysis, reverse valuation, financials, risks and catalysts.",
    "tags": [
      "AI Equity Report",
      "Nordic",
      "Industrials",
      "PDF"
    ]
  }
];

var PAYMENT_CONFIG = { mode: "stripe", currency: "EUR", currencySymbol: "€", readyReportPrice: 20, freshReportPrice: 50 };

function getReportAgeDays(reportDate) {
  const now = new Date();
  const rd = new Date(reportDate);
  return Math.floor((now - rd) / (1000 * 60 * 60 * 24));
}

function getReportAgeLabel(reportDate) {
  const days = getReportAgeDays(reportDate);
  if (days === 0) return "Generated today";
  if (days === 1) return "Generated yesterday";
  if (days < 7) return `Generated ${days} days ago`;
  if (days < 14) return "Generated 1 week ago";
  if (days < 30) return `Generated ${Math.floor(days / 7)} weeks ago`;
  return `Generated ${Math.floor(days / 30)} month${Math.floor(days / 30) > 1 ? "s" : ""} ago`;
}

function formatReportDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

if (typeof module !== "undefined") {
  module.exports = { REPORTS_CATALOG, PAYMENT_CONFIG, getReportAgeDays, getReportAgeLabel, formatReportDate };
}
