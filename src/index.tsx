import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Canva loads the JS bundle into an iframe that may not have a #root div.
// Create one if it doesn't exist.
let rootEl = document.getElementById("root");
if (!rootEl) {
  rootEl = document.createElement("div");
  rootEl.id = "root";
  rootEl.style.cssText = "width:100%;height:100%;margin:0;padding:0;";
  document.body.style.cssText = "margin:0;padding:0;background:#1a1a2e;";
  document.body.appendChild(rootEl);
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);
