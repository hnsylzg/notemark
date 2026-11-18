const MIN_RASTER_SCALE = 2;
const MAX_RASTER_SCALE = 3;
const FALLBACK_SIZE_PX = 1;

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("公式图片加载失败"));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

function rasterScale(): number {
  return Math.min(
    MAX_RASTER_SCALE,
    Math.max(MIN_RASTER_SCALE, window.devicePixelRatio || MIN_RASTER_SCALE)
  );
}

/** 把当前可见的 MathJax SVG 栅格化为透明背景 canvas。 */
export async function formulaSvgToCanvas(
  source: SVGSVGElement
): Promise<HTMLCanvasElement> {
  const rect = source.getBoundingClientRect();
  const logicalWidth = Math.max(FALLBACK_SIZE_PX, rect.width);
  const logicalHeight = Math.max(FALLBACK_SIZE_PX, rect.height);
  const clone = source.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("width", String(logicalWidth));
  clone.setAttribute("height", String(logicalHeight));
  clone.style.color = getComputedStyle(source).color;

  const scale = rasterScale();
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(logicalWidth * scale));
  canvas.height = Math.max(1, Math.round(logicalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建公式图片画布");

  const image = await loadSvgImage(new XMLSerializer().serializeToString(clone));
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("无法生成公式 PNG"));
    }, "image/png");
  });
}
