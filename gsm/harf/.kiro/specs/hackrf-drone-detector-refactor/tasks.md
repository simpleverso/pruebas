# Implementation Plan: HackRF Drone Detector Refactor

## Overview

Refactor the monolithic `harf.html` (~1445 lines) into 10 files: `index.html`, `css/styles.css`, and 8 JavaScript ES modules. Each task extracts a specific concern, adds detailed logging, and wires it into the growing modular structure. Implementation uses plain JavaScript ES modules (no build tools). Property-based tests use fast-check.

## Tasks

- [x] 1. Create project structure, CSS stylesheet, and HTML entry point
  - [x] 1.1 Create `css/styles.css` with all style rules extracted from the `<style>` block in `harf.html`
    - Copy every CSS rule verbatim from the original inline styles
    - Include all `@keyframes` and `@media` rules
    - _Requirements: 2.1, 2.2, 2.3_
  - [x] 1.2 Create `index.html` entry point with external CSS and module script references
    - Copy the HTML body structure from `harf.html` preserving all element IDs and DOM hierarchy
    - Add `<link rel="stylesheet" href="css/styles.css">`
    - Keep Leaflet CSS and JS CDN references
    - Add `<script type="module" src="js/main.js">`
    - No inline `<script>` or `<style>` blocks
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 12.1, 12.4_

- [x] 2. Implement the centralized Logger module
  - [x] 2.1 Create `js/logger.js` with Logger class and LogLevel enum
    - Implement five log levels: DEBUG=0, INFO=1, WARNING=2, ERROR=3, SUCCESS=4
    - Implement `debug()`, `info()`, `warning()`, `error()`, `success()` methods
    - Each method prepends `[HH:MM:SS.mmm] [LEVEL] [ModuleName]` to the message
    - Append styled DOM element to `#logConsole` with CSS class matching the level
    - Call corresponding `console.*` method (debug→console.debug, info→console.info, warning→console.warn, error→console.error, success→console.log)
    - Implement `setLevel()` for configurable minimum log level filtering
    - Fall back to console-only if `#logConsole` is not in the DOM
    - Export singleton instance and LogLevel
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_
  - [x] 2.2 Write property test: Logger Message Format (Property 3)
    - **Property 3: Logger Message Format**
    - Generate random module names and message strings with fast-check
    - Verify output contains timestamp matching `HH:MM:SS` pattern, the level label, and the module name
    - **Validates: Requirements 3.4**
  - [x] 2.3 Write property test: Logger Output Routing (Property 4)
    - **Property 4: Logger Output Routing**
    - Generate random log levels, verify DOM element appended with correct CSS class and correct `console.*` method called
    - **Validates: Requirements 3.5, 3.6**
  - [x] 2.4 Write property test: Logger Level Filtering (Property 5)
    - **Property 5: Logger Level Filtering**
    - Generate random (minLevel, messageLevel) pairs where messageLevel < minLevel
    - Verify no DOM output and no console output
    - **Validates: Requirements 3.7**

- [ ] 3. Implement the DSP module
  - [x] 3.1 Create `js/dsp.js` with Complex, FFT, ZadoffChu, and GoldSequence classes
    - Port all four classes from `harf.html` preserving identical algorithms and numerical behavior
    - Add detailed logging: FFT construction (size, bit-reversed indices count), FFT.forward (input length, stages, execution time), ZadoffChu.generate (root, length, execution time), GoldSequence construction (seed, LFSR states), GoldSequence.generate (length, execution time)
    - Import logger from `./logger.js`
    - Export all four classes
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_
  - [x] 3.2 Write property test: Complex Arithmetic Correctness (Property 6)
    - **Property 6: Complex Arithmetic Correctness**
    - Generate random Complex number pairs, verify add, sub, mul, magnitude, conjugate identities
    - **Validates: Requirements 6.3**
  - [x] 3.3 Write property test: FFT Size Invariant (Property 7)
    - **Property 7: FFT Size Invariant**
    - Generate random Complex arrays of power-of-2 sizes, verify output length equals input length and bit-reversed indices length equals size
    - **Validates: Requirements 6.3**
  - [x] 3.4 Write property test: ZadoffChu Sequence Length and Magnitude (Property 8)
    - **Property 8: ZadoffChu Sequence Length**
    - Generate random root/length, verify output length and unit magnitude (≈1.0) for each element
    - **Validates: Requirements 6.3**
  - [x] 3.5 Write property test: GoldSequence Output is Binary (Property 9)
    - **Property 9: GoldSequence Output is Binary**
    - Generate random seeds and lengths, verify output length and each value is 0 or 1
    - **Validates: Requirements 6.3**

