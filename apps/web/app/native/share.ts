import { Capacitor } from '@capacitor/core';

interface ShareOptions {
  title: string;
  text: string;
  /**
   * Image to include in the share sheet — e.g. the composited
   * gift-card face. Accepts either a `data:image/png;base64,...`
   * URL or a fetch-able HTTP URL. On native we write it to
   * `Directory.Cache` via `@capacitor/filesystem` and hand the
   * resulting URI to the Share plugin (the plugin's `files`
   * field rejects blob / data URIs directly). On web we stream
   * the blob into a `File` and use `navigator.share({ files })`
   * when the browser supports it.
   */
  imageUrl?: string | undefined;
  /** Alt text / filename the share sheet will display. */
  imageFilename?: string | undefined;
}

/**
 * Materialises an image URL / data URL as a PNG file in the
 * OS-managed cache directory and returns its addressable URI. Used
 * to hand an image to `@capacitor/share`'s `files` field, which
 * rejects data / blob URIs directly. Only called on native —
 * `Directory.Cache` on web falls through to IndexedDB which the
 * share intent can't reach anyway.
 */
async function writeTempShareImage(imageUrl: string, filename: string): Promise<string | null> {
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    // Accept either a data URL (already-base64) or an HTTP URL
    // that we fetch and re-encode. The CTX-hosted barcode images
    // come as HTTP via the image proxy; the canvas-composited
    // share image comes as data:image/png;base64,...
    let base64: string;
    if (imageUrl.startsWith('data:')) {
      const comma = imageUrl.indexOf(',');
      if (comma < 0) return null;
      base64 = imageUrl.slice(comma + 1);
    } else {
      const response = await fetch(imageUrl);
      if (!response.ok) return null;
      const blob = await response.blob();
      base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
        reader.onload = () => {
          const dataUrl = reader.result;
          if (typeof dataUrl !== 'string') {
            reject(new Error('FileReader produced non-string result'));
            return;
          }
          const comma = dataUrl.indexOf(',');
          resolve(comma < 0 ? '' : dataUrl.slice(comma + 1));
        };
        reader.readAsDataURL(blob);
      });
    }
    // A2-1213: prefix the filename with `share/` so it lands in
    // `<cache>/share/`, the only directory the Android FileProvider
    // grants access to (see `apps/mobile/native-overlays/android/app/
    // src/main/res/xml/file_paths.xml`). Capacitor's writeFile creates
    // intermediate directories automatically.
    const scopedPath = `share/${filename}`;
    // No `encoding` field — the plugin interprets the data as
    // base64 when the option is omitted, which is exactly what we
    // want for binary PNG payloads. Passing `Encoding.UTF8` would
    // write the base64 string as literal text instead of decoding.
    await Filesystem.writeFile({
      path: scopedPath,
      data: base64,
      directory: Directory.Cache,
      recursive: true,
    });
    const { uri } = await Filesystem.getUri({
      path: scopedPath,
      directory: Directory.Cache,
    });
    return uri;
  } catch {
    return null;
  }
}

/**
 * Opens the native share sheet with optional file attachment. On
 * Capacitor native we write the image to `Directory.Cache` and
 * pass the URI to `@capacitor/share`'s `files` field (the only
 * native-supported way to attach a binary). On web we try
 * `navigator.share({ files })` first and fall back to text-only.
 */
export async function nativeShare(options: ShareOptions): Promise<boolean> {
  // Native path — needs `@capacitor/share` + `@capacitor/filesystem`.
  if (Capacitor.isNativePlatform()) {
    try {
      const { Share } = await import('@capacitor/share');
      if (options.imageUrl !== undefined) {
        const filename = options.imageFilename ?? 'share.png';
        const uri = await writeTempShareImage(options.imageUrl, filename);
        if (uri !== null) {
          await Share.share({ title: options.title, text: options.text, files: [uri] });
          return true;
        }
      }
      await Share.share({ title: options.title, text: options.text });
      return true;
    } catch {
      return false;
    }
  }

  // Web path — Web Share API with files where supported, text-only
  // fallback otherwise.
  const tryWebShareWithFile = async (): Promise<boolean> => {
    if (options.imageUrl === undefined) return false;
    if (typeof navigator === 'undefined' || navigator.share === undefined) return false;
    try {
      const response = await fetch(options.imageUrl);
      if (!response.ok) return false;
      const blob = await response.blob();
      if (blob.size === 0) return false;
      const filename = options.imageFilename ?? 'share.png';
      const file = new File([blob], filename, { type: blob.type || 'image/png' });
      if (typeof navigator.canShare === 'function' && !navigator.canShare({ files: [file] })) {
        return false;
      }
      await navigator.share({ title: options.title, text: options.text, files: [file] });
      return true;
    } catch {
      return false;
    }
  };

  try {
    if (await tryWebShareWithFile()) return true;
    if (typeof navigator !== 'undefined' && navigator.share !== undefined) {
      await navigator.share({ title: options.title, text: options.text });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
