import {
  createPrivateKey,
  createPublicKey,
  sign as signEd25519,
  verify as verifyEd25519,
  type KeyObject,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  exp0001aModelRoleQualificationV2PlanSchema,
} from "./exp0001a-model-role-qualification-v2";
import {
  EXP0001A_QUALIFICATION_V2_AUTHORITY_KEY_ID,
  EXP0001A_QUALIFICATION_V2_AUTHORITY_PUBLIC_KEY_DIGEST,
  EXP0001A_QUALIFICATION_V2_AUTHORITY_SIGNATURE_VERSION,
  exp0001aQualificationV2AuthoritySignatureMessage,
  exp0001aQualificationV2AuthoritySignatureSchema,
  verifyExp0001aQualificationV2AuthoritySignature,
} from "./exp0001a-model-role-qualification-v2-authority";
import {
  qualificationV2CoordinatorStateSchema,
  qualificationV2ProductionBindingSchema,
  qualificationV2ResultSchema,
  sealQualificationV2Result,
  signedQualificationV2ResultEnvelopeSchema,
} from "./exp0001a-model-role-qualification-v2-coordinator";
import {
  qualificationV2TerminalEvidenceAttestationSchema,
  verifyQualificationV2TerminalEvidenceAttestation,
} from "./exp0001a-model-role-qualification-v2-result-attestation";
import { canonicalJson, hashCanonicalJson, sha256Digest, type JsonValue } from "./provenance-crypto";

type QualificationPurpose = "qualification_plan" | "qualification_launch_binding" | "qualification_result";

export function createQualificationV2AuthoritySignature(input: Readonly<{
  payload: JsonValue;
  purpose: QualificationPurpose;
  signedAt: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}>) {
  const content = {
    schemaVersion: EXP0001A_QUALIFICATION_V2_AUTHORITY_SIGNATURE_VERSION,
    protocolId: "EXP-0001A-MODEL-ROLE-QUALIFICATION-V2" as const,
    kind: "model-role-qualification-authority-signature" as const,
    algorithm: "Ed25519" as const,
    keyId: EXP0001A_QUALIFICATION_V2_AUTHORITY_KEY_ID,
    publicKeyDigest: EXP0001A_QUALIFICATION_V2_AUTHORITY_PUBLIC_KEY_DIGEST,
    signedAt: input.signedAt,
    purpose: input.purpose,
    payloadDigest: hashCanonicalJson(input.payload),
  };
  const message = exp0001aQualificationV2AuthoritySignatureMessage(content);
  const signatureBytes = signEd25519(null, message, input.privateKey);
  if (signatureBytes.length !== 64
      || !verifyEd25519(null, message, input.publicKey, signatureBytes)) {
    throw new Error("QUALIFICATION_V2_SIGNATURE_SELF_CHECK_FAILED");
  }
  return Object.freeze(exp0001aQualificationV2AuthoritySignatureSchema.parse({
    ...content,
    signatureBase64: signatureBytes.toString("base64"),
  }));
}

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

async function readJson(filePath: string, label: string, requiredMode: number | null = null) {
  const bytes = await readPlainFile(filePath, label, requiredMode);
  try { return JSON.parse(bytes.toString("utf8")) as unknown; } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

async function writeNewAtomic(filePath: string, value: unknown, mode: number) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.qualification-v2-${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    mode,
  );
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await link(temporary, filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("QUALIFICATION_V2_OUTPUT_ALREADY_EXISTS");
    }
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const readback = await readPlainFile(filePath, "Qualification signer output", mode);
  if (!readback.equals(bytes)) throw new Error("QUALIFICATION_V2_OUTPUT_READBACK_MISMATCH");
}

async function loadFixedAuthority(repositoryRoot: string) {
  const privatePath = path.join(repositoryRoot, ".research-private", "exp0001a-authority-private.pem");
  const publicPath = path.join(repositoryRoot, "research", "data", "exp0001a-execution-authority-public.pem");
  const [privateRealPath, publicRealPath] = await Promise.all([realpath(privatePath), realpath(publicPath)]);
  if (privateRealPath !== privatePath || publicRealPath !== publicPath) {
    throw new Error("QUALIFICATION_V2_AUTHORITY_PATH_INVALID");
  }
  const [privateBytes, publicBytes] = await Promise.all([
    readPlainFile(privatePath, "Qualification authority private key", 0o600),
    readPlainFile(publicPath, "Qualification authority public key"),
  ]);
  if (sha256Digest(publicBytes) !== EXP0001A_QUALIFICATION_V2_AUTHORITY_PUBLIC_KEY_DIGEST) {
    throw new Error("QUALIFICATION_V2_AUTHORITY_TRUST_ANCHOR_INVALID");
  }
  const privateKey = createPrivateKey(privateBytes);
  const publicKey = createPublicKey(publicBytes);
  const derived = createPublicKey(privateKey);
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519"
      || !Buffer.from(publicKey.export({ type: "spki", format: "der" }))
        .equals(Buffer.from(derived.export({ type: "spki", format: "der" })))) {
    throw new Error("QUALIFICATION_V2_AUTHORITY_KEY_MISMATCH");
  }
  return { privateKey, publicKey };
}

