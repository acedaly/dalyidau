// Browser entry for /display (Intelligence Centre wallboards). Its own shell and bundle: a display
// loads no portal navigation, and reads only its own wallboard's data with its display credential.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DisplayApp } from "@/display/display-app";
import "@/styles/apps.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <DisplayApp />
    </StrictMode>,
);
