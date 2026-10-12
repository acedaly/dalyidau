// Status badges used across modules, so the same state always looks the same.
import { BadgeWithDot } from "@/components/base/badges/badges";
import type { Guest, MessageStatus, PaymentState, RsvpStatus, SupplierStatus, TaskPriority, TaskStatus } from "@/shared/portal/types";

type DotColor = "gray" | "brand" | "error" | "warning" | "success" | "blue" | "indigo" | "orange";

const badge = (label: string, color: DotColor) => (
    <BadgeWithDot size="sm" type="pill-color" color={color}>
        {label}
    </BadgeWithDot>
);

export const RSVP_LABELS: Record<RsvpStatus | "not_invited", string> = {
    attending: "Attending",
    declined: "Declined",
    pending: "Awaiting reply",
    not_invited: "Not invited",
};

export const RsvpBadge = ({ status }: { status: Guest["rsvp"] | RsvpStatus }) =>
    badge(RSVP_LABELS[status], status === "attending" ? "success" : status === "declined" ? "error" : status === "pending" ? "warning" : "gray");

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = { todo: "To do", in_progress: "In progress", done: "Done" };
export const TaskStatusBadge = ({ status }: { status: TaskStatus }) =>
    badge(TASK_STATUS_LABELS[status], status === "done" ? "success" : status === "in_progress" ? "blue" : "gray");

export const PRIORITY_LABELS: Record<TaskPriority, string> = { high: "High", medium: "Medium", low: "Low" };
export const PriorityBadge = ({ priority }: { priority: TaskPriority }) =>
    badge(PRIORITY_LABELS[priority], priority === "high" ? "error" : priority === "medium" ? "warning" : "gray");

export const SUPPLIER_STATUS_LABELS: Record<SupplierStatus, string> = {
    researching: "Researching",
    quoted: "Quoted",
    booked: "Booked",
    cancelled: "Cancelled",
};
export const SupplierStatusBadge = ({ status }: { status: SupplierStatus }) =>
    badge(SUPPLIER_STATUS_LABELS[status], status === "booked" ? "success" : status === "quoted" ? "indigo" : status === "cancelled" ? "gray" : "warning");

export const PAYMENT_LABELS: Record<PaymentState, string> = { paid: "Paid", partial: "Part paid", unpaid: "Unpaid", overdue: "Overdue" };
export const PaymentBadge = ({ state }: { state: PaymentState }) =>
    badge(PAYMENT_LABELS[state], state === "paid" ? "success" : state === "partial" ? "blue" : state === "overdue" ? "error" : "gray");

export const MESSAGE_STATUS_LABELS: Record<MessageStatus, string> = {
    draft: "Draft",
    queued: "Queued",
    sending: "Sending",
    sent: "Sent",
    partial: "Partly sent",
    failed: "Failed",
};
export const MessageStatusBadge = ({ status }: { status: MessageStatus }) =>
    badge(
        MESSAGE_STATUS_LABELS[status],
        status === "sent" ? "success" : status === "failed" ? "error" : status === "partial" ? "warning" : status === "draft" ? "gray" : "blue",
    );
