/** Maior lado da imagem guardada. Acima disso o dataURL fica grande demais. */
const MAX_SIDE = 1600;
const JPEG_QUALITY = 0.82;

/**
 * Reduz a imagem escolhida e devolve um dataURL JPEG.
 *
 * O arquivo original pode ter dezenas de MB; como o wallpaper é guardado no
 * IndexedDB e só aparece desfocado atrás do app, 1600px de lado maior já é mais
 * resolução do que se consegue enxergar.
 */
export function downscaleImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      try {
        const k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * k);
        canvas.height = Math.round(img.height * k);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas 2d indisponível');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      } finally {
        URL.revokeObjectURL(url);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('não foi possível ler a imagem'));
    };

    img.src = url;
  });
}
