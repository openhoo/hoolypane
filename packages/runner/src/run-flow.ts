import { chromium } from "playwright";
import type { Browser, BrowserContext, Page, CDPSession } from "playwright";
import { mkdir, access } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { DEFAULT_RECORDING, HoolypaneConfigSchema } from "@hoolypane/contracts";
import type { ResolvedHoolypaneConfig, ViewportSpec } from "@hoolypane/contracts";
import { createFlowContext } from "@hoolypane/flow";
import type { FlowDefinition, FlowEvent, Screen } from "@hoolypane/flow";
import { RecordingSession } from "@hoolypane/recorder";
import type { RecordingTarget, RecorderFailure } from "@hoolypane/recorder";
import { compileModule, validateConfigExport, validateFlowExport } from "./module-loader.js";
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
  try { await access(path); return true; } catch { return false; }
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
  const parsed = HoolypaneConfigSchema.parse(config);
  const ids = new Set(parsed.viewports.map((viewport) => viewport.id));
  if (ids.size !== parsed.viewports.length) throw new Error("Configuration contains duplicate viewport IDs");
  if (parsed.viewports.length === 0) throw new Error("Configuration must contain at least one viewport");
  return {
    viewports: parsed.viewports,
    timeoutMs: parsed.timeoutMs,
    recording: {
      fps: parsed.recording.fps ?? DEFAULT_RECORDING.fps,
      jpegQuality: parsed.recording.jpegQuality ?? DEFAULT_RECORDING.jpegQuality,
      layout: parsed.recording.layout ?? DEFAULT_RECORDING.layout,
      compositeMaxSize: parsed.recording.compositeMaxSize ?? DEFAULT_RECORDING.compositeMaxSize,
      compositeBackground: parsed.recording.compositeBackground ?? DEFAULT_RECORDING.compositeBackground,
      outputDir: parsed.recording.outputDir ?? DEFAULT_RECORDING.outputDir,
      keepRaw: parsed.recording.keepRaw ?? DEFAULT_RECORDING.keepRaw,
    },
    ...(parsed.baseURL === undefined ? {} : { baseURL: parsed.baseURL }),
    ...(parsed.storageState === undefined ? {} : { storageState: parsed.storageState }),
  };
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

export async function runFlow(args: RunArguments, dependencies: RunnerDependencies = defaultDependencies): Promise<RunResult> {
  const projectDir = dirname(resolve(args.flowFile));
  const flowPath = resolve(args.flowFile);
  if (!(await exists(flowPath))) throw new Error(`Flow file not found: ${flowPath}`);
  const configPath = resolve(args.configFile);
  if (!(await exists(configPath))) throw new Error(`Config file not found: ${configPath}`);
  const cacheDir = resolve(projectDir, ".hoolypane/cache");
  const [flowCompiled, configCompiled] = await Promise.all([compileModule(flowPath, cacheDir), compileModule(configPath, cacheDir)]);
  let browser: Browser | undefined;
  const contexts: BrowserContext[] = [];
  let interrupted = false;
  let forced = false;
  let signalDeadline: ReturnType<typeof setTimeout> | undefined;
  const signal = Promise.withResolvers<void>();
  const onSignal = (): void => {
    if (interrupted) {
      forced = true;
      process.exitCode = 130;
      return;
    }
    interrupted = true;
    signal.resolve();
    signalDeadline = setTimeout(() => {
      forced = true;
      process.exitCode = 130;
    }, 10_000);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const configModule = (await import(`${configCompiled.path}?run=${Date.now()}`)) as Record<string, unknown>;
    const configCandidate = resolveExport<unknown>(configModule, ["default", "config"], configPath);
    validateConfigExport(configCandidate, configPath);
    const config = validateResolvedConfig(configCandidate);
    const flowModule = (await import(`${flowCompiled.path}?run=${Date.now()}`)) as Record<string, unknown>;
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
      const context = await browser.newContext(buildContextOptions(config, viewport));
      contexts.push(context);
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      targets.push(recorderTarget(viewport.id, viewport, cdp));
      screens.push({ id: viewport.id, viewport, page });
    }
    const recorder = dependencies.createRecorder?.(config, config.timeoutMs, outputDir) ?? new RecordingSession({ recording: config.recording, timeoutMs: config.timeoutMs, outputDir });
    await recorder.start(targets);
    let flowError: unknown;
    const flowEvents: FlowEvent[] = [];
    const stopTraces = async (): Promise<void> => {
      if (tracesStopped) return;
      tracesStopped = true;
      await Promise.allSettled(contexts.map((context, index) => context.tracing.stop({ path: join(outputDir, "traces", `${config.viewports[index]?.id ?? index}.zip`) })));
    };
    try {
      if (!interrupted) {
        const initial = recorder.awaitInitialFrames().then(() => "ready" as const, (error: unknown) => {
          flowError = error;
          return "failed" as const;
        });
        const initialOutcome = await Promise.race([initial, signal.promise.then(() => "interrupted" as const)]);
        if (initialOutcome === "ready" && !interrupted) {
          recorder.markFlowStart();
          const execution = flow.run(createFlowContext(screens, (event) => flowEvents.push(event))).catch((error: unknown) => { flowError = error; });
          await Promise.race([execution, signal.promise]);
          void execution.catch(() => undefined);
        }
      }
      await stopTraces();
      const failures: RecorderFailure[] = [];
      if (flowError) failures.push(failureFrom(flowError));
      if (interrupted) failures.push({ message: "Interrupted by SIGINT or SIGTERM" });
      await recorder.finalize({ status: interrupted ? "interrupted" : flowError ? "failed" : "success", failures, events: flowEvents });
    } finally {
      await stopTraces();
      if (signalDeadline) clearTimeout(signalDeadline);
    }
    if (forced) process.exitCode = 130;
    return { outputDir, status: interrupted ? "interrupted" : flowError ? "failed" : "success" };
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (signalDeadline) clearTimeout(signalDeadline);
    await Promise.allSettled(contexts.map((context) => context.close()));
    await browser?.close();
    await Promise.allSettled([flowCompiled.cleanup(), configCompiled.cleanup()]);
  }
}
