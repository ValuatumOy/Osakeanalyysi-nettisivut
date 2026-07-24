// Report catalog fallback.
// The reports page lists companies that have both a company page and a ready PDF report.

var REPORTS_CATALOG = [
  {
    "id": "upm-21052026",
    "companyName": "UPM-Kymmene Oyj",
    "name": "UPM-Kymmene Oyj",
    "ticker": "UPM.HE",
    "exchange": "Helsinki",
    "country": "FI",
    "sector": "Materials",
    "reportDate": "2026-07-24",
    "reportDateLabel": "24 July 2026",
    "uploadedAt": "2026-06-08T06:39:57.000Z",
    "fileName": "UPM_24072026.pdf",
    "pdfUrl": "reports/pdfs/UPM_24072026.pdf",
    "reportType": "free",
    "availability": "available",
    "price": 0,
    "priceLabel": "Free report",
    "creditCost": 0,
    "isFree": true,
    "description": "Free AI equity report on UPM's pulp, forestry, energy, paper and bio-based materials businesses, valuation assumptions, risks, catalysts, and financial outlook.",
    "tags": [
      "Free Report",
      "AI Equity Report",
      "Nordic",
      "Materials",
      "PDF"
    ],
    "slug": "upm-equity-report"
  },
  {
    "id": "storaenso-01062026",
    "companyName": "Stora Enso Oyj",
    "name": "Stora Enso Oyj",
    "ticker": "STERV.HE",
    "exchange": "Helsinki",
    "country": "FI",
    "sector": "Materials",
    "reportDate": "2026-07-24",
    "reportDateLabel": "24 July 2026",
    "uploadedAt": "2026-06-05T08:49:15.899Z",
    "fileName": "StoraEnso_24072026.pdf",
    "pdfUrl": "reports/pdfs/StoraEnso_24072026.pdf",
    "reportType": "free",
    "availability": "available",
    "price": 0,
    "priceLabel": "Free report",
    "creditCost": 0,
    "isFree": true,
    "description": "Free AI equity report on Stora Enso's packaging, biomaterials, forest assets, valuation assumptions, risks, catalysts, and financial outlook.",
    "tags": [
      "Free Report",
      "AI Equity Report",
      "Nordic",
      "Materials",
      "PDF"
    ],
    "slug": "stora-enso-equity-report"
  },
  {
    "id": "tesla-01062026",
    "companyName": "Tesla, Inc.",
    "name": "Tesla, Inc.",
    "ticker": "TSLA",
    "exchange": "NASDAQ",
    "country": "US",
    "sector": "Consumer Discretionary",
    "reportDate": "2026-07-23",
    "reportDateLabel": "23 July 2026",
    "uploadedAt": "2026-06-05T08:49:15.443Z",
    "fileName": "Tesla_23072026.pdf",
    "pdfUrl": "reports/pdfs/Tesla_23072026.pdf",
    "reportType": "free",
    "availability": "available",
    "price": 0,
    "priceLabel": "Free report",
    "creditCost": 0,
    "isFree": true,
    "description": "Free AI equity report on Tesla's electric vehicle, energy storage, autonomy, robotics, valuation assumptions, risks, catalysts, and financial outlook.",
    "tags": [
      "Free Report",
      "AI Equity Report",
      "EV",
      "Reverse Valuation",
      "PDF"
    ],
    "slug": "tesla-equity-report"
  },
  {
    "companyName": "NVIDIA",
    "name": "NVIDIA Corporation",
    "slug": "nvidia-equity-report",
    "ticker": "NVDA",
    "exchange": "NASDAQ",
    "country": "US",
    "sector": "Technology",
    "reportDate": "2026-07-16",
    "reportDateLabel": "16 July 2026",
    "fileName": "Nvidia_16072026.pdf",
    "pdfUrl": "reports/pdfs/Nvidia_16072026.pdf",
    "description": "AI equity report on NVIDIA's accelerated computing, data center AI platform, GPU ecosystem, valuation assumptions, risks, catalysts, and financial outlook.",
    "tags": [
      "AI Equity Report",
      "AI Infrastructure",
      "Ready Report",
      "PDF"
    ],
    "id": "nvidia-13072026",
    "reportType": "existing",
    "availability": "available",
    "price": 20,
    "priceLabel": "Ready report",
    "creditCost": 2,
    "isFree": false
  },
  {
    "companyName": "Intel",
    "name": "Intel Corporation",
    "id": "intel-05062026",
    "ticker": "INTC",
    "exchange": "NASDAQ",
    "country": "US",
    "sector": "Technology",
    "reportDate": "2026-07-16",
    "reportDateLabel": "16 July 2026",
    "uploadedAt": "2026-06-05T12:49:51.463Z",
    "fileName": "Intel_16072026.pdf",
    "pdfUrl": "reports/pdfs/Intel_16072026.pdf",
    "reportType": "existing",
    "availability": "available",
    "price": 20,
    "priceLabel": "Ready report",
    "creditCost": 2,
    "isFree": false,
    "description": "AI equity report on Intel's client, data center, foundry, manufacturing strategy, valuation assumptions, risks, catalysts, and financial outlook.",
    "tags": [
      "AI Equity Report",
      "Semiconductors",
      "Ready Report",
      "PDF"
    ],
    "slug": "intel-equity-report"
  },
  {
    "companyName": "Kesko",
    "name": "Kesko Oyj",
    "id": "kesko-05062026",
    "ticker": "KESKOB.HE",
    "exchange": "Helsinki",
    "country": "FI",
    "sector": "Consumer Staples",
    "reportDate": "2026-07-16",
    "reportDateLabel": "16 July 2026",
    "uploadedAt": "2026-06-05T12:49:54.363Z",
    "fileName": "Kesko_16072026.pdf",
    "pdfUrl": "reports/pdfs/Kesko_16072026.pdf",
    "reportType": "existing",
    "availability": "available",
    "price": 20,
    "priceLabel": "Ready report",
    "creditCost": 2,
    "isFree": false,
    "description": "AI equity report on Kesko's grocery, building and technical trade businesses, valuation assumptions, risks, catalysts, and financial outlook.",
    "tags": [
      "AI Equity Report",
      "Nordic",
      "Ready Report",
      "PDF"
    ],
    "slug": "kesko-equity-report"
  },
  {
    "id": "amd-05062026",
    "companyName": "Advanced Micro Devices, Inc.",
    "name": "Advanced Micro Devices, Inc.",
    "ticker": "AMD",
    "exchange": "NASDAQ",
    "country": "US",
    "sector": "Semiconductors",
    "reportDate": "2026-06-05",
    "reportDateLabel": "5 June 2026",
    "uploadedAt": "2026-06-05T12:49:48.555Z",
    "fileName": "AMD_05062026.pdf",
    "pdfUrl": "https://files.valuatum.com/reports/pdfs/AMD_05062026.pdf",
    "reportType": "existing",
    "availability": "available",
    "price": 20,
    "priceLabel": "Ready report",
    "creditCost": 2,
    "isFree": false,
    "description": "AI equity report on AMD's data center, client, gaming, embedded, and AI accelerator businesses, valuation assumptions, risks, catalysts, and financial outlook.",
    "tags": [
      "AI Equity Report",
      "Semiconductors",
      "US",
      "PDF"
    ]
  },
  {
    "id": "nokia-05062026",
    "companyName": "Nokia Oyj",
    "name": "Nokia Oyj",
    "ticker": "NOKIA.HE",
    "exchange": "Helsinki",
    "country": "FI",
    "sector": "Communication Equipment",
    "reportDate": "2026-06-05",
    "reportDateLabel": "5 June 2026",
    "uploadedAt": "2026-06-05T12:49:57.283Z",
    "fileName": "Nokia_05062026.pdf",
    "pdfUrl": "https://files.valuatum.com/reports/pdfs/Nokia_05062026.pdf",
    "reportType": "existing",
    "availability": "available",
    "price": 20,
    "priceLabel": "Ready report",
    "creditCost": 2,
    "isFree": false,
    "description": "AI equity report on Nokia's network infrastructure, mobile networks, patent licensing, valuation assumptions, risks, catalysts, and financial outlook.",
    "tags": [
      "AI Equity Report",
      "Nordic",
      "Communication Equipment",
      "PDF"
    ]
  },
  {
    "id": "wartsila-05062026",
    "companyName": "Wärtsilä Oyj Abp",
    "name": "Wärtsilä Oyj Abp",
    "ticker": "WRT1V.HE",
    "exchange": "Helsinki",
    "country": "FI",
    "sector": "Industrials",
    "reportDate": "2026-06-05",
    "reportDateLabel": "5 June 2026",
    "uploadedAt": "2026-06-05T12:50:00.211Z",
    "fileName": "Wartsila_05062026.pdf",
    "pdfUrl": "https://files.valuatum.com/reports/pdfs/Wartsila_05062026.pdf",
    "reportType": "existing",
    "availability": "available",
    "price": 20,
    "priceLabel": "Ready report",
    "creditCost": 2,
    "isFree": false,
    "description": "AI equity report on Wärtsilä's marine and energy businesses, valuation assumptions, risks, catalysts, and financial outlook.",
    "tags": [
      "AI Equity Report",
      "Nordic",
      "Industrials",
      "PDF"
    ]
  },
  {
    "id": "recursion-02062026",
    "companyName": "Recursion Pharmaceuticals",
    "name": "Recursion Pharmaceuticals",
    "ticker": "RXRX",
    "exchange": "NASDAQ",
    "country": "US",
    "sector": "Health Care",
    "reportDate": "2026-06-02",
    "reportDateLabel": "2 June 2026",
    "uploadedAt": "2026-06-05T08:49:17.103Z",
    "fileName": "RecursionPharmaceuticals_02062026.pdf",
    "pdfUrl": "https://files.valuatum.com/reports/pdfs/RecursionPharmaceuticals_02062026.pdf",
    "reportType": "existing",
    "availability": "available",
    "price": 20,
    "priceLabel": "Ready report",
    "creditCost": 2,
    "isFree": false,
    "description": "AI equity report on Recursion's AI drug discovery platform, pipeline optionality, path to commercial milestones, and reverse valuation.",
    "tags": [
      "AI Equity Report",
      "Biotech",
      "AI Drug Discovery",
      "PDF"
    ]
  },
  {
    "id": "oriola-01062026",
    "companyName": "Oriola Oyj",
    "name": "Oriola Oyj",
    "ticker": "ORIOLA.HE",
    "exchange": "Helsinki",
    "country": "FI",
    "sector": "Health Care",
    "reportDate": "2026-06-01",
    "reportDateLabel": "1 June 2026",
    "uploadedAt": "2026-06-05T08:49:16.500Z",
    "fileName": "Oriola_01062026.pdf",
    "pdfUrl": "https://files.valuatum.com/reports/pdfs/Oriola_01062026.pdf",
    "reportType": "existing",
    "availability": "available",
    "price": 20,
    "priceLabel": "Ready report",
    "creditCost": 2,
    "isFree": false,
    "description": "AI equity report on Oriola's pharmaceutical distribution business, margin recovery trajectory, Nordic healthcare market dynamics, and valuation case.",
    "tags": [
      "AI Equity Report",
      "Nordic",
      "Health Care",
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
