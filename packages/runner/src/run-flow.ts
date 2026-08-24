import { chromium } from "playwright";
import type { Browser, BrowserContext, CDPSession } from "playwright";
import { mkdir, access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { HoolypaneConfigSchema } from "@hoolypane/contracts";
import { resolve, dirname, join } from "node:path";
import type { ResolvedHoolypaneConfig, ViewportSpec } from "@hoolypane/contracts";
import { createFlowContext } from "@hoolypane/flow";
import type { FlowDefinition, FlowEvent, Screen } from "@hoolypane/flow";
import { RecordingSession } from "@hoolypane/recorder";
import type { RecordingTarget, RecorderFailure } from "@hoolypane/recorder";
import { compileModule, validateConfigExport, validateFlowExport } from "./module-loader.js";
import type { CompiledModule } from "./module-loader.js";
import type { RunArguments } from "./cli-arguments.js";

interface RunnerDependencies {
  readonly createRecorder?: (config: ResolvedHoolypaneConfig, timeoutMs: number, outputDir: string) => RecordingSession;
  readonly chromiumType?: typeof chromium;
}

interface RunResult {
  readonly outputDir: string;
  readonly status: "success" | "failed" | "interrupted";
}

const defaultDependencies: RunnerDependencies = {};

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

export function validateResolvedConfig(config: unknown): ResolvedHoolypaneConfig {
  return HoolypaneConfigSchema.parse(config);
}

function resolveExport<T>(module: Record<string, unknown>, names: readonly string[], source: string): T {
  for (const name of names) if (module[name] !== undefined) return module[name] as T;
  throw new Error(`${source} must export ${names.join(" or ")}`);
}

function recorderTarget(id: string, viewport: ViewportSpec, cdp: CDPSession): RecordingTarget {
  const wrappers = new Map<(params: unknown) => void, (params: unknown) => void>();
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
      const wrapper = (params: unknown): void => listener(params);
      wrappers.set(listener, wrapper);
      cdp.on("Page.screencastFrame", wrapper);
    },
    off(event, listener): void {
      if (event !== "Page.screencastFrame") return;
      const wrapper = wrappers.get(listener);
      if (wrapper) cdp.off("Page.screencastFrame", wrapper);
      wrappers.delete(listener);
    },
  };
}

function failureFrom(error: unknown): RecorderFailure {
  if (error instanceof Error) return { message: error.message, ...(error.stack === undefined ? {} : { stack: error.stack }) };
  return { message: String(error) };
}

// User config/flow modules are user code: their top-level evaluation is bounded like the flow
// phase so a never-settling top-level await cannot hang the CLI before any deadline, output
// directory, or artifact exists. The config deadline matches the schema default for timeoutMs
// (the config itself defines the real flow deadline and is not known yet).
const MODULE_EVAL_TIMEOUT_MS = 30_000;

async function evaluateModule(path: string, deadlineMs: number, source: string): Promise<Record<string, unknown>> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error(`${source} module evaluation exceeded ${deadlineMs}ms (top-level await never settled?)`)), deadlineMs);
  try {
    return (await Promise.race([import(`${pathToFileURL(path).href}?run=${Date.now()}`), deadline.promise])) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

export async function runFlow(args: RunArguments, dependencies: RunnerDependencies = defaultDependencies): Promise<RunResult> {
  const projectDir = dirname(resolve(args.flowFile));
  const flowPath = resolve(args.flowFile);
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
    const config = validateResolvedConfig(configCandidate);
    const flowModule = await evaluateModule(flowCompiled.path, config.timeoutMs, flowPath);
    const flow = resolveExport<FlowDefinition>(flowModule, ["default", "flow"], flowPath);
    validateFlowExport(flow, flowPath);
    const outputDir = resolve(args.outputDir ?? config.recording.outputDir);
    await mkdir(join(outputDir, "traces"), { recursive: true });
    const browserType = dependencies.chromiumType ?? chromium;
    try {
      browser = await browserType.launch({ headless: !args.headed, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/executable|browser.*(not|missing)|ENOENT/i.test(message)) throw new Error(`${message}\nInstall the pinned Chromium browser with: npx playwright install chromium`);
      throw error;
    }
    const screens: Screen[] = [];
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
      recorder = dependencies.createRecorder?.(config, config.timeoutMs, outputDir) ?? new RecordingSession({ recording: config.recording, timeoutMs: config.timeoutMs, outputDir });
      await recorder.start(targets);
    }
    let flowError: unknown;
    let flowFailed = false;
    let timedOut = false;
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
      const results = await Promise.allSettled(contexts.map((context, index) => context.tracing.stop({ path: join(outputDir, "traces", `${config.viewports[index]?.id ?? index}.zip`) })));
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
        // contents are intact, so there is nothing to finalize.
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
      const finalizeResult = await recorder.finalize({ status: traceFailed ? "failed" : interrupted ? "interrupted" : flowFailed ? "failed" : "success", failures, events: finalizedEvents });
      recorderFinalized = true;
      // captureFailures (a pane's screencast ending early) flip the manifest to "failed" even when the flow
      // itself succeeded; the CLI must not exit 0 while the written manifest reports a failed recording.
      manifestFailed = finalizeResult.kind === "manifest" && finalizeResult.manifest.status === "failed";
    } finally {
      for (const failure of await stopTraces()) process.stderr.write(`tracing.stop failed: ${failure.message}\n`);
      clearTimeout(signalDeadline);
    }
    return { outputDir, status: manifestFailed || traceFailed ? "failed" : interrupted ? "interrupted" : flowFailed ? "failed" : "success" };
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    clearTimeout(signalDeadline);
    initialFramesAbort.abort();
    await Promise.allSettled([...contexts.map((context) => context.close()), browser?.close()]);
    if (recorder && !recorderFinalized) {
      try { await recorder.finalize({ status: "failed", failures: [], events: [] }); } catch { /* best effort */ }
    }
    await Promise.allSettled([flowCompiled.cleanup(), configCompiled.cleanup()]);
  }
}