async function verifyTerminalStateAuthorities(
  repositoryRoot: string,
  state: z.infer<typeof qualificationV2CoordinatorStateSchema>,
) {
  const dataRoot = path.join(repositoryRoot, "research", "data");
  const [planRaw, planSignatureRaw, bindingRaw, bindingSignatureRaw] = await Promise.all([
    readJson(path.join(dataRoot, "exp0001a-model-role-qualification-plan-v2.json"), "Qualification plan"),
    readJson(path.join(dataRoot, "exp0001a-model-role-qualification-plan-signature-v2.json"), "Qualification plan signature"),
    readJson(path.join(dataRoot, "exp0001a-model-role-qualification-launch-binding-v2.json"), "Qualification production binding"),
    readJson(path.join(dataRoot, "exp0001a-model-role-qualification-launch-binding-signature-v2.json"), "Qualification binding signature"),
  ]);
  const plan = exp0001aModelRoleQualificationV2PlanSchema.parse(planRaw);
  const planSignature = exp0001aQualificationV2AuthoritySignatureSchema.parse(planSignatureRaw);
  const binding = qualificationV2ProductionBindingSchema.parse(bindingRaw);
  const bindingSignature = exp0001aQualificationV2AuthoritySignatureSchema.parse(bindingSignatureRaw);
  verifyExp0001aQualificationV2AuthoritySignature({
    payload: plan as unknown as JsonValue,
    signature: planSignature,
    purpose: "qualification_plan",
    notBefore: plan.frozenAt,
  });
  verifyExp0001aQualificationV2AuthoritySignature({
    payload: binding as unknown as JsonValue,
    signature: bindingSignature,
    purpose: "qualification_launch_binding",
    notBefore: binding.verifiedAt,
  });
  if (state.planDigest !== plan.planDigest
      || canonicalJson(state.planAuthoritySignature as unknown as JsonValue)
        !== canonicalJson(planSignature as unknown as JsonValue)
      || canonicalJson(state.productionBinding as unknown as JsonValue)
        !== canonicalJson(binding as unknown as JsonValue)
      || canonicalJson(state.productionBindingAuthoritySignature as unknown as JsonValue)
        !== canonicalJson(bindingSignature as unknown as JsonValue)) {
    throw new Error("QUALIFICATION_V2_TERMINAL_STATE_AUTHORITY_BINDING_INVALID");
  }
}

export function parseQualificationV2SignerArgs(argv: readonly string[]) {
  if (argv[0] !== "--purpose" || argv[2] !== "--input") throw new Error("QUALIFICATION_V2_SIGNER_ARGUMENTS_INVALID");
  const purposeName = argv[1];
  const purpose = purposeName === "plan" ? "qualification_plan"
    : purposeName === "launch-binding" ? "qualification_launch_binding"
      : purposeName === "result" ? "qualification_result" : null;
  if (purpose === null) throw new Error("QUALIFICATION_V2_SIGNER_PURPOSE_INVALID");
  const inputPath = argv[3];
  const resultPurpose = purpose === "qualification_result";
  if ((!resultPurpose && (argv.length !== 6 || argv[4] !== "--output"))
      || (resultPurpose && (argv.length !== 10 || argv[4] !== "--state"
        || argv[6] !== "--attestation" || argv[8] !== "--output"))) {
    throw new Error("QUALIFICATION_V2_SIGNER_ARGUMENTS_INVALID");
  }
  const statePath = resultPurpose ? argv[5] : null;
  const attestationPath = resultPurpose ? argv[7] : null;
  const outputPath = resultPurpose ? argv[9] : argv[5];
  for (const candidate of [inputPath, statePath, attestationPath, outputPath].filter(
    (value): value is string => value !== null,
  )) {
    if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate
        || candidate === path.parse(candidate).root) throw new Error("QUALIFICATION_V2_SIGNER_PATH_INVALID");
  }
  return Object.freeze({ purpose, inputPath, statePath, attestationPath, outputPath });
}

async function assertQualificationPrivatePath(repositoryRoot: string, candidate: string, mustExist: boolean) {
  const resolvedRepositoryRoot = await realpath(repositoryRoot);
  const root = path.join(resolvedRepositoryRoot, ".research-private", "exp0001a-qualification-v2");
  const resolvedRoot = await realpath(root);
  if (resolvedRoot !== root) throw new Error("QUALIFICATION_V2_SIGNER_PRIVATE_ROOT_INVALID");
  let existing = path.resolve(candidate);
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      if (mustExist) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error("QUALIFICATION_V2_SIGNER_PATH_NOT_PRIVATE");
      existing = parent;
    }
  }
  const resolvedExisting = await realpath(existing);
  const resolvedCandidate = path.resolve(resolvedExisting, path.relative(existing, path.resolve(candidate)));
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("QUALIFICATION_V2_SIGNER_PATH_NOT_PRIVATE");
  }
}

