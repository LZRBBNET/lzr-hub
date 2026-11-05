#!/usr/bin/env node
// Inspect the environment already supplied to this process. Do not load .env
// files or run the staging wrapper first: it could hide inherited unsafe flags.
import { assessStagingReadiness } from "../lib/runtime/staging-readiness.ts";

const report = assessStagingReadiness(process.env);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === "blocked" ? 1 : 0;