- [x] 4. Checkpoint - Ensure logger and DSP modules work
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Implement HackRF Manager module
  - [x] 5.1 Create `js/hackrf-manager.js` with HackRFManager class
    - Port all USB constants (vendor ID, product ID, vendor request codes, transceiver modes, buffer size)
    - Port connectHackRF, disconnectHackRF, getBoardInfo, setFrequency, setSampleRate, setLNAGain, setVGAGain, setTransceiverMode, and add transferIn method
    - Add detailed logging for every USB operation step: device request, open, config select, interface claim, board info, frequency (Hz and MHz + value/index params), sample rate (Hz and MS/s), gain values (dB), transceiver mode name, and all error details with request type and parameters
    - Import logger from `./logger.js`
    - Export singleton instance and USB constants
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11_

- [ ] 6. Implement Frequency Controller module
  - [x] 6.1 Create `js/frequency-controller.js` with FrequencyController class
    - Port band selection logic, custom frequency slider handling, gain slider event handlers
    - Port DJI DroneID frequency constants (2.4 GHz, 5.8 GHz, 1.4 GHz)
    - Implement getFrequencyForBand, getCustomFrequency, getLNAGain, getVGAGain, getSampleRate
    - Add detailed logging: band selection (name, center freq MHz, previous band), custom frequency changes (MHz), gain changes (type, new value dB, previous value)
    - Import logger from `./logger.js`
    - Export singleton instance and frequency constants
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_
  - [x] 6.2 Write property test: Band-to-Frequency Mapping (Property 12)
    - **Property 12: Band-to-Frequency Mapping**
    - Generate random band selections from {'2.4', '5.8', '1.4'}, verify correct frequency constant returned
    - **Validates: Requirements 5.3, 11.2**

- [ ] 7. Implement DroneID Decoder module
  - [x] 7.1 Create `js/droneid-decoder.js` with DroneIDDecoder class
    - Port the full DroneIDDecoder class from `harf.html`: processSamples, processFrame, correlateZC, extractSubcarriers, qpskDemodulate, descramble, turboDecode, generateInterleaverPattern, parsePacket, parseDJIDroneID, parseRemoteID, and all helper parsing functions
    - Port OUI constants (DJI_OUI, REMOTE_ID_OUI) and DSP constants (FFT_SIZE, CYCLE_PREFIX_LENGTH, ZC_ROOT_1, ZC_ROOT_2)
    - Import Complex, FFT, ZadoffChu, GoldSequence from `./dsp.js` and logger from `./logger.js`
    - Add detailed logging at every decoding stage: processSamples (raw bytes, Complex samples, frame buffer length), processFrame (ZC correlation peaks, threshold check), extractSubcarriers (count, start bin), qpskDemodulate (input symbols, output bits), descramble (Gold seed, bit count), turboDecode (block size, interleaver length), parsePacket (byte count, OUI found/type/offset), parseDJIDroneID (subcommand, packet type, all fields), parseRemoteID (message type, all fields), no-signature debug message
    - Export DroneIDDecoder class and constants
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.12, 7.13_
  - [x] 7.2 Write property test: QPSK Demodulation Output Size (Property 10)
    - **Property 10: QPSK Demodulation Output Size**
    - Generate random Complex arrays, verify qpskDemodulate returns exactly 2×N bits, each 0 or 1
    - **Validates: Requirements 7.7**
  - [x] 7.3 Write property test: Coordinate Parsing Round Trip (Property 11)
    - **Property 11: Coordinate Parsing Round Trip**
    - Generate random integers in [-1800000000, 1800000000], encode as 4 big-endian bytes, verify parseCoordinate returns original / 10000000
    - **Validates: Requirements 7.3, 11.4**

