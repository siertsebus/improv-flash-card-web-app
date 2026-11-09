import { render } from "preact";
import { App } from "./App";
import { refresh } from "./store";
import "./styles.css";

void refresh().catch(() => {});

// Pick up changes made by the AI while the app was in the background (e.g. after dictating in Claude).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh().catch(() => {});
});

render(<App />, document.getElementById("app")!);
