/**
 * Session-replay data access (#58/#67).
 *
 * Wire contract (written by @nais/apm's ReplayInstrumentation, flattened by
 * Alloy's faro.receiver into logfmt `event_data_<key>` fields):
 *
 *   kind=event event_name=faro.session_recording.chunk session_id=<sid>
 *   event_data_chunk_seq=<n> event_data_mode=snapshot|recording
 *   event_data_enc=gzip+b64 event_data_count=<events in chunk>
 *   event_data_data=<base64(gzip(JSON rrweb eventWithTime[]))>
 *
 * Today chunks land under kind="event"; the future Alloy pipeline relabels
 * the stream to kind="replay" (dedicated 7d retention), so all queries here
 * match kind=~"event|replay".
 */
import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { gunzipSync, strFromU8 } from 'fflate';
import { otel } from '../../../../otelconfig';
import { sanitizeLabelValue } from '../../../../utils/sanitize';
import { parseLogfmt } from '../exception-utils';

export type ReplayMode = 'snapshot' | 'recording';

/** rrweb eventWithTime — structurally typed so the heavy rrweb packages stay out of this module. */
export interface ReplayEventWithTime {
  type: number;
  data: unknown;
  timestamp: number;
}

export interface ReplayQueryOptions {
  logsUid: string;
  service: string;
  sessionId: string;
  fromMs: number;
  toMs: number;
  environment?: string;
  /** Stream label used for the environment matcher (defaults to otel.labels.deploymentEnv). */
  environmentLabel?: string;
}

export interface ReplayData {
  /** All rrweb events for the session, chunk-ordered and concatenated. */
  events: ReplayEventWithTime[];
  mode: ReplayMode;
  chunkCount: number;
}

export interface ReplayProbeResult {
  hasChunks: boolean;
  /** "recording" wins when a session has both snapshot and recording chunks. */
  mode: ReplayMode | null;
  chunkCount: number;
}

/** The only chunk encoding this plugin version understands (format is versioned via `enc`). */
const SUPPORTED_ENC = 'gzip+b64';

/** Millisecond timestamp → Loki nanosecond string (string concat avoids float precision loss). */
function msToNs(ms: number): string {
  return `${Math.floor(ms)}000000`;
}

/**
 * Shared log pipeline: stream selector + cheap line prefilters (Loki skips
 * logfmt-parsing lines that miss them) + exact session match.
 */
function buildReplayPipeline(opts: ReplayQueryOptions): string {
  const fl = otel.faroLoki;
  const service = sanitizeLabelValue(opts.service);
  const sessionId = sanitizeLabelValue(opts.sessionId);
  const envLabel = opts.environmentLabel || otel.labels.deploymentEnv;
  const envStream = opts.environment ? `, ${envLabel}="${sanitizeLabelValue(opts.environment)}"` : '';
  const selector = `{${fl.serviceName}="${service}", ${fl.kind}=~"${fl.kindEvent}|${fl.kindReplay}"${envStream}}`;
  return `${selector} |= \`${fl.replayChunkEvent}\` |= \`${sessionId}\` | logfmt | ${fl.sessionId}="${sessionId}"`;
}

/** Decode one chunk payload: base64 → gunzip → JSON rrweb eventWithTime[]. */
export function decodeReplayChunk(b64: string): ReplayEventWithTime[] {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  const parsed = JSON.parse(strFromU8(gunzipSync(bytes)));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Fetch and reassemble all replay chunks for a session: query Loki via the
 * datasource proxy, order by chunk_seq, gunzip and concatenate the rrweb
 * events. Returns null when the session has no chunks in the range.
 */
export async function fetchReplay(opts: ReplayQueryOptions): Promise<ReplayData | null> {
  const res = await lastValueFrom(
    getBackendSrv().fetch<any>({
      url: `/api/datasources/proxy/uid/${encodeURIComponent(opts.logsUid)}/loki/api/v1/query_range`,
      params: {
        query: buildReplayPipeline(opts),
        limit: '1000',
        direction: 'forward',
        start: msToNs(opts.fromMs),
        end: msToNs(opts.toMs),
      },
      method: 'GET',
    })
  );

  const streams = res.data?.data?.result ?? [];
  const chunks: Array<{ seq: number; mode?: string; enc?: string; data: string }> = [];
  streams.forEach((stream: any) => {
    (stream.values ?? []).forEach((val: [string, string]) => {
      const p = parseLogfmt(val[1]);
      if (!p.event_data_data) {
        return;
      }
      chunks.push({
        seq: Number(p.event_data_chunk_seq),
        mode: p.event_data_mode,
        enc: p.event_data_enc,
        data: p.event_data_data,
      });
    });
  });

  if (chunks.length === 0) {
    return null;
  }

  chunks.sort((a, b) => a.seq - b.seq);

  const events: ReplayEventWithTime[] = [];
  const seen = new Set<number>();
  let decoded = 0;
  for (const chunk of chunks) {
    if (Number.isFinite(chunk.seq) && seen.has(chunk.seq)) {
      continue; // Loki retries can duplicate lines — keep the first of each seq
    }
    seen.add(chunk.seq);
    if (chunk.enc && chunk.enc !== SUPPORTED_ENC) {
      throw new Error(
        `Unsupported replay chunk encoding "${chunk.enc}" (this plugin understands "${SUPPORTED_ENC}") — update the plugin.`
      );
    }
    events.push(...decodeReplayChunk(chunk.data));
    decoded++;
  }

  return {
    events,
    mode: chunks.some((c) => c.mode === 'recording') ? 'recording' : 'snapshot',
    chunkCount: decoded,
  };
}

/**
 * Cheap existence probe: a count-only Loki metric query (no chunk payloads
 * cross the wire) grouped by mode, so the drawer knows whether to offer
 * "Play replay" (recording) or "View snapshot" (snapshot-only session).
 */
export async function probeReplay(opts: ReplayQueryOptions): Promise<ReplayProbeResult> {
  const rangeSec = Math.max(1, Math.ceil((opts.toMs - opts.fromMs) / 1000));
  const query = `sum by (event_data_mode) (count_over_time(${buildReplayPipeline(opts)} [${rangeSec}s]))`;

  const res = await lastValueFrom(
    getBackendSrv().fetch<any>({
      url: `/api/datasources/proxy/uid/${encodeURIComponent(opts.logsUid)}/loki/api/v1/query`,
      params: {
        query,
        time: msToNs(opts.toMs),
      },
      method: 'GET',
    })
  );

  const samples = res.data?.data?.result ?? [];
  let chunkCount = 0;
  let mode: ReplayMode | null = null;
  for (const sample of samples) {
    const value = Number(sample.value?.[1] ?? 0);
    if (!(value > 0)) {
      continue;
    }
    chunkCount += value;
    const sampleMode = sample.metric?.event_data_mode;
    if (sampleMode === 'recording') {
      mode = 'recording';
    } else if (sampleMode === 'snapshot' && mode !== 'recording') {
      mode = 'snapshot';
    }
  }

  return { hasChunks: chunkCount > 0, mode, chunkCount };
}
