const zlib = require("node:zlib");

function csvMoney(amount, currency) {
  if (amount == null) return "Unavailable";
  const raw = String(amount);
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [integer = "0", fraction = ""] = unsigned.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const decimals = fraction.length < 2 ? fraction.padEnd(2, "0") : fraction;
  return `${currency || ""} ${negative ? "-" : ""}${grouped}.${decimals}`.trim();
}
const csvBreakdown = value => value == null ? "Unavailable" : JSON.stringify(value);
const statusText = row => [row.profitStatus, row.profitReason].filter(Boolean).join(" - ");
const marginText = row => row.profitMarginPercent == null ? "Unavailable" : `${row.profitMarginPercent}%`;
const sampleEstimateText = row => row.estimatedPartnerCostSource === "LOCAL_MOCK_ONLY" ? "SAMPLE" : "";
const performanceColumns = ["Courier", "Code", "Shipments", "Delivered", "In transit", "Exceptions", "Unmapped", "Sample"];
const performanceRows = report => (report.courierPerformance || []).map(row => [
  row.name, row.code, row.shipmentCount, row.deliveredCount, row.inTransitCount, row.exceptionCount, row.unmappedCount, row.sampleCount,
]);

function periodRows(report) {
  return Object.entries(report.profitPeriods || {}).flatMap(([granularity, groups]) =>
    groups.flatMap(group => group.currencies.map(row => [
      granularity, group.key, row.currency, group.shipmentCount,
      csvMoney(row.confirmedGrossProfit, row.currency), csvMoney(row.provisionalGrossProfit, row.currency),
    ]))
  );
}
const orderAwb = row => [row.reference, row.waybill].filter(Boolean).join(" / ") || "Unavailable";

