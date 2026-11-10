const alphaMaps = new Map<string, CanvasRenderingContext2D | null>();

export function hitOpaquePixel(picture: HTMLImageElement, point: { clientX: number; clientY: number }): boolean {
  if (!picture.complete || !picture.naturalWidth || !picture.naturalHeight) return true;
  let pixels = alphaMaps.get(picture.src);
  if (pixels === undefined) {
    const canvas = document.createElement('canvas');
    canvas.width = picture.naturalWidth;
    canvas.height = picture.naturalHeight;
    try {
      pixels = canvas.getContext('2d', { willReadFrequently: true });
      pixels?.drawImage(picture, 0, 0);
    } catch { pixels = null; }
    alphaMaps.set(picture.src, pixels);
  }
  const bounds = picture.getBoundingClientRect();
  if (!pixels || !bounds.width || !bounds.height) return true;
  const x = Math.floor((point.clientX - bounds.left) / bounds.width * picture.naturalWidth);
  const y = Math.floor((point.clientY - bounds.top) / bounds.height * picture.naturalHeight);
  if (x < 0 || y < 0 || x >= picture.naturalWidth || y >= picture.naturalHeight) return false;
  try { return pixels.getImageData(x, y, 1, 1).data[3] > 28; } catch { return true; }
}
