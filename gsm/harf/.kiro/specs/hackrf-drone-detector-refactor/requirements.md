# Requirements Document

## Introduction

The HackRF Drone Detector application is currently a single monolithic HTML file (`harf.html`, ~1445 lines) containing all HTML structure, CSS styles, and JavaScript logic. This refactoring effort separates the application into well-organized, modular files by concern and adds comprehensive, detailed logging throughout every layer of the application to aid debugging, monitoring, and development.

## Glossary

- **Application**: The HackRF Drone Detector web application
- **Module**: A self-contained JavaScript ES module file responsible for a single concern
- **Entry_Point**: The main HTML file (`index.html`) that loads all modules and stylesheets
- **CSS_Stylesheet**: An external `.css` file containing all visual styles for the Application
- **Logger**: The centralized logging utility Module responsible for all log output
- **HackRF_Manager**: The Module responsible for WebUSB device connection, configuration, and data transfer with the HackRF device
- **Frequency_Controller**: The Module responsible for frequency band selection, slider controls, and gain configuration
- **DSP_Module**: The Module containing Complex number operations, FFT (Cooley-Tukey), Zadoff-Chu sequence generation, and Gold sequence generation classes
- **DroneID_Decoder**: The Module containing OFDM demodulation, QPSK demodulation, descrambling, turbo decoding, and DJI DroneID / ASTM F3411 RemoteID packet parsing
- **Detection_Controller**: The Module responsible for starting/stopping scanning, the receive loop, and coordinating packet processing
- **UI_Manager**: The Module responsible for map initialization, drone markers, drone list rendering, stats updates, and decoder step visualization
- **Log_Level**: A severity classification for log messages: DEBUG, INFO, WARNING, ERROR, SUCCESS
- **Detailed_Log**: A log statement that includes contextual data such as parameter values, timing, byte counts, computed results, or state transitions

## Requirements

### Requirement 1: Separate HTML Structure into Entry Point

**User Story:** As a developer, I want the HTML structure in a standalone `index.html` file that loads external CSS and JS modules, so that I can navigate and edit the markup independently.

#### Acceptance Criteria

1. THE Entry_Point SHALL contain only HTML markup, external CSS link tags, and ES module script tags
2. THE Entry_Point SHALL load the CSS_Stylesheet via a `<link>` element
3. THE Entry_Point SHALL load the main JavaScript Module via a `<script type="module">` element
4. THE Entry_Point SHALL preserve the identical DOM structure and element IDs present in the original `harf.html`
5. WHEN the Entry_Point is opened in a browser, THE Application SHALL render identically to the original `harf.html`

### Requirement 2: Extract CSS into External Stylesheet

**User Story:** As a developer, I want all CSS styles in a dedicated stylesheet file, so that I can modify visual presentation without touching HTML or JavaScript.

#### Acceptance Criteria

1. THE CSS_Stylesheet SHALL contain all style rules currently embedded in the `<style>` block of `harf.html`
2. THE CSS_Stylesheet SHALL be stored as `css/styles.css` relative to the Entry_Point
3. THE CSS_Stylesheet SHALL produce identical visual rendering when loaded by the Entry_Point compared to the original inline styles

### Requirement 3: Create Centralized Logger Module

**User Story:** As a developer, I want a centralized logging module with configurable log levels and detailed contextual output, so that I can trace every operation in the application.

#### Acceptance Criteria

1. THE Logger SHALL be stored as `js/logger.js` as an ES module
2. THE Logger SHALL support five Log_Level values: DEBUG, INFO, WARNING, ERROR, and SUCCESS
3. THE Logger SHALL expose methods for each Log_Level: `debug()`, `info()`, `warning()`, `error()`, and `success()`
4. WHEN a log method is called, THE Logger SHALL prepend a timestamp, the Log_Level label, and the caller module name to the message
5. THE Logger SHALL render log entries to the `#logConsole` DOM element with the appropriate CSS class for the Log_Level
6. THE Logger SHALL also output log entries to the browser `console` using the corresponding console method (console.debug, console.info, console.warn, console.error, console.log)
7. WHERE a configurable minimum Log_Level is set, THE Logger SHALL suppress log entries below that level

### Requirement 4: Create HackRF Connection Manager Module

**User Story:** As a developer, I want HackRF USB connection logic in its own module with detailed logging of every USB operation, so that I can debug connection issues and understand device communication.

#### Acceptance Criteria

