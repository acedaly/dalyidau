// The 12-month year planner: public holidays, school holidays, leave and busy days at a glance.
import { ArrowLeft, ArrowRight, Printer } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import type { PageData } from "@/portal/lib/page-types";
import { CalendarHeader } from "../shared";
import { YearPlanner } from "../year-planner";

export const CalendarYearPage = ({ data }: { data: PageData<"calendar-year"> }) => (
    <>
        <CalendarHeader
            shell={data}
            title={`Year planner ${data.year}`}
            description="NSW public holidays, school holidays, leave and busy days. Choose a day to open it."
            crumb={{ label: "Year planner" }}
            actions={
                <>
                    <Button
                        size="md"
                        color="secondary"
                        iconLeading={ArrowLeft}
                        href={`/portal/calendar/year?year=${data.year - 1}`}
                        aria-label={`${data.year - 1}`}
                    >
                        {data.year - 1}
                    </Button>
                    <Button
                        size="md"
                        color="secondary"
                        iconTrailing={ArrowRight}
                        href={`/portal/calendar/year?year=${data.year + 1}`}
                        aria-label={`${data.year + 1}`}
                    >
                        {data.year + 1}
                    </Button>
                    <Button size="md" color="secondary" iconLeading={Printer} onClick={() => window.print()} className="max-sm:hidden">
                        Print
                    </Button>
                </>
            }
        />
        <YearPlanner
            year={data.year}
            today={data.today}
            overlays={data.overlays}
            busy={data.busy}
            weekStart={data.preferences.weekStart}
            hrefFor={(d) => `/portal/calendar?view=day&date=${d}`}
        />
    </>
);
