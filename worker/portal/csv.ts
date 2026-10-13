// CSV in and out. Cell escaping, including formula neutralisation, lives in src/shared/portal/csv.ts
// so client-side downloads use the same rules.

export { csvCell, toCsv, type CsvColumn } from "../../src/shared/portal/csv";

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