1. THE HackRF_Manager SHALL be stored as `js/hackrf-manager.js` as an ES module
2. THE HackRF_Manager SHALL contain all WebUSB device connection, disconnection, and board info retrieval logic
3. THE HackRF_Manager SHALL contain all device control functions: setFrequency, setSampleRate, setLNAGain, setVGAGain, setTransceiverMode
4. THE HackRF_Manager SHALL contain all HackRF USB constants (vendor ID, product ID, vendor request codes, transceiver modes, buffer size)
5. WHEN connectHackRF is called, THE HackRF_Manager SHALL log a Detailed_Log entry for each step: USB device request, device open, configuration selection, interface claim, and board info retrieval, including device name and firmware version
6. WHEN disconnectHackRF is called, THE HackRF_Manager SHALL log a Detailed_Log entry for transceiver mode off and device close, including any error details
7. WHEN setFrequency is called, THE HackRF_Manager SHALL log the target frequency in both Hz and MHz, the computed value/index parameters, and success or failure
8. WHEN setSampleRate is called, THE HackRF_Manager SHALL log the target rate in Hz and MS/s, and success or failure
9. WHEN setLNAGain or setVGAGain is called, THE HackRF_Manager SHALL log the gain value in dB and success or failure
10. WHEN setTransceiverMode is called, THE HackRF_Manager SHALL log the mode name (OFF, RECEIVE) and success or failure
11. IF a USB control transfer fails, THEN THE HackRF_Manager SHALL log the error message, the request type, and the parameters that were sent

### Requirement 5: Create Frequency Controller Module

**User Story:** As a developer, I want frequency band selection and gain controls in their own module with detailed logging, so that I can trace every configuration change.

#### Acceptance Criteria

1. THE Frequency_Controller SHALL be stored as `js/frequency-controller.js` as an ES module
2. THE Frequency_Controller SHALL contain band selection logic, custom frequency slider handling, and gain slider event handlers
3. THE Frequency_Controller SHALL contain the DJI DroneID frequency constants (2.4 GHz, 5.8 GHz, 1.4 GHz)
4. WHEN a band is selected, THE Frequency_Controller SHALL log the band name, the corresponding center frequency in MHz, and the previous band
5. WHEN the custom frequency slider value changes, THE Frequency_Controller SHALL log the new frequency value in MHz
6. WHEN an LNA or VGA gain slider value changes, THE Frequency_Controller SHALL log the gain type, the new value in dB, and the previous value

### Requirement 6: Create DSP Module

**User Story:** As a developer, I want DSP classes (Complex, FFT, ZadoffChu, GoldSequence) in their own module with detailed logging, so that I can debug signal processing independently.

#### Acceptance Criteria

1. THE DSP_Module SHALL be stored as `js/dsp.js` as an ES module
2. THE DSP_Module SHALL export the Complex, FFT, ZadoffChu, and GoldSequence classes
3. THE DSP_Module SHALL preserve the identical algorithms and numerical behavior of the original classes
4. WHEN an FFT instance is constructed, THE DSP_Module SHALL log the FFT size and the number of bit-reversed indices computed
5. WHEN FFT.forward is called, THE DSP_Module SHALL log the input length, the number of butterfly stages, and the execution time in milliseconds
6. WHEN ZadoffChu.generate is called, THE DSP_Module SHALL log the root index, the sequence length, and the execution time
7. WHEN a GoldSequence is constructed, THE DSP_Module SHALL log the seed value and the initial LFSR states
8. WHEN GoldSequence.generate is called, THE DSP_Module SHALL log the requested length and the execution time

### Requirement 7: Create DroneID Decoder Module

**User Story:** As a developer, I want the DroneID decoder in its own module with detailed logging of every decoding stage, so that I can trace signal processing from raw I/Q to parsed packets.

#### Acceptance Criteria

1. THE DroneID_Decoder SHALL be stored as `js/droneid-decoder.js` as an ES module
2. THE DroneID_Decoder SHALL contain the DroneIDDecoder class with all OFDM demodulation, QPSK demodulation, descrambling, turbo decoding, and packet parsing logic
3. THE DroneID_Decoder SHALL preserve the identical decoding algorithms and packet parsing behavior of the original class
4. WHEN processSamples is called, THE DroneID_Decoder SHALL log the number of raw I/Q bytes received, the number of Complex samples produced, and the current frame buffer length
5. WHEN processFrame is called, THE DroneID_Decoder SHALL log the Zadoff-Chu correlation peak values for both root sequences and whether the correlation threshold (0.7) was exceeded
6. WHEN extractSubcarriers is called, THE DroneID_Decoder SHALL log the number of extracted subcarriers and the start bin index
7. WHEN qpskDemodulate is called, THE DroneID_Decoder SHALL log the number of input symbols and the number of output bits
8. WHEN descramble is called, THE DroneID_Decoder SHALL log the Gold sequence seed used and the bit count
9. WHEN turboDecode is called, THE DroneID_Decoder SHALL log the block size and the interleaver pattern length
10. WHEN parsePacket is called, THE DroneID_Decoder SHALL log the number of bytes, whether an OUI signature was found, the OUI type (DJI or RemoteID), and the offset
11. WHEN parseDJIDroneID successfully parses a packet, THE DroneID_Decoder SHALL log the subcommand byte, the packet type, all parsed coordinate values, speed, heading, serial number, and drone model
12. WHEN parseRemoteID successfully parses a packet, THE DroneID_Decoder SHALL log the message type, the packet type, and all parsed fields including UAS ID, coordinates, altitude, and speed
13. IF parsePacket finds no OUI signature, THEN THE DroneID_Decoder SHALL log a debug message indicating no signature was found in the byte stream

