import {
  createPrivateKey,
  createPublicKey,
  sign as signEd25519,
  verify as verifyEd25519,
  type KeyObject,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  baselineFreezeReceiptV3Schema,
  baselineProductionEvidenceV3Schema,
  baselineWebMcpInventoryV3Schema,
  computeBaselineFreezeReceiptV3Digest,
  verifyBaselineV3ExecutionReady,
} from "./baseline-freeze-v3";
import {
  BASELINE_FREEZE_V3_AUTHORITY_KEY_ID,
  BASELINE_FREEZE_V3_AUTHORITY_KEY_PURPOSE,
  BASELINE_FREEZE_V3_AUTHORITY_PUBLIC_KEY_DIGEST,
  BASELINE_FREEZE_V3_AUTHORITY_PUBLIC_KEY_PATH,
  BASELINE_FREEZE_V3_AUTHORITY_SIGNATURE_VERSION,
  baselineFreezeV3AuthoritySignatureMessage,
  baselineFreezeV3AuthoritySignatureSchema,
  verifyBaselineFreezeV3AuthoritySignature,
} from "./baseline-freeze-v3-authority";
import { canonicalJson, hashCanonicalJson, sha256Digest, type JsonValue } from "./provenance-crypto";

async function readPlainFile(filePath: string, label: string, requiredMode: number | null = null) {
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath
      || filePath === path.parse(filePath).root) throw new Error(`${label} path is unsafe.`);
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be a singly linked plain file.`);
  }
  if (requiredMode !== null && (metadata.mode & 0o777) !== requiredMode) {
    throw new Error(`${label} must have mode ${requiredMode.toString(8)}.`);
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

async function writeNewAtomic(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const existing = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) throw new Error("BASELINE_FREEZE_V3_SIGNATURE_OUTPUT_EXISTS");
  const temporary = path.join(path.dirname(filePath), `.baseline-freeze-v3-${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o644,
  );
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, filePath);
  const readback = await readPlainFile(filePath, "Baseline-v3 authority signature output");
  if (!readback.equals(bytes)) throw new Error("BASELINE_FREEZE_V3_SIGNATURE_READBACK_MISMATCH");
}

async function loadAuthority(repositoryRoot: string) {
  const privatePath = path.join(repositoryRoot, ".research-private", "exp0001a-authority-private.pem");
  const publicPath = path.join(repositoryRoot, BASELINE_FREEZE_V3_AUTHORITY_PUBLIC_KEY_PATH);
  const [privateRealPath, publicRealPath] = await Promise.all([realpath(privatePath), realpath(publicPath)]);
  if (privateRealPath !== privatePath || publicRealPath !== publicPath) {
    throw new Error("BASELINE_FREEZE_V3_AUTHORITY_PATH_INVALID");
  }
  const [privateBytes, publicBytes] = await Promise.all([
    readPlainFile(privatePath, "Baseline-v3 authority private key", 0o600),
    readPlainFile(publicPath, "Baseline-v3 authority public key"),
  ]);
  if (sha256Digest(publicBytes) !== BASELINE_FREEZE_V3_AUTHORITY_PUBLIC_KEY_DIGEST) {
    throw new Error("BASELINE_FREEZE_V3_AUTHORITY_TRUST_ANCHOR_INVALID");
  }
  const privateKey = createPrivateKey(privateBytes);
  const publicKey = createPublicKey(publicBytes);
  const derived = createPublicKey(privateKey);
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519"
      || !Buffer.from(publicKey.export({ type: "spki", format: "der" }))
        .equals(Buffer.from(derived.export({ type: "spki", format: "der" })))) {
    throw new Error("BASELINE_FREEZE_V3_AUTHORITY_KEY_MISMATCH");
  }
  return { privateKey, publicKey, publicBytes };
}

