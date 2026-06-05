// ── Report catalog configuration ──────────────────────────────────────────
// Edit this file to add, remove, or update reports.
// reportType: "free" | "existing" | "fresh"
// availability: "available" | "coming_soon" | "hidden"

const REPORTS_CATALOG = [
  {
    id: "tesla-01062026",
    companyName: "Tesla, Inc.",
    ticker: "TSLA",
    exchange: "NASDAQ",
    country: "US",
    sector: "Consumer Discretionary",
    reportDate: "2026-06-01",
    fileName: "Tesla_01062026.pdf",
    pdfUrl: "reports/pdfs/Tesla_01062026.pdf",
    reportType: "free",
    availability: "available",
    price: 0,
    creditCost: 0,
    isFree: true,
    description: "AI equity report mapping Tesla's value pools across automotive, energy storage, FSD software, and Robotaxi option — with reverse valuation and risk analysis.",
    tags: ["AI Equity Report", "Reverse Valuation", "Value Pools", "PDF"],
  },
  {
    id: "storaenso-01062026",
    companyName: "Stora Enso Oyj",
    ticker: "STERV.HE",
    exchange: "Helsinki",
    country: "FI",
    sector: "Materials",
    reportDate: "2026-06-01",
    fileName: "StoraEnso_01062026.pdf",
    pdfUrl: "reports/pdfs/StoraEnso_01062026.pdf",
    reportType: "free",
    availability: "available",
    price: 0,
    creditCost: 0,
    isFree: true,
    description: "AI equity report on Stora Enso's renewable materials transformation, segment value allocation, packaging growth, and reverse valuation case.",
    tags: ["AI Equity Report", "Nordic", "Materials", "PDF"],
  },
  {
    id: "oriola-01062026",
    companyName: "Oriola Oyj",
    ticker: "ORIH.HE",
    exchange: "Helsinki",
    country: "FI",
    sector: "Health Care",
    reportDate: "2026-06-01",
    fileName: "Oriola_01062026.pdf",
    pdfUrl: "reports/pdfs/Oriola_01062026.pdf",
    reportType: "existing",
    availability: "available",
    price: 9.90,
    creditCost: 2,
    isFree: false,
    description: "AI equity report on Oriola's pharmaceutical distribution business, margin recovery trajectory, Nordic healthcare market dynamics, and valuation case.",
    tags: ["AI Equity Report", "Reverse Valuation", "Nordic", "PDF"],
  },
  {
    id: "nuholdings-02062026",
    companyName: "Nu Holdings Ltd.",
    ticker: "NU",
    exchange: "NYSE",
    country: "US",
    sector: "Financials",
    reportDate: "2026-06-02",
    fileName: "NuHoldings_02062026.pdf",
    pdfUrl: "reports/pdfs/NuHoldings_02062026.pdf",
    reportType: "existing",
    availability: "available",
    price: 9.90,
    creditCost: 2,
    isFree: false,
    description: "AI equity report on Nu Holdings' digital banking platform, Latin America expansion, profitability ramp, and reverse valuation against current market pricing.",
    tags: ["AI Equity Report", "Fintech", "LatAm", "PDF"],
  },
  {
    id: "recursion-02062026",
    companyName: "Recursion Pharmaceuticals",
    ticker: "RXRX",
    exchange: "NASDAQ",
    country: "US",
    sector: "Health Care",
    reportDate: "2026-06-02",
    fileName: "RecursionPharmaceuticals_02062026.pdf",
    pdfUrl: "reports/pdfs/RecursionPharmaceuticals_02062026.pdf",
    reportType: "existing",
    availability: "available",
    price: 9.90,
    creditCost: 2,
    isFree: false,
    description: "AI equity report on Recursion's AI drug discovery platform, pipeline optionality, path to commercial milestones, and reverse valuation.",
    tags: ["AI Equity Report", "Biotech", "AI Drug Discovery", "PDF"],
  },
];

// ── Payment configuration ──────────────────────────────────────────────────
// Set mode to 'stripe' and fill stripeLinks when Stripe is configured.

const PAYMENT_CONFIG = {
  mode: "manual", // "manual" | "stripe"
  currency: "EUR",
  currencySymbol: "€",
  freshReportPrice: 19.90,
  freshReportCredits: 5,
  manualInstructions: {
    payee: "Valuatum Oy",
    iban: "FI00 0000 0000 0000 00",  // PLACEHOLDER — replace with real IBAN
    bic: "PLACEHOLDER",              // PLACEHOLDER — replace with real BIC
    bank: "Placeholder Bank",
    referenceNote: "Include your email address and the company ticker (e.g. TSLA) as the payment reference.",
    deliveryNote: "After we confirm your payment, the report PDF will be delivered to your email address within one business day.",
  },
  stripeLinks: {
    singleReport: "",   // Add Stripe Payment Link URL here
    freshReport: "",    // Add Stripe Payment Link URL here
    credits10: "",
    credits25: "",
    credits100: "",
  },
};

// ── Helper: report age in days ─────────────────────────────────────────────
function getReportAgeDays(reportDate) {
  const now = new Date();
  const rd = new Date(reportDate);
  return Math.floor((now - rd) / (1000 * 60 * 60 * 24));
}

// ── Helper: human-readable age label ──────────────────────────────────────
function getReportAgeLabel(reportDate) {
  const days = getReportAgeDays(reportDate);
  if (days === 0) return "Generated today";
  if (days === 1) return "Generated yesterday";
  if (days < 7) return `Generated ${days} days ago`;
  if (days < 14) return "Generated 1 week ago";
  if (days < 30) return `Generated ${Math.floor(days / 7)} weeks ago`;
  return `Generated ${Math.floor(days / 30)} month${Math.floor(days / 30) > 1 ? "s" : ""} ago`;
}

// ── Helper: formatted date ─────────────────────────────────────────────────
function formatReportDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

if (typeof module !== "undefined") {
  module.exports = { REPORTS_CATALOG, PAYMENT_CONFIG, getReportAgeDays, getReportAgeLabel, formatReportDate };
}
