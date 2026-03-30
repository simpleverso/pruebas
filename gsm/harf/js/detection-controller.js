/**
 * Detection Controller Module
 * Handles starting/stopping scanning, the receive loop, and coordinating packet processing.
 * Ported from the DETECTION CONTROL section of harf.html.
 */

import hackrfManager, { HACKRF_TRANSCEIVER_MODE_RECEIVE, HACKRF_TRANSCEIVER_MODE_OFF, SAMPLE_BUFFER_SIZE } from './hackrf-manager.js';
import frequencyController from './frequency-controller.js';
import uiManager from './ui-manager.js';
import { DroneIDDecoder } from './droneid-decoder.js';
import logger from './logger.js';

const MODULE = 'DetectionController';

class DetectionController {
  constructor() {
    this.isScanning = false;
    this.scanStartTime = null;
    this.packetCount = 0;
    this.validDroneIDCount = 0;
    this.transferLoop = null;
    this.decoder = new DroneIDDecoder();
    this.lastSignalAlertTime = 0;
    this.signalDetectionCount = 0;
  }

  /**
   * Start detection. Ported from startDetection() in harf.html.
   * Reads config from frequencyController, sends commands via hackrfManager,
   * updates UI via uiManager.
   */
  async startDetection() {
    if (!hackrfManager.isConnected) {
      logger.warning(MODULE, 'Please connect HackRF first');
      return;
    }

    try {
      this.isScanning = true;
      this.scanStartTime = Date.now();
      this.packetCount = 0;
      this.validDroneIDCount = 0;

      uiManager.setButtonStates({
        startBtn: false,
        stopBtn: true
      });

      const indicator = document.querySelector('.status-indicator');
      if (indicator) indicator.className = 'status-indicator scanning';
      const statusText = document.getElementById('statusText');
      if (statusText) statusText.textContent = 'Scanning & Decoding...';

      // Configure device
      const sampleRate = frequencyController.getSampleRate();
      const lnaGain = frequencyController.getLNAGain();
      const vgaGain = frequencyController.getVGAGain();

      await hackrfManager.setSampleRate(sampleRate);
      await hackrfManager.setLNAGain(lnaGain);
      await hackrfManager.setVGAGain(vgaGain);

      // Set frequency based on selected band
      const freq = frequencyController.getFrequencyForBand(frequencyController.currentBand);

      await hackrfManager.setFrequency(freq);
      await hackrfManager.setTransceiverMode(HACKRF_TRANSCEIVER_MODE_RECEIVE);

      logger.info(MODULE, `startDetection: sampleRate=${sampleRate} Hz, LNA gain=${lnaGain} dB, VGA gain=${vgaGain} dB, band=${frequencyController.currentBand}, frequency=${(freq / 1000000).toFixed(3)} MHz`);
      logger.success(MODULE, 'Starting DroneID detection with real-time decoding...');

      // Start receive loop
      this.startReceiveLoop();

      // Start stats update loop
      this._updateStatsLoop();

    } catch (error) {
      logger.error(MODULE, `Start error: ${error.message}`);
      this.isScanning = false;
    }
  }

  /**
   * Stop detection. Ported from stopDetection() in harf.html.
   * Logs total scan duration, packets received, and valid DroneID packets decoded.
   */
  async stopDetection() {
    this.isScanning = false;

    if (this.transferLoop) {
      clearTimeout(this.transferLoop);
      this.transferLoop = null;
    }

    if (hackrfManager.isConnected) {
      await hackrfManager.setTransceiverMode(HACKRF_TRANSCEIVER_MODE_OFF);
    }

    uiManager.setButtonStates({
      startBtn: true,
      stopBtn: false
    });
    uiManager.updateConnectionStatus(true);

    // Reset decoder steps
    ['iq', 'fft', 'demod', 'decode', 'parse'].forEach(step => {
      uiManager.updateDecoderStep(step, '');
    });

    const duration = this.scanStartTime ? Math.floor((Date.now() - this.scanStartTime) / 1000) : 0;
    logger.info(MODULE, `stopDetection: total duration=${duration}s, packets=${this.packetCount}, valid DroneIDs=${this.validDroneIDCount}`);
  }