export function createBaselineFreezeV3AuthoritySignature(input: Readonly<{
  receipt: JsonValue;
  signedAt: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}>) {
  const content = {
    schemaVersion: BASELINE_FREEZE_V3_AUTHORITY_SIGNATURE_VERSION,
    kind: "baseline-freeze-authority-signature" as const,
    algorithm: "Ed25519" as const,
    keyId: BASELINE_FREEZE_V3_AUTHORITY_KEY_ID,
    publicKeyDigest: BASELINE_FREEZE_V3_AUTHORITY_PUBLIC_KEY_DIGEST,
    signedAt: input.signedAt,
    keyPurpose: BASELINE_FREEZE_V3_AUTHORITY_KEY_PURPOSE,
    payloadSchema: "baseline-freeze/v3" as const,
    payloadDigest: hashCanonicalJson(input.receipt),
  };
  const message = baselineFreezeV3AuthoritySignatureMessage(content);
  const bytes = signEd25519(null, message, input.privateKey);
  if (bytes.length !== 64 || !verifyEd25519(null, message, input.publicKey, bytes)) {
    throw new Error("BASELINE_FREEZE_V3_SIGNATURE_SELF_CHECK_FAILED");
  }
  return baselineFreezeV3AuthoritySignatureSchema.parse({
    ...content,
    signatureBase64: bytes.toString("base64"),
  });
}

export function parseBaselineFreezeV3SignerArgs(argv: readonly string[]) {
  if (argv.length !== 4 || argv[0] !== "--input" || argv[2] !== "--output") {
    throw new Error("Usage: --input /absolute/baseline-freeze-v3.json --output /absolute/signature.json");
  }
  const inputPath = argv[1]!;
  const outputPath = argv[3]!;
  for (const candidate of [inputPath, outputPath]) {
    if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate
        || candidate === path.parse(candidate).root) throw new Error("BASELINE_FREEZE_V3_SIGNER_PATH_INVALID");
  }
  return Object.freeze({ inputPath, outputPath });
}

function fixedPaths(repositoryRoot: string) {
  const captureRoot = path.join(repositoryRoot, ".research-private", "exp0001a-baseline-v3-capture-20260901-run2");
  return {
    input: path.join(repositoryRoot, "research", "data", "baseline-freeze-v3.json"),
    output: path.join(repositoryRoot, "research", "data", "baseline-freeze-v3-authority-signature.json"),
    inventory: path.join(repositoryRoot, "research", "data", "baseline-webmcp-inventory-v3.json"),
    evidence: path.join(repositoryRoot, "research", "data", "baseline-production-evidence-v3.json"),
    captureScript: path.join(repositoryRoot, "research", "scripts", "capture-baseline-v3.mjs"),
    privateInventory: path.join(captureRoot, "baseline-webmcp-inventory-private-v2.json"),
    semanticArtifact: path.join(captureRoot, "baseline-semantic-artifact-redacted-v2.json"),
    semanticHandler: path.join(captureRoot, "baseline-semantic-handler-redacted-v2.json"),
    authoritativeState: path.join(captureRoot, "baseline-authoritative-state-redacted-v2.json"),
    history: path.join(repositoryRoot, ".research-private", "exp0001a-baseline-v2-capture-history-run5.json"),
    png: path.join(captureRoot, "baseline-exact-revision-v2.png"),
    stage: path.join(captureRoot, "baseline-progressive-draft-stage-call-result-v3.json"),
    finish: path.join(captureRoot, "baseline-progressive-draft-finish-call-result-v3.json"),
    predecessorReceipt: path.join(repositoryRoot, "research", "data", "baseline-freeze-v2.json"),
    predecessorSignature: path.join(repositoryRoot, "research", "data", "baseline-freeze-v2-authority-signature.json"),
    transportSpike: path.join(repositoryRoot, "research", "data", "exp0001a-browser-attached-transport-spike-public-v1.json"),
  };
}

