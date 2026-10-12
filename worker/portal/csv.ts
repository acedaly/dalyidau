// CSV in and out. Exports are opened in spreadsheets, so any cell that a spreadsheet would treat
// as a formula (= + - @, tab, carriage return) is prefixed with an apostrophe.

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

export const csvResponse = (filename: string, body: string) =>
    new Response(body, {
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename.replace(/[^a-z0-9._-]/gi, "_")}"`,
            "Cache-Control": "no-store",
        },
    });

/** RFC 4180 parser: quoted fields, escaped quotes, CRLF or LF, and a leading BOM. Blank rows are dropped. */
export function parseCsv(text: string): string[][] {
    return parseCsvRows(text).map((row) => row.cells);
}

/** Like parseCsv, but keeps each row's line number in the file (quoted line breaks count). */
export function parseCsvRows(text: string): { cells: string[]; line: number }[] {
    const input = text.replace(/^\uFEFF/, "");
    const rows: { cells: string[]; line: number }[] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    let line = 1;
    let rowLine = 1;

    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if (quoted) {
            if (char === '"') {
                if (input[i + 1] === '"') {
                    field += '"';
                    i++;
                } else quoted = false;
            } else {
                if (char === "\n") line++;
                field += char;
            }
            continue;
        }
        if (char === '"' && field === "") quoted = true;
        else if (char === ",") {
            row.push(field);
            field = "";
        } else if (char === "\n" || char === "\r") {
            if (char === "\r" && input[i + 1] === "\n") i++;
            row.push(field);
            rows.push({ cells: row, line: rowLine });
            row = [];
            field = "";
            line++;
            rowLine = line;
        } else field += char;
    }
    if (field !== "" || row.length) {
        row.push(field);
        rows.push({ cells: row, line: rowLine });
    }
    return rows.filter((r) => r.cells.some((cell) => cell.trim() !== ""));
}