- [x] 8. Checkpoint - Ensure decoder and frequency modules work
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Implement UI Manager module
  - [x] 9.1 Create `js/ui-manager.js` with UIManager class
    - Port initMap (Leaflet map initialization with Juchitán coordinates, tile layer, center marker, detection radius circle)
    - Port addDroneToMap (marker creation/update with custom icon, popup content, drone count update)
    - Port updateDroneList (sorted drone list rendering with click-to-focus)
    - Port updateStats (scan time display via requestAnimationFrame), updatePacketRate, updateSignalStrength (RMS power → dBm)
    - Port updateDecoderStep (step icon/class updates) and updateConnectionStatus
    - Implement setButtonStates for centralized button enable/disable control
    - Move detectedDrones Map into UIManager
    - Add detailed logging: initMap (center coords, zoom, tile URL), addDroneToMap (drone ID, coords, new/updated, total count), updateDroneList (drone count), updateSignalStrength (RMS power, dBm), updateDecoderStep (step name, status), updateConnectionStatus (state transition)
    - Import logger from `./logger.js`
    - Export singleton instance
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_

- [ ] 10. Implement Detection Controller module
  - [x] 10.1 Create `js/detection-controller.js` with DetectionController class
    - Port startDetection, stopDetection, startReceiveLoop, processValidPacket
    - Import hackrfManager, frequencyController, uiManager, DroneIDDecoder, and logger
    - Wire startDetection to read config from frequencyController, send commands via hackrfManager, update UI via uiManager
    - Wire startReceiveLoop to call hackrfManager.transferIn, pass data to decoder.processSamples, call uiManager updates on valid packets
    - Wire processValidPacket to construct DroneInfo and call uiManager.addDroneToMap and updateDroneList
    - Add detailed logging: startDetection (sample rate, LNA gain, VGA gain, band, frequency MHz), stopDetection (total duration, packets, valid DroneIDs), receive loop (transfer size at DEBUG), processValidPacket (drone ID, type, protocol, coords, altitude, speed), receive errors (message, retry delay)
    - Export singleton instance
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

- [ ] 11. Implement Main application module and wire everything together
  - [x] 11.1 Create `js/main.js` that imports and initializes all modules
    - Import logger, hackrfManager, frequencyController, detectionController, uiManager
    - Implement init(): initialize logger, call uiManager.initMap(), check navigator.usb availability
    - Implement bindEventHandlers(): bind connect/disconnect/start/stop buttons to hackrfManager and detectionController methods, bind band selection buttons to frequencyController.selectBand, bind slider inputs to frequencyController.initSliderListeners
    - Register beforeunload handler to call hackrfManager.disconnectHackRF if connected
    - Log initialization sequence: each module loaded, WebUSB check result, readiness status
    - Remove all `onclick` attributes from `index.html` (handlers bound programmatically)
    - Auto-run init() on module load
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

- [ ] 12. Verify functional equivalence and file structure
  - [x] 12.1 Write property test: ES Module Syntax (Property 13)
    - **Property 13: ES Module Syntax**
    - For each JS file in `js/`, verify it contains at least one `export` statement and no `window.*` global assignments
    - **Validates: Requirements 12.3**
  - [x] 12.2 Write unit tests for DOM ID preservation and CSS selector preservation
    - Verify all element IDs from original `harf.html` exist in `index.html` (Property 1)
    - Verify all CSS selectors from original `<style>` block exist in `css/styles.css` (Property 2)
    - **Validates: Requirements 1.4, 2.1, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6**

- [x] 13. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Implementation uses plain JavaScript ES modules (no TypeScript, no bundler)
- Property tests use fast-check library
- Leaflet.js continues to load from CDN
- The original `harf.html` is preserved as reference
