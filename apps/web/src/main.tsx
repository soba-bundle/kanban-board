import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ToastProvider } from "./components/ToastContext.js";
import { ToastViewport } from "./components/ToastViewport.js";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
      <ToastViewport />
    </ToastProvider>
  </React.StrictMode>,
);
