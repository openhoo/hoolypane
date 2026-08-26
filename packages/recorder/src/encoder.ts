import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { access, constants, mkdir } from "node:fs/promises";
import { join } from "node:path";
import ffmpegStaticPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { errorMessage, gridCellPosition } from "@hoolypane/contracts";
import { ARTIFACT_DIRECTORIES, asError, CHILD_GRACE_MS, COMPOSITE_VIDEO_NAME, compositeGeometry, trackVideoName, type CompositeGeometry, type SlotMapping, type TrackGeometry } from "./capture-contract.js";
import type { FrameSpool } from "./spool.js";

interface EncoderPaths { readonly ffmpeg: string; readonly ffprobe: string }
/** stdin fd of ffmpeg's first image2pipe input: stdio is [ignore, ignore, stderr pipe, ...input pipes]. */
const INPUT_PIPE_STDIO_BASE = 3;
interface AlignedTrack { readonly id: string; readonly spool: FrameSpool; readonly mappings: readonly SlotMapping[]; readonly geometry: TrackGeometry }
export interface EncodingResult { readonly geometry: CompositeGeometry }

async function executable(path: string, envVariable?: string): Promise<string> {
  try {
    await access(path, constants.X_OK);
  } catch (error) {
    if (!envVariable) throw error;
    throw new Error(`${envVariable}="${path}" is not an accessible executable: ${errorMessage(error)}`);
  }
  return path;
}

export async function resolveEncoders(): Promise<EncoderPaths> {
  const ffmpeg = process.env.HOOLYPANE_FFMPEG_PATH;
  const ffprobe = process.env.HOOLYPANE_FFPROBE_PATH;
  if (Boolean(ffmpeg) !== Boolean(ffprobe)) throw new Error("HOOLYPANE_FFMPEG_PATH and HOOLYPANE_FFPROBE_PATH must be supplied together");
  if (ffmpeg && ffprobe) return { ffmpeg: await executable(ffmpeg, "HOOLYPANE_FFMPEG_PATH"), ffprobe: await executable(ffprobe, "HOOLYPANE_FFPROBE_PATH") };
  try {
    const candidate: unknown = ffmpegStaticPath;
    if (typeof candidate !== "string" || !ffprobeStatic.path) throw new Error("static encoder paths unavailable");
    return { ffmpeg: await executable(candidate), ffprobe: await executable(ffprobeStatic.path) };
  } catch (error) {
    throw new Error(`unable to resolve ffmpeg/ffprobe: ${errorMessage(error)}`);
  }
}

