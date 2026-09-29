// Ambient types for the `jpegxr` package (WASM JPEG XR decoder).
// The package ships no TypeScript definitions; these mirror its JS API.
declare module 'jpegxr' {
  interface JxrPixelInfo {
    channels: number;
    colorFormat: string;
    bitDepth: string;
    bitsPerPixel: number;
    hasAlpha: boolean;
    premultipliedAlpha: boolean;
    bgr: boolean;
  }

  interface JxrDecodedImage {
    width: number;
    height: number;
    pixelInfo: JxrPixelInfo;
    bytes: Uint8Array;
  }

  interface JxrCodec {
    decode(bytes: Uint8Array): JxrDecodedImage;
  }

  function jpegxrFactory(): Promise<JxrCodec>;
  export = jpegxrFactory;
}