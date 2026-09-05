import {
  avatarFamilyFor,
  avatarTraitsFor,
  rippleTraitsFor,
  type AvatarFamily,
  type LoopTraits,
  type MochiTraits,
  type PuddleTraits,
  type RippleTraits,
} from "./ripple-traits";

export type RippleEyeGeometry = {
  centersX: [number, number];
  centerY: number;
  halfWidth: number;
  halfHeight: number;
  cornerRadius: number;
  maxLookOffset: number;
};

export type RippleBody = {
  family: AvatarFamily;
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
    family: "ripple",
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

function smoothMax(a: number, b: number, radius: number) {
  const blend = clamp(0.5 + (0.5 * (a - b)) / radius, 0, 1);
  return b + (a - b) * blend + radius * blend * (1 - blend);
}

function superellipseRadius(x: number, y: number, width: number, height: number, exponent: number) {
  return Math.pow(
    Math.pow(Math.abs(x / width), exponent) + Math.pow(Math.abs(y / height), exponent),
    1 / exponent,
  );
}

function samplePuddle(x: number, y: number, traits: PuddleTraits) {
  const shiftedX = x - traits.skew * (0.3 - y);
  const shiftedY = y + 0.075;
  const baseRadius = superellipseRadius(shiftedX, shiftedY, traits.width, traits.height, 2.65);
  const theta = Math.atan2(shiftedY / traits.height, shiftedX / traits.width);
  const baseInside = 1 - baseRadius + 0.018 * Math.cos(theta * 2 + traits.phase);
  const bumpX = Math.cos(traits.bumpAngle) * traits.width * 0.79;
  const bumpY = -0.535 + Math.sin(traits.bumpAngle + 0.78) * 0.035;
  const bumpRadius = Math.hypot(
    (x - bumpX) / traits.bumpWidth,
    (y - bumpY) / traits.bumpHeight,
  );
  const bumpInside = 1 - bumpRadius;
  const join = 0.055;
  const inside =
    0.5 *
    (baseInside +
      bumpInside +
      Math.sqrt(Math.pow(baseInside - bumpInside, 2) + join * join));
  if (inside <= 0) return { inside, height: 0 };
  const broad = Math.sqrt(
    Math.max(
      0,
      1 -
        Math.pow(shiftedX / (traits.width * 1.12), 2) -
        Math.pow(shiftedY / (traits.height * 1.16), 2),
    ),
  );
  const baseRoll =
    Math.pow(Math.max(0, 1 - baseRadius * baseRadius), 0.56) * (0.39 + broad * 0.61);
  const bumpDome = Math.sqrt(Math.max(0, 1 - bumpRadius * bumpRadius)) * 0.87;
  const bumpBlend = smoothstep(-0.04, 0.14, bumpInside);
  return {
    inside,
    height: Math.min(1.12, smoothMax(baseRoll, bumpDome * bumpBlend * 0.86, 0.17)),
  };
}

function sampleMochi(x: number, y: number, traits: MochiTraits) {
  const shiftedX = x - traits.lean * (y + 0.05);
  const shiftedY = y + 0.025 + traits.crown * Math.cos((x / traits.width) * Math.PI);
  const radius = superellipseRadius(
    shiftedX,
    shiftedY,
    traits.width,
    traits.height,
    traits.exponent,
  );
  const inside = 1 - radius;
  if (inside <= 0) return { inside, height: 0 };
  const edgeRoll = Math.pow(Math.max(0, 1 - radius * radius), 0.53);
  const broad = Math.sqrt(
    Math.max(
      0,
      1 -
        Math.pow(shiftedX / (traits.width * 1.2), 2) -
        Math.pow(shiftedY / (traits.height * 1.22), 2),
    ),
  );
  return { inside, height: edgeRoll * (0.34 + broad * 0.66) };
}

function loopPoint(traits: LoopTraits, u: number, v: number) {
  const cosineU = Math.cos(u);
  const sineU = Math.sin(u);
  const broadFaceWeight = (1 - Math.cos(u + 0.8)) * 0.5;
  const tubeRadius = traits.tubeBase + traits.faceExpansion * broadFaceWeight;
  const localX = (traits.width + tubeRadius * Math.cos(v)) * cosineU;
  const localY = (traits.height + tubeRadius * Math.cos(v)) * sineU;
  const localZ = tubeRadius * traits.foldDepth * Math.sin(v);
  const yawCosine = Math.cos(traits.tilt);
  const yawSine = Math.sin(traits.tilt);
  const yawedX = localX * yawCosine + localZ * yawSine;
  const yawedZ = -localX * yawSine + localZ * yawCosine;
  const rollCosine = Math.cos(traits.roll);
  const rollSine = Math.sin(traits.roll);
  return {
    x: yawedX + traits.centerX,
    y: localY * rollCosine - yawedZ * rollSine + traits.centerY,
    z: localY * rollSine + yawedZ * rollCosine,
    inner: clamp(-Math.cos(v), 0, 1),
    rear: clamp(-sineU, 0, 1),
    lower: clamp(sineU, 0, 1),
  };
}

type LoopVertex = ReturnType<typeof loopVertex>;

function loopVertex(traits: LoopTraits, u: number, v: number, rasterSize: number) {
  const point = loopPoint(traits, u, v);
  const epsilon = 0.001;
  const along = loopPoint(traits, u + epsilon, v);
  const around = loopPoint(traits, u, v + epsilon);
  const ux = along.x - point.x;
  const uy = along.y - point.y;
  const uz = along.z - point.z;
  const vx = around.x - point.x;
  const vy = around.y - point.y;
  const vz = around.z - point.z;
  let normal = normalize3(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  if (normal[2] < 0) normal = [-normal[0], -normal[1], -normal[2]];
  return {
    x: ((point.x + 1) * rasterSize) / 2,
    y: ((point.y + 1) * rasterSize) / 2,
    z: point.z,
    nx: normal[0],
    ny: normal[1],
    nz: normal[2],
    inner: point.inner,
    rear: point.rear,
    lower: point.lower,
  };
}

function renderLoopBody(name: string, size: number, traits: LoopTraits): RippleBody {
  const data = new Uint8ClampedArray(size * size * 4);
  const depths = new Float32Array(size * size);
  depths.fill(-Infinity);
  for (let row = 0; row < size; row += 1) {
    const y = ((row + 0.5) / size) * 2 - 1;
    for (let column = 0; column < size; column += 1) {
      const x = ((column + 0.5) / size) * 2 - 1;
      const shadowX = (x + 0.01) / 0.61;
      const shadowY = (y - 0.69) / 0.07;
      const shadowAlpha = Math.exp(-(shadowX * shadowX * 2.1 + shadowY * shadowY * 2.8)) * 0.19;
      blendPixel(
        data,
        (row * size + column) * 4,
        traits.color[0] * 0.42,
        traits.color[1] * 0.39,
        traits.color[2] * 0.46,
        shadowAlpha,
      );
    }
  }

  const uSegments = 88;
  const vSegments = 24;
  const vertices: LoopVertex[] = [];
  for (let uIndex = 0; uIndex <= uSegments; uIndex += 1) {
    for (let vIndex = 0; vIndex <= vSegments; vIndex += 1) {
      vertices.push(
        loopVertex(
          traits,
          (uIndex / uSegments) * Math.PI * 2,
          (vIndex / vSegments) * Math.PI * 2,
          size,
        ),
      );
    }
  }

  const light = normalize3(-0.46, -0.6, 0.66);
  const halfVector = normalize3(light[0], light[1], light[2] + 1);
  const rasterizeTriangle = (a: LoopVertex, b: LoopVertex, c: LoopVertex) => {
    const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(denominator) < 0.0001) return;
    const left = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const right = Math.min(size - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const top = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const bottom = Math.min(size - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        const px = column + 0.5;
        const py = row + 0.5;
        const wa = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / denominator;
        const wb = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / denominator;
        const wc = 1 - wa - wb;
        if (wa < -0.0001 || wb < -0.0001 || wc < -0.0001) continue;
        const pixelIndex = row * size + column;
        const z = a.z * wa + b.z * wb + c.z * wc;
        if (z <= depths[pixelIndex]) continue;
        depths[pixelIndex] = z;
        let normal = normalize3(
          a.nx * wa + b.nx * wb + c.nx * wc,
          a.ny * wa + b.ny * wb + c.ny * wc,
          a.nz * wa + b.nz * wb + c.nz * wc,
        );
        if (normal[2] < 0) normal = [-normal[0], -normal[1], -normal[2]];
        const inner = a.inner * wa + b.inner * wb + c.inner * wc;
        const rear = a.rear * wa + b.rear * wb + c.rear * wc;
        const lower = a.lower * wa + b.lower * wb + c.lower * wc;
        const diffuse = Math.max(
          0,
          normal[0] * light[0] + normal[1] * light[1] + normal[2] * light[2],
        );
        const wrapped = (diffuse + 0.4) / 1.4;
        const halfDot = Math.max(
          0,
          normal[0] * halfVector[0] +
            normal[1] * halfVector[1] +
            normal[2] * halfVector[2],
        );
        const specular = Math.pow(halfDot, 6) * 0.018;
        const wallOcclusion = 1 - inner * (0.16 + rear * 0.16);
        const frontBounce = inner * lower * 0.055;
        const foamLight = (0.69 + wrapped * 0.33) * wallOcclusion + frontBounce;
        const dataIndex = pixelIndex * 4;
        data[dataIndex] = clamp(traits.color[0] * foamLight + specular * 255, 0, 255);
        data[dataIndex + 1] = clamp(traits.color[1] * foamLight + specular * 249, 0, 255);
        data[dataIndex + 2] = clamp(
          traits.color[2] * foamLight + specular * 246 + frontBounce * 20,
          0,
          255,
        );
        data[dataIndex + 3] = 255;
      }
    }
  };

  for (let uIndex = 0; uIndex < uSegments; uIndex += 1) {
    for (let vIndex = 0; vIndex < vSegments; vIndex += 1) {
      const aIndex = uIndex * (vSegments + 1) + vIndex;
      const bIndex = aIndex + vSegments + 1;
      rasterizeTriangle(vertices[aIndex], vertices[bIndex], vertices[aIndex + 1]);
      rasterizeTriangle(vertices[aIndex + 1], vertices[bIndex], vertices[bIndex + 1]);
    }
  }

  return {
    family: "loop",
    name,
    width: size,
    height: size,
    data,
    eyeGeometry: {
      centersX: [traits.eyeX - traits.eyeSpacing / 2, traits.eyeX + traits.eyeSpacing / 2],
      centerY: traits.eyeY,
      halfWidth: 0.039,
      halfHeight: traits.eyeHeight / 2,
      cornerRadius: 0.036,
      maxLookOffset: 0.027,
    },
  };
}

function renderSimpleFamilyBody(
  name: string,
  size: number,
  traits: PuddleTraits | MochiTraits,
): RippleBody {
  const data = new Uint8ClampedArray(size * size * 4);
  const pixel = 2 / size;
  const normalStep = pixel * 0.88;
  const light = normalize3(-0.46, -0.6, 0.66);
  const halfVector = normalize3(light[0], light[1], light[2] + 1);
  const sample = traits.family === "puddle"
    ? (x: number, y: number) => samplePuddle(x, y, traits)
    : (x: number, y: number) => sampleMochi(x, y, traits);
  for (let row = 0; row < size; row += 1) {
    const y = ((row + 0.5) / size) * 2 - 1;
    for (let column = 0; column < size; column += 1) {
      const x = ((column + 0.5) / size) * 2 - 1;
      const index = (row * size + column) * 4;
      const shadowWidth = traits.family === "puddle" ? 0.66 : 0.59;
      const shadowY = traits.family === "puddle" ? 0.535 : 0.7;
      const shadowX = x / shadowWidth;
      const shadowVertical = (y - shadowY) / 0.07;
      const shadowAlpha =
        Math.exp(-(shadowX * shadowX * 2.15 + shadowVertical * shadowVertical * 2.8)) * 0.19;
      blendPixel(
        data,
        index,
        traits.color[0] * 0.42,
        traits.color[1] * 0.39,
        traits.color[2] * 0.46,
        shadowAlpha,
      );
      const surface = sample(x, y);
      const coverage = smoothstep(-pixel * 1.15, pixel * 1.15, surface.inside);
      if (coverage <= 0) continue;
      const left = sample(x - normalStep, y).height;
      const right = sample(x + normalStep, y).height;
      const top = sample(x, y - normalStep).height;
      const bottom = sample(x, y + normalStep).height;
      const normal = normalize3((left - right) * 0.68, (top - bottom) * 0.68, normalStep * 2);
      const diffuse = Math.max(
        0,
        normal[0] * light[0] + normal[1] * light[1] + normal[2] * light[2],
      );
      const wrapped = (diffuse + 0.4) / 1.4;
      const halfDot = Math.max(
        0,
        normal[0] * halfVector[0] + normal[1] * halfVector[1] + normal[2] * halfVector[2],
      );
      const specular = Math.pow(halfDot, 5) * 0.016;
      const edgeDepth = smoothstep(0, 0.31, surface.inside);
      const occlusion = 0.895 + edgeDepth * 0.105;
      const underside = 1 - Math.max(0, y - 0.14) * 0.075;
      const foamLight = (0.695 + wrapped * 0.325) * occlusion * underside;
      const bounce = Math.max(0, y) * 2.5;
      blendPixel(
        data,
        index,
        clamp(traits.color[0] * foamLight + specular * 255 + bounce, 0, 255),
        clamp(traits.color[1] * foamLight + specular * 249 + bounce * 0.52, 0, 255),
        clamp(traits.color[2] * foamLight + specular * 246, 0, 255),
        coverage,
      );
    }
  }
  return {
    family: traits.family,
    name,
    width: size,
    height: size,
    data,
    eyeGeometry: {
      centersX: [traits.eyeX - traits.eyeSpacing / 2, traits.eyeX + traits.eyeSpacing / 2],
      centerY: traits.eyeY,
      halfWidth: 0.039,
      halfHeight: traits.eyeHeight / 2,
      cornerRadius: 0.036,
      maxLookOffset: 0.027,
    },
  };
}

export function renderAvatarBody(name: string, requestedSize: number): RippleBody {
  const family = avatarFamilyFor(name);
  if (family === "ripple") return renderRippleBody(name, requestedSize);
  const size = clamp(Math.round(requestedSize), 16, 192);
  const traits = avatarTraitsFor(name);
  if (traits.family === "ripple") return renderRippleBody(name, size);
  if (traits.family === "loop") return renderLoopBody(name, size, traits);
  return renderSimpleFamilyBody(name, size, traits);
}
