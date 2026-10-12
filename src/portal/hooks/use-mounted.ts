import { useEffect, useState } from "react";

/**
 * False during the server render and the hydration pass, true afterwards. Use it for anything that
 * depends on the browser (measured charts, "3 minutes ago") so hydration always matches.
 */
export const useMounted = () => {
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    return mounted;
};
