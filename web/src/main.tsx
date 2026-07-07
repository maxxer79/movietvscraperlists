import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Start in dark mode by default; respect a saved preference if the user toggles.
const saved = localStorage.getItem("mtv_theme");
if (saved === "light") document.documentElement.classList.remove("dark");
else document.documentElement.classList.add("dark");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
