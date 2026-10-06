import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "../app.css";
import {Theme} from "@astryxdesign/core/theme";
import {neutralTheme} from "@astryxdesign/theme-neutral/built";
import React from "react";
import {createRoot} from "react-dom/client";
import LiveTicketPreview from "./LiveTicketPreview.js";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Theme theme={neutralTheme} mode="dark">
      <LiveTicketPreview />
    </Theme>
  </React.StrictMode>,
);
