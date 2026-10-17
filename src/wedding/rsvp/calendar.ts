// Saves an "Add to calendar" file built in the browser. The file itself comes from
// src/shared/portal/calendar.ts, so it matches the Save the Date's .ics exactly.

export function downloadCalendarFile(contents: string, filename: string) {
    const url = URL.createObjectURL(new Blob([contents], { type: "text/calendar;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
