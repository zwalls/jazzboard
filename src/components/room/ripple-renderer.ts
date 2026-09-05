import { rippleTraitsFor, type RippleTraits } from "./ripple-traits";

export type RippleEyeGeometry = {
  centersX: [number, number];
  centerY: number;
  halfWidth: number;
  halfHeight: number;
  cornerRadius: number;
  maxLookOffset: number;
};

export type RippleBody = {
  name: string;
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
  eyeGeometry: RippleEyeGeometry;
};

const TAU = Math.PI * 2;

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value));
}

function smoothstep(low: number, high: number, value: number) {
  const t = clamp((value - low) / (high - low), 0, 1);
  return t * t * (3 - 2 * t);
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

function boundaryRadius(theta: number, traits: RippleTraits) {
  const modulation = 1 + traits.lobeVariation * Math.cos(theta + traits.lobeVariationPhase);
  const lobes = traits.lobeAmplitude * modulation * Math.cos(5 * (theta - traits.lobePhase));
  const asymmetry = traits.asymmetry * Math.cos(2 * theta + traits.asymmetryPhase);
  return 1 + lobes + asymmetry;
}

function surfaceSample(x: number, y: number, traits: RippleTraits) {
  const scaledX = x / traits.width;
  const scaledY = y / traits.height;
  const theta = Math.atan2(scaledY, scaledX);
  const radius = Math.hypot(scaledX, scaledY);
  const boundary = boundaryRadius(theta, traits);
  const inside = 1 - radius / boundary;
  if (inside <= 0) return { height: 0, inside };

  const broadX = x / (traits.width * 1.3);
  const broadY = (y + 0.025) / (traits.height * 1.27);
  const centralDome = Math.sqrt(Math.max(0, 1 - broadX * broadX - broadY * broadY));
  const contourWeight = smoothstep(0.3, 0.7, radius);
  const shadingBoundary = 1 + (boundary - 1) * contourWeight;
  const shadingRadius = radius / shadingBoundary;
  const edgeRoll = Math.pow(Math.max(0, 1 - shadingRadius * shadingRadius), 0.55);
  let lobeCushion = 0;
  for (let index = 0; index < 5; index += 1) {
    const lobeAngle = traits.lobePhase + (index / 5) * TAU;
    const lobeX = Math.cos(lobeAngle) * traits.width * 0.69;
    const lobeY = Math.sin(lobeAngle) * traits.height * 0.69;
    const offsetX = (x - lobeX) / (traits.width * 0.42);
    const offsetY = (y - lobeY) / (traits.height * 0.42);
    lobeCushion += Math.exp(-(offsetX * offsetX + offsetY * offsetY) * 2.2) * 0.035;
  }
  return { height: edgeRoll * (0.28 + centralDome * 0.72 + lobeCushion), inside };
}

function blendPixel(
  data: Uint8ClampedArray,
  index: number,
  red: number,
  green: number,
  blue: number,
  alpha: number,
) {
  const sourceAlpha = clamp(alpha, 0, 1);
  if (sourceAlpha <= 0) return;
  const destinationAlpha = data[index + 3] / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  const mix = outputAlpha > 0 ? sourceAlpha / outputAlpha : 0;
  data[index] = Math.round(data[index] + (red - data[index]) * mix);
  data[index + 1] = Math.round(data[index + 1] + (green - data[index + 1]) * mix);
  data[index + 2] = Math.round(data[index + 2] + (blue - data[index + 2]) * mix);
  data[index + 3] = Math.round(outputAlpha * 255);
}

export function renderRippleBody(name: string, size: number): RippleBody {
  const safeSize = clamp(Math.round(size), 16, 192);
  const traits = rippleTraitsFor(name);
  const data = new Uint8ClampedArray(safeSize * safeSize * 4);
  const pixel = 2 / safeSize;
  const normalStep = pixel * 0.85;
  const light = normalize3(-0.48, -0.58, 0.66);
  const viewHalf = normalize3(light[0], light[1], light[2] + 1);

  for (let row = 0; row < safeSize; row += 1) {
    const y = ((row + 0.5) / safeSize) * 2 - 1;
    for (let column = 0; column < safeSize; column += 1) {
      const x = ((column + 0.5) / safeSize) * 2 - 1;
      const index = (row * safeSize + column) * 4;
      const shadowX = x / 0.57;
      const shadowY = (y - 0.79) / 0.075;
      const shadowAlpha = Math.exp(-(shadowX * shadowX * 2.2 + shadowY * shadowY * 2.7)) * 0.2;
      blendPixel(
        data,
        index,
        traits.color[0] * 0.45,
        traits.color[1] * 0.4,
        traits.color[2] * 0.45,
        shadowAlpha,
      );

      const surface = surfaceSample(x, y, traits);
      const coverage = smoothstep(-pixel * 1.1, pixel * 1.1, surface.inside);
      if (coverage <= 0) continue;
      const left = surfaceSample(x - normalStep, y, traits).height;
      const right = surfaceSample(x + normalStep, y, traits).height;
      const top = surfaceSample(x, y - normalStep, traits).height;
      const bottom = surfaceSample(x, y + normalStep, traits).height;
      const normal = normalize3((left - right) * 0.62, (top - bottom) * 0.62, normalStep * 2);
      const diffuseDot = Math.max(0, normal[0] * light[0] + normal[1] * light[1] + normal[2] * light[2]);
      const wrappedDiffuse = (diffuseDot + 0.38) / 1.38;
      const halfDot = Math.max(0, normal[0] * viewHalf[0] + normal[1] * viewHalf[1] + normal[2] * viewHalf[2]);
      const broadSpecular = Math.pow(halfDot, 5) * 0.015;
      const edgeDepth = smoothstep(0, 0.34, surface.inside);
      const ambientOcclusion = 0.9 + edgeDepth * 0.1;
      const underside = 1 - Math.max(0, y - 0.18) * 0.08;
      const foamLight = (0.7 + wrappedDiffuse * 0.32) * ambientOcclusion * underside;
      const warmBounce = Math.max(0, y) * 3;
      blendPixel(
        data,
        index,
        clamp(traits.color[0] * foamLight + broadSpecular * 255 + warmBounce, 0, 255),
        clamp(traits.color[1] * foamLight + broadSpecular * 248 + warmBounce * 0.45, 0, 255),
        clamp(traits.color[2] * foamLight + broadSpecular * 242, 0, 255),
        coverage,
      );
    }
  }

  return {
    name,
    width: safeSize,
    height: safeSize,
    data,
    eyeGeometry: {
      centersX: [-traits.eyeSpacing / 2, traits.eyeSpacing / 2],
      centerY: traits.eyeY,
      halfWidth: 0.047,
      halfHeight: traits.eyeHeight / 2,
      cornerRadius: 0.043,
      maxLookOffset: 0.027,
    },
  };
}
