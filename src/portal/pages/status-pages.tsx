import { ArrowLeft, Lock01, SearchLg } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Empty } from "@/portal/components/empty";

export const NotFoundPage = () => (
    <div className="py-16">
        <Empty
            icon={SearchLg}
            title="Page not found"
            description="This part of the portal doesn't exist, or the record was deleted."
            actions={
                <Button href="/portal/wedding" color="secondary" iconLeading={ArrowLeft}>
                    Back to the dashboard
                </Button>
            }
        />
    </div>
);

export const ForbiddenPage = ({ message }: { message: string }) => (
    <div className="py-16">
        <Empty
            icon={Lock01}
            title="Not available"
            description={message}
            actions={
                <Button href="/portal/wedding" color="secondary" iconLeading={ArrowLeft}>
                    Back to the dashboard
                </Button>
            }
        />
    </div>
);
