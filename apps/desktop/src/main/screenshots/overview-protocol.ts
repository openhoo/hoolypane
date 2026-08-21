export interface OverviewTileInput {
  readonly name: string;
  readonly dimensions: string;
  readonly png?: Uint8Array;
  readonly error?: string;
}

export interface OverviewInput {
  readonly tiles: readonly OverviewTileInput[];
  readonly background: string;
}

export type OverviewWorkerResponse = { ok: true; png: Uint8Array } | { ok: false; error: string };
