// CSV cells for exports, shared by the Worker and the portal's client-side downloads. Exports are
// opened in spreadsheets, so any cell that a spreadsheet would treat as a formula (= + - @, tab,
// carriage return) is prefixed with an apostrophe.

export interface CsvColumn<T> {
    header: string;
    value: (row: T) => string | number | boolean | null | undefined;
}

const FORMULA_START = /^[=+\-@\t\r]/;

export const csvCell = (value: string | number | boolean | null | undefined): string => {
    if (value === null || value === undefined) return "";
    let text = typeof value === "boolean" ? (value ? "yes" : "no") : String(value);
    if (typeof value === "string" && FORMULA_START.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
};

export const toCsv = <T>(rows: T[], columns: CsvColumn<T>[]) =>
    // A BOM so Excel reads UTF-8 names correctly; CRLF per RFC 4180.
    "﻿" + [columns.map((c) => csvCell(c.header)).join(","), ...rows.map((row) => columns.map((c) => csvCell(c.value(row))).join(","))].join("\r\n") + "\r\n";
