import { Feather, GraduationHat02, Lightbulb05, Tool02 } from "@untitledui/icons";
import { topics } from "@/content/site";
import { FeatureTextFeaturedIconTopLeft } from "./base-components/feature-text";

const icons = [GraduationHat02, Tool02, Lightbulb05, Feather];

// Untitled UI PRO "features-simple-icons-01", repurposed as a quiet list of what the blog covers.
// Left-aligned with a short heading so it reads as an introduction, not a product feature grid.
export const FeaturesSimpleIcons01 = () => {
    return (
        <section aria-labelledby="topics-heading" className="bg-secondary py-16 md:py-24">
            <div className="mx-auto w-full max-w-container px-4 md:px-8">
                <div className="max-w-3xl">
                    <p className="text-sm font-semibold text-brand-secondary md:text-md">What I write about</p>
                    <h2 id="topics-heading" className="mt-3 text-display-sm font-semibold text-primary md:text-display-md">
                        The sorts of things you'll find here
                    </h2>
                </div>
                <ul className="mt-12 grid w-full grid-cols-1 gap-x-8 gap-y-10 sm:grid-cols-2 md:mt-16 md:gap-y-12 lg:grid-cols-4">
                    {topics.map((topic, i) => (
                        <li key={topic.title}>
                            <FeatureTextFeaturedIconTopLeft icon={icons[i % icons.length]} title={topic.title} subtitle={topic.description} />
                        </li>
                    ))}
                </ul>
            </div>
        </section>
    );
};