function buildFinancialExportSheets(report) {
  const totals = report.summary?.currencies || [];
  const summary = [
    ["Profitability report", report.period?.label || "Unavailable"],
    ["Date basis", report.period?.dateBasis || "Unavailable"],
    ["Date from", report.period?.from?.slice(0, 10) || "Unavailable"],
    ["Date to (exclusive)", report.period?.toExclusive?.slice(0, 10) || "Unavailable"],
    ["Customer filter", report.filters?.customerId || "All customers"],
    ["Courier filter", report.filters?.partnerCode || "All couriers"],
    ["Shipment status filter", report.filters?.shipmentStatus || "All statuses"],
    ["Shipment count", report.summary?.shipmentCount ?? 0],
    ["Confirmed", report.summary?.confirmedCount ?? 0],
    ["Provisional", report.summary?.provisionalCount ?? 0],
    ["Configuration required", report.summary?.configurationRequiredCount ?? 0],
    ["Unavailable", report.summary?.unavailableCount ?? 0],
    [],
    ["Currency", "Customer selling amount", "Revenue ex GST", "Estimated partner cost", "Estimated cost ex GST", "Final partner cost", "Final cost ex GST", "Confirmed gross profit", "Provisional gross profit"],
    ...totals.map(item => [item.currency, csvMoney(item.customerSellingAmount, item.currency), csvMoney(item.customerRevenueExGst, item.currency), csvMoney(item.estimatedPartnerCost, item.currency), csvMoney(item.estimatedPartnerCostExGst, item.currency), csvMoney(item.finalPartnerCost, item.currency), csvMoney(item.finalPartnerCostExGst, item.currency), csvMoney(item.confirmedGrossProfit, item.currency), csvMoney(item.provisionalGrossProfit, item.currency)]),
    [], ["Notes", ...(report.notes || [])],
  ];
  const shipments = [["Shipment date", "Order / AWB", "Customer", "Courier", "Status", "Customer selling price", "Customer price breakdown", "Customer revenue ex GST", "Revenue GST", "Revenue tax state", "Revenue source", "Estimated partner cost", "Estimate breakdown", "Estimate tax state", "Final partner cost", "Final breakdown", "Final tax state", "Cost reconciliation", "Gross profit", "Profit state", "Reason"], ...(report.shipments || []).map(row => [row.shipmentDate?.slice(0, 10) || "Unavailable", orderAwb(row), row.customer?.name || "Unknown customer", `${row.courier?.name || "Unknown courier"} (${row.courier?.code || "Unknown code"})`, row.shipmentStatus || row.bookingStatus || "Unavailable", csvMoney(row.customerSellingAmount, row.customerSellingCurrency || row.currency), csvBreakdown(row.customerChargeBreakdown), csvMoney(row.customerRevenueExGst, row.customerRevenueCurrency), csvMoney(row.revenueTaxAmount, row.customerRevenueCurrency), row.revenueTaxBasisStatus || "UNAVAILABLE", row.revenueSource || "Unavailable", csvMoney(row.estimatedPartnerCost, row.estimatedPartnerCostCurrency), csvBreakdown(row.estimatedPartnerCostBreakdown), row.estimatedCostTaxBasisStatus || "UNAVAILABLE", csvMoney(row.finalPartnerCost, row.finalPartnerCostCurrency), csvBreakdown(row.finalPartnerCostBreakdown), row.finalCostTaxBasisStatus || "UNAVAILABLE", row.costReconciliationStatus || "UNAVAILABLE", csvMoney(row.grossProfit, row.grossProfitCurrency), row.profitStatus || "UNAVAILABLE", row.profitReason || ""] )];
  const customers = [["Customer", "Currency", "Shipments", "Selling amount", "Revenue ex GST", "Confirmed", "Provisional", "Configuration required", "Unavailable"], ...(report.customers || []).flatMap(group => (group.currencies || []).map(item => [group.key, item.currency, group.shipmentCount, csvMoney(item.customerSellingAmount, item.currency), csvMoney(item.customerRevenueExGst, item.currency), group.confirmedCount, group.provisionalCount, group.configurationRequiredCount, group.unavailableCount]))];
  const couriers = [["Courier partner", "Currency", "Shipments", "Estimated cost", "Final cost", "Estimated cost ex GST", "Final cost ex GST", "Confirmed", "Provisional", "Configuration required", "Unavailable"], ...(report.couriers || []).flatMap(group => (group.currencies || []).map(item => [group.key, item.currency, group.shipmentCount, csvMoney(item.estimatedPartnerCost, item.currency), csvMoney(item.finalPartnerCost, item.currency), csvMoney(item.estimatedPartnerCostExGst, item.currency), csvMoney(item.finalPartnerCostExGst, item.currency), group.confirmedCount, group.provisionalCount, group.configurationRequiredCount, group.unavailableCount]))];
  const comparisons = [["Order / AWB", "Courier", "Estimated cost", "Estimate tax state", "Final cost", "Final tax state", "Estimated cost ex GST", "Final cost ex GST", "Reconciliation", "Profit state", "Reason"], ...(report.shipments || []).map(row => [orderAwb(row), row.courier?.name || "Unknown courier", csvMoney(row.estimatedPartnerCost, row.estimatedPartnerCostCurrency), row.estimatedCostTaxBasisStatus || "UNAVAILABLE", csvMoney(row.finalPartnerCost, row.finalPartnerCostCurrency), row.finalCostTaxBasisStatus || "UNAVAILABLE", csvMoney(row.estimatedPartnerCostExGst, row.estimatedPartnerCostCurrency), csvMoney(row.finalPartnerCostExGst, row.finalPartnerCostCurrency), row.costReconciliationStatus || "UNAVAILABLE", row.profitStatus || "UNAVAILABLE", row.profitReason || ""] )];
  const billingSummary = report.creditBillingSummary || { status: "UNAVAILABLE", reason: "Invoice balance details are unavailable in the profitability response.", invoices: [], byPeriodCurrency: [], excludedInvoiceCount: 0 };
  const billing = [
    ["Credit customer outstanding status", billingSummary.status || "UNAVAILABLE"],
    ["Status reason", billingSummary.reason || "Unavailable"],
    ["Excluded partial invoices", billingSummary.excludedInvoiceCount ?? 0],
    [], ["Invoice", "Customer", "Customer ID", "Billing period", "Invoice date", "Currency", "Invoice total", "Paid", "Outstanding", "Invoice status", "Financial status"],
    ...(billingSummary.invoices || []).map(row => [row.invoiceNumber, row.customer, row.customerId || "Unavailable", row.period, row.invoiceDate?.slice(0, 10) || "Unavailable", row.currency || "Unavailable", csvMoney(row.totalAmount, row.currency), csvMoney(row.paidAmount, row.currency), csvMoney(row.outstandingAmount, row.currency), row.status, row.financialStatus]),
    [], ["Monthly billing summary"], ["Billing period", "Currency", "Invoice count", "Invoice total", "Paid", "Outstanding", "Status"],
    ...(billingSummary.byPeriodCurrency || []).map(row => [row.period, row.currency || "Unavailable", row.invoiceCount, csvMoney(row.totalAmount, row.currency), csvMoney(row.paidAmount, row.currency), csvMoney(row.outstandingAmount, row.currency), row.status]),
  ];
  shipments[0].push("Margin", "Sample charge");
  (report.shipments || []).forEach((row, index) => shipments[index + 1].push(marginText(row), sampleEstimateText(row)));
  const periods = periodRows(report);
  return [
    { name: "Summary", rows: summary },
    { name: "Shipments", rows: shipments },
    { name: "Customers", rows: customers },
    { name: "Courier costs", rows: couriers },
    { name: "Estimate vs final", rows: comparisons },
    { name: "Credit billing", rows: billing },
    ...(periods.length ? [{ name: "Profit by period", rows: [["Granularity", "Period start", "Currency", "Shipments", "Confirmed profit", "Provisional profit"], ...periods] }] : []),
    ...((report.courierPerformance || []).length ? [{ name: "Courier performance", rows: [performanceColumns, ...performanceRows(report)] }] : []),
  ];
}

