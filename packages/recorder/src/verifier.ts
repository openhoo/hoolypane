import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@hoolypane/contracts";
import { ARTIFACT_DIRECTORIES, CHILD_GRACE_MS, COMPOSITE_VIDEO_NAME, trackVideoName, type TrackGeometry } from "./capture-contract.js";
import { awaitChildExit, resolveEncoders } from "./encoder.js";
import { certifyArtifact } from "./spool.js";

interface VerificationResult {
  readonly success: boolean;
  readonly geometry: readonly { file: string; width: number; height: number }[];
  readonly artifacts: Record<string, string>;
  readonly sha256: Record<string, string>;
  readonly error?: string;
}

interface ExpectedArtifacts {
  readonly tracks: readonly TrackGeometry[];
  readonly composite: { readonly width: number; readonly height: number };
}

interface ProbePacket { readonly pts?: number | string; readonly duration?: number | string }
interface ProbeStream { readonly time_base?: string; readonly width?: number; readonly height?: number }
interface PacketOutput { readonly streams?: readonly ProbeStream[]; readonly packets?: readonly ProbePacket[] }

async function ffprobeJson(executable: string, args: readonly string[]): Promise<unknown> {
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
  const { completion, stderrText } = awaitChildExit(child, child.stderr!, executable);
  const watchdog = setTimeout(() => {
    completion.reject(new Error(`${executable} did not exit within ${CHILD_GRACE_MS}ms; sending SIGKILL`));
    child.kill("SIGKILL");
  }, CHILD_GRACE_MS);
  try {
    await completion.promise;
  } finally {
    clearTimeout(watchdog);
  }
  try { return JSON.parse(stdout); } catch (error) { throw new Error(`${errorMessage(error)}\n${stdout.slice(0, 1000)}\n${stderrText()}`); }
}

async function probe(executable: string, file: string): Promise<{ stream: ProbeStream; packets: readonly ProbePacket[] }> {
  const data = await ffprobeJson(executable, ["-v", "error", "-select_streams", "v:0", "-show_streams", "-show_packets", "-show_entries", "stream=time_base,width,height:packet=pts,duration", "-of", "json", file]) as PacketOutput;
  const stream = data.streams?.[0];
  if (!stream?.time_base) throw new Error(`ffprobe returned no video time base for ${file}`);
  return { stream, packets: data.packets ?? [] };
}

function timeBaseTicks(timeBase: string): { numerator: bigint; denominator: bigint } {
  const [numeratorText, denominatorText] = timeBase.split("/");
  const numerator = BigInt(numeratorText ?? "");
  const denominator = BigInt(denominatorText ?? "");
  if (denominator <= 0n || numerator <= 0n) throw new Error(`invalid stream time base: ${timeBase}`);
  return { numerator, denominator };
}

function exactPtsVector(stream: ProbeStream, packets: readonly ProbePacket[], fps: 30 | 60): bigint[] {
  timeBaseTicks(stream.time_base!);
  // Slot-duration fallback for a lone packet with no neighbor gap to infer from; safe to compute
  // up front because timeBaseTicks above already validated the same time base this re-parses.
  const [firstTick, secondTick] = idealPtsTicks(stream.time_base!, fps, 2);
  const lonePacketDuration = secondTick! - firstTick!;
  const ticks: bigint[] = [];
  packets.forEach((packet, index) => {
    if (packet.pts === undefined) throw new Error(`packet ${index} lacks integer PTS`);
    const ownTicks = BigInt(packet.pts);
    const nextPts = packets[index + 1]?.pts;
    const previousPts = packets[index - 1]?.pts;
    // Reported duration wins over inference, which pays its neighbor BigInt parses only when the
    // container stores no durations; a lone packet with neither neighbor takes the ideal
    // constant-frame-rate slot duration instead of rejecting a valid artifact.
    const duration = packet.duration === undefined
      ? (nextPts !== undefined ? BigInt(nextPts) - ownTicks : previousPts !== undefined ? ownTicks - BigInt(previousPts) : lonePacketDuration)
      : BigInt(packet.duration);
    if (duration <= 0n) throw new Error(`packet ${index} lacks positive duration`);
    ticks.push(ownTicks);
  });
  return ticks;
}