### Requirement 8: Create Detection Controller Module

**User Story:** As a developer, I want detection start/stop and the receive loop in their own module with detailed logging, so that I can trace the scanning lifecycle and data flow.

#### Acceptance Criteria

1. THE Detection_Controller SHALL be stored as `js/detection-controller.js` as an ES module
2. THE Detection_Controller SHALL contain startDetection, stopDetection, startReceiveLoop, and processValidPacket functions
3. WHEN startDetection is called, THE Detection_Controller SHALL log the configured sample rate, LNA gain, VGA gain, selected frequency band, and the resolved frequency in MHz
4. WHEN stopDetection is called, THE Detection_Controller SHALL log the total scan duration, total packets received, and total valid DroneID packets decoded
5. WHEN startReceiveLoop receives data, THE Detection_Controller SHALL log the transfer size in bytes at DEBUG level for every transfer
6. WHEN processValidPacket is called, THE Detection_Controller SHALL log the drone ID, drone type, protocol, coordinates, altitude, and speed
7. IF a receive transfer fails, THEN THE Detection_Controller SHALL log the error message and the retry delay

### Requirement 9: Create UI Manager Module

**User Story:** As a developer, I want all UI update logic (map, drone list, stats, decoder steps) in their own module with detailed logging, so that I can trace every visual update.

#### Acceptance Criteria

1. THE UI_Manager SHALL be stored as `js/ui-manager.js` as an ES module
2. THE UI_Manager SHALL contain map initialization, addDroneToMap, updateDroneList, updateStats, updatePacketRate, updateSignalStrength, updateDecoderStep, and updateConnectionStatus functions
3. WHEN initMap is called, THE UI_Manager SHALL log the map center coordinates, zoom level, and tile layer URL
4. WHEN addDroneToMap is called, THE UI_Manager SHALL log the drone ID, coordinates, whether the marker is new or updated, and the total drone count on the map
5. WHEN updateDroneList is called, THE UI_Manager SHALL log the number of drones rendered in the list
6. WHEN updateSignalStrength is called, THE UI_Manager SHALL log the computed RMS power and the dBm value
7. WHEN updateDecoderStep is called, THE UI_Manager SHALL log the step name and the new status (active, complete, error)
8. WHEN updateConnectionStatus is called, THE UI_Manager SHALL log the connection state transition (connected or disconnected)

### Requirement 10: Create Main Application Module

**User Story:** As a developer, I want a main entry-point module that imports and wires all other modules together, so that the application initializes correctly from modular components.

#### Acceptance Criteria

1. THE Application SHALL have a main module stored as `js/main.js` that imports all other Modules
2. WHEN the main module loads, THE Application SHALL initialize the Logger, the UI_Manager (including the map), and check for WebUSB API availability
3. WHEN the main module loads, THE Application SHALL bind all UI event handlers (connect, disconnect, start, stop, band selection, slider changes) to the corresponding Module functions
4. THE Application SHALL log the initialization sequence: each module loaded, WebUSB availability check result, and readiness status
5. THE Application SHALL register a beforeunload handler that calls disconnectHackRF if connected

### Requirement 11: Preserve Functional Equivalence

**User Story:** As a developer, I want the refactored application to behave identically to the original monolithic file, so that no functionality is lost or broken during refactoring.

#### Acceptance Criteria

1. THE Application SHALL support the same HackRF WebUSB connection workflow as the original `harf.html`
2. THE Application SHALL support the same frequency band selection (2.4 GHz, 5.8 GHz, 1.4 GHz, Custom) as the original
3. THE Application SHALL support the same DSP pipeline (FFT, Zadoff-Chu correlation, QPSK demodulation, Gold sequence descrambling, turbo decoding) as the original
4. THE Application SHALL support the same DJI DroneID and ASTM F3411 RemoteID packet parsing as the original
5. THE Application SHALL support the same map visualization with drone markers, popups, and detection radius as the original
6. THE Application SHALL support the same drone list rendering, stats updates, and decoder step visualization as the original
7. IF the original `harf.html` handles an error condition, THEN THE Application SHALL handle the same error condition in the same manner

### Requirement 12: Organized File Structure

**User Story:** As a developer, I want a clear, predictable file structure, so that I can quickly locate any piece of code by its concern.

#### Acceptance Criteria

1. THE Application SHALL organize files into the following structure: `index.html` at root, `css/` directory for stylesheets, and `js/` directory for all JavaScript modules
2. THE Application SHALL have one JavaScript module file per concern: logger, hackrf-manager, frequency-controller, dsp, droneid-decoder, detection-controller, ui-manager, and main
3. THE Application SHALL use ES module `import`/`export` syntax for all inter-module dependencies
4. THE Application SHALL have no inline `<script>` blocks or inline `<style>` blocks in the Entry_Point
