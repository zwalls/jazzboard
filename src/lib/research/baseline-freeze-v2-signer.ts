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
  baselineFreezeReceiptV2Schema,
  computeBaselineFreezeReceiptV2Digest,
} from "./baseline-freeze-v2";
import {
  BASELINE_FREEZE_V2_AUTHORITY_KEY_ID,
  BASELINE_FREEZE_V2_AUTHORITY_KEY_PURPOSE,
  BASELINE_FREEZE_V2_AUTHORITY_PUBLIC_KEY_DIGEST,
  BASELINE_FREEZE_V2_AUTHORITY_PUBLIC_KEY_PATH,
  BASELINE_FREEZE_V2_AUTHORITY_SIGNATURE_VERSION,
  baselineFreezeV2AuthoritySignatureMessage,
  baselineFreezeV2AuthoritySignatureSchema,
  verifyBaselineFreezeV2AuthoritySignature,
} from "./baseline-freeze-v2-authority";
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
  if (existing !== null) throw new Error("BASELINE_FREEZE_V2_SIGNATURE_OUTPUT_EXISTS");
  const temporary = path.join(path.dirname(filePath), `.baseline-freeze-v2-${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o644,
  );
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, filePath);
  const readback = await readPlainFile(filePath, "Baseline authority signature output");
  if (!readback.equals(bytes)) throw new Error("BASELINE_FREEZE_V2_SIGNATURE_READBACK_MISMATCH");
}

async function loadAuthority(repositoryRoot: string) {
  const privatePath = path.join(repositoryRoot, ".research-private", "exp0001a-authority-private.pem");
  const publicPath = path.join(repositoryRoot, BASELINE_FREEZE_V2_AUTHORITY_PUBLIC_KEY_PATH);
  const [privateRealPath, publicRealPath] = await Promise.all([realpath(privatePath), realpath(publicPath)]);
  if (privateRealPath !== privatePath || publicRealPath !== publicPath) {
    throw new Error("BASELINE_FREEZE_V2_AUTHORITY_PATH_INVALID");
  }
  const [privateBytes, publicBytes] = await Promise.all([
    readPlainFile(privatePath, "Baseline authority private key", 0o600),
    readPlainFile(publicPath, "Baseline authority public key"),
  ]);
  if (sha256Digest(publicBytes) !== BASELINE_FREEZE_V2_AUTHORITY_PUBLIC_KEY_DIGEST) {
    throw new Error("BASELINE_FREEZE_V2_AUTHORITY_TRUST_ANCHOR_INVALID");
  }
  const privateKey = createPrivateKey(privateBytes);
  const publicKey = createPublicKey(publicBytes);
  const derived = createPublicKey(privateKey);
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519"
      || !Buffer.from(publicKey.export({ type: "spki", format: "der" }))
        .equals(Buffer.from(derived.export({ type: "spki", format: "der" })))) {
    throw new Error("BASELINE_FREEZE_V2_AUTHORITY_KEY_MISMATCH");
  }
  return { privateKey, publicKey };
}

export function createBaselineFreezeV2AuthoritySignature(input: Readonly<{
  receipt: JsonValue;
  signedAt: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}>) {
  const content = {
    schemaVersion: BASELINE_FREEZE_V2_AUTHORITY_SIGNATURE_VERSION,
    protocolId: "EXP-0001A" as const,
    kind: "baseline-freeze-authority-signature" as const,
    algorithm: "Ed25519" as const,
    keyId: BASELINE_FREEZE_V2_AUTHORITY_KEY_ID,
    keyPurpose: BASELINE_FREEZE_V2_AUTHORITY_KEY_PURPOSE,
    publicKeyPath: BASELINE_FREEZE_V2_AUTHORITY_PUBLIC_KEY_PATH,
    publicKeyDigest: BASELINE_FREEZE_V2_AUTHORITY_PUBLIC_KEY_DIGEST,
    signedAt: input.signedAt,
    payloadSchema: "baseline-freeze/v2" as const,
    payloadDigest: hashCanonicalJson(input.receipt),
  };
  const message = baselineFreezeV2AuthoritySignatureMessage(content);
  const bytes = signEd25519(null, message, input.privateKey);
  if (bytes.length !== 64 || !verifyEd25519(null, message, input.publicKey, bytes)) {
    throw new Error("BASELINE_FREEZE_V2_SIGNATURE_SELF_CHECK_FAILED");
  }
  return baselineFreezeV2AuthoritySignatureSchema.parse({
    ...content,
    signatureBase64: bytes.toString("base64"),
  });
}

export function parseBaselineFreezeV2SignerArgs(argv: readonly string[]) {
  if (argv.length !== 4 || argv[0] !== "--input" || argv[2] !== "--output") {
    throw new Error("Usage: --input /absolute/baseline-freeze-v2.json --output /absolute/signature.json");
  }
  const inputPath = argv[1]!;
  const outputPath = argv[3]!;
  for (const candidate of [inputPath, outputPath]) {
    if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate
        || candidate === path.parse(candidate).root) throw new Error("BASELINE_FREEZE_V2_SIGNER_PATH_INVALID");
  }
  return Object.freeze({ inputPath, outputPath });
}

export async function runBaselineFreezeV2SignerCli(
  argv: readonly string[],
  io: { stdout: Pick<NodeJS.WriteStream, "write">; stderr: Pick<NodeJS.WriteStream, "write"> },
  repositoryRoot: string,
) {
  try {
    const args = parseBaselineFreezeV2SignerArgs(argv);
    const receiptBytes = await readPlainFile(args.inputPath, "Baseline freeze v2 receipt");
    const receipt = baselineFreezeReceiptV2Schema.parse(JSON.parse(receiptBytes.toString("utf8")));
    if (computeBaselineFreezeReceiptV2Digest(receipt) !== receipt.receiptDigest) {
      throw new Error("BASELINE_FREEZE_V2_RECEIPT_SELF_DIGEST_INVALID");
    }
    const authority = await loadAuthority(repositoryRoot);
    const signature = createBaselineFreezeV2AuthoritySignature({
      receipt: receipt as unknown as JsonValue,
      signedAt: new Date().toISOString(),
      ...authority,
    });
    verifyBaselineFreezeV2AuthoritySignature({
      receipt: receipt as unknown as JsonValue,
      signature,
      notBefore: receipt.frozenAt,
    });
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
      errorCode: error instanceof Error ? error.message : "BASELINE_FREEZE_V2_SIGNER_ERROR",
    })}\n`);
    return 1;
  }
}
