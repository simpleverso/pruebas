/**
 * Main Application Module
 * Imports and wires all modules together, initializes the application,
 * and binds all UI event handlers programmatically.
 * Ported from the INITIALIZATION section of harf.html.
 */

import logger from './logger.js';
import hackrfManager from './hackrf-manager.js';
import frequencyController from './frequency-controller.js';
import detectionController from './detection-controller.js';
import uiManager from './ui-manager.js';

const MODULE = 'Main';

/**
 * Bind all UI event handlers programmatically.
 * Replaces all onclick attributes from the original harf.html.
 */
function bindEventHandlers() {
  // Connection buttons
  const connectBtn = document.getElementById('connectBtn');
  if (connectBtn) {
    connectBtn.addEventListener('click', async () => {
      try {
        await hackrfManager.connectHackRF();
        uiManager.updateConnectionStatus(true);
        uiManager.setButtonStates({
          connectBtn: false,
          disconnectBtn: true,
          startBtn: true
        });
      } catch (error) {
        logger.error(MODULE, `Connect failed: ${error.message}`);
      }
    });
  }

  const disconnectBtn = document.getElementById('disconnectBtn');
  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', async () => {
      if (detectionController.isScanning) {
        await detectionController.stopDetection();
      }
      await hackrfManager.disconnectHackRF();
      uiManager.updateConnectionStatus(false);
      uiManager.setButtonStates({
        connectBtn: true,
        disconnectBtn: false,
        startBtn: false,
        stopBtn: false
      });
    });
  }

  // Detection control buttons
  const startBtn = document.getElementById('startBtn');
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      detectionController.startDetection();
    });
  }

  const stopBtn = document.getElementById('stopBtn');
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      detectionController.stopDetection();
    });
  }

  // Band selection buttons
  document.querySelectorAll('.band-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const band = e.target.dataset.band;
      if (band) {
        frequencyController.selectBand(band);
      }
    });
  });

  // Slider listeners (frequency, LNA gain, VGA gain)
  frequencyController.initSliderListeners();

  // Download logs button
  const downloadLogsBtn = document.getElementById('downloadLogsBtn');
  if (downloadLogsBtn) {
    downloadLogsBtn.addEventListener('click', () => logger.downloadLogs());
  }

  logger.info(MODULE, 'Event handlers bound: connect, disconnect, start, stop, band selection, sliders, download logs');
}

/**
 * Initialize the application.
 * Sets up logger, map, checks WebUSB, and binds event handlers.
 */
function init() {
  logger.info(MODULE, 'Logger module loaded');
  logger.info(MODULE, 'HackRFManager module loaded');
  logger.info(MODULE, 'FrequencyController module loaded');
  logger.info(MODULE, 'DetectionController module loaded');
  logger.info(MODULE, 'UIManager module loaded');

  // Initialize map
  uiManager.initMap();
  logger.info(MODULE, 'Map initialized');

  // Check WebUSB availability
  if (!navigator.usb) {
    logger.error(MODULE, 'WebUSB not supported. Use Chrome/Edge.');
    const connectBtn = document.getElementById('connectBtn');
    if (connectBtn) connectBtn.disabled = true;
  } else {
    logger.success(MODULE, 'WebUSB API available');
  }

  // Bind all event handlers
  bindEventHandlers();

  // Register beforeunload handler
  window.addEventListener('beforeunload', () => {
    if (hackrfManager.isConnected) {
      hackrfManager.disconnectHackRF();
    }
  });

  logger.success(MODULE, 'Application ready');
}

// Auto-run on module load
init();
