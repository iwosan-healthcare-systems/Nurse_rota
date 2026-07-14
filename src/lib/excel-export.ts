import * as ExcelJS from "exceljs";

function triggerDownload(buf: ArrayBuffer | Uint8Array, filename: string) {
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function xlsWorkbook() {
  return new ExcelJS.Workbook();
}

export function xlsAddJsonSheet(
  wb: ExcelJS.Workbook,
  rows: Record<string, unknown>[],
  sheetName: string,
  colWidths?: number[],
) {
  const ws = wb.addWorksheet(sheetName);
  if (rows.length > 0) {
    const keys = Object.keys(rows[0]);
    ws.columns = keys.map((k, i) => ({ header: k, key: k, width: colWidths?.[i] }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ws.addRows(rows as any[]);
  }
  return ws;
}

export function xlsAddAoaSheet(
  wb: ExcelJS.Workbook,
  data: unknown[][],
  sheetName: string,
  colWidths?: number[],
) {
  const ws = wb.addWorksheet(sheetName);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data.forEach((row) => ws.addRow(row as any));
  if (colWidths) {
    colWidths.forEach((w, i) => {
      ws.getColumn(i + 1).width = w;
    });
  }
  return ws;
}

export async function xlsDownload(wb: ExcelJS.Workbook, filename: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  triggerDownload((await wb.xlsx.writeBuffer()) as any, filename);
}
