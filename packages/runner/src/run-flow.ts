import { chromium } from "playwright";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { mkdir, access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { HoolypaneConfigSchema, errorMessage } from "@hoolypane/contracts";
import { resolve, dirname, join } from "node:path";
import type { FlowEvent, ResolvedHoolypaneConfig, ViewportSpec } from "@hoolypane/contracts";
import { createFlowContext } from "@hoolypane/flow";
import type { FlowDefinition } from "@hoolypane/flow";
import { RecordingSession } from "@hoolypane/recorder";
import type { RecordingTarget, RecorderFailure } from "@hoolypane/recorder";
import { compileModule, validateConfigExport, validateFlowExport } from "./module-loader.js";
import type { CompiledModule } from "./module-loader.js";
import type { RunArguments } from "./cli-arguments.js";

interface RunResult {
  readonly outputDir: string;
  readonly status: "success" | "failed" | "interrupted";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

export function buildContextOptions(config: ResolvedHoolypaneConfig, viewport: ViewportSpec): Parameters<Browser["newContext"]>[0] {
  return {
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    isMobile: viewport.isMobile,
    hasTouch: viewport.hasTouch,
    ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
    ...(config.storageState === undefined ? {} : { storageState: config.storageState }),
  };
}

function resolveExport<T>(module: Record<string, unknown>, names: readonly string[], source: string): T {
  for (const name of names) if (module[name] !== undefined) return module[name] as T;
  throw new Error(`${source} must export ${names.join(" or ")}`);
}

function recorderTarget(id: string, viewport: ViewportSpec, cdp: CDPSession): RecordingTarget {
  return {
    id,
    viewport,
    async send(method, params): Promise<unknown> {
      if (method === "Page.stopScreencast") return cdp.send("Page.stopScreencast");
      if (method === "Page.screencastFrameAck") {
        const sessionId = params?.sessionId;
        if (typeof sessionId !== "number") throw new Error("Page.screencastFrameAck requires a numeric sessionId");
        return cdp.send("Page.screencastFrameAck", { sessionId });
      }
      if (method === "Page.startScreencast") {
        const quality = params?.quality;
        const maxWidth = params?.maxWidth;
        const maxHeight = params?.maxHeight;
        const everyNthFrame = params?.everyNthFrame;
        if (typeof quality !== "number" || typeof maxWidth !== "number" || typeof maxHeight !== "number" || typeof everyNthFrame !== "number") {
          throw new Error("Page.startScreencast requires numeric quality and geometry");
        }
        return cdp.send("Page.startScreencast", { format: "jpeg", quality, maxWidth, maxHeight, everyNthFrame });
      }
      throw new Error(`unsupported recorder CDP command: ${method}`);
    },
    on(event, listener): void {
      if (event !== "Page.screencastFrame") throw new Error(`unsupported recorder CDP event: ${event}`);
      cdp.on("Page.screencastFrame", listener);
    },
    off(event, listener): void {
      if (event !== "Page.screencastFrame") return;
      cdp.off("Page.screencastFrame", listener);
    },
  };
}

function failureFrom(error: unknown): RecorderFailure {
  const message = errorMessage(error);
  return error instanceof Error && error.stack !== undefined ? { message, stack: error.stack } : { message };
}

// User config/flow modules are user code: their top-level evaluation is bounded like the flow
// phase so a never-settling top-level await cannot hang the CLI before any deadline, output
// directory, or artifact exists. Derived straight from the schema default for timeoutMs so the
// two cannot drift (the config itself defines the real flow deadline and is not known yet).
const MODULE_EVAL_TIMEOUT_MS = HoolypaneConfigSchema.pick({ timeoutMs: true }).parse({}).timeoutMs;

async function evaluateModule(path: string, deadlineMs: number, source: string): Promise<Record<string, unknown>> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error(`${source} module evaluation exceeded ${deadlineMs}ms (top-level await never settled?)`)), deadlineMs);
  try {
    return (await Promise.race([import(`${pathToFileURL(path).href}?run=${Date.now()}`), deadline.promise])) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

export async function runFlow(args: RunArguments): Promise<RunResult> {
  const flowPath = resolve(args.flowFile);
  const projectDir = dirname(flowPath);
  if (!(await exists(flowPath))) throw new Error(`Flow file not found: ${flowPath}`);
  const configPath = resolve(args.configFile);
  const cacheDir = resolve(projectDir, ".hoolypane/cache");
  const settledModules = await Promise.allSettled([compileModule(flowPath, cacheDir), compileModule(configPath, cacheDir)]);
  const compiledModules: CompiledModule[] = [];
  for (const settled of settledModules) {
    if (settled.status === "rejected") {
      await Promise.allSettled(compiledModules.map((module) => module.cleanup()));
      throw settled.reason;
    }
    compiledModules.push(settled.value);
  }
  const flowCompiled = compiledModules[0]!;
  const configCompiled = compiledModules[1]!;
  let browser: Browser | undefined;
  const contexts: BrowserContext[] = [];
  let interrupted = false;
  let signalDeadline: ReturnType<typeof setTimeout> | undefined;
  // Cooperative cancellation for the user flow itself: createFlowContext checks this between steps.
  const flowAbort = new AbortController();
  const signal = Promise.withResolvers<void>();
  const onSignal = (): void => {
    // A second SIGINT/SIGTERM means "stop now": bypass graceful teardown like the force timer below.
    if (interrupted) process.exit(130);
    interrupted = true;
    flowAbort.abort();
    signal.resolve();
    signalDeadline = setTimeout(() => process.exit(130), 10_000);
  };
  const initialFramesAbort = new AbortController();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let recorder: RecordingSession | undefined;
  let recorderFinalized = false;
  let manifestFailed = false;
  let traceFailed = false;
  try {
    // The specifiers are only known at runtime: freshly compiled cache artifacts with a cache-busting query.
    const configModule = await evaluateModule(configCompiled.path, MODULE_EVAL_TIMEOUT_MS, configPath);
    const configCandidate = resolveExport<unknown>(configModule, ["default", "config"], configPath);
    validateConfigExport(configCandidate, configPath);
    const config = HoolypaneConfigSchema.parse(configCandidate);
    const flowModule = await evaluateModule(flowCompiled.path, config.timeoutMs, flowPath);
    const flow = resolveExport<FlowDefinition>(flowModule, ["default", "flow"], flowPath);
    validateFlowExport(flow, flowPath);
    const outputDir = resolve(args.outputDir ?? config.recording.outputDir);
    await mkdir(join(outputDir, "traces"), { recursive: true });
    try {
      browser = await chromium.launch({ headless: !args.headed, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    } catch (error) {
      const message = errorMessage(error);
      if (/executable|browser.*(not|missing)|ENOENT/i.test(message)) throw new Error(`${message}\nInstall the pinned Chromium browser with: npx playwright install chromium`);
      throw error;
    }
    const screens: { id: string; viewport: ViewportSpec; page: Page }[] = [];
    const targets: RecordingTarget[] = [];
    let tracesStopped = false;
    for (const viewport of config.viewports) {
      if (interrupted) break;
      const context = await browser.newContext(buildContextOptions(config, viewport));
      contexts.push(context);
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      targets.push(recorderTarget(viewport.id, viewport, cdp));
      screens.push({ id: viewport.id, viewport, page });
    }
    // recorder.start() wipes the output directory: a SIGINT during browser/context setup must
    // never reach it, or a rerun into the same --output dir destroys the previous recording.
    if (!interrupted) {
      recorder = new RecordingSession({ recording: config.recording, timeoutMs: config.timeoutMs, outputDir });
      await recorder.start(targets);
    }
    let flowError: unknown;
    let flowFailed = false;
    let timedOut = false;
    // Single source of truth for run-status precedence: capture/trace failures beat interruption,
    // which beats flow failure. manifestFailed is only set after finalize, so it is false there.
    const statusFor = (): RunResult["status"] => (manifestFailed || traceFailed ? "failed" : interrupted ? "interrupted" : flowFailed ? "failed" : "success");
    // Once the race below picks a terminal outcome, late settlements (an orphaned flow rejecting
    // after SIGINT or timeout) must not overwrite status or failures.
    let outcomeDecided = false;
    const recordFlowFailure = (error: unknown): void => {
      if (outcomeDecided) return;
      flowFailed = true;
      flowError = error;
    };
    const flowEvents: FlowEvent[] = [];
    // Snapshotted when the race ends early so post-interrupt event pushes cannot pollute finalize.
    let finalizedEvents: FlowEvent[] = flowEvents;
    const stopTraces = async (): Promise<readonly RecorderFailure[]> => {
      if (tracesStopped) return [];
      tracesStopped = true;
      const results = await Promise.allSettled(contexts.map((context, index) => context.tracing.stop({ path: join(outputDir, "traces", `${config.viewports[index]!.id}.zip`) })));
      return results.flatMap((result) => (result.status === "rejected" ? [failureFrom(result.reason)] : []));
    };
    try {
      if (!interrupted && recorder !== undefined) {
        const initial = recorder.awaitInitialFrames(initialFramesAbort.signal).then(() => "ready" as const, (error: unknown) => {
          flowError = error;
          if (!interrupted) flowFailed = true;
          return "failed" as const;
        });
        const initialOutcome = await Promise.race([initial, signal.promise.then(() => "interrupted" as const)]);
        if (initialOutcome === "ready" && !interrupted) {
          recorder.markFlowStart();
          const flowAbortSignal = flowAbort.signal;
          const execution = Promise.resolve()
            .then(() => flow.run(createFlowContext(screens, (event) => flowEvents.push(event), flowAbortSignal)))
            .catch((error: unknown) => {
              recordFlowFailure(error);
            });
          // config.timeoutMs bounds the OVERALL flow execution; without a winner an endless user
          // flow would keep recording forever while artifacts stay unwritten.
          const timeoutSettled = Promise.withResolvers<"timeout">();
          const timeoutTimer = setTimeout(() => timeoutSettled.resolve("timeout"), config.timeoutMs);
          const raced = await Promise.race([
            execution.then(() => "executed" as const),
            signal.promise.then(() => "interrupted" as const),
            timeoutSettled.promise,
          ]);
          clearTimeout(timeoutTimer);
          outcomeDecided = true;
          if (raced === "timeout") {
            timedOut = true;
            flowFailed = true;
            flowAbort.abort();
            finalizedEvents = flowEvents.slice();
          } else if (raced === "interrupted") {
            finalizedEvents = flowEvents.slice();
          }
        }
      }
      if (recorder === undefined) {
        // Interrupted during setup: no recording started and the previous output directory
        // contents must stay intact, so discard the partial traces instead of writing them
        // over the preserved directory. context.close() below drops the unfinished buffers.
        tracesStopped = true;
        return { outputDir, status: "interrupted" };
      }
      initialFramesAbort.abort();
      const traceFailures = await stopTraces();
      // tracing.stop failures (lost Playwright traces) must fail loudly like captureFailures do:
      // they land in manifest.failures AND flip the manifest status and the runner exit code.
      traceFailed = traceFailures.length > 0;
      const failures: RecorderFailure[] = [...traceFailures];
      if (timedOut) {
        failures.push({ message: `flow timed out after ${config.timeoutMs}ms` });
      } else if (flowFailed) {
        failures.push(failureFrom(flowError));
      }
      if (interrupted) failures.push({ message: "Interrupted by SIGINT or SIGTERM" });
      const finalizeResult = await recorder.finalize({ status: statusFor(), failures, events: finalizedEvents });
      recorderFinalized = true;
      // captureFailures (a pane's screencast ending early) flip the manifest to "failed" even when the flow
      // itself succeeded; the CLI must not exit 0 while the written manifest reports a failed recording.
      manifestFailed = finalizeResult.kind === "manifest" && finalizeResult.manifest.status === "failed";
    } finally {
      for (const failure of await stopTraces()) process.stderr.write(`tracing.stop failed: ${failure.message}\n`);
    }
    return { outputDir, status: statusFor() };
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    initialFramesAbort.abort();
    await Promise.allSettled([...contexts.map((context) => context.close()), browser?.close()]);
    if (recorder && !recorderFinalized) {
      try { await recorder.finalize({ status: "failed", failures: [], events: [] }); } catch { /* best effort */ }
    }
    await Promise.allSettled([flowCompiled.cleanup(), configCompiled.cleanup()]);
    // Disarm the force-exit backstop only after every teardown await has settled: a wedged
    // close(), finalize(), or cleanup() must still be bounded by the documented 10s window.
    clearTimeout(signalDeadline);
  }
}