export async function runQualificationV2SignerCli(
  argv: readonly string[],
  io: { stdout: Pick<NodeJS.WriteStream, "write">; stderr: Pick<NodeJS.WriteStream, "write"> },
  repositoryRoot: string,
) {
  try {
    const args = parseQualificationV2SignerArgs(argv);
    const raw = await readJson(
      args.inputPath,
      "Qualification signer input",
      args.purpose === "qualification_result" ? 0o600 : null,
    );
    let payload = args.purpose === "qualification_plan"
      ? exp0001aModelRoleQualificationV2PlanSchema.parse(raw)
      : args.purpose === "qualification_launch_binding"
        ? qualificationV2ProductionBindingSchema.parse(raw)
        : qualificationV2ResultSchema.parse(raw);
    if (args.purpose === "qualification_result") {
      if (args.statePath === null || args.attestationPath === null) {
        throw new Error("QUALIFICATION_V2_RESULT_SIGNER_EVIDENCE_PATHS_REQUIRED");
      }
      await Promise.all([
        assertQualificationPrivatePath(repositoryRoot, args.inputPath, true),
        assertQualificationPrivatePath(repositoryRoot, args.statePath, true),
        assertQualificationPrivatePath(repositoryRoot, args.attestationPath, true),
        assertQualificationPrivatePath(repositoryRoot, args.outputPath, false),
      ]);
      const [stateRaw, attestationRaw] = await Promise.all([
        readJson(args.statePath, "Qualification terminal coordinator state", 0o600),
        readJson(args.attestationPath, "Qualification terminal evidence attestation", 0o600),
      ]);
      const state = qualificationV2CoordinatorStateSchema.parse(stateRaw);
      const attestation = qualificationV2TerminalEvidenceAttestationSchema.parse(attestationRaw);
      await verifyTerminalStateAuthorities(repositoryRoot, state);
      await verifyQualificationV2TerminalEvidenceAttestation({
        repositoryRoot,
        statePath: args.statePath,
        excludedPaths: [args.inputPath, args.attestationPath, args.outputPath],
        attestation,
      });
      const independentlyDerived = sealQualificationV2Result(
        state,
        qualificationV2ResultSchema.parse(payload).completedAt,
        attestation,
      );
      if (canonicalJson(independentlyDerived as unknown as JsonValue)
          !== canonicalJson(payload as unknown as JsonValue)) {
        throw new Error("QUALIFICATION_V2_RESULT_NOT_DERIVED_FROM_ATTESTED_TERMINAL_STATE");
      }
      payload = independentlyDerived;
    }
    const notBefore = args.purpose === "qualification_plan"
      ? exp0001aModelRoleQualificationV2PlanSchema.parse(payload).frozenAt
      : args.purpose === "qualification_launch_binding"
        ? qualificationV2ProductionBindingSchema.parse(payload).verifiedAt
        : qualificationV2ResultSchema.parse(payload).completedAt;
    const signedAt = new Date().toISOString();
    const authority = await loadFixedAuthority(repositoryRoot);
    const signature = createQualificationV2AuthoritySignature({
      payload: payload as unknown as JsonValue,
      purpose: args.purpose,
      signedAt,
      ...authority,
    });
    verifyExp0001aQualificationV2AuthoritySignature({
      payload: payload as unknown as JsonValue,
      signature,
      purpose: args.purpose,
      notBefore,
    });
    const output = args.purpose === "qualification_result"
      ? (() => {
        const content = {
          schemaVersion: "exp-0001a-model-role-qualification-signed-result/v2" as const,
          result: payload,
          authoritySignature: signature,
        };
        return signedQualificationV2ResultEnvelopeSchema.parse({
          ...content,
          envelopeDigest: hashCanonicalJson(content as unknown as JsonValue),
        });
      })()
      : signature;
    await writeNewAtomic(args.outputPath, output, args.purpose === "qualification_result" ? 0o600 : 0o644);
    io.stdout.write(`${canonicalJson({
      status: "signed",
      purpose: args.purpose,
      payloadDigest: signature.payloadDigest,
      outputDigest: hashCanonicalJson(output as unknown as JsonValue),
    })}\n`);
    return 0;
  } catch {
    io.stderr.write(`${canonicalJson({
      status: "error",
      errorCode: "QUALIFICATION_V2_SIGNER_ERROR",
    })}\n`);
    return 1;
  }
}
