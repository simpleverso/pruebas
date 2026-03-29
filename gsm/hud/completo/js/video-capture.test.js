// video-capture.test.js — Unit tests for VideoCapture
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---- Mock browser APIs before importing the module ----

// Polyfill ImageData for Node/Vitest environment
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = function ImageData(w, h) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  };
}

// Mock localStorage
var store = {};
globalThis.localStorage = {
  getItem: function (key) { return store[key] || null; },
  setItem: function (key, val) { store[key] = String(val); },
  removeItem: function (key) { delete store[key]; },
  clear: function () { store = {}; }
};

// Provide ConfigManager on globalThis (video-capture.js depends on it)
import './config-manager.js';

// Mock device list and getUserMedia
var mockDevices = [];
var deviceChangeListeners = [];
var mockGetUserMedia = vi.fn();

// Mock MediaStream and tracks
function createMockStream(deviceId, label) {
  var endedListeners = [];
  var track = {
    label: label || 'Mock Camera',
    stop: vi.fn(),
    getSettings: function () { return { deviceId: deviceId || 'device-1' }; },
    addEventListener: function (evt, fn) { if (evt === 'ended') endedListeners.push(fn); },
    removeEventListener: function (evt, fn) {
      if (evt === 'ended') {
        endedListeners = endedListeners.filter(function (f) { return f !== fn; });
      }
    },
    _triggerEnded: function () {
      endedListeners.forEach(function (fn) { fn(); });
    }
  };
  return {
    getTracks: function () { return [track]; },
    getVideoTracks: function () { return [track]; },
    _track: track
  };
}

function createMockDeviceInfo(deviceId, label) {
  return { kind: 'videoinput', deviceId: deviceId, label: label || 'Camera ' + deviceId, groupId: '' };
}

// Stub navigator.mediaDevices using vi.stubGlobal
var mockMediaDevices = {
  enumerateDevices: vi.fn(function () { return Promise.resolve(mockDevices); }),
  getUserMedia: mockGetUserMedia,
  addEventListener: function (evt, fn) { if (evt === 'devicechange') deviceChangeListeners.push(fn); },
  removeEventListener: function (evt, fn) {
    if (evt === 'devicechange') {
      deviceChangeListeners = deviceChangeListeners.filter(function (f) { return f !== fn; });
    }
  }
};

vi.stubGlobal('navigator', { mediaDevices: mockMediaDevices });

// Mock video element
var mockVideoEl;
function createMockVideoEl() {
  return {
    id: 'video-source',
    srcObject: null,
    videoWidth: 640,
    videoHeight: 480,
    play: vi.fn().mockResolvedValue(undefined)
  };
}

// Mock document
mockVideoEl = createMockVideoEl();
vi.stubGlobal('document', {
  getElementById: function (id) {
    if (id === 'video-source') return mockVideoEl;
    return null;
  },
  createElement: function (tag) {
    if (tag === 'canvas') {
      return {
        width: 0,
        height: 0,
        getContext: function () {
          return {
            drawImage: vi.fn(),
            getImageData: function (x, y, w, h) {
              return new ImageData(w, h);
            }
          };
        }
      };
    }
    return {};
  }
});

// Now import the module under test
import './video-capture.js';
var VideoCapture = globalThis.VideoCapture;

beforeEach(function () {
  store = {};
  mockDevices = [
    createMockDeviceInfo('device-1', 'Front Camera'),
    createMockDeviceInfo('device-2', 'Back Camera')
  ];
  deviceChangeListeners = [];
  mockVideoEl = createMockVideoEl();

  mockMediaDevices.enumerateDevices.mockImplementation(function () {
    return Promise.resolve(mockDevices);
  });

  mockGetUserMedia.mockImplementation(function (constraints) {
    var id = 'device-1';
    if (constraints && constraints.video && constraints.video.deviceId && constraints.video.deviceId.exact) {
      id = constraints.video.deviceId.exact;
    }
    return Promise.resolve(createMockStream(id, 'Camera ' + id));
  });
});

afterEach(function () {
  VideoCapture.stop();
  store = {};
  vi.restoreAllMocks();
});

