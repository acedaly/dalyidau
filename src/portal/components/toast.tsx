// Toast notifications built on Untitled UI's IconNotification. Untitled UI ships the notification
// card but not a toaster, so this adds the queue, auto-dismiss and an aria-live region.
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { IconNotification } from "@/components/application/notifications/notifications";

type ToastColor = "success" | "error" | "warning" | "brand" | "default";

/** A button on the toast, e.g. "Undo". Pressing it runs the action and dismisses the toast. */
interface ToastAction {
    label: string;
    run: () => void;
}

interface Toast {
    id: number;
    title: string;
    description: string;
    color: ToastColor;
    action?: ToastAction;
}

interface ToastApi {
    show: (toast: { title: string; description?: string; color?: ToastColor; action?: ToastAction }) => void;
    success: (title: string, description?: string) => void;
    error: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export const ToastProvider = ({ children }: { children: ReactNode }) => {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const nextId = useRef(1);

    const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

    const show = useCallback<ToastApi["show"]>(
        ({ title, description = "", color = "default", action }) => {
            const id = nextId.current++;
            setToasts((list) => [...list.slice(-2), { id, title, description, color, action }]);
            // Errors stay until dismissed so they can be read; everything else fades after 5 s
            // (8 s when there's something to press, like Undo).
            if (color !== "error") window.setTimeout(() => dismiss(id), action ? 8000 : 5000);
        },
        [dismiss],
    );

    const api = useMemo<ToastApi>(
        () => ({
            show,
            success: (title, description) => show({ title, description, color: "success" }),
            error: (title, description) => show({ title, description, color: "error" }),
        }),
        [show],
    );

    return (
        <ToastContext.Provider value={api}>
            {children}
            <div
                aria-live="polite"
                aria-relevant="additions"
                className="pointer-events-none fixed inset-x-0 bottom-0 z-60 flex flex-col items-center gap-3 p-4 [--width:400px] sm:items-end sm:p-6"
            >
                {toasts.map((toast) => (
                    <div
                        key={toast.id}
                        role={toast.color === "error" ? "alert" : "status"}
                        className="pointer-events-auto w-full max-w-100 duration-200 animate-in fade-in slide-in-from-bottom-2"
                    >
                        <IconNotification
                            title={toast.title}
                            description={toast.description}
                            color={toast.color}
                            hideDismissLabel
                            confirmLabel={toast.action?.label}
                            onConfirm={() => {
                                toast.action?.run();
                                dismiss(toast.id);
                            }}
                            onClose={() => dismiss(toast.id)}
                        />
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
};

export const useToast = () => {
    const context = useContext(ToastContext);
    if (!context) throw new Error("useToast must be used inside ToastProvider");
    return context;
};