  /**
   * Receive loop. Ported from startReceiveLoop() in harf.html.
   * Calls hackrfManager.transferIn, passes data to decoder.processSamples,
   * calls uiManager updates on valid packets.
   */
  async startReceiveLoop() {
    if (!this.isScanning) return;

    try {
      const result = await hackrfManager.transferIn(1, SAMPLE_BUFFER_SIZE);

      if (result && result.data) {
        const data = new Uint8Array(result.data.buffer);
        this.packetCount++;

        logger.debug(MODULE, `startReceiveLoop: transfer size=${data.length} bytes`);

        // Update decoder step visualization
        uiManager.updateDecoderStep('iq', 'active');

        // Process through DroneID decoder
        const result = this.decoder.processSamples(data);

        if (result) {
          // Signal detected (ZC correlation above threshold)
          if (result.signalDetected) {
            this._handleSignalDetected(result.peak1, result.peak2);
          }

          // Full packet decoded
          if (result.packet) {
            this.validDroneIDCount++;

            const validDroneIDEl = document.getElementById('validDroneID');
            if (validDroneIDEl) validDroneIDEl.textContent = this.validDroneIDCount;

            this.processValidPacket(result.packet);
          }
        }

        // Update stats periodically
        if (this.packetCount % 10 === 0) {
          uiManager.updatePacketRate(this.packetCount);
          uiManager.updateSignalStrength(data);
        }
      }

      if (this.isScanning) {
        // Use setTimeout with 1ms to yield to the browser's rendering/event loop
        this.transferLoop = setTimeout(() => this.startReceiveLoop(), 1);
      }

    } catch (error) {
      if (this.isScanning) {
        logger.error(MODULE, `Receive error: ${error.message}, retry delay=100ms`);
        this.transferLoop = setTimeout(() => this.startReceiveLoop(), 100);
      }
    }
  }

  /**
   * Process a valid decoded packet. Ported from processValidPacket() in harf.html.
   * Constructs DroneInfo and calls uiManager.addDroneToMap and updateDroneList.
   */
  processValidPacket(packet) {
    const droneId = packet.serialNumber ||
                    packet.uasId ||
                    `DRONE-${packet.droneLat?.toFixed(4)}-${packet.droneLon?.toFixed(4)}`;

    // Create unique ID for this drone
    const uniqueId = droneId + '_' + (packet.droneLat?.toFixed(6) || '0');

    const drone = {
      id: uniqueId,
      displayId: droneId,
      type: packet.droneModel || packet.uasType || 'DJI Drone',
      protocol: packet.protocol,
      packetType: packet.packetType,
      lat: packet.droneLat || packet.pilotLat || 16.4333,
      lng: packet.droneLon || packet.pilotLon || -95.0167,
      altitude: packet.droneAlt || packet.height || 0,
      pilotLat: packet.pilotLat,
      pilotLon: packet.pilotLon,
      homeLat: packet.homeLat,
      homeLon: packet.homeLon,
      speedH: packet.speedH || 0,
      speedV: packet.speedV || 0,
      heading: packet.heading || packet.course || 0,
      timestamp: new Date(),
      rawHex: packet.rawBytes ? Array.from(packet.rawBytes).map(b => b.toString(16).padStart(2, '0')).join(' ') : '',
      crcValid: packet.crcValid
    };

    logger.info(MODULE, `processValidPacket: droneId=${drone.displayId}, type=${drone.type}, protocol=${drone.protocol}, coords=[${drone.lat.toFixed(6)}, ${drone.lng.toFixed(6)}], altitude=${drone.altitude.toFixed(1)}m, speed=${drone.speedH}m/s`);

    uiManager.addDroneToMap(drone);
    uiManager.updateDroneList();

    logger.success(MODULE, `Detected ${drone.type} [${drone.displayId}] at ${drone.altitude.toFixed(1)}m`);
  }

  /**
   * Handle drone signal detection (ZC correlation above threshold).
   * Shows a warning alert in the UI, throttled to once per 3 seconds.
   */
  _handleSignalDetected(peak1, peak2) {
    this.signalDetectionCount++;
    const now = Date.now();

    // Throttle UI alerts to once per 3 seconds
    if (now - this.lastSignalAlertTime < 3000) return;
    this.lastSignalAlertTime = now;

    logger.warning(MODULE, `⚠ Drone signal detected! ZC peaks: ${peak1.toFixed(3)} / ${peak2.toFixed(3)} (count: ${this.signalDetectionCount})`);

    // Update signal alert in UI
    uiManager.showSignalAlert(peak1, peak2);
  }

  /**
   * Internal stats update loop using requestAnimationFrame.
   * Ported from updateStats() in harf.html.
   */
  _updateStatsLoop() {
    if (!this.isScanning) return;

    uiManager.updateStats(this.scanStartTime);

    requestAnimationFrame(() => this._updateStatsLoop());
  }
}

export default new DetectionController();
