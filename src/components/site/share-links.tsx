import { useState } from "react";
import { Check, Copy01, Mail01 } from "@untitledui/icons";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Facebook, LinkedIn, X } from "@/components/foundations/social-icons";

/** Share links work without JavaScript; the copy button needs it and is enhanced on hydration. */
export const ShareLinks = ({ url, title }: { url: string; title: string }) => {
    const [copied, setCopied] = useState(false);
    const encodedUrl = encodeURIComponent(url);
    const encodedTitle = encodeURIComponent(title);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard may be unavailable (insecure context); the URL is still in the address bar.
        }
    };

    const links = [
        { label: "Share on LinkedIn", href: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`, icon: LinkedIn },
        { label: "Share on X", href: `https://x.com/intent/post?url=${encodedUrl}&text=${encodedTitle}`, icon: X },
        { label: "Share on Facebook", href: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`, icon: Facebook },
    ];

    return (
        <div className="flex flex-wrap items-center gap-2">
            <ButtonUtility color="secondary" size="sm" tooltip={copied ? "Copied" : "Copy link"} icon={copied ? Check : Copy01} onPress={copy} />
            {links.map((link) => (
                <ButtonUtility
                    key={link.label}
                    color="secondary"
                    size="sm"
                    tooltip={link.label}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    icon={<link.icon data-icon size={20} className="text-fg-quaternary" />}
                />
            ))}
            <ButtonUtility color="secondary" size="sm" tooltip="Share by email" href={`mailto:?subject=${encodedTitle}&body=${encodedUrl}`} icon={Mail01} />
        </div>
    );
};
