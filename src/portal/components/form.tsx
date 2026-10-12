// Small helpers shared by every portal form: a submit hook that tracks busy state and server-side
// validation errors, and layout primitives matching Untitled UI's settings-form spacing.
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { AlertCircle } from "@untitledui/icons";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import { cx } from "@/utils/cx";

export function useSubmit<T>(action: () => Promise<T>, options: { success?: string; onSuccess?: (result: T) => void } = {}) {
    const toast = useToast();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ApiError | null>(null);

    const submit = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const result = await action();
            if (options.success) toast.success(options.success);
            options.onSuccess?.(result);
            return result;
        } catch (e) {
            const apiError = e instanceof ApiError ? e : new ApiError(0, "error", errorMessage(e));
            setError(apiError);
            // Field errors are shown inline; anything else becomes a toast.
            if (apiError.issues.length === 0) toast.error("Couldn't save", apiError.message);
            return undefined;
        } finally {
            setBusy(false);
        }
    }, [action, options, toast]);

    return { submit, busy, error, fieldError: (field: string) => error?.issueFor(field), clearError: () => setError(null) };
}

export const FormGrid = ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={cx("grid grid-cols-1 gap-4 sm:grid-cols-2", className)}>{children}</div>
);

export const FullWidth = ({ children }: { children: ReactNode }) => <div className="sm:col-span-2">{children}</div>;

export const FormSection = ({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) => (
    <section className="grid grid-cols-1 gap-5 border-b border-secondary pb-8 last:border-b-0 lg:grid-cols-[minmax(200px,280px)_minmax(0,1fr)] lg:gap-8">
        <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold text-secondary">{title}</h2>
            {description && <p className="text-sm text-tertiary">{description}</p>}
        </div>
        <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
);

/** Shown above a form when the server rejected it for a reason not tied to one field. */
export const FormError = ({ message }: { message?: string | null }) =>
    message ? (
        <div role="alert" className="flex items-start gap-3 rounded-lg bg-error-primary p-3 text-sm text-error-primary ring-1 ring-error_subtle ring-inset">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{message}</span>
        </div>
    ) : null;
