export const ADMIN = "e2e-admin-token-0123456789abcdef";

/** Capacities sync is off (archived) by default; the Capacities fixtures need it on. The e2e Worker signs in as an owner. */
export const setCapacitiesSync = async (enabled: boolean) => {
    const response = await fetch("http://localhost:8787/api/portal/flags/website.capacities.sync", {
        method: "PUT",
        headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
    });
    if (!response.ok) throw new Error(`switching Capacities sync failed: ${response.status} ${await response.text()}`);
};

export const sync = async () => {
    await setCapacitiesSync(true);
    const response = await fetch("http://localhost:8787/api/admin/sync", { method: "POST", headers: { Authorization: `Bearer ${ADMIN}` } });
    if (!response.ok) throw new Error(`sync failed: ${response.status} ${await response.text()}`);
    return response.json();
};

export const mock = async (action: string, ...args: unknown[]) => {
    const response = await fetch("http://localhost:8790/__control", { method: "POST", body: JSON.stringify({ action, args }) });
    if (!response.ok) throw new Error(`mock control failed: ${action}`);
};

/**
 * The portal lists only Wedding Planner unless Portal settings → Features → "Other applications" is
 * on (it defaults off). Specs that open other applications from the launcher or sidebar switch it
 * on, and back off afterwards (both projects share one database).
 */
export const setOtherApplications = async (enabled: boolean) => {
    const response = await fetch("http://localhost:8787/api/portal/flags/portal.other_applications", {
        method: "PUT",
        headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
    });
    if (!response.ok) throw new Error(`switching other applications failed: ${response.status} ${await response.text()}`);
};
