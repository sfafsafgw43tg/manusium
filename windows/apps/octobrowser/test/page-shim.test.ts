import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { pageShim, PageConfig, PageFingerprint } from '../src/preload/page-shim';

describe('pageShim Graphics Card Emulation', () => {
  const origWindowDesc = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const origDocDesc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  beforeEach(() => {
    const mockNav = {
      userAgent: 'Mozilla/5.0',
      platform: 'Win32',
      language: 'en-US',
      languages: ['en-US', 'en'],
      hardwareConcurrency: 4,
      deviceMemory: 4,
      gpu: { requestAdapter: async () => ({}) },
    };

    class MockNavigator {}
    Object.assign(MockNavigator.prototype, mockNav);

    const mockDoc = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return {
            width: 300,
            height: 150,
            getContext: () => null,
            toDataURL: () => 'data:image/png;base64,',
            toBlob: () => {},
          };
        }
        return { style: {}, appendChild: () => {}, remove: () => {} };
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelectorAll: () => [],
    };

    const mockWindow: Record<string, unknown> = {
      Navigator: MockNavigator,
      navigator: mockNav,
      document: mockDoc,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    };
    (mockWindow as unknown as { window: unknown }).window = mockWindow;

    Object.defineProperty(globalThis, 'window', { value: mockWindow, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'document', { value: mockDoc, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'navigator', { value: mockNav, configurable: true, writable: true });
  });

  afterEach(() => {
    if (origWindowDesc) Object.defineProperty(globalThis, 'window', origWindowDesc);
    else delete (globalThis as Record<string, unknown>).window;

    if (origDocDesc) Object.defineProperty(globalThis, 'document', origDocDesc);
    else delete (globalThis as Record<string, unknown>).document;

    if (origNavDesc) Object.defineProperty(globalThis, 'navigator', origNavDesc);
    else delete (globalThis as Record<string, unknown>).navigator;
  });

  function createMockGlContext(isGl2 = false) {
    void isGl2;
    const gl = {
      getParameter: (param: number) => {
        if (param === 0x1f00) return 'Native Vendor';
        if (param === 0x1f01) return 'Native Renderer';
        return 0;
      },
      getShaderPrecisionFormat: (shaderType: number, precisionType: number) => {
        void shaderType; void precisionType;
        return { rangeMin: 62, rangeMax: 62, precision: 16 };
      },
      getSupportedExtensions: () => ['OES_texture_float'],
      getExtension: (name: string) => {
        if (name === 'OES_texture_float') return {};
        return null;
      },
      readPixels: () => {},
    };
    return gl;
  }

  it('passes through native WebGL parameters and limits while preserving truthful unmasked vendor/renderer', () => {
    class MockWebGLRenderingContext {
      getParameter(param: number): unknown {
        if (param === 0x1f00) return 'WebKit Native';
        if (param === 0x1f01) return 'WebKit WebGL Native';
        if (param === 0x0d33) return 8192; // Native MAX_TEXTURE_SIZE
        if (param === 0x8869) return 16;
        return 0;
      }
      getShaderPrecisionFormat(s: number, p: number): unknown {
        return { rangeMin: 62, rangeMax: 62, precision: 16 };
      }
      getSupportedExtensions(): string[] { return ['OES_texture_float', 'WEBGL_debug_renderer_info']; }
      getExtension(n: string): unknown {
        if (n === 'WEBGL_debug_renderer_info') return { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
        return null;
      }
    }
    (window as unknown as Record<string, unknown>).WebGLRenderingContext = MockWebGLRenderingContext;

    class MockWebGLShaderPrecisionFormat {}
    (window as unknown as Record<string, unknown>).WebGLShaderPrecisionFormat = MockWebGLShaderPrecisionFormat;

    const fp: PageFingerprint = {
      platform: 'Win32',
      brands: [{ brand: 'Chromium', version: '130' }],
      fullVersionList: [{ brand: 'Chromium', version: '130.0.6723.70' }],
      uaFullVersion: '130.0.6723.70',
      chPlatform: 'Windows',
      platformVersion: '15.0.0',
      architecture: 'x86',
      bitness: '64',
      languages: ['en-US', 'en'],
      cores: 8,
      memory: 16,
      screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 },
      deviceScaleFactor: 1,
      webglVendor: 'Google Inc. (NVIDIA)',
      webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.5176)',
      canvas: 'noise',
      webgl: 'noise',
      audio: 'noise',
      clientRects: 'noise',
      fonts: 'noise',
      webgpu: 'real',
      webrtcMode: 'real',
      webrtcIp: '',
      mediaDevices: { audioInputs: 1, audioOutputs: 1, videoInputs: 1 },
      doNotTrack: false,
      mobile: false,
      model: '',
      formFactor: 'Desktop',
      seed: 123456,
    };

    const cfg: PageConfig = {
      canvas: 'allow',
      hw: 'allow',
      hwValues: { hardwareConcurrency: 8, deviceMemory: 8 },
      volume: 1,
      sinkId: '',
      cameraLabel: '',
      microphoneLabel: '',
      fp,
    };

    pageShim(cfg, 'test-event');

    const ctx = Object.create(MockWebGLRenderingContext.prototype);

    // Vendor and Renderer unmasked
    expect(ctx.getParameter(0x9245)).toBe('Google Inc. (NVIDIA)');
    expect(ctx.getParameter(0x9246)).toBe('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.5176)');

    // Native WebGL vendor/renderer/limits pass through natively without synthetic override
    expect(ctx.getParameter(0x1F00)).toBe('WebKit Native');
    expect(ctx.getParameter(0x1F01)).toBe('WebKit WebGL Native');
    expect(ctx.getParameter(0x0D33)).toBe(8192); // Native MAX_TEXTURE_SIZE preserved

    // Native shader precision format preserved
    const floatPrecision = ctx.getShaderPrecisionFormat(0x8B30, 0x8DF2);
    expect(floatPrecision.rangeMin).toBe(62);
    expect(floatPrecision.precision).toBe(16);

    // Native extensions list preserved
    const extList = ctx.getSupportedExtensions();
    expect(extList).toEqual(['OES_texture_float', 'WEBGL_debug_renderer_info']);
  });

  it('blocks WebGL and WebGL2 context creation when WebGL is Off', () => {
    class MockCanvas {
      getContext(kind: string): unknown { return { kind }; }
    }
    (window as unknown as Record<string, unknown>).HTMLCanvasElement = MockCanvas;
    const fp = {
      webgl: 'off',
      webglVendor: null,
      webglRenderer: null,
      canvas: 'real',
      audio: 'real',
      clientRects: 'real',
      fonts: 'real',
      webgpu: 'real',
      webrtcMode: 'real',
      webrtcIp: '',
      doNotTrack: false,
      mobile: false,
      model: '',
      formFactor: 'Desktop' as const,
      seed: 7,
    } as PageFingerprint;
    pageShim({
      canvas: 'allow', hw: 'allow', hwValues: { hardwareConcurrency: 8, deviceMemory: 8 },
      volume: 1, sinkId: '', cameraLabel: '', microphoneLabel: '', fp,
    }, 'test-webgl-off');
    const canvas = Object.create(MockCanvas.prototype) as MockCanvas;
    expect(canvas.getContext('webgl')).toBeNull();
    expect(canvas.getContext('webgl2')).toBeNull();
    expect(canvas.getContext('2d')).toEqual({ kind: '2d' });
  });

  it('preserves native WebGL 2 parameters and limits without synthetic constants', () => {
    class MockWebGL2RenderingContext {
      getParameter(param: number): unknown {
        if (param === 0x1f02) return 'WebGL 2.0 Native';
        if (param === 0x8073) return 4096; // Native MAX_3D_TEXTURE_SIZE
        return 0;
      }
      getShaderPrecisionFormat(_s: number, _p: number): unknown { return null; }
      getSupportedExtensions(): string[] { return ['EXT_color_buffer_float']; }
      getExtension(_n: string): unknown { return null; }
    }
    (window as unknown as Record<string, unknown>).WebGL2RenderingContext = MockWebGL2RenderingContext;

    const fp: PageFingerprint = {
      platform: 'Win32',
      brands: [{ brand: 'Chromium', version: '130' }],
      fullVersionList: [{ brand: 'Chromium', version: '130.0.6723.70' }],
      uaFullVersion: '130.0.6723.70',
      chPlatform: 'Windows',
      platformVersion: '15.0.0',
      architecture: 'x86',
      bitness: '64',
      languages: ['en-US'],
      cores: 8,
      memory: 16,
      screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 },
      deviceScaleFactor: 1,
      webglVendor: 'Google Inc. (AMD)',
      webglRenderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
      canvas: 'noise',
      webgl: 'noise',
      audio: 'noise',
      clientRects: 'noise',
      fonts: 'noise',
      webgpu: 'real',
      webrtcMode: 'real',
      webrtcIp: '',
      mediaDevices: null,
      doNotTrack: false,
      mobile: false,
      model: '',
      formFactor: 'Desktop',
      seed: 987654,
    };

    const cfg: PageConfig = {
      canvas: 'allow',
      hw: 'allow',
      hwValues: { hardwareConcurrency: 8, deviceMemory: 8 },
      volume: 1,
      sinkId: '',
      cameraLabel: '',
      microphoneLabel: '',
      fp,
    };

    pageShim(cfg, 'test-event-gl2');

    const ctx = Object.create(MockWebGL2RenderingContext.prototype);

    expect(ctx.getParameter(0x9245)).toBe('Google Inc. (AMD)');
    expect(ctx.getParameter(0x9246)).toBe('ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)');
    expect(ctx.getParameter(0x1F02)).toBe('WebGL 2.0 Native');
    expect(ctx.getParameter(0x8073)).toBe(4096);
  });

  it('emulates WebGPU adapter info, limits, and features matching configured GPU', async () => {
    class MockGPUAdapterInfo {}
    Object.defineProperties(MockGPUAdapterInfo.prototype, {
      vendor: { get: () => 'real-native-vendor', configurable: true },
      architecture: { get: () => 'real-native-arch', configurable: true },
      device: { get: () => 'real-native-device', configurable: true },
      description: { get: () => 'real-native-desc', configurable: true },
    });
    (window as unknown as Record<string, unknown>).GPUAdapterInfo = MockGPUAdapterInfo;

    class MockGPUAdapter {
      requestAdapterInfo(): Promise<unknown> {
        return Promise.resolve(new MockGPUAdapterInfo());
      }
    }
    Object.defineProperties(MockGPUAdapter.prototype, {
      info: { get: () => new MockGPUAdapterInfo(), configurable: true },
      isFallbackAdapter: { get: () => true, configurable: true },
    });
    (window as unknown as Record<string, unknown>).GPUAdapter = MockGPUAdapter;

    class MockGPUSupportedLimits {}
    Object.defineProperties(MockGPUSupportedLimits.prototype, {
      maxTextureDimension2D: { get: () => 8192, configurable: true },
      maxBindGroups: { get: () => 4, configurable: true },
      maxStorageBufferBindingSize: { get: () => 1048576, configurable: true },
    });
    (window as unknown as Record<string, unknown>).GPUSupportedLimits = MockGPUSupportedLimits;

    class MockGPUSupportedFeatures {
      has(name: string): boolean {
        return name === 'some-old-feature';
      }
    }
    (window as unknown as Record<string, unknown>).GPUSupportedFeatures = MockGPUSupportedFeatures;
    const fp: PageFingerprint = {
      platform: 'Win32',
      brands: [{ brand: 'Chromium', version: '130' }],
      fullVersionList: [{ brand: 'Chromium', version: '130.0.6723.70' }],
      uaFullVersion: '130.0.6723.70',
      chPlatform: 'Windows',
      platformVersion: '15.0.0',
      architecture: 'x86',
      bitness: '64',
      languages: ['en-US'],
      cores: 8,
      memory: 16,
      screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 },
      deviceScaleFactor: 1,
      webglVendor: 'Google Inc. (NVIDIA)',
      webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      canvas: 'noise',
      webgl: 'noise',
      audio: 'noise',
      clientRects: 'noise',
      fonts: 'noise',
      webgpu: 'real',
      webrtcMode: 'real',
      webrtcIp: '',
      mediaDevices: null,
      doNotTrack: false,
      mobile: false,
      model: '',
      formFactor: 'Desktop',
      seed: 456789,
    };

    const cfg: PageConfig = {
      canvas: 'allow',
      hw: 'allow',
      hwValues: { hardwareConcurrency: 8, deviceMemory: 8 },
      volume: 1,
      sinkId: '',
      cameraLabel: '',
      microphoneLabel: '',
      fp,
    };

    pageShim(cfg, 'test-event-webgpu');

    const adapter = new MockGPUAdapter();
    const adapterInfoProto = MockGPUAdapterInfo.prototype as unknown as Record<string, string>;

    expect(adapterInfoProto.vendor).toBe('nvidia');
    expect(adapterInfoProto.architecture).toBe('ampere');
    expect(adapterInfoProto.description).toBe('NVIDIA GeForce RTX 3060');

    // adapter.info getter
    const info = (adapter as unknown as { info: { vendor: string; architecture: string; description: string; isFallbackAdapter: boolean } }).info;
    expect(info.vendor).toBe('nvidia');
    expect(info.architecture).toBe('ampere');
    expect(info.description).toBe('NVIDIA GeForce RTX 3060');
    expect(info.isFallbackAdapter).toBe(false);

    // requestAdapterInfo method
    const asyncInfo = await (adapter as unknown as { requestAdapterInfo: () => Promise<{ vendor: string; architecture: string; description: string }> }).requestAdapterInfo();
    expect(asyncInfo.vendor).toBe('nvidia');
    expect(asyncInfo.architecture).toBe('ampere');
    expect(asyncInfo.description).toBe('NVIDIA GeForce RTX 3060');
    // GPUSupportedLimits
    const limitsProto = MockGPUSupportedLimits.prototype as unknown as Record<string, number>;
    expect(limitsProto.maxTextureDimension2D).toBe(16384);
    expect(limitsProto.maxBindGroups).toBe(8);
    expect(limitsProto.maxStorageBufferBindingSize).toBe(2147483648);

    // GPUSupportedFeatures
    const features = new MockGPUSupportedFeatures();
    expect(features.has('texture-compression-bc')).toBe(true);
    expect(features.has('depth-clip-control')).toBe(true);
  });

  it('emulates WebGPU for Apple Silicon and Intel architectures correctly', async () => {
    class MockGPUAdapterInfo {}
    Object.defineProperties(MockGPUAdapterInfo.prototype, {
      vendor: { get: () => 'real-native-vendor', configurable: true },
      architecture: { get: () => 'real-native-arch', configurable: true },
      device: { get: () => 'real-native-device', configurable: true },
      description: { get: () => 'real-native-desc', configurable: true },
    });
    (window as unknown as Record<string, unknown>).GPUAdapterInfo = MockGPUAdapterInfo;

    class MockGPUAdapter {
      requestAdapterInfo(): Promise<unknown> {
        return Promise.resolve(new MockGPUAdapterInfo());
      }
    }
    Object.defineProperties(MockGPUAdapter.prototype, {
      info: { get: () => new MockGPUAdapterInfo(), configurable: true },
      isFallbackAdapter: { get: () => true, configurable: true },
    });
    (window as unknown as Record<string, unknown>).GPUAdapter = MockGPUAdapter;

    const fpApple: PageFingerprint = {
      platform: 'MacIntel',
      brands: [{ brand: 'Chromium', version: '130' }],
      fullVersionList: [{ brand: 'Chromium', version: '130.0.6723.70' }],
      uaFullVersion: '130.0.6723.70',
      chPlatform: 'macOS',
      platformVersion: '14.0.0',
      architecture: 'arm',
      bitness: '64',
      languages: ['en-US'],
      cores: 8,
      memory: 16,
      screen: { width: 1440, height: 900, availWidth: 1440, availHeight: 875 },
      deviceScaleFactor: 2,
      webglVendor: 'Google Inc. (Apple)',
      webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)',
      canvas: 'noise',
      webgl: 'noise',
      audio: 'noise',
      clientRects: 'noise',
      fonts: 'noise',
      webgpu: 'real',
      webrtcMode: 'real',
      webrtcIp: '',
      mediaDevices: null,
      doNotTrack: false,
      mobile: false,
      model: '',
      formFactor: 'Desktop',
      seed: 222222,
    };

    const cfgApple: PageConfig = {
      canvas: 'allow',
      hw: 'allow',
      hwValues: { hardwareConcurrency: 8, deviceMemory: 8 },
      volume: 1,
      sinkId: '',
      cameraLabel: '',
      microphoneLabel: '',
      fp: fpApple,
    };

    pageShim(cfgApple, 'test-apple');

    const appleInfo = MockGPUAdapterInfo.prototype as unknown as Record<string, string>;
    expect(appleInfo.vendor).toBe('apple');
    expect(appleInfo.architecture).toBe('apple-m');
    expect(appleInfo.description).toBe('ANGLE Metal Renderer: Apple M2 Pro');
  });

  it('hides navigator.gpu completely when webgpu is off', () => {
    class MockNavigatorWithGpu {}
    Object.defineProperty(MockNavigatorWithGpu.prototype, 'gpu', {
      get: () => ({ requestAdapter: async () => ({}) }),
      configurable: true,
    });
    (window as unknown as Record<string, unknown>).Navigator = MockNavigatorWithGpu;
    const navInstance = Object.create(MockNavigatorWithGpu.prototype);
    Object.defineProperty(globalThis, 'navigator', { value: navInstance, configurable: true, writable: true });
    (window as unknown as Record<string, unknown>).navigator = navInstance;

    const fp: PageFingerprint = {
      platform: 'Win32',
      brands: [{ brand: 'Chromium', version: '130' }],
      fullVersionList: [{ brand: 'Chromium', version: '130.0.6723.70' }],
      uaFullVersion: '130.0.6723.70',
      chPlatform: 'Windows',
      platformVersion: '15.0.0',
      architecture: 'x86',
      bitness: '64',
      languages: ['en-US'],
      cores: 8,
      memory: 16,
      screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 },
      deviceScaleFactor: 1,
      webglVendor: 'Google Inc. (NVIDIA)',
      webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      canvas: 'noise',
      webgl: 'noise',
      audio: 'noise',
      clientRects: 'noise',
      fonts: 'noise',
      webgpu: 'off',
      webrtcMode: 'real',
      webrtcIp: '',
      mediaDevices: null,
      doNotTrack: false,
      mobile: false,
      model: '',
      formFactor: 'Desktop',
      seed: 111111,
    };

    const cfg: PageConfig = {
      canvas: 'allow',
      hw: 'allow',
      hwValues: { hardwareConcurrency: 8, deviceMemory: 8 },
      volume: 1,
      sinkId: '',
      cameraLabel: '',
      microphoneLabel: '',
      fp,
    };

    pageShim(cfg, 'test-event-gpu-off');

    expect((navigator as unknown as { gpu?: unknown }).gpu).toBeUndefined();
  });

  it('injects deterministic noise across Canvas 2D, OffscreenCanvas, and TextMetrics', () => {
    class MockCanvasRenderingContext2D {
      getImageData(sx: number, sy: number, sw: number, sh: number): { width: number; height: number; data: Uint8ClampedArray } {
        void sx; void sy;
        const data = new Uint8ClampedArray(sw * sh * 4);
        // Fill opaque white pixels
        for (let i = 0; i < data.length; i += 4) {
          data[i] = 255;
          data[i + 1] = 255;
          data[i + 2] = 255;
          data[i + 3] = 255;
        }
        return { width: sw, height: sh, data };
      }
      isPointInPath(x: number, y: number): boolean {
        return x > 0 && y > 0;
      }
      isPointInStroke(x: number, y: number): boolean {
        return x > 0 && y > 0;
      }
    }
    (window as unknown as Record<string, unknown>).CanvasRenderingContext2D = MockCanvasRenderingContext2D;

    class MockOffscreenCanvasRenderingContext2D {
      getImageData(sx: number, sy: number, sw: number, sh: number): { width: number; height: number; data: Uint8ClampedArray } {
        void sx; void sy;
        const data = new Uint8ClampedArray(sw * sh * 4);
        for (let i = 0; i < data.length; i += 4) {
          data[i] = 200;
          data[i + 1] = 200;
          data[i + 2] = 200;
          data[i + 3] = 255;
        }
        return { width: sw, height: sh, data };
      }
      isPointInPath(x: number, y: number): boolean {
        return x > 0 && y > 0;
      }
      isPointInStroke(x: number, y: number): boolean {
        return x > 0 && y > 0;
      }
    }
    (window as unknown as Record<string, unknown>).OffscreenCanvasRenderingContext2D = MockOffscreenCanvasRenderingContext2D;

    class MockHTMLCanvasElement {
      width = 100;
      height = 100;
      toDataURL(): string {
        return 'data:image/png;base64,RAW';
      }
      toBlob(cb: (b: Blob | null) => void): void {
        cb(null);
      }
    }
    (window as unknown as Record<string, unknown>).HTMLCanvasElement = MockHTMLCanvasElement;

    class MockOffscreenCanvas {
      width = 100;
      height = 100;
      convertToBlob(): Promise<Blob> {
        return Promise.resolve(new Blob([]));
      }
      transferToImageBitmap(): unknown {
        return {};
      }
    }
    (window as unknown as Record<string, unknown>).OffscreenCanvas = MockOffscreenCanvas;

    class MockTextMetrics {}
    Object.defineProperties(MockTextMetrics.prototype, {
      width: { get: () => 100, configurable: true },
      actualBoundingBoxLeft: { get: () => 10, configurable: true },
      actualBoundingBoxRight: { get: () => 90, configurable: true },
      actualBoundingBoxAscent: { get: () => 20, configurable: true },
      actualBoundingBoxDescent: { get: () => 5, configurable: true },
      fontBoundingBoxAscent: { get: () => 22, configurable: true },
      fontBoundingBoxDescent: { get: () => 6, configurable: true },
    });
    (window as unknown as Record<string, unknown>).TextMetrics = MockTextMetrics;

    const fp: PageFingerprint = {
      platform: 'Win32',
      brands: [{ brand: 'Chromium', version: '130' }],
      fullVersionList: [{ brand: 'Chromium', version: '130.0.6723.70' }],
      uaFullVersion: '130.0.6723.70',
      chPlatform: 'Windows',
      platformVersion: '15.0.0',
      architecture: 'x86',
      bitness: '64',
      languages: ['en-US'],
      cores: 8,
      memory: 16,
      screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 },
      deviceScaleFactor: 1,
      webglVendor: 'Google Inc. (NVIDIA)',
      webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      canvas: 'noise',
      webgl: 'noise',
      audio: 'noise',
      clientRects: 'noise',
      fonts: 'noise',
      webgpu: 'real',
      webrtcMode: 'real',
      webrtcIp: '',
      mediaDevices: null,
      doNotTrack: false,
      mobile: false,
      model: '',
      formFactor: 'Desktop',
      seed: 777888,
    };

    const cfg: PageConfig = {
      canvas: 'allow',
      hw: 'allow',
      hwValues: { hardwareConcurrency: 8, deviceMemory: 8 },
      volume: 1,
      sinkId: '',
      cameraLabel: '',
      microphoneLabel: '',
      fp,
    };

    pageShim(cfg, 'test-canvas-noise');

    // 1. CanvasRenderingContext2D getImageData has noise
    const c2d = Object.create(MockCanvasRenderingContext2D.prototype) as MockCanvasRenderingContext2D;
    const imgData = c2d.getImageData(0, 0, 50, 50);
    // At least one pixel was modified from 255 to 254 (255 ^ 1)
    let modified2D = 0;
    for (let i = 0; i < imgData.data.length; i += 4) {
      if (imgData.data[i] !== 255 || imgData.data[i + 1] !== 255 || imgData.data[i + 2] !== 255) {
        modified2D++;
      }
    }
    expect(modified2D).toBeGreaterThan(0);

    // 2. OffscreenCanvasRenderingContext2D getImageData has noise
    const oc2d = Object.create(MockOffscreenCanvasRenderingContext2D.prototype) as MockOffscreenCanvasRenderingContext2D;
    const offData = oc2d.getImageData(0, 0, 50, 50);
    let modifiedOff = 0;
    for (let i = 0; i < offData.data.length; i += 4) {
      if (offData.data[i] !== 200 || offData.data[i + 1] !== 200 || offData.data[i + 2] !== 200) {
        modifiedOff++;
      }
    }
    expect(modifiedOff).toBeGreaterThan(0);

    // 3. TextMetrics scaled
    const tm = Object.create(MockTextMetrics.prototype) as { width: number; actualBoundingBoxLeft: number; actualBoundingBoxAscent: number };
    expect(tm.width).not.toBe(100);
    expect(Math.abs(tm.width - 100)).toBeLessThan(1);
    expect(tm.actualBoundingBoxLeft).not.toBe(10);
    expect(tm.actualBoundingBoxAscent).not.toBe(20);
  });
});
