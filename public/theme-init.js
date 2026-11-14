(function () {
    try {
        var root = document.documentElement;
        // Pages with their own fixed palette (the wedding website) opt out of dark mode.
        if (root.getAttribute("data-theme-lock") === "light") {
            root.classList.remove("dark-mode");
            return;
        }
        var stored = localStorage.getItem("ui-theme");
        var dark = stored === "dark" || (stored !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
        root.classList.toggle("dark-mode", dark);
        // A theme chosen by hand overrides the device's, so the browser's own chrome must follow it too
        // (src/providers/theme-provider.tsx keeps it in step afterwards).
        if (stored === "dark" || stored === "light") {
            var metas = document.querySelectorAll('meta[name="theme-color"]');
            var chosen = document.querySelector('meta[name="theme-color"][media*="' + stored + '"]');
            for (var i = 0; chosen && i < metas.length; i++) {
                metas[i].setAttribute("data-content", metas[i].getAttribute("content"));
                if (metas[i] !== chosen) metas[i].setAttribute("content", chosen.getAttribute("content"));
            }
        }
    } catch (e) {}
})();
