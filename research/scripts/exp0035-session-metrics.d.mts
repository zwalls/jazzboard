export interface Exp0035SessionOptions {
  attemptId?: string;
  threadId?: string | null;
}

export interface Exp0035FinalText {
  status: "observed" | "unavailable";
  source: string | null;
  utf8Bytes: number | null;
  text: string | null;
}

export interface Exp0035RetainedJsonMetric {
  status: "complete" | "truncated" | "unavailable";
  utf8Bytes: number | null;
}

export interface Exp0035NativeMetadataEntry {
  hostCallOrdinal: number;
  nativeEntryOrdinal: number;
  name: string;
  sourceHostname: string | null;
  input: Exp0035RetainedJsonMetric;
  output: Exp0035RetainedJsonMetric;
}

export interface Exp0035SessionMetrics {
  schemaVersion: "jazzboard-exp0035-session-metrics/v1";
  attemptId: string | null;
  threadId: string | null;
  turnId: string | null;
  status: string;
  finalText: Exp0035FinalText;
  timing: {
    totalWallMs: number | null;
    accountedWallMs: number;
    clockDeltaMs: number;
    hostExecutionMs: number;
    modelAndCoordinationMs: number;
    hostExecutionShare: number;
  };
  hostCalls: {
    completedCount: number;
    failedCount: number;
    byHostTool: Record<string, number>;
    errors: Array<{
      hostCallOrdinal: number;
      hostTool: string;
      status: string;
      errorTextStatus: "observed" | "unavailable";
      errorText?: string;
    }>;
  };
  webMcp: {
    runtimeCallCount: null;
    runtimeCallCountStatus: "unobservable_from_host_session";
    nativeMetadata: {
      status: "invalid_metadata_observed" | "observed_without_completeness_signal" | "unavailable";
      observedEntryCount: number;
      observedHostCallCount: number;
      byName: Record<string, number>;
      completeOutputCount: number;
      completeOutputUtf8Bytes: number | null;
      truncatedInputCount: number;
      truncatedOutputCount: number;
      hostCalls: Array<{
        hostCallOrdinal: number;
        status: "absent" | "invalid" | "observed";
        observedEntryCount: number;
      }>;
      entries: Exp0035NativeMetadataEntry[];
    };
    readOutput: {
      status: "partially_observed" | "unavailable";
      observedHostCallCount: number;
      observedUtf8Bytes: number | null;
      hostCalls: Array<{
        hostCallOrdinal: number;
        readToolReferenced: string;
        outputStatus: "observed" | "truncated" | "non_textual" | "unavailable";
        outputSourceField: "result" | "output" | null;
        utf8Bytes: number | null;
      }>;
    };
  };
  observability: {
    hostCalls: string;
    webMcpCalls: string;
    nativeOutputBytes: string;
    readOutputBytes: string;
    exactTokens: "unobservable";
  };
}

/** Summarize one retained Codex author-task JSONL without inferring hidden calls or bytes. */
export function summarizeExp0035Session(
  raw: string,
  options?: Exp0035SessionOptions,
): Exp0035SessionMetrics;
