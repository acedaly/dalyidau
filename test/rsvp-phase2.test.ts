import { beforeEach, describe, expect, it } from "vitest";
import type { Guest, Household, QuestionSummary, RsvpHousehold, RsvpQuestion, WeddingEvent } from "../src/shared/portal/types";
import { ORIGIN, apiCall, call, db, resetPortal } from "./portal-helpers";

async function fixture() {
    const event = (await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", { name: "Reception" })).json.item;
    const household = (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name: "The Secure Family" })).json.item;
    const guest = (
        await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", {
            firstName: "Alex",
            lastName: "Secure",
            householdId: household.id,
            events: [event.id],
        })
    ).json.guest;
    for (const flag of ["wedding.site.public", "rsvp.native"]) await apiCall("PUT", `/api/portal/flags/${flag}`, { enabled: true });
    const issued = await apiCall<{ household: Household }>("POST", `/api/portal/wedding/households/${household.id}/invitation`, { action: "restore" });
    const invitationUrl = issued.json.household.invitationUrl!;
    return { event, household: issued.json.household, guest, token: new URL(invitationUrl).searchParams.get("invite")! };
}

const publicPost = async (action: "lookup" | "submit", body: unknown) => {
    const response = await call(`/api/wedding/rsvp/${action}`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.41" },
        body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as { household?: RsvpHousehold; error?: string; message?: string } };
};

beforeEach(resetPortal);

describe("signed RSVP invitations", () => {
    it("accepts long signed links and rejects tampering, rotation and revocation uniformly", async () => {
        const f = await fixture();
        expect(f.token.length).toBeGreaterThan(60);
        expect((await publicPost("lookup", { token: f.token })).status).toBe(200);

        const tampered = `${f.token.slice(0, -1)}${f.token.endsWith("A") ? "B" : "A"}`;
        const invalid = await publicPost("lookup", { token: tampered });
        expect(invalid).toMatchObject({ status: 404, json: { error: "not_found" } });

        const rotated = await apiCall<{ household: Household }>("POST", `/api/portal/wedding/households/${f.household.id}/invitation`, { action: "rotate" });
        const newToken = new URL(rotated.json.household.invitationUrl!).searchParams.get("invite")!;
        expect((await publicPost("lookup", { token: f.token })).json.message).toBe(invalid.json.message);
        expect((await publicPost("lookup", { token: newToken })).status).toBe(200);

        await apiCall("POST", `/api/portal/wedding/households/${f.household.id}/invitation`, { action: "revoke" });
        expect((await publicPost("lookup", { token: newToken })).json.message).toBe(invalid.json.message);
    });

    it("can disable short-code lookups without affecting signed invitations", async () => {
        const f = await fixture();
        const settings = {
            externalUrl: "https://sayi.do/aidanandamelia2258/",
            deadline: "",
            collectDietary: true,
            collectMessage: true,
            allowChangesAfterDeadline: false,
            allowCodes: false,
            linkExpiryDays: 60,
        };
        expect((await apiCall("PUT", "/api/portal/settings/rsvp", settings)).status).toBe(200);
        expect((await publicPost("lookup", { code: f.household.rsvpCode })).status).toBe(404);
        expect((await publicPost("lookup", { token: f.token })).status).toBe(200);
    });
});

describe("configurable RSVP questions", () => {
    it("validates conditional answers, preserves question versions and reports bus interest", async () => {
        const f = await fixture();
        const parent = (
            await apiCall<{ question: RsvpQuestion }>("POST", "/api/portal/wedding/rsvp-questions", {
                label: "Will you need help?",
                type: "yes_no",
                scope: "guest",
                audience: "all",
                required: true,
                published: true,
                sortOrder: 1,
            })
        ).json.question;
        const detail = (
            await apiCall<{ question: RsvpQuestion }>("POST", "/api/portal/wedding/rsvp-questions", {
                label: "What help do you need?",
                type: "short_text",
                scope: "guest",
                audience: "all",
                required: true,
                published: true,
                condition: { questionId: parent.id, equals: "yes" },
                sortOrder: 2,
            })
        ).json.question;
        const bus = (await apiCall<{ questions: RsvpQuestion[] }>("GET", "/api/portal/wedding/rsvp-questions")).json.questions.find(
            (question) => question.id === "q_bus",
        )!;
        await apiCall("PATCH", `/api/portal/wedding/rsvp-questions/${bus.id}`, { ...bus, published: true });

        const base = {
            token: f.token,
            clientId: "client-submission-00000001",
            guests: [{ guestId: f.guest.id, events: { [f.event.id]: "attending" } }],
        };
        const missing = await publicPost("submit", {
            ...base,
            answers: { household: {}, guests: { [f.guest.id]: { [parent.id]: "yes", q_bus: "yes" } } },
        });
        expect(missing).toMatchObject({ status: 400, json: { error: "invalid" } });

        const answers = { household: {}, guests: { [f.guest.id]: { [parent.id]: "yes", [detail.id]: "Step-free entry", q_bus: "yes" } } };
        expect((await publicPost("submit", { ...base, answers })).status).toBe(200);
        // A retry with the same id is acknowledged without a second submission or audit entry.
        expect((await publicPost("submit", { ...base, answers })).status).toBe(200);
        expect(await db().prepare("SELECT COUNT(*) AS n FROM rsvp_submissions").first()).toEqual({ n: 1 });
        expect(await db().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'rsvp.submit'").first()).toEqual({ n: 1 });

        const edited = await apiCall<{ question: RsvpQuestion }>("PATCH", `/api/portal/wedding/rsvp-questions/${detail.id}`, {
            ...detail,
            label: "Please describe the help you need",
            updatedAt: detail.updatedAt,
        });
        expect(edited.json.question.version).toBe(2);
        const stored = await db().prepare("SELECT question_version, question_snapshot FROM rsvp_answers WHERE question_id = ?").bind(detail.id).first<{
            question_version: number;
            question_snapshot: string;
        }>();
        expect(stored?.question_version).toBe(1);
        expect(stored?.question_snapshot).toContain("What help do you need?");

        const report = await apiCall<{ summaries: QuestionSummary[] }>("GET", "/api/portal/wedding/rsvp-questions");
        expect(report.json.summaries.find((summary) => summary.question.id === "q_bus")?.counts).toContainEqual({ option: "yes", count: 1 });
        expect(report.json.summaries.find((summary) => summary.question.id === detail.id)?.responses[0]).toMatchObject({
            who: "Alex Secure",
            value: "Step-free entry",
            version: 1,
        });
    });
});
