export { alignFrames, assertStateTransition, CAPTURE_CONTRACT, compositeGeometry, durationFrameCount, geometryForViewport, MAX_QUEUED_BYTES, MAX_QUEUED_FRAMES, POST_ROLL_US, timestampSecondsToUs, VALIDATOR_VERSION } from "./capture-contract.js";
export type { CompositeGeometry, RecordingState, SlotMapping, SourceFrame, TrackGeometry } from "./capture-contract.js";
export { resolveEncoders } from "./encoder.js";
export type { EncoderPaths } from "./encoder.js";
export { RecordingSession } from "./session.js";
export type { RecorderFailure, RecorderFlowEvent, RecordingFinalizeResult, RecordingManifest, RecordingTarget } from "./session.js";
export { verifyArtifacts } from "./verifier.js";
export type { VerificationResult } from "./verifier.js";
