const TAU = Math.PI * 2;

const RIPPLE_COLORS = [
  [255, 157, 115],
  [143, 133, 239],
  [103, 199, 170],
  [242, 189, 84],
  [108, 169, 239],
  [239, 125, 164],
  [127, 198, 106],
  [191, 132, 223],
] as const;

const FAMILY_COLORS = {
  puddle: [[164, 139, 233], [192, 148, 231], [139, 153, 234], [225, 144, 195]],
  loop: [[112, 126, 229], [123, 137, 239], [105, 147, 221], [144, 122, 226]],
  mochi: [[134, 205, 172], [119, 195, 181], [162, 208, 148], [112, 189, 202]],
} as const;

export type AvatarFamily = "puddle" | "loop" | "mochi" | "ripple";

export type RippleTraits = {
  family: "ripple";
  name: string;
  seed: number;
  color: readonly [number, number, number];
  lobeAmplitude: number;
  lobePhase: number;
  width: number;
  height: number;
  asymmetry: number;
  asymmetryPhase: number;
  lobeVariation: number;
  lobeVariationPhase: number;
  eyeSpacing: number;
  eyeHeight: number;
  eyeY: number;
};

type SharedFamilyTraits = {
  family: Exclude<AvatarFamily, "ripple">;
  name: string;
  seed: number;
  color: readonly [number, number, number];
  eyeHeight: number;
  eyeSpacing: number;
  eyeY: number;
  eyeX: number;
};

export type PuddleTraits = SharedFamilyTraits & {
  family: "puddle";
  width: number;
  height: number;
  phase: number;
  skew: number;
  bumpAngle: number;
  bumpWidth: number;
  bumpHeight: number;
};

export type LoopTraits = SharedFamilyTraits & {
  family: "loop";
  width: number;
  height: number;
  tubeBase: number;
  faceExpansion: number;
  centerX: number;
  centerY: number;
  tilt: number;
  roll: number;
  foldDepth: number;
};

export type MochiTraits = SharedFamilyTraits & {
  family: "mochi";
  width: number;
  height: number;
  exponent: number;
  lean: number;
  crown: number;
};

export type AvatarTraits = RippleTraits | PuddleTraits | LoopTraits | MochiTraits;

export function rippleHash(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function rippleRandom(seed: number, salt: number) {
  let value = seed + Math.imul(salt, 0x9e3779b1);
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return ((value ^ (value >>> 15)) >>> 0) / 4_294_967_296;
}

export function rippleTraitsFor(displayName: string): RippleTraits {
  const seed = rippleHash(`jazzboard-agent:${displayName}`);
  return {
    family: "ripple",
    name: displayName,
    seed,
    color: RIPPLE_COLORS[Math.floor(rippleRandom(seed, 17) * RIPPLE_COLORS.length)],
    lobeAmplitude: 0.165 + rippleRandom(seed, 1) * 0.025,
    lobePhase: -Math.PI / 2 + (rippleRandom(seed, 2) - 0.5) * 0.12,
    width: 0.78 * (0.95 + rippleRandom(seed, 3) * 0.1),
    height: 0.75 * (0.95 + rippleRandom(seed, 4) * 0.1),
    asymmetry: 0.014 + rippleRandom(seed, 5) * 0.012,
    asymmetryPhase: rippleRandom(seed, 6) * TAU,
    lobeVariation: 0.08 + rippleRandom(seed, 16) * 0.07,
    lobeVariationPhase: rippleRandom(seed, 18) * TAU,
    eyeSpacing: 0.205 + rippleRandom(seed, 7) * 0.065,
    eyeHeight: 0.265 + rippleRandom(seed, 8) * 0.035,
    eyeY: 0.08 + rippleRandom(seed, 9) * 0.045,
  };
}

export function avatarFamilyFor(displayName: string): AvatarFamily {
  const families: AvatarFamily[] = ["puddle", "loop", "mochi", "ripple"];
  const seed = rippleHash(`jazzboard-agent-family:v1:${displayName}`);
  return families[Math.floor(rippleRandom(seed, 71) * families.length)];
}

export function avatarTraitsFor(displayName: string): AvatarTraits {
  const family = avatarFamilyFor(displayName);
  if (family === "ripple") return rippleTraitsFor(displayName);
  const seed = rippleHash(`jazzboard-agent:${family}:${displayName}`);
  const colors = FAMILY_COLORS[family];
  const shared = {
    family,
    name: displayName,
    seed,
    color: colors[Math.floor(rippleRandom(seed, 1) * colors.length)],
    eyeHeight: 0.17 + rippleRandom(seed, 2) * 0.022,
    eyeSpacing: 0.17 + rippleRandom(seed, 3) * 0.04,
    eyeY: 0.075 + (rippleRandom(seed, 4) - 0.5) * 0.025,
  };

  if (family === "puddle") {
    return {
      ...shared,
      family,
      width: 0.79 + rippleRandom(seed, 5) * 0.06,
      height: 0.55 + rippleRandom(seed, 6) * 0.055,
      phase: (rippleRandom(seed, 7) - 0.5) * 0.5,
      skew: (rippleRandom(seed, 8) - 0.5) * 0.07,
      bumpAngle: -0.78 + (rippleRandom(seed, 9) - 0.5) * 0.23,
      bumpWidth: 0.17 + rippleRandom(seed, 16) * 0.025,
      bumpHeight: 0.19 + rippleRandom(seed, 17) * 0.025,
      eyeX: -0.08 + (rippleRandom(seed, 12) - 0.5) * 0.035,
      eyeY: 0.1 + (rippleRandom(seed, 13) - 0.5) * 0.025,
    };
  }
  if (family === "loop") {
    return {
      ...shared,
      family,
      width: 0.575 + (rippleRandom(seed, 5) - 0.5) * 0.025,
      height: 0.43 + (rippleRandom(seed, 6) - 0.5) * 0.018,
      tubeBase: 0.142 + rippleRandom(seed, 7) * 0.012,
      faceExpansion: 0.225 + rippleRandom(seed, 8) * 0.02,
      centerX: 0.015 + (rippleRandom(seed, 9) - 0.5) * 0.015,
      centerY: 0.025 + (rippleRandom(seed, 10) - 0.5) * 0.015,
      tilt: 0.38 + rippleRandom(seed, 11) * 0.1,
      roll: 0.245 + rippleRandom(seed, 13) * 0.045,
      foldDepth: 0.88 + rippleRandom(seed, 12) * 0.06,
      eyeX: -0.405 + (rippleRandom(seed, 14) - 0.5) * 0.025,
      eyeY: 0.095 + (rippleRandom(seed, 15) - 0.5) * 0.02,
    };
  }
  const tallness = rippleRandom(seed, 5);
  return {
    ...shared,
    family,
    width: 0.66 + (1 - tallness) * 0.105 + rippleRandom(seed, 6) * 0.035,
    height: 0.62 + tallness * 0.115 + rippleRandom(seed, 7) * 0.03,
    exponent: 3.65 + rippleRandom(seed, 8) * 0.65,
    lean: (rippleRandom(seed, 9) - 0.5) * 0.05,
    crown: (rippleRandom(seed, 10) - 0.5) * 0.022,
    eyeX: (rippleRandom(seed, 11) - 0.5) * 0.035,
    eyeY: 0.07 + (rippleRandom(seed, 12) - 0.5) * 0.025,
  };
}

export function ripplePrimaryColor(displayName: string) {
  return `#${rippleTraitsFor(displayName).color
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function avatarPrimaryColor(displayName: string) {
  return `#${avatarTraitsFor(displayName).color
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}
