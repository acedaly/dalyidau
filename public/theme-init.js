(function () {
    try {
        var stored = localStorage.getItem("ui-theme");
        var dark = stored === "dark" || (stored !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
        document.documentElement.classList.toggle("dark-mode", dark);
    } catch (e) {}
})();