// Constant-frame-rate expectation: slot k sits at k·(1e6/fps) µs, expressed in the stream time base with
// nearest-tick rounding (matches the libwebm rescale of setpts=N/(fps*TB)). verifyArtifacts checks each
// probed packet PTS against this slot vector; exactPtsVector produces those compared ticks and additionally
// enforces per-packet duration positivity.
function idealPtsTicks(timeBase: string, fps: 30 | 60, durationFrames: number): bigint[] {
  const { numerator, denominator } = timeBaseTicks(timeBase);
  const divisor = BigInt(fps) * denominator;
  return Array.from({ length: durationFrames }, (_unused, slot) => {
    const scaled = BigInt(slot) * 1_000_000n * numerator;
    return (scaled * 2n + divisor) / (divisor * 2n);
  });
}

function assertArtifactSet(names: readonly string[], expected?: ExpectedArtifacts): void {
  if (!expected) return;
  const expectedNames = [...expected.tracks.map((track) => trackVideoName(track.id)), COMPOSITE_VIDEO_NAME].sort();
  if (names.join("\u0000") !== expectedNames.join("\u0000")) {
    throw new Error(`artifact set mismatch: expected ${expectedNames.join(", ")}, found ${names.join(", ")}`);
  }
}

function assertConstantFrameRate(names: readonly string[], probed: readonly { stream: ProbeStream; packets: readonly ProbePacket[] }[], fps: 30 | 60, durationFrames: number): void {
  const vectors = probed.map(({ stream, packets }, index) => {
    if (packets.length !== durationFrames) throw new Error(`${names[index]}: packet frame count mismatch (${packets.length} probed, ${durationFrames} expected)`);
    return exactPtsVector(stream, packets, fps);
  });
  const idealTicks = idealPtsTicks(probed[0]!.stream.time_base!, fps, durationFrames);
  for (const [trackIndex, ticks] of vectors.entries()) {
    for (let index = 0; index < ticks.length; index += 1) {
      if (ticks[index] !== idealTicks[index]) {
        throw new Error(`${names[trackIndex]}: packet ${index} pts ${ticks[index]} deviates from the ${fps} fps constant-frame-rate timeline (${idealTicks[index]} ticks)`);
      }
    }
  }
}

function assertGeometry(geometry: readonly { file: string; width: number; height: number }[], expected: ExpectedArtifacts): void {
  for (const track of expected.tracks) {
    const entry = geometry.find((item) => item.file === trackVideoName(track.id))!;
    if (entry.width !== track.encodedWidth || entry.height !== track.encodedHeight) {
      throw new Error(`${entry.file} geometry ${entry.width}x${entry.height} differs from expected ${track.encodedWidth}x${track.encodedHeight}`);
    }
  }
  const composite = geometry.find((item) => item.file === COMPOSITE_VIDEO_NAME)!;
  if (composite.width !== expected.composite.width || composite.height !== expected.composite.height) {
    throw new Error(`composite.webm geometry ${composite.width}x${composite.height} differs from expected ${expected.composite.width}x${expected.composite.height}`);
  }
}

export async function verifyArtifacts(outputDir: string, fps: 30 | 60, durationFrames: number, expected?: ExpectedArtifacts): Promise<VerificationResult> {
  try {
    const encoders = await resolveEncoders();
    const names = (await readdir(join(outputDir, ARTIFACT_DIRECTORIES.videos))).filter((file) => file.endsWith(".webm")).sort();
    if (names.length === 0) throw new Error("no encoded WebM artifacts");
    assertArtifactSet(names, expected);
    const probed = await Promise.all(names.map((name) => probe(encoders.ffprobe, join(outputDir, ARTIFACT_DIRECTORIES.videos, name))));
    assertConstantFrameRate(names, probed, fps, durationFrames);
    const geometry = probed.map(({ stream }, index) => {
      if (stream.width === undefined || stream.height === undefined || stream.width <= 0 || stream.height <= 0) {
        throw new Error(`ffprobe returned no dimensions for ${names[index]}`);
      }
      return { file: names[index]!, width: stream.width, height: stream.height };
    });
    if (expected) assertGeometry(geometry, expected);
    const artifacts: Record<string, string> = {};
    const hashes: Record<string, string> = {};
    for (const name of names) await certifyArtifact(outputDir, ARTIFACT_DIRECTORIES.videos, name, artifacts, hashes);
    return {
      success: true,
      geometry,
      artifacts,
      sha256: hashes,
    };
  } catch (error) {
    return { success: false, geometry: [], artifacts: {}, sha256: {}, error: errorMessage(error) };
  }
}