export async function runBaselineFreezeV3SignerCli(
  argv: readonly string[],
  io: { stdout: Pick<NodeJS.WriteStream, "write">; stderr: Pick<NodeJS.WriteStream, "write"> },
  repositoryRoot: string,
) {
  try {
    const args = parseBaselineFreezeV3SignerArgs(argv);
    const paths = fixedPaths(repositoryRoot);
    if (args.inputPath !== paths.input || args.outputPath !== paths.output) {
      throw new Error("BASELINE_FREEZE_V3_SIGNER_FIXED_PATH_REQUIRED");
    }
    const authority = await loadAuthority(repositoryRoot);
    const [
      receiptBytes, inventoryBytes, evidenceBytes, captureScriptBytes, privateInventoryBytes,
      semanticArtifactBytes, semanticHandlerBytes, authoritativeStateBytes, historyBytes, pngBytes,
      stageBytes, finishBytes, predecessorReceiptBytes, predecessorSignatureBytes, transportSpikeBytes,
    ] = await Promise.all([
      readPlainFile(paths.input, "Baseline-v3 receipt"),
      readPlainFile(paths.inventory, "Baseline-v3 public inventory"),
      readPlainFile(paths.evidence, "Baseline-v3 public evidence"),
      readPlainFile(paths.captureScript, "Baseline-v3 capture script"),
      readPlainFile(paths.privateInventory, "Baseline-v3 private inventory"),
      readPlainFile(paths.semanticArtifact, "Baseline-v3 semantic artifact"),
      readPlainFile(paths.semanticHandler, "Baseline-v3 semantic handler"),
      readPlainFile(paths.authoritativeState, "Baseline-v3 authoritative state"),
      readPlainFile(paths.history, "Baseline-v3 capture history"),
      readPlainFile(paths.png, "Baseline-v3 exact revision PNG"),
      readPlainFile(paths.stage, "Baseline-v3 draft stage result"),
      readPlainFile(paths.finish, "Baseline-v3 draft finish result"),
      readPlainFile(paths.predecessorReceipt, "Baseline-v3 predecessor receipt"),
      readPlainFile(paths.predecessorSignature, "Baseline-v3 predecessor signature"),
      readPlainFile(paths.transportSpike, "Baseline-v3 transport spike"),
    ]);
    const receipt = baselineFreezeReceiptV3Schema.parse(JSON.parse(receiptBytes.toString("utf8")));
    if (computeBaselineFreezeReceiptV3Digest(receipt) !== receipt.receiptDigest) {
      throw new Error("BASELINE_FREEZE_V3_RECEIPT_SELF_DIGEST_INVALID");
    }
    const inventory = baselineWebMcpInventoryV3Schema.parse(JSON.parse(inventoryBytes.toString("utf8")));
    const evidence = baselineProductionEvidenceV3Schema.parse(JSON.parse(evidenceBytes.toString("utf8")));
    const signature = createBaselineFreezeV3AuthoritySignature({
      receipt: receipt as unknown as JsonValue,
      signedAt: new Date().toISOString(),
      ...authority,
    });
    verifyBaselineFreezeV3AuthoritySignature({
      receipt: receipt as unknown as JsonValue,
      signature,
      notBefore: receipt.frozenAt,
    });
    const signatureFileBytes = Buffer.from(`${canonicalJson(signature)}\n`, "utf8");
    const verification = verifyBaselineV3ExecutionReady(receipt, inventory, evidence, {
      receiptFileBytes: receiptBytes,
      inventoryFileBytes: inventoryBytes,
      evidenceFileBytes: evidenceBytes,
      captureScriptBytes,
      privateInventoryFileBytes: privateInventoryBytes,
      semanticArtifactFileBytes: semanticArtifactBytes,
      semanticHandlerFileBytes: semanticHandlerBytes,
      authoritativeStateFileBytes: authoritativeStateBytes,
      captureHistoryFileBytes: historyBytes,
      exactRevisionPngBytes: pngBytes,
      progressiveDraftStageFileBytes: stageBytes,
      progressiveDraftFinishFileBytes: finishBytes,
      authoritySignature: signature,
      authoritySignatureFileBytes: signatureFileBytes,
      authorityPublicKeyFileBytes: authority.publicBytes,
      predecessorReceiptFileBytes: predecessorReceiptBytes,
      predecessorAuthoritySignatureFileBytes: predecessorSignatureBytes,
      transportSpikeFileBytes: transportSpikeBytes,
    });
    if (!verification.ok) {
      throw new Error(`BASELINE_FREEZE_V3_EXECUTION_NOT_READY:${verification.errors.join("|")}`);
    }
    await writeNewAtomic(args.outputPath, signature);
    io.stdout.write(`${canonicalJson({
      status: "signed",
      payloadDigest: signature.payloadDigest,
      signatureDigest: hashCanonicalJson(signature),
    })}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${canonicalJson({
      status: "error",
      errorCode: error instanceof Error ? error.message : "BASELINE_FREEZE_V3_SIGNER_ERROR",
    })}\n`);
    return 1;
  }
}
