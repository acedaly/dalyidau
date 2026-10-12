// A slide-over panel for viewing and editing one record, built on Untitled UI's SlideoutMenu.
import type { FormEvent, ReactNode } from "react";
import { Dialog, Modal, ModalOverlay, SlideoutMenu } from "@/components/application/slideout-menus/slideout-menu";
import { cx } from "@/utils/cx";

interface RecordPanelProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: ReactNode;
    /** Shown above the title, e.g. an avatar. */
    leading?: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
    onSubmit?: () => void;
    width?: "md" | "lg";
}

export const RecordPanel = ({ isOpen, onOpenChange, title, description, leading, children, footer, onSubmit, width = "md" }: RecordPanelProps) => (
    // Built from SlideoutMenu's parts rather than SlideoutMenu itself: its className is applied to the
    // overlay as well as the panel, so a width there would shrink the overlay.
    <ModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable className="z-50">
        <Modal className={cx(width === "lg" ? "max-w-140" : "max-w-110")}>
            <Dialog className="gap-0">
                {({ close }) => {
                    const content = (
                        <>
                            <SlideoutMenu.Header onClose={close} className="pb-5">
                                <div className="flex flex-col gap-3 pr-8">
                                    {leading}
                                    <div className="flex flex-col gap-0.5">
                                        <h2 slot="title" className="text-lg font-semibold text-primary">
                                            {title}
                                        </h2>
                                        {description && <div className="text-sm text-tertiary">{description}</div>}
                                    </div>
                                </div>
                            </SlideoutMenu.Header>
                            <SlideoutMenu.Content role="presentation" className="pb-6">
                                {children}
                            </SlideoutMenu.Content>
                            {footer && <SlideoutMenu.Footer className="flex flex-wrap items-center justify-end gap-3">{footer}</SlideoutMenu.Footer>}
                        </>
                    );
                    return onSubmit ? (
                        <form
                            noValidate
                            className="flex size-full flex-col"
                            onSubmit={(event: FormEvent) => {
                                event.preventDefault();
                                onSubmit();
                            }}
                        >
                            {content}
                        </form>
                    ) : (
                        <div className="flex size-full flex-col">{content}</div>
                    );
                }}
            </Dialog>
        </Modal>
    </ModalOverlay>
);
