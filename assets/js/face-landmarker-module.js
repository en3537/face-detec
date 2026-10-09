const EDGE_VISION_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";
const EDGE_WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const EDGE_MODEL_URL = "/model/face_landmarker.task";
const EDGE_DETECTOR_URL = "/assets/js/fatigue-detector.js";

let edgePromise = null;
let landmarker = null;

window.edgeDetector = null;

// =========================================================
// Edge：載入 MediaPipe Face Landmarker 與疲勞偵測器
// =========================================================

function ensureEdge() {
  if (edgePromise) return edgePromise;

  edgePromise = (async () => {
    const [vision, detectorModule] = await Promise.all([
      import(EDGE_VISION_URL),
      import(EDGE_DETECTOR_URL),
    ]);

    if (typeof addSystemLog === "function") {
      addSystemLog("[OK] Fatigue Detector module loaded", "success");
    }

    const { FaceLandmarker, FilesetResolver } = vision;

    const fileset = await FilesetResolver.forVisionTasks(EDGE_WASM_URL);

    const create = (delegate) =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: EDGE_MODEL_URL,
          delegate,
        },
        runningMode: "VIDEO",
        numFaces: 1,
      });

    try {
      landmarker = await create("GPU");

      if (typeof addSystemLog === "function") {
        addSystemLog("[OK] MediaPipe GPU initialized", "success");
      }
    } catch (error) {
      console.warn(
        "[EDGE] GPU delegate unavailable, falling back to CPU.",
        error,
      );

      if (typeof addSystemLog === "function") {
        addSystemLog("[INFO] GPU unavailable, using CPU", "info");
      }

      landmarker = await create("CPU");

      if (typeof addSystemLog === "function") {
        addSystemLog("[OK] MediaPipe CPU initialized", "success");
      }
    }

    let config = null;

    try {
      const response = await fetch("/api/config", { cache: "no-store" });
      if (!response.ok)
        throw new Error(`Config API returned ${response.status}`);
      config = await response.json();
    } catch (error) {
      console.error("[CONFIG] Failed to load Python config:", error);
      throw error;
    }

    window.edgeConfig = config;
    applyLandmarkConfig(config);

    window.edgeDetector = new detectorModule.FatigueDetector({
      config,
    });

    if (typeof addSystemLog === "function") {
      addSystemLog("[OK] MediaPipe Face Landmarker initialized", "success");

      addSystemLog("[OK] Fatigue Detector initialized", "success");
    }
  })();

  edgePromise.catch(() => {
    edgePromise = null;
  });

  return edgePromise;
}
