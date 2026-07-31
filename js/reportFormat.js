// Report display helpers shared by the pages that render catalog reports.
// The catalog itself is fetched from the live API (/api/reports) — these are
// only presentation utilities and carry no report data.
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
  module.exports = { PAYMENT_CONFIG, getReportAgeDays, getReportAgeLabel, formatReportDate };
}
