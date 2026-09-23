import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Inter ships in the binary: the stylesheet asks for its cv05 and ss03, which
// no fallback has, and a machine without it installed drew Segoe instead.
import "@fontsource-variable/inter/wght.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
