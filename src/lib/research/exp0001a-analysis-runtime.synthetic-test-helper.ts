import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { canonicalJson, hashCanonicalJson, SHA256_DIGEST_PATTERN } from "./provenance-crypto";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });

const SYNTHETIC_FILES = [
  "00-synthetic-analysis-input.json",
  "01-synthetic-analysis-report.json",
  "02-synthetic-failure-taxonomy.json",
  "03-synthetic-scorer-judge-validation.json",
  "04-synthetic-sample-plan.json",
  "05-synthetic-analysis-completion-seal.json",
] as const;

const syntheticArtifactSchema = z.object({
  schemaVersion: z.literal("exp-0001a-synthetic-analysis-artifact/v1"),
  protocolId: z.literal("EXP-0001A"),
  kind: z.literal("synthetic_analysis_test_artifact"),
  stage: z.enum(["input", "report", "failure_taxonomy", "scorer_judge_validation", "sample_plan"]),
  fixtureDigest: digestSchema,
  previousArtifactRoot: digestSchema.nullable(),
  artifactRoot: digestSchema,
}).strict();

export const syntheticExp0001aAnalysisCompletionSealSchema = z.object({
  schemaVersion: z.literal("exp-0001a-synthetic-analysis-completion/v1"),
  protocolId: z.literal("EXP-0001A"),
  kind: z.literal("synthetic_analysis_complete"),
  syntheticOnly: z.literal(true),
  analysisCompletedAt: timestampSchema,
  reviewCompletedAt: timestampSchema,
  attemptMetricsSealedAt: timestampSchema,
  artifactRoots: z.array(digestSchema).length(5),
  completionSealDigest: digestSchema,
}).strict();

export type SyntheticExp0001aAnalysisCompletionSeal = z.infer<
  typeof syntheticExp0001aAnalysisCompletionSealSchema
>;

export type SyntheticExp0001aAnalysisRuntimeOptions = {
  outputRoot: string;
  fixture: unknown;
  reviewCompletedAt: string;
  attemptMetricsSealedAt: string;
  now?: () => string;
};

export type SyntheticExp0001aAnalysisRuntimeSnapshot = {
  status: "empty" | "in_progress" | "synthetic_analysis_complete";
  retainedArtifacts: readonly string[];
  completionSeal: SyntheticExp0001aAnalysisCompletionSeal | null;
};

export type SyntheticExp0001aAnalysisRuntime = {
  advance(): Promise<SyntheticExp0001aAnalysisRuntimeSnapshot>;
  run(): Promise<SyntheticExp0001aAnalysisCompletionSeal>;
  read(): Promise<SyntheticExp0001aAnalysisRuntimeSnapshot>;
  artifactPaths: Readonly<Record<
    "analysisInput" | "analysisReport" | "failureTaxonomy" | "scorerJudgeValidation" | "sealedSamplePlan" | "completionSeal",
    string
  >>;
};

function withoutDigest(value: SyntheticExp0001aAnalysisCompletionSeal): Record<string, unknown> {
  const { completionSealDigest: _ignored, ...content } = value;
  void _ignored;
  return content;
}

function nodeErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function assertSyntheticPath(outputRoot: string): void {
  if (!path.isAbsolute(outputRoot) || path.normalize(outputRoot) !== outputRoot) {
    throw new Error("Synthetic analysis test output root must be absolute and normalized.");
  }
  if (path.resolve(outputRoot).split(path.sep).some((segment) => /^(?:sealed[-_]?tests?|test[-_]?set)$/i.test(segment))) {
    throw new Error("Synthetic analysis test helper is forbidden from accessing sealed-test data.");
  }
}

async function ensurePrivateDirectory(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("Synthetic analysis output directory must be private and non-symlinked.");
  }
  return realpath(directory);
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function retainExclusive(filePath: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  const handle = await open(
    filePath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(path.dirname(filePath));
  const retained = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await retained.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
      throw new Error("Synthetic analysis artifact must be private, singly linked, and regular.");
    }
    const readback = await retained.readFile();
    if (!readback.equals(bytes)) throw new Error("Synthetic analysis artifact readback mismatch.");
  } finally {
    await retained.close();
  }
}