describe('VideoCapture.init', function () {
  it('initializes and auto-connects to first available device', async function () {
    await VideoCapture.init();
    VideoCapture.start();

    var status = VideoCapture.getStatus();
    expect(status.status).toBe('connected');
    expect(status.deviceId).toBe('device-1');
  });

  it('auto-connects to last-used device if available', async function () {
    var cfg = globalThis.ConfigManager.getDefaults();
    cfg.video.lastDeviceId = 'device-2';
    globalThis.ConfigManager.save(cfg);

    await VideoCapture.init();
    VideoCapture.start();

    var status = VideoCapture.getStatus();
    expect(status.status).toBe('connected');
    expect(status.deviceId).toBe('device-2');
  });

  it('falls back to first device if last-used is not available', async function () {
    var cfg = globalThis.ConfigManager.getDefaults();
    cfg.video.lastDeviceId = 'nonexistent-device';
    globalThis.ConfigManager.save(cfg);

    await VideoCapture.init();
    VideoCapture.start();

    var status = VideoCapture.getStatus();
    expect(status.status).toBe('connected');
    expect(status.deviceId).toBe('device-1');
  });

  it('enters no-signal when no devices available', async function () {
    mockDevices = [];
    await VideoCapture.init();
    VideoCapture.start();

    var status = VideoCapture.getStatus();
    expect(status.status).toBe('no-signal');
  });
});

describe('VideoCapture.enumerateDevices', function () {
  it('returns only videoinput devices', async function () {
    mockDevices = [
      createMockDeviceInfo('cam-1', 'Webcam'),
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Mic', groupId: '' },
      createMockDeviceInfo('cam-2', 'USB Camera')
    ];

    await VideoCapture.init();
    var devices = await VideoCapture.enumerateDevices();
    expect(devices).toHaveLength(2);
    expect(devices[0].deviceId).toBe('cam-1');
    expect(devices[1].deviceId).toBe('cam-2');
  });

  it('returns empty array when no devices', async function () {
    mockDevices = [];
    await VideoCapture.init();
    var devices = await VideoCapture.enumerateDevices();
    expect(devices).toHaveLength(0);
  });
});

describe('VideoCapture.selectDevice', function () {
  it('switches to the selected device', async function () {
    await VideoCapture.init();
    VideoCapture.start();

    await VideoCapture.selectDevice('device-2');
    var status = VideoCapture.getStatus();
    expect(status.status).toBe('connected');
    expect(status.deviceId).toBe('device-2');
  });

  it('persists the selected device ID', async function () {
    await VideoCapture.init();
    VideoCapture.start();

    await VideoCapture.selectDevice('device-2');
    var cfg = globalThis.ConfigManager.load();
    expect(cfg.video.lastDeviceId).toBe('device-2');
  });

  it('rejects when no deviceId provided', async function () {
    await VideoCapture.init();
    await expect(VideoCapture.selectDevice('')).rejects.toThrow('deviceId is required');
  });
});

describe('VideoCapture.getFrame', function () {
  it('returns ImageData with correct dimensions', async function () {
    await VideoCapture.init();
    VideoCapture.start();

    var frame = VideoCapture.getFrame();
    expect(frame).toBeInstanceOf(ImageData);
    expect(frame.width).toBe(640);
    expect(frame.height).toBe(480);
  });
});

describe('VideoCapture.onDeviceLost', function () {
  it('calls callback with fallback device ID when track ends', async function () {
    await VideoCapture.init();
    VideoCapture.start();

    var callbackArg = undefined;
    VideoCapture.onDeviceLost(function (fallbackId) {
      callbackArg = fallbackId;
    });

    // Simulate track ended
    var stream = mockVideoEl.srcObject;
    stream._track._triggerEnded();

    // Wait for async fallback logic
    await new Promise(function (r) { setTimeout(r, 50); });

    expect(callbackArg).toBe('device-2');
  });
});

describe('VideoCapture.getStatus', function () {
  it('returns connected after successful init', async function () {
    await VideoCapture.init();
    var status = VideoCapture.getStatus();
    expect(status.status).toBe('connected');
    expect(status.label).toContain('Camera');
  });
});

describe('VideoCapture.start and stop', function () {
  it('start sets the subsystem as active', async function () {
    await VideoCapture.init();
    VideoCapture.start();
    var status = VideoCapture.getStatus();
    expect(status.status).toBe('connected');
  });

  it('stop cleans up stream and resets status', async function () {
    await VideoCapture.init();
    VideoCapture.start();
    VideoCapture.stop();

    var status = VideoCapture.getStatus();
    expect(status.status).toBe('disconnected');
    expect(status.deviceId).toBe('');
    expect(status.label).toBe('');
  });
});
