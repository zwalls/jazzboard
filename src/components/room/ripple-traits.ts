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

export type RippleTraits = {
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

export function ripplePrimaryColor(displayName: string) {
  return `#${rippleTraitsFor(displayName).color
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}
