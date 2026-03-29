import path from "node:path";
import { main } from "./cli.js";
import type { AppError } from "./types.js";

// Detect if invoked as the deprecated `cc-continue` name
const binName = path.basename(process.argv[1] || "");
if (binName === "cc-continue" || binName === "cc-continue.mjs") {
  process.stderr.write(
    "\x1b[33mNote:\x1b[0m cc-continue has been renamed to \x1b[1mctx-switch\x1b[0m. Please use \x1b[36mctx-switch\x1b[0m going forward.\n\n"
  );
}

void main().catch((error: unknown) => {
  const appError = error as AppError;
  const message = appError?.message ? appError.message : String(error);
  console.error(`Error: ${message}`);
  if (Array.isArray(appError?.suggestions) && appError.suggestions.length > 0) {
    console.error("");
    console.error("Next Steps");
    for (const suggestion of appError.suggestions) {
      console.error(`- ${suggestion}`);
    }
  }
  process.exit(typeof appError?.exitCode === "number" ? appError.exitCode : 1);
});
