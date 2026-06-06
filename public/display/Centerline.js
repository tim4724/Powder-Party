// Centerline — an OPEN polyline of oriented frames (pos, tangent, up, lateral)
// with cumulative arclength, interpolated with a non-uniform Catmull-Rom spline.
// Adapted from the reference kart game's (closed-loop) Centerline: a ski run is
// point-to-point (a top and a bottom), not a lap, so sampleAt CLAMPS s to
// [0, length] and clamps the four-point stencil at the ends instead of wrapping.
// The spline/Hermite math is otherwise identical, and we return the spline's OWN
// derivative as the tangent so facing == direction of travel (no shimmy).
import * as THREE from 'three';

export class Centerline {
  constructor(samples, length) {
    this.samples = samples;     // [{pos, tangent, up, lateral, s}]
    this.length = length;
  }

  sampleAt(s) {
    const len = this.length;
    // OPEN path: clamp instead of wrap. (Lets a finished skier coast a hair past
    // the line without the sampler snapping back to the top.)
    if (s < 0) s = 0; else if (s > len) s = len;

    const a = this.samples, n = a.length;
    let i = 0;
    while (i < n - 1 && a[i + 1].s <= s) i++;

    // Four-point stencil around the segment [i, i+1], CLAMPED at the open ends
    // (duplicate the endpoint instead of wrapping the ring).
    const idx = (k) => (k < 0 ? 0 : k > n - 1 ? n - 1 : k);
    const pA = a[idx(i - 1)], pB = a[i], pC = a[idx(i + 1)], pD = a[idx(i + 2)];
    const sB = pB.s;
    // Arclengths are already monotonic on an open path; nudge degenerate spans so
    // the duplicated endpoints don't divide by zero.
    let sA = pA.s, sC = pC.s, sD = pD.s;
    if (sA >= sB) sA = sB - 1e-3;
    if (sC <= sB) sC = sB + 1e-3;
    if (sD <= sC) sD = sC + 1e-3;

    const h = (sC - sB) || 1e-6;
    const u = (s - sB) / h, u2 = u * u, u3 = u2 * u;
    // Non-uniform Catmull-Rom = cubic Hermite with finite-difference tangents
    // (per unit arclength) at the two knots; tangents scaled by the segment span.
    const mB = pC.pos.clone().sub(pA.pos).multiplyScalar(h / ((sC - sA) || 1e-6));
    const mC = pD.pos.clone().sub(pB.pos).multiplyScalar(h / ((sD - sB) || 1e-6));
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    const pos = pB.pos.clone().multiplyScalar(h00)
      .addScaledVector(mB, h10).addScaledVector(pC.pos, h01).addScaledVector(mC, h11);
    // Derivative of the same curve → tangent (motion direction == facing).
    const g00 = 6 * u2 - 6 * u, g10 = 3 * u2 - 4 * u + 1;
    const g01 = -6 * u2 + 6 * u, g11 = 3 * u2 - 2 * u;
    const tangent = pB.pos.clone().multiplyScalar(g00)
      .addScaledVector(mB, g10).addScaledVector(pC.pos, g01).addScaledVector(mC, g11).normalize();

    const f = u;
    const up = pB.up.clone().lerp(pC.up, f).normalize();
    const lateral = tangent.clone().cross(up).normalize();
    return { pos, tangent, up, lateral };
  }
}
