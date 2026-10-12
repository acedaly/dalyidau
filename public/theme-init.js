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
    } catch (e) {}
})();
