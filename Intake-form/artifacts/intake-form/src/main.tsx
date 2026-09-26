import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { CONVERSION_BUILD_STATE } from "./lib/conversion";

// Observable build state for the conversion signal (see lib/conversion.ts).
document.documentElement.setAttribute("data-drsnip-conversion", CONVERSION_BUILD_STATE);

createRoot(document.getElementById("root")!).render(<App />);
