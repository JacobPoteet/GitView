import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Inter ships in the binary: the stylesheet asks for its cv05 and ss03, which
// no fallback has, and a machine without it installed drew Segoe instead.
import "@fontsource-variable/inter/wght.css";
// The terminal's faces ship too, regular and bold, Latin only.
import "@fontsource/cascadia-code/latin-400.css";
import "@fontsource/cascadia-code/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "@fontsource/fira-code/latin-400.css";
import "@fontsource/fira-code/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-700.css";
import "./styles.css";
import "./theme-win98.css";
import { settings, subscribeSettings } from "./lib/settings";
import { applyTheme } from "./lib/themes";

// Before the first render, so the window never paints one theme and then another.
applyTheme(settings().appearance.theme);
subscribeSettings(() => applyTheme(settings().appearance.theme));

// A face that has not loaded when the terminal measures its cell gives a grid
// of the wrong width, so the chosen one is asked for before the first render.
// A second is the most it may hold the window.
const face = settings().terminal.fontFamily;
Promise.race([
  Promise.all([
    document.fonts.load(`12.5px "${face}"`),
    document.fonts.load(`bold 12.5px "${face}"`),
  ]),
  new Promise((resolve) => window.setTimeout(resolve, 1000)),
])
  .catch(() => undefined)
  .then(() => {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