function xml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function columnName(index) {
  let name = "";
  for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
}

function worksheetXml(rows) {
  const rowXml = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => {
    const cell = `${columnName(columnIndex)}${rowIndex + 1}`;
    const style = rowIndex === 0 ? ` s="1"` : "";
    return `<c r="${cell}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  }).join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><sheetData>${rowXml}</sheetData><autoFilter ref="A1:${columnName(Math.max(0, ...rows.map(row => row.length)) - 1)}${Math.max(rows.length, 1)}"/></worksheet>`;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  const local = []; const central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8"); const data = Buffer.from(text, "utf8"); const crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, data);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(nameBytes.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes); offset += header.length + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

function generateXlsx(report) {
  const sheets = buildFinancialExportSheets(report);
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, i) => `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF334155"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>`,
  };
  sheets.forEach((sheet, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = worksheetXml(sheet.rows); });
  return zipStore(files);
}

function pdfEscape(text) { return String(text ?? "").replace(/[^\x20-\x7e]/g, "?").replace(/([\\()])/g, "\\$1"); }
function pdfLines(report) {
  const performance = performanceRows(report);
  const rows = [
    "Profitability report",
    `Period: ${report.period?.label || "Unavailable"} | Date basis: ${report.period?.dateBasis || "SHIPMENT_DATE"}`,
    `Filters: customer ${report.filters?.customerId || "All"}; courier ${report.filters?.partnerCode || "All"}; status ${report.filters?.shipmentStatus || "All"}`,
    `Shipments ${report.summary?.shipmentCount ?? 0} | Confirmed ${report.summary?.confirmedCount ?? 0} | Provisional ${report.summary?.provisionalCount ?? 0} | Configuration required ${report.summary?.configurationRequiredCount ?? 0} | Unavailable ${report.summary?.unavailableCount ?? 0}`,
    "",
    "Totals by currency:",
    ...((report.summary?.currencies || []).map(row => `${row.currency}: revenue ex GST ${csvMoney(row.customerRevenueExGst, row.currency)}; estimated cost ${csvMoney(row.estimatedPartnerCost, row.currency)}; final cost ${csvMoney(row.finalPartnerCost, row.currency)}; confirmed profit ${csvMoney(row.confirmedGrossProfit, row.currency)}; provisional profit ${csvMoney(row.provisionalGrossProfit, row.currency)}`)),
    "",
    "Shipment profitability (customer selling price and partner costs remain separate):",
    "Date | Order/AWB | Customer | Courier | Revenue ex GST | Estimate | Final cost | Profit | State",
    ...((report.shipments || []).map(row => [row.shipmentDate?.slice(0, 10) || "Unavailable", orderAwb(row), row.customer?.name || "Unknown", row.courier?.name || "Unknown", `selling ${csvMoney(row.customerSellingAmount, row.customerSellingCurrency || row.currency)}`, `revenue ex GST ${csvMoney(row.customerRevenueExGst, row.customerRevenueCurrency)}`, `estimate ${csvMoney(row.estimatedPartnerCost, row.estimatedPartnerCostCurrency)}; estimate ex GST ${csvMoney(row.estimatedPartnerCostExGst, row.estimatedPartnerCostCurrency)}`, `final ${csvMoney(row.finalPartnerCost, row.finalPartnerCostCurrency)}; final ex GST ${csvMoney(row.finalPartnerCostExGst, row.finalPartnerCostCurrency)}`, `profit ${csvMoney(row.grossProfit, row.grossProfitCurrency)}`, statusText(row)].join(" | "))),
    "",
    ...periodRows(report).map(row => `${row[0]} ${row[1]} | ${row[2]} | shipments ${row[3]} | confirmed ${row[4]} | provisional ${row[5]}`),
    ...((report.shipments || []).map(row => `${orderAwb(row)} | Margin ${marginText(row)} ${sampleEstimateText(row)}`)),
    "",
    "Customer revenue:",
    ...((report.customers || []).flatMap(group => (group.currencies || []).map(item => `${group.key} | ${item.currency} | shipments ${group.shipmentCount} | selling ${csvMoney(item.customerSellingAmount, item.currency)} | revenue ex GST ${csvMoney(item.customerRevenueExGst, item.currency)} | confirmed ${group.confirmedCount} | provisional ${group.provisionalCount} | configuration required ${group.configurationRequiredCount} | unavailable ${group.unavailableCount}`))),
    "",
    "Courier partner costs:",
    ...((report.couriers || []).flatMap(group => (group.currencies || []).map(item => `${group.key} | ${item.currency} | shipments ${group.shipmentCount} | estimated ${csvMoney(item.estimatedPartnerCost, item.currency)} | final ${csvMoney(item.finalPartnerCost, item.currency)} | confirmed ${group.confirmedCount} | provisional ${group.provisionalCount} | configuration required ${group.configurationRequiredCount} | unavailable ${group.unavailableCount}`))),
    "",
    ...(performance.length ? ["Courier performance", performanceColumns.join(" | "), ...performance.map(row => row.join(" | ")), ""] : []),
    `Credit billing status: ${report.creditBillingSummary?.status || "UNAVAILABLE"}. ${report.creditBillingSummary?.reason || "No invoice balance snapshot is available."}`,
    ...(report.creditBillingSummary?.invoices || []).map(row => `Credit invoice ${row.invoiceNumber} | ${row.customer} | period ${row.period} | ${row.currency || "Unavailable"} | total ${csvMoney(row.totalAmount, row.currency)} | paid ${csvMoney(row.paidAmount, row.currency)} | outstanding ${csvMoney(row.outstandingAmount, row.currency)} | ${row.financialStatus}`),
    ...(report.creditBillingSummary?.byPeriodCurrency || []).map(row => `Monthly billing ${row.period} | ${row.currency || "Unavailable"} | invoices ${row.invoiceCount} | total ${csvMoney(row.totalAmount, row.currency)} | paid ${csvMoney(row.paidAmount, row.currency)} | outstanding ${csvMoney(row.outstandingAmount, row.currency)} | ${row.status}`),
  ];
  return rows.flatMap(line => {
    const text = String(line);
    const chunks = [];
    for (let i = 0; i < text.length; i += 115) chunks.push(text.slice(i, i + 115));
    return chunks.length ? chunks : [""];
  });
}

function generatePdf(report) {
  const lines = pdfLines(report); const pages = [];
  for (let i = 0; i < lines.length; i += 48) pages.push(lines.slice(i, i + 48));
  if (!pages.length) pages.push(["No report data available."]);
  const objects = [];
  const add = body => { objects.push(body); return objects.length; };
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds = [];
  for (const pageLines of pages) {
    const stream = `BT /F1 8 Tf 36 560 Td 10 TL ${pageLines.map(line => `(${pdfEscape(line)}) Tj T*`).join(" ")} ET`;
    const streamId = add(`<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent PAGESREF /MediaBox [0 0 842 595] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${streamId} 0 R >>`));
  }
  const pagesId = add(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  for (const pageId of pageIds) objects[pageId - 1] = objects[pageId - 1].replace("PAGESREF", `${pagesId} 0 R`);
  let output = "%PDF-1.4\n% financial report\n"; const offsets = [0];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(output, "ascii")); output += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(output, "ascii"); output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output, "ascii");
}

module.exports = { buildFinancialExportSheets, generateXlsx, generatePdf };