export function filterGraph(tracks: readonly AlignedTrack[], grid: CompositeGeometry, fps: 30 | 60, background: string): string {
  const color = background.replace(/^#/, "0x");
  const filters: string[] = [];
  for (const [index, track] of tracks.entries()) {
    if (tracks.length === 1) {
      // Solo input: compositeGeometry's max-of-one makes tile dims equal encoded dims, so the old
      // tile stage resampled an already-matching frame. One resample feeds both the [track0] map
      // (a label can be consumed once) and the composite scale through a zero-cost split.
      filters.push(`[${index}:v]settb=AVTB,setpts=N/(${fps}*TB),scale=${track.geometry.encodedWidth}:${track.geometry.encodedHeight}:force_original_aspect_ratio=decrease,pad=${track.geometry.encodedWidth}:${track.geometry.encodedHeight}:(ow-iw)/2:(oh-ih)/2:color=${color},split=2[track${index}][compositesrc${index}]`);
      continue;
    }
    filters.push(`[${index}:v]settb=AVTB,setpts=N/(${fps}*TB),split=2[raw${index}][gridraw${index}]`);
    filters.push(`[raw${index}]scale=${track.geometry.encodedWidth}:${track.geometry.encodedHeight}:force_original_aspect_ratio=decrease,pad=${track.geometry.encodedWidth}:${track.geometry.encodedHeight}:(ow-iw)/2:(oh-ih)/2:color=${color}[track${index}]`);
    filters.push(`[gridraw${index}]scale=${grid.tileWidth}:${grid.tileHeight}:force_original_aspect_ratio=decrease,pad=${grid.tileWidth}:${grid.tileHeight}:(ow-iw)/2:(oh-ih)/2:color=${color}[tile${index}]`);
  }
  if (tracks.length === 1) {
    filters.push(`[compositesrc0]scale=${grid.outputWidth}:${grid.outputHeight}[composite]`);
  } else {
    const layout = tracks.map((_track, index) => {
      const { left, top } = gridCellPosition(index, grid.columns, grid.tileWidth, grid.tileHeight);
      return `${left}_${top}`;
    }).join("|");
    const inputs = tracks.map((_track, index) => `[tile${index}]`).join("");
    filters.push(`${inputs}xstack=inputs=${tracks.length}:layout=${layout}:fill=${color},scale=${grid.outputWidth}:${grid.outputHeight}[composite]`);
  }
  return filters.join(";");
}

function writeChunk(stream: Writable, data: Buffer): Promise<void> {
  const completion = Promise.withResolvers<void>();
  const onError = (error: Error): void => completion.reject(error);
  stream.once("error", onError);
  stream.write(data, (error: Error | null | undefined) => {
    stream.removeListener("error", onError);
    if (error) completion.reject(error);
    else completion.resolve();
  });
  return completion.promise;
}

/** Pure ffmpeg argv assembly: per-track image2pipe inputs, filter graph, and per-output map pushes. */
export function ffmpegArguments(outputDir: string, tracks: readonly AlignedTrack[], geometry: CompositeGeometry, fps: 30 | 60, durationFrames: number, background: string): string[] {
  const videos = tracks.map((track) => join(outputDir, ARTIFACT_DIRECTORIES.videos, trackVideoName(track.id)));
  const composite = join(outputDir, ARTIFACT_DIRECTORIES.videos, COMPOSITE_VIDEO_NAME);
  const args: string[] = ["-hide_banner", "-loglevel", "error", "-y", "-nostdin"];
  for (let index = 0; index < tracks.length; index += 1) {
    args.push("-probesize", "32", "-analyzeduration", "0", "-c:v", "mjpeg", "-f", "image2pipe", "-framerate", String(fps), "-i", `pipe:${index + INPUT_PIPE_STDIO_BASE}`);
  }
  args.push("-filter_complex", filterGraph(tracks, geometry, fps, background));
  const outputOptions = ["-an", "-frames:v", String(durationFrames), "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-fps_mode", "passthrough"];
  for (const [index, path] of videos.entries()) args.push("-map", `[track${index}]`, ...outputOptions, path);
  args.push("-map", "[composite]", ...outputOptions, composite);
  return args;
}

/** Frame pump: reads each aligned slot from the spools and writes it to ffmpeg's input pipes. */
async function pumpFrames(tracks: readonly AlignedTrack[], pipes: readonly Writable[], durationFrames: number): Promise<void> {
  const framesByTrack = tracks.map((track) => new Map(track.spool.index.frames.map((frame) => [frame.sequence, frame])));
  try {
    for (let slot = 0; slot < durationFrames; slot += 1) {
      const chunks = await Promise.all(tracks.map(async (track, index) => {
        const mapping = track.mappings[slot];
        const frame = mapping ? framesByTrack[index]!.get(mapping.sourceSequence) : undefined;
        if (!mapping || !frame) throw new Error(`missing source mapping for ${track.id} slot ${slot}`);
        return track.spool.read(frame);
      }));
      await Promise.all(chunks.map((chunk, index) => writeChunk(pipes[index]!, chunk)));
    }
  } finally {
    // Spools are closed before encoding starts, so cached read handles opened here have no other owner.
    await Promise.allSettled(tracks.map((track) => track.spool.closeRead()));
  }
}

/** Failure teardown: destroy pipes, SIGTERM with a CHILD_GRACE_MS watchdog, SIGKILL escalation, then rethrow composed diagnostics. */
async function terminateFailedEncoder(child: ChildProcess, pipes: readonly Writable[], completion: { readonly promise: Promise<void> }, spawnError: Error | undefined, stderr: string, paths: EncoderPaths, error: unknown): Promise<never> {
  for (const pipe of pipes) pipe.destroy();
  child.kill("SIGTERM");
  const graceful = Promise.withResolvers<void>();
  const watchdog = setTimeout(graceful.resolve, CHILD_GRACE_MS);
  try {
    await Promise.race([completion.promise.catch(() => undefined), graceful.promise]);
  } finally {
    clearTimeout(watchdog);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await completion.promise.catch(() => undefined);
  throw new Error(`ffmpeg ${paths.ffmpeg} failed: ${spawnError?.message ?? errorMessage(error)}${spawnError ? "" : stderr ? `\n${stderr}` : ""}`);
}

/** Shared child-completion wiring: accumulates stderr and settles on spawn error or exit status; a nonzero exit rejects with `${label} exited ${code}: ${stderr}`. */
export function awaitChildExit(child: ChildProcess, stderrStream: Readable, label: string): { readonly completion: PromiseWithResolvers<void>; readonly stderrText: () => string } {
  let stderr = "";
  stderrStream.on("data", (data: Buffer) => { stderr += data.toString(); });
  const completion = Promise.withResolvers<void>();
  child.once("error", completion.reject);
  child.once("close", (code: number | null) => code === 0 ? completion.resolve() : completion.reject(new Error(`${label} exited ${code}: ${stderr}`)));
  return { completion, stderrText: () => stderr };
}

export async function encodeAligned(
  outputDir: string,
  tracks: readonly AlignedTrack[],
  fps: 30 | 60,
  durationFrames: number,
  recording: { readonly compositeMaxSize: { readonly width: number; readonly height: number }; readonly compositeBackground: string },
): Promise<EncodingResult> {
  if (tracks.length === 0) throw new Error("encoding requires at least one track");
  await mkdir(join(outputDir, ARTIFACT_DIRECTORIES.videos), { recursive: true });
  const paths = await resolveEncoders();
  const geometry = compositeGeometry(tracks.map((track) => track.geometry), recording.compositeMaxSize);
  const args = ffmpegArguments(outputDir, tracks, geometry, fps, durationFrames, recording.compositeBackground);

  // stdio[0..1] ignore stdout/stderr sinks, [2] stderr pipe; input pipe i lives at stdio[i + INPUT_PIPE_STDIO_BASE].
  const child = spawn(paths.ffmpeg, args, { stdio: ["ignore", "ignore", "pipe", ...tracks.map(() => "pipe" as const)] });
  const stderrStream = child.stderr;
  if (!stderrStream) throw new Error("ffmpeg stderr pipe unavailable");
  const { completion, stderrText } = awaitChildExit(child, stderrStream, `ffmpeg ${paths.ffmpeg}`);
  let spawnError: Error | undefined;
  child.once("error", (error: Error) => {
    spawnError ??= asError(error);
  });
  // Sink early exit/close rejections raised while the frame-write loop below has not yet reached an
  // await of completion.promise; spawn errors are captured by the listener above instead.
  completion.promise.catch(() => undefined);
  const pipes = tracks.map((_track, index) => {
    const pipe = child.stdio[index + INPUT_PIPE_STDIO_BASE];
    if (!pipe || !("write" in pipe)) throw new Error(`ffmpeg input pipe ${index} unavailable`);
    const writable = pipe as Writable;
    writable.on("error", () => undefined);
    return writable;
  });
  try {
    await pumpFrames(tracks, pipes, durationFrames);
    for (const pipe of pipes) pipe.end();
    await completion.promise;
    return { geometry };
  } catch (error) {
    return terminateFailedEncoder(child, pipes, completion, spawnError, stderrText(), paths, error);
  }
}
