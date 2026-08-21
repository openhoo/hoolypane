import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { resolveEncoders } from "./encoder.js";

export interface VerificationResult {
  readonly success: boolean;
  readonly geometry: readonly { file: string; width: number; height: number; timeBase: string }[];
  readonly artifacts: Record<string, string>;
  readonly sha256: Record<string, string>;
  readonly ptsVector?: readonly string[];
  readonly error?: string;
}

interface ProbePacket { readonly pts?: number | string; readonly duration?: number | string }
interface ProbeFrame { readonly best_effort_timestamp?: number | string }
interface ProbeStream { readonly time_base?: string; readonly width?: number; readonly height?: number; readonly duration_ts?: number | string }
interface PacketOutput { readonly streams?: readonly ProbeStream[]; readonly packets?: readonly ProbePacket[] }
interface FrameOutput { readonly frames?: readonly ProbeFrame[] }

async function ffprobeJson(executable: string, args: readonly string[]): Promise<unknown> {
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  const completion = Promise.withResolvers<void>();
  child.once("error", completion.reject);
  child.once("close", (code: number | null) => code === 0 ? completion.resolve() : completion.reject(new Error(`${executable} exited ${code}: ${stderr}`)));
  await completion.promise;
  try { return JSON.parse(stdout); } catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stdout.slice(0, 1000)}`); }
}

async function probe(executable: string, file: string): Promise<{ stream: ProbeStream; frames: readonly ProbeFrame[]; packets: readonly ProbePacket[] }> {
  const [packetData, frameData] = await Promise.all([
    ffprobeJson(executable, ["-v", "error", "-select_streams", "v:0", "-show_streams", "-show_packets", "-show_entries", "stream=time_base,width,height,duration_ts:packet=pts,duration", "-of", "json", file]),
    ffprobeJson(executable, ["-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=best_effort_timestamp", "-of", "json", file]),
  ]);
  const packets = packetData as PacketOutput;
  const frames = frameData as FrameOutput;
  const stream = packets.streams?.[0];
  if (!stream?.time_base) throw new Error(`ffprobe returned no video time base for ${file}`);
  return { stream, frames: frames.frames ?? [], packets: packets.packets ?? [] };
}

function exactPtsVector(stream: ProbeStream, packets: readonly ProbePacket[]): string[] {
  const [numeratorText, denominatorText] = stream.time_base!.split("/");
  const numerator = BigInt(numeratorText!);
  const denominator = BigInt(denominatorText!);
  return packets.map((packet, index) => {
    if (packet.pts === undefined) throw new Error(`packet ${index} lacks integer PTS`);
    const next = packets[index + 1]?.pts;
    const previous = packets[index - 1]?.pts;
    const inferred = next === undefined ? previous === undefined ? undefined : BigInt(packet.pts) - BigInt(previous) : BigInt(next) - BigInt(packet.pts);
    const duration = packet.duration === undefined ? inferred : BigInt(packet.duration);
    if (duration === undefined || duration <= 0n) throw new Error(`packet ${index} lacks positive duration`);
    return `${BigInt(packet.pts) * numerator}/${denominator}|${duration * numerator}/${denominator}`;
  });
}

export async function verifyArtifacts(outputDir: string, _fps: 30 | 60, durationFrames: number): Promise<VerificationResult> {
  try {
    const encoders = await resolveEncoders();
    const names = (await readdir(join(outputDir, "videos"))).filter((file) => file.endsWith(".webm")).sort();
    if (names.length === 0) throw new Error("no encoded WebM artifacts");
    const probed = await Promise.all(names.map((name) => probe(encoders.ffprobe, join(outputDir, "videos", name))));
    if (probed.some(({ frames }) => frames.length !== durationFrames)) throw new Error("decoded frame count mismatch");
    const vectors = probed.map(({ stream, packets }) => exactPtsVector(stream, packets));
    if (vectors.some((vector) => vector.length !== durationFrames)) throw new Error("packet frame count mismatch");
    const expected = vectors[0]!;
    if (!expected[0]?.startsWith("0/")) throw new Error("output timeline does not start at zero");
    if (vectors.some((vector) => vector.length !== expected.length || vector.some((entry, index) => entry !== expected[index]))) throw new Error("exact PTS/duration vectors differ");
    const [lastPtsText, lastDurationText] = expected.at(-1)!.split("|");
    const endTicks = BigInt(lastPtsText!.split("/")[0]!) + BigInt(lastDurationText!.split("/")[0]!);
    if (endTicks <= 0n) throw new Error("stream end time is not positive");
    const artifacts: Record<string, string> = {};
    const hashes: Record<string, string> = {};
    for (const name of names) {
      const path = join(outputDir, "videos", name);
      const key = relative(outputDir, path);
      artifacts[key] = key;
      hashes[key] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
    return {
      success: true,
      geometry: probed.map(({ stream }, index) => ({ file: names[index]!, width: stream.width ?? 0, height: stream.height ?? 0, timeBase: stream.time_base! })),
      artifacts,
      sha256: hashes,
      ptsVector: expected,
    };
  } catch (error) {
    return { success: false, geometry: [], artifacts: {}, sha256: {}, error: error instanceof Error ? error.message : String(error) };
  }
}
