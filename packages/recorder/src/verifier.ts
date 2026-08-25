import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { TrackGeometry } from "./capture-contract.js";
import { resolveEncoders } from "./encoder.js";

interface VerificationResult {
  readonly success: boolean;
  readonly geometry: readonly { file: string; width: number; height: number; timeBase: string }[];
  readonly artifacts: Record<string, string>;
  readonly sha256: Record<string, string>;
  readonly ptsVector?: readonly string[];
  readonly error?: string;
}

interface ExpectedArtifacts {
  readonly tracks: readonly TrackGeometry[];
  readonly composite: { readonly width: number; readonly height: number };
}

interface ProbePacket { readonly pts?: number | string; readonly duration?: number | string }
interface ProbeStream { readonly time_base?: string; readonly width?: number; readonly height?: number; readonly duration_ts?: number | string }
interface PacketOutput { readonly streams?: readonly ProbeStream[]; readonly packets?: readonly ProbePacket[] }

const CHILD_GRACE_MS = 10_000;

async function ffprobeJson(executable: string, args: readonly string[]): Promise<unknown> {
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  const completion = Promise.withResolvers<void>();
  child.once("error", completion.reject);
  child.once("close", (code: number | null) => code === 0 ? completion.resolve() : completion.reject(new Error(`${executable} exited ${code}: ${stderr}`)));
  const watchdog = setTimeout(() => {
    completion.reject(new Error(`${executable} did not exit within ${CHILD_GRACE_MS}ms; sending SIGKILL`));
    child.kill("SIGKILL");
  }, CHILD_GRACE_MS);
  try {
    await completion.promise;
  } finally {
    clearTimeout(watchdog);
  }
  try { return JSON.parse(stdout); } catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stdout.slice(0, 1000)}`); }
}

async function probe(executable: string, file: string): Promise<{ stream: ProbeStream; packets: readonly ProbePacket[] }> {
  const data = await ffprobeJson(executable, ["-v", "error", "-select_streams", "v:0", "-show_streams", "-show_packets", "-show_entries", "stream=time_base,width,height,duration_ts:packet=pts,duration", "-of", "json", file]) as PacketOutput;
  const stream = data.streams?.[0];
  if (!stream?.time_base) throw new Error(`ffprobe returned no video time base for ${file}`);
  return { stream, packets: data.packets ?? [] };
}

export async function sha256File(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function timeBaseTicks(timeBase: string): { numerator: bigint; denominator: bigint } {
  const [numeratorText, denominatorText] = timeBase.split("/");
  const numerator = BigInt(numeratorText ?? "");
  const denominator = BigInt(denominatorText ?? "");
  if (denominator <= 0n || numerator <= 0n) throw new Error(`invalid stream time base: ${timeBase}`);
  return { numerator, denominator };
}

function exactPtsVector(stream: ProbeStream, packets: readonly ProbePacket[], fps: 30 | 60): { entries: string[]; ticks: bigint[] } {
  const { numerator, denominator } = timeBaseTicks(stream.time_base!);
  const ticks: bigint[] = [];
  const entries = packets.map((packet, index) => {
    if (packet.pts === undefined) throw new Error(`packet ${index} lacks integer PTS`);
    const next = packets[index + 1]?.pts;
    const previous = packets[index - 1]?.pts;
    const inferred = next === undefined ? previous === undefined ? undefined : BigInt(packet.pts) - BigInt(previous) : BigInt(next) - BigInt(packet.pts);
    let duration = packet.duration === undefined ? inferred : BigInt(packet.duration);
    if (duration === undefined) {
      // A lone packet has no neighbor to infer from and the pinned container stores no durations;
      // accept it at the ideal constant-frame-rate slot duration instead of rejecting a valid artifact.
      if (packets.length !== 1) throw new Error(`packet ${index} lacks positive duration`);
      const [firstTick, secondTick] = idealPtsTicks(stream.time_base!, fps, 2);
      duration = secondTick! - firstTick!;
    }
    if (duration <= 0n) throw new Error(`packet ${index} lacks positive duration`);
    ticks.push(BigInt(packet.pts));
    return `${BigInt(packet.pts) * numerator}/${denominator}|${duration * numerator}/${denominator}`;
  });
  return { entries, ticks };
}

// Constant-frame-rate expectation: slot k sits at k·(1e6/fps) µs, expressed in the stream time base with
// nearest-tick rounding (matches the libwebm rescale of setpts=N/(fps*TB)). Durations are not stored by the
// pinned container and are verified via consecutive PTS deltas inside exactPtsVector.
function idealPtsTicks(timeBase: string, fps: 30 | 60, durationFrames: number): bigint[] {
  const { numerator, denominator } = timeBaseTicks(timeBase);
  const divisor = BigInt(fps) * denominator;
  return Array.from({ length: durationFrames }, (_unused, slot) => {
    const scaled = BigInt(slot) * 1_000_000n * numerator;
    return (scaled * 2n + divisor) / (divisor * 2n);
  });
}

export async function verifyArtifacts(outputDir: string, fps: 30 | 60, durationFrames: number, expected?: ExpectedArtifacts): Promise<VerificationResult> {
  try {
    const encoders = await resolveEncoders();
    const names = (await readdir(join(outputDir, "videos"))).filter((file) => file.endsWith(".webm")).sort();
    if (names.length === 0) throw new Error("no encoded WebM artifacts");
    if (expected) {
      const expectedNames = [...expected.tracks.map((track) => `${track.id}.webm`), "composite.webm"].sort();
      if (names.join("\u0000") !== expectedNames.join("\u0000")) {
        throw new Error(`artifact set mismatch: expected ${expectedNames.join(", ")}, found ${names.join(", ")}`);
      }
    }
    const probed = await Promise.all(names.map((name) => probe(encoders.ffprobe, join(outputDir, "videos", name))));
    const vectors = probed.map(({ stream, packets }) => {
      if (packets.length !== durationFrames) throw new Error("packet frame count mismatch");
      return exactPtsVector(stream, packets, fps);
    });
    const [firstVector] = vectors;
    if (!firstVector) throw new Error("no encoded WebM artifacts");
    const idealTicks = idealPtsTicks(probed[0]!.stream.time_base!, fps, durationFrames);
    for (const { ticks } of vectors) {
      for (let index = 0; index < ticks.length; index += 1) {
        if (ticks[index] !== idealTicks[index]) {
          throw new Error(`packet ${index} pts ${ticks[index]} deviates from the ${fps} fps constant-frame-rate timeline (${idealTicks[index]} ticks)`);
        }
      }
    }
    const geometry = probed.map(({ stream }, index) => {
      if (stream.width === undefined || stream.height === undefined || stream.width <= 0 || stream.height <= 0) {
        throw new Error(`ffprobe returned no dimensions for ${names[index]}`);
      }
      return { file: names[index]!, width: stream.width, height: stream.height, timeBase: stream.time_base! };
    });
    if (expected) {
      for (const track of expected.tracks) {
        const entry = geometry.find((item) => item.file === `${track.id}.webm`);
        if (!entry) throw new Error(`missing encoded track ${track.id}.webm`);
        if (entry.width !== track.encodedWidth || entry.height !== track.encodedHeight) {
          throw new Error(`${entry.file} geometry ${entry.width}x${entry.height} differs from expected ${track.encodedWidth}x${track.encodedHeight}`);
        }
      }
      const composite = geometry.find((item) => item.file === "composite.webm");
      if (!composite) throw new Error("missing encoded composite.webm");
      if (composite.width !== expected.composite.width || composite.height !== expected.composite.height) {
        throw new Error(`composite.webm geometry ${composite.width}x${composite.height} differs from expected ${expected.composite.width}x${expected.composite.height}`);
      }
    }
    const artifacts: Record<string, string> = {};
    const hashes: Record<string, string> = {};
    for (const name of names) {
      const path = join(outputDir, "videos", name);
      const key = relative(outputDir, path);
      hashes[key] = await sha256File(path);
      artifacts[key] = key;
    }
    return {
      success: true,
      geometry,
      artifacts,
      sha256: hashes,
      ptsVector: firstVector.entries,
    };
  } catch (error) {
    return { success: false, geometry: [], artifacts: {}, sha256: {}, error: error instanceof Error ? error.message : String(error) };
  }
}
