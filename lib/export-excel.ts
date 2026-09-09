import writeExcelFile, { type SheetData } from "write-excel-file/browser";

export type ExcelCell = string | number;

export type ExcelExport = {
  filename: string;
  sheetName: string;
  columns: string[];
  rows: ExcelCell[][];
};

function safeFilename(filename: string) {
  const cleaned = filename
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return `${cleaned || "WISE export"}.xlsx`;
}

function safeSheetName(sheetName: string) {
  return sheetName.replace(/[\\/?*[\]:]+/g, "-").slice(0, 31) || "Export";
}

export async function downloadExcel({ filename, sheetName, columns, rows }: ExcelExport) {
  const header = columns.map((value) => ({
    value,
    fontWeight: "bold" as const,
    textColor: "#FFFFFF",
    backgroundColor: "#1D5FC4",
  }));
  const data = [header, ...rows] as SheetData;
  const widths = columns.map((column, index) => {
    const values = [column, ...rows.map((row) => String(row[index] ?? ""))];
    return { width: Math.min(36, Math.max(12, ...values.map((value) => value.length + 2))) };
  });

  await writeExcelFile(data, {
    sheet: safeSheetName(sheetName),
    columns: widths,
    stickyRowsCount: 1,
  }).toFile(safeFilename(filename));
}
