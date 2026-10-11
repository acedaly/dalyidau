import type { ReactNode } from "react";
import { FaceSmile } from "@untitledui/icons";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";

// Untitled UI PRO "content-section-simple-01": heading and lede on the left, prose on the right.
// Takes its copy as props; used for the About page.
export const ContentSectionSimple01 = ({ title, lede, children }: { title: string; lede: string; children: ReactNode }) => {
    return (
        <section className="bg-primary pt-12 pb-16 md:pt-20 md:pb-24">
            <div className="mx-auto max-w-container px-4 md:px-8">
                <div className="grid grid-cols-1 gap-10 md:gap-16 lg:grid-cols-[1fr_1.15fr]">
                    <div className="max-w-3xl lg:sticky lg:top-32 lg:self-start">
                        <FeaturedIcon className="hidden md:flex" size="xl" icon={FaceSmile} theme="light" color="brand" />
                        <FeaturedIcon className="md:hidden" size="lg" icon={FaceSmile} theme="light" color="brand" />

                        <h1 className="mt-5 text-display-md font-semibold text-primary md:text-display-lg">{title}</h1>
                        <p className="mt-4 text-lg text-tertiary md:mt-5 md:text-xl">{lede}</p>
                    </div>

                    <div className="prose md:prose-lg">{children}</div>
                </div>
            </div>
        </section>
    );
};
