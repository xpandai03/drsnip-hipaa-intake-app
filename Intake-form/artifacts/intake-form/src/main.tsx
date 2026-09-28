import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { conversionBuildState } from "./lib/conversion";

// Observable build state for the conversion signal (see lib/conversion.ts).
document.documentElement.setAttribute("data-drsnip-conversion", conversionBuildState());

createRoot(document.getElementById("root")!).render(<App />);
