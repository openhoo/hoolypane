import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { access, constants, mkdir } from "node:fs/promises";
import { join } from "node:path";
import ffmpegStaticPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { errorMessage } from "@hoolypane/contracts";
import { asError, compositeGeometry, type CompositeGeometry, type SlotMapping, type TrackGeometry } from "./capture-contract.js";
import type { FrameSpool } from "./spool.js";

interface EncoderPaths { readonly ffmpeg: string; readonly ffprobe: string }
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

function filterGraph(tracks: readonly AlignedTrack[], grid: CompositeGeometry, fps: 30 | 60, background: string): string {
  const color = background.replace(/^#/, "0x");
  const filters: string[] = [];
  for (const [index, track] of tracks.entries()) {
    filters.push(`[${index}:v]settb=AVTB,setpts=N/(${fps}*TB),split=2[raw${index}][gridraw${index}]`);
    filters.push(`[raw${index}]scale=${track.geometry.encodedWidth}:${track.geometry.encodedHeight}:force_original_aspect_ratio=decrease,pad=${track.geometry.encodedWidth}:${track.geometry.encodedHeight}:(ow-iw)/2:(oh-ih)/2:color=${color}[track${index}]`);
    filters.push(`[gridraw${index}]scale=${grid.tileWidth}:${grid.tileHeight}:force_original_aspect_ratio=decrease,pad=${grid.tileWidth}:${grid.tileHeight}:(ow-iw)/2:(oh-ih)/2:color=${color}[tile${index}]`);
  }
  if (tracks.length === 1) {
    filters.push(`[tile0]scale=${grid.outputWidth}:${grid.outputHeight}[composite]`);
  } else {
    const layout = tracks.map((_track, index) => `${index % grid.columns * grid.tileWidth}_${Math.floor(index / grid.columns) * grid.tileHeight}`).join("|");
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

export async function encodeAligned(
  outputDir: string,
  tracks: readonly AlignedTrack[],
  fps: 30 | 60,
  durationFrames: number,
  recording: { readonly compositeMaxSize: { readonly width: number; readonly height: number }; readonly compositeBackground: string },
): Promise<EncodingResult> {
  if (tracks.length === 0) throw new Error("encoding requires at least one track");
  await mkdir(join(outputDir, "videos"), { recursive: true });
  const paths = await resolveEncoders();
  const geometry = compositeGeometry(tracks.map((track) => track.geometry), recording.compositeMaxSize);
  const videos = tracks.map((track) => join(outputDir, "videos", `${track.id}.webm`));
  const composite = join(outputDir, "videos", "composite.webm");
  const args: string[] = ["-hide_banner", "-loglevel", "error", "-y", "-nostdin"];
  for (let index = 0; index < tracks.length; index += 1) {
    args.push("-probesize", "32", "-analyzeduration", "0", "-c:v", "mjpeg", "-f", "image2pipe", "-framerate", String(fps), "-i", `pipe:${index + 3}`);
  }
  args.push("-filter_complex", filterGraph(tracks, geometry, fps, recording.compositeBackground));
  const outputOptions = ["-an", "-frames:v", String(durationFrames), "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-fps_mode", "passthrough"];
  for (const [index, path] of videos.entries()) args.push("-map", `[track${index}]`, ...outputOptions, path);
  args.push("-map", "[composite]", ...outputOptions, composite);

  const child = spawn(paths.ffmpeg, args, { stdio: ["ignore", "ignore", "pipe", ...tracks.map(() => "pipe" as const)] });
  let stderr = "";
  const stderrStream = child.stderr;
  if (!stderrStream) throw new Error("ffmpeg stderr pipe unavailable");
  stderrStream.on("data", (data: Buffer) => { stderr += data.toString(); });
  const completion = Promise.withResolvers<void>();
  child.once("error", completion.reject);
  child.once("close", (code: number | null) => code === 0 ? completion.resolve() : completion.reject(new Error(`ffmpeg ${paths.ffmpeg} exited ${code}: ${stderr}`)));
  let spawnError: Error | undefined;
  completion.promise.catch((error: unknown) => {
    spawnError ??= asError(error);
  });
  const pipes = tracks.map((_track, index) => {
    const pipe = child.stdio[index + 3];
    if (!pipe || !("write" in pipe)) throw new Error(`ffmpeg input pipe ${index} unavailable`);
    const writable = pipe as Writable;
    writable.on("error", () => undefined);
    return writable;
  });
  try {
    const framesByTrack = tracks.map((track) => new Map(track.spool.index.frames.map((frame) => [frame.sequence, frame])));
    for (let slot = 0; slot < durationFrames; slot += 1) {
      const chunks = await Promise.all(tracks.map(async (track, index) => {
        const mapping = track.mappings[slot];
        const frame = mapping ? framesByTrack[index]!.get(mapping.sourceSequence) : undefined;
        if (!mapping || !frame) throw new Error(`missing source mapping for ${track.id} slot ${slot}`);
        return track.spool.read(frame);
      }));
      await Promise.all(chunks.map((chunk, index) => writeChunk(pipes[index]!, chunk)));
    }
    for (const pipe of pipes) pipe.end();
    await completion.promise;
    return { geometry };
  } catch (error) {
    for (const pipe of pipes) pipe.destroy();
    child.kill("SIGTERM");
    const graceful = Promise.withResolvers<void>();
    const watchdog = setTimeout(graceful.resolve, 10_000);
    try {
      await Promise.race([completion.promise.catch(() => undefined), graceful.promise]);
    } finally {
      clearTimeout(watchdog);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await completion.promise.catch(() => undefined);
    throw new Error(`ffmpeg ${paths.ffmpeg} failed (ffprobe ${paths.ffprobe}): ${spawnError?.message ?? errorMessage(error)}${stderr ? `\n${stderr}` : ""}`);
  }
}
