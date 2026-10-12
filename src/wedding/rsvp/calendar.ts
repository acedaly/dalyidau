// An "Add to calendar" file built in the browser, so guests who are coming can save the date.
// Event times are wall-clock times in the wedding's time zone; without a time it's an all-day event.

const escapeText = (value: string) =>
    value
        .replace(/\\/g, "\\\\")
        .replace(/\n/g, "\\n")
        .replace(/([,;])/g, "\\$1");
const compact = (local: string) => local.replace(/[-:]/g, "").slice(0, 13) + "00";
const nextDay = (date: string) => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10).replace(/-/g, "");
};

export function weddingCalendarFile(input: { title: string; date: string; timeZone: string; location: string; startsAt: string | null; url: string }): string {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const timed = !!input.startsAt && input.startsAt.length >= 16;
    const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//daly.id.au//Wedding//EN",
        "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        `UID:wedding-${input.date}@daly.id.au`,
        `DTSTAMP:${stamp}`,
        ...(timed
            ? [`DTSTART;TZID=${input.timeZone}:${compact(input.startsAt!)}`, `DURATION:PT7H`]
            : [`DTSTART;VALUE=DATE:${input.date.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${nextDay(input.date)}`]),
        `SUMMARY:${escapeText(input.title)}`,
        ...(input.location ? [`LOCATION:${escapeText(input.location)}`] : []),
        `URL:${input.url}`,
        "END:VEVENT",
        "END:VCALENDAR",
    ];
    return lines.join("\r\n") + "\r\n";
}

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
