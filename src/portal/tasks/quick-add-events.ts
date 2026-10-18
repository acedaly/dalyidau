// "Add task" from anywhere in the portal: the sidebar button, the floating button on phones and
// the q shortcut all send this event. On a Tasks page the page's own Quick Add answers it (with the
// page's defaults, e.g. today's date on Today); elsewhere the portal-wide Quick Add does. Exactly
// one of the two is ever mounted, so a request is never handled twice.
export const QUICK_ADD_EVENT = "daly:tasks-quick-add";

export const requestQuickAdd = () => window.dispatchEvent(new CustomEvent(QUICK_ADD_EVENT));

/** A random id for one Quick Add draft, so a retried save returns the task the first one created. */
export const draftId = () => `qa-${crypto.randomUUID()}`;

/**
 * Sent by the portal-wide Quick Add after it creates a task, so a page outside Tasks (a Knowledge
 * object's related tasks) can refresh what it shows without a page load. Carries the task's id only.
 */
export const TASK_CREATED_EVENT = "daly:tasks-created";