async function readPrivateBytes(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
      throw new Error("Synthetic analysis artifact must be private, singly linked, and regular.");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function rootedArtifact(
  stage: z.infer<typeof syntheticArtifactSchema>["stage"],
  fixtureDigest: string,
  previousArtifactRoot: string | null,
) {
  const content = {
    schemaVersion: "exp-0001a-synthetic-analysis-artifact/v1" as const,
    protocolId: "EXP-0001A" as const,
    kind: "synthetic_analysis_test_artifact" as const,
    stage,
    fixtureDigest,
    previousArtifactRoot,
  };
  return syntheticArtifactSchema.parse({ ...content, artifactRoot: hashCanonicalJson(content) });
}

function material(options: SyntheticExp0001aAnalysisRuntimeOptions, completedAt: string) {
  const fixtureDigest = hashCanonicalJson({
    schemaVersion: "exp-0001a-synthetic-analysis-fixture/v1",
    kind: "synthetic_analysis_fixture",
    fixture: options.fixture,
  });
  const stages = ["input", "report", "failure_taxonomy", "scorer_judge_validation", "sample_plan"] as const;
  const artifacts: Array<z.infer<typeof syntheticArtifactSchema>> = [];
  for (const stage of stages) {
    artifacts.push(rootedArtifact(stage, fixtureDigest, artifacts.at(-1)?.artifactRoot ?? null));
  }
  const analysisCompletedAt = timestampSchema.parse(completedAt);
  const reviewCompletedAt = timestampSchema.parse(options.reviewCompletedAt);
  const attemptMetricsSealedAt = timestampSchema.parse(options.attemptMetricsSealedAt);
  if (Date.parse(analysisCompletedAt) < Math.max(Date.parse(reviewCompletedAt), Date.parse(attemptMetricsSealedAt))) {
    throw new Error("Synthetic analysis completion cannot predate review completion or the exact-48 metrics seal.");
  }
  const sealContent = {
    schemaVersion: "exp-0001a-synthetic-analysis-completion/v1" as const,
    protocolId: "EXP-0001A" as const,
    kind: "synthetic_analysis_complete" as const,
    syntheticOnly: true as const,
    analysisCompletedAt,
    reviewCompletedAt,
    attemptMetricsSealedAt,
    artifactRoots: artifacts.map((artifact) => artifact.artifactRoot),
  };
  const completionSeal = syntheticExp0001aAnalysisCompletionSealSchema.parse({
    ...sealContent,
    completionSealDigest: hashCanonicalJson(sealContent),
  });
  return { artifacts, completionSeal, values: [...artifacts, completionSeal] as const };
}

async function inventory(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  const unexpected = entries.find((entry) => !SYNTHETIC_FILES.includes(entry.name as typeof SYNTHETIC_FILES[number])
    || !entry.isFile() || entry.isSymbolicLink());
  if (unexpected) throw new Error(`Unexpected synthetic analysis artifact: ${unexpected.name}`);
  let missingSeen = false;
  for (const fileName of SYNTHETIC_FILES) {
    if (!names.includes(fileName)) missingSeen = true;
    else if (missingSeen) throw new Error(`Synthetic analysis artifact sequence has a gap before ${fileName}.`);
  }
  return names;
}

function paths(root: string): SyntheticExp0001aAnalysisRuntime["artifactPaths"] {
  return Object.freeze({
    analysisInput: path.join(root, SYNTHETIC_FILES[0]),
    analysisReport: path.join(root, SYNTHETIC_FILES[1]),
    failureTaxonomy: path.join(root, SYNTHETIC_FILES[2]),
    scorerJudgeValidation: path.join(root, SYNTHETIC_FILES[3]),
    sealedSamplePlan: path.join(root, SYNTHETIC_FILES[4]),
    completionSeal: path.join(root, SYNTHETIC_FILES[5]),
  });
}

export function createSyntheticExp0001aAnalysisRuntimeForTesting(
  options: SyntheticExp0001aAnalysisRuntimeOptions,
): SyntheticExp0001aAnalysisRuntime {
  assertSyntheticPath(options.outputRoot);
  const now = options.now ?? (() => new Date().toISOString());
  const artifactPaths = paths(options.outputRoot);
  const evaluate = async (writeNext: boolean): Promise<SyntheticExp0001aAnalysisRuntimeSnapshot> => {
    let rootExists = true;
    try {
      await lstat(options.outputRoot);
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
      rootExists = false;
    }
    if (!rootExists && !writeNext) {
      material(options, timestampSchema.parse(now()));
      return { status: "empty", retainedArtifacts: [], completionSeal: null };
    }
    const root = await ensurePrivateDirectory(options.outputRoot);
    const names = await inventory(root);
    let completedAt = timestampSchema.parse(now());
    if (names.includes(SYNTHETIC_FILES[5])) {
      const raw = JSON.parse((await readPrivateBytes(path.join(root, SYNTHETIC_FILES[5]))).toString("utf8"));
      completedAt = syntheticExp0001aAnalysisCompletionSealSchema.parse(raw).analysisCompletedAt;
    }
    const expected = material(options, completedAt);
    for (let index = 0; index < names.length; index += 1) {
      const bytes = await readPrivateBytes(path.join(root, names[index]));
      if (bytes.toString("utf8") !== canonicalJson(expected.values[index])) {
        throw new Error(`Synthetic analysis artifact was tampered or rewritten: ${names[index]}`);
      }
    }
    if (writeNext && names.length < SYNTHETIC_FILES.length) {
      await retainExclusive(path.join(root, SYNTHETIC_FILES[names.length]), expected.values[names.length]);
      names.push(SYNTHETIC_FILES[names.length]);
    }
    const complete = names.length === SYNTHETIC_FILES.length;
    return {
      status: complete ? "synthetic_analysis_complete" : names.length === 0 ? "empty" : "in_progress",
      retainedArtifacts: names,
      completionSeal: complete ? expected.completionSeal : null,
    };
  };
  return Object.freeze({
    artifactPaths,
    advance: () => evaluate(true),
    read: () => evaluate(false),
    async run() {
      for (let index = 0; index <= SYNTHETIC_FILES.length; index += 1) {
        const snapshot = await evaluate(true);
        if (snapshot.status === "synthetic_analysis_complete" && snapshot.completionSeal) {
          if (snapshot.completionSeal.completionSealDigest !== hashCanonicalJson(withoutDigest(snapshot.completionSeal))) {
            throw new Error("Synthetic completion seal digest is invalid.");
          }
          return snapshot.completionSeal;
        }
      }
      throw new Error("Synthetic analysis finalization did not complete.");
    },
  });
}
