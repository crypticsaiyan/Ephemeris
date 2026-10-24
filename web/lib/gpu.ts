"use client";

/** Whether WebGL here is drawn by the CPU.
 *
 *  A headless browser, a virtual machine, or a laptop with acceleration switched off renders
 *  through SwiftShader or llvmpipe, and the orrery at full device pixel ratio then costs about
 *  fifty milliseconds a frame: the page still works, but every keystroke waits behind a frame.
 *  Knowing this before the canvas mounts lets the scene pick a cheaper size instead of a
 *  stuttering one. The answer is cached: the probe context is created once and discarded. */

let cached: boolean | null = null;

export function softwareRenderer(): boolean {
  if (cached !== null) return cached;
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: false }) ??
      canvas.getContext("webgl", { failIfMajorPerformanceCaveat: false });
    if (!gl) return (cached = true);
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    cached = /swiftshader|llvmpipe|software|mesa offscreen|microsoft basic render/i.test(renderer);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return cached;
  } catch {
    return (cached = false);
  }
}
