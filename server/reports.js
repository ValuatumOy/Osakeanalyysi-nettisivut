const { getReportMapSync } = require('./catalog');

const REPORT_CATALOG = getReportMapSync({ persistState: false });

module.exports = { REPORT_CATALOG };
