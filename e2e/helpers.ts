export const ADMIN = "e2e-admin-token-0123456789abcdef";

export const sync = async () => {
    const response = await fetch("http://localhost:8787/api/admin/sync", { method: "POST", headers: { Authorization: `Bearer ${ADMIN}` } });
    if (!response.ok) throw new Error(`sync failed: ${response.status} ${await response.text()}`);
    return response.json();
};

export const mock = async (action: string, ...args: unknown[]) => {
    const response = await fetch("http://localhost:8790/__control", { method: "POST", body: JSON.stringify({ action, args }) });
    if (!response.ok) throw new Error(`mock control failed: ${action}`);
};
