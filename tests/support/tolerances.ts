/**
 * Recorded numerical tolerances for the GPU-vs-CPU comparison (AC.2).
 *
 * The CPU reference mirrors `shaders/step.frag` operation for operation in float32, so the
 * residual difference is not a precision artifact of the reference: it is driver rounding plus
 * possible fused-multiply-add contraction in the fragment shader, amplified by the nonlinear
 * reaction term over the compared number of steps.
 *
 * Measured on the target machine (ANGLE / Mesa Intel RPL-U, 40x40 grid, seam-crossing seed):
 * 1 step -> max |dU|=2.4e-7, |dV|=1.1e-7; 10 steps -> max |dU|=1.8e-7, |dV|=1.5e-7. The
 * tolerances below keep roughly an order of magnitude of headroom for other drivers while still
 * failing loudly on any real numerical divergence. Measured values are printed by both tests.
 */
export const GPU_CPU_TOLERANCE_1_STEP = 1e-6;
export const GPU_CPU_TOLERANCE_10_STEPS = 5e-6;

/** Bound for the 10,000-step smoke run's clipping frequency (fraction of cell-updates). */
export const CLIPPING_FREQUENCY_BOUND = 1e-3;
