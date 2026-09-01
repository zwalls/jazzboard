import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  sealExp0001aModelRoleQualificationV2Plan,
} from "./exp0001a-model-role-qualification-v2";
import {
  sealQualificationV2AuthorEvidence,
  sealQualificationV2ExternalTaskReceipt,
  sealQualificationProductionBinding,
  sealQualificationV2RoomReceipt,
} from "./exp0001a-model-role-qualification-v2-coordinator";
import { canonicalJson, hashCanonicalJson, type JsonValue } from "./provenance-crypto";

type SealKind = "plan" | "launch-binding" | "room" | "task-receipt" | "author-evidence";

async function readPlainJson(filePath: string) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("QUALIFICATION_V2_SEAL_INPUT_UNSAFE");
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { return JSON.parse((await handle.readFile()).toString("utf8")) as unknown; } catch {
    throw new Error("QUALIFICATION_V2_SEAL_INPUT_INVALID_JSON");
  } finally { await handle.close(); }
}

async function writeNew(filePath: string, value: unknown, mode: number) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (await lstat(filePath).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) throw new Error("QUALIFICATION_V2_SEAL_OUTPUT_EXISTS");
  const temporary = path.join(path.dirname(filePath), `.qualification-v2-seal-${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    mode,
  );
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, filePath);
}

function parseArgs(argv: readonly string[]) {
  if (argv.length !== 6 || argv[0] !== "--kind" || argv[2] !== "--input" || argv[4] !== "--output") {
    throw new Error("Usage: --kind plan|launch-binding|room|task-receipt|author-evidence --input /absolute/input.json --output /absolute/output.json");
  }
  const kind = argv[1] as SealKind;
  if (!["plan", "launch-binding", "room", "task-receipt", "author-evidence"].includes(kind)) {
    throw new Error("QUALIFICATION_V2_SEAL_KIND_INVALID");
  }
  for (const candidate of [argv[3], argv[5]]) {
    if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate
        || candidate === path.parse(candidate).root) throw new Error("QUALIFICATION_V2_SEAL_PATH_INVALID");
  }
  return { kind, inputPath: argv[3], outputPath: argv[5] };
}

export async function runQualificationV2SealerCli(
  argv: readonly string[],
  io: { stdout: Pick<NodeJS.WriteStream, "write">; stderr: Pick<NodeJS.WriteStream, "write"> },
) {
  try {
    const args = parseArgs(argv);
    const raw = await readPlainJson(args.inputPath);
    const sealed = args.kind === "plan"
      ? sealExp0001aModelRoleQualificationV2Plan(raw)
      : args.kind === "launch-binding"
        ? sealQualificationProductionBinding(raw)
        : args.kind === "room"
          ? sealQualificationV2RoomReceipt(raw)
          : args.kind === "task-receipt"
            ? sealQualificationV2ExternalTaskReceipt(raw)
            : sealQualificationV2AuthorEvidence(raw);
    await writeNew(args.outputPath, sealed, args.kind === "plan" || args.kind === "launch-binding" ? 0o644 : 0o600);
    io.stdout.write(`${canonicalJson({
      status: "sealed",
      kind: args.kind,
      outputDigest: hashCanonicalJson(sealed as unknown as JsonValue),
    })}\n`);
    return 0;
  } catch {
    io.stderr.write(`${canonicalJson({
      status: "error",
      errorCode: "QUALIFICATION_V2_SEAL_ERROR",
    })}\n`);
    return 1;
  }
}
