/**
 * UI Manager Module
 * Handles map initialization, drone markers, drone list rendering,
 * stats updates, decoder step visualization, and connection status.
 */

import logger from './logger.js';

const MODULE = 'UIManager';

class UIManager {
  constructor() {
    this.map = null;
    this.detectedDrones = new Map();
    this.lastPacketCount = 0;
    this.lastPacketTime = Date.now();
  }

  /**
   * Initialize Leaflet map centered on Juchitán de Zaragoza.
   * Creates tile layer, center marker, and detection radius circle.
   */
  initMap() {
    const juchitanCoords = [16.4333, -95.0167];
    const zoom = 14;
    const tileUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

    this.map = L.map('map').setView(juchitanCoords, zoom);

    L.tileLayer(tileUrl, {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(this.map);

    L.marker(juchitanCoords)
      .addTo(this.map)
      .bindPopup('<b>Juchitán de Zaragoza</b><br>Oaxaca, México<br>Detection Center')
      .openPopup();

    L.circle(juchitanCoords, {
      color: '#00d4ff',
      fillColor: '#00d4ff',
      fillOpacity: 0.1,
      radius: 5000
    }).addTo(this.map);

    logger.info(MODULE, `Map initialized: center=[${juchitanCoords}], zoom=${zoom}, tileURL=${tileUrl}`);
  }

  /**
   * Add or update a drone marker on the map.
   * Creates a custom icon, popup content, and updates drone count.
   * @param {object} drone - DroneInfo object
   */
  addDroneToMap(drone) {
    const isUpdate = this.detectedDrones.has(drone.id);

    if (isUpdate) {
      const existing = this.detectedDrones.get(drone.id);
      if (existing.marker) this.map.removeLayer(existing.marker);
    }

    const icon = L.divIcon({
      className: 'custom-drone-marker',
      html: `<div class="custom-marker">${drone.id.substr(-2)}</div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    const popupContent = `
      <b>${drone.type}</b><br>
      <b>ID:</b> ${drone.displayId}<br>
      <b>Protocol:</b> ${drone.protocol}<br>
      <b>Type:</b> ${drone.packetType}<br>
      <b>Position:</b> ${drone.lat.toFixed(6)}, ${drone.lng.toFixed(6)}<br>
      <b>Altitude:</b> ${drone.altitude.toFixed(1)}m<br>
      <b>Speed:</b> ${drone.speedH?.toFixed(1) || 0} m/s<br>
      <b>Heading:</b> ${drone.heading?.toFixed(1) || 0}°<br>
      <b>Time:</b> ${drone.timestamp.toLocaleTimeString()}<br>
      ${drone.crcValid !== undefined ? `<b>CRC:</b> ${drone.crcValid ? '✓ Valid' : '✗ Invalid'}<br>` : ''}
      ${drone.rawHex ? `<div class="packet-hex">${drone.rawHex.substring(0, 100)}...</div>` : ''}
    `;

    const marker = L.marker([drone.lat, drone.lng], { icon: icon })
      .addTo(this.map)
      .bindPopup(popupContent);

    drone.marker = marker;
    this.detectedDrones.set(drone.id, drone);

    const droneCountEl = document.getElementById('droneCount');
    if (droneCountEl) droneCountEl.textContent = this.detectedDrones.size;

    const validDroneIDEl = document.getElementById('validDroneID');
    if (validDroneIDEl) validDroneIDEl.textContent = validDroneIDEl.textContent; // preserved; updated externally

    logger.info(MODULE, `addDroneToMap: id=${drone.id}, coords=[${drone.lat.toFixed(6)}, ${drone.lng.toFixed(6)}], ${isUpdate ? 'updated' : 'new'}, total=${this.detectedDrones.size}`);
  }

  /**
   * Update the drone list panel, sorted by timestamp (newest first).
   * Each item is clickable to focus the map on that drone.
   */
  updateDroneList() {
    const list = document.getElementById('droneList');
    if (!list) return;

    if (this.detectedDrones.size === 0) {
      list.innerHTML = '<div style="color: #b0bec5; text-align: center; padding: 20px;">No drones detected</div>';
      logger.debug(MODULE, 'updateDroneList: drone count=0');
      return;
    }

    list.innerHTML = '';

    // Sort by timestamp (newest first)
    const sortedDrones = Array.from(this.detectedDrones.values())
      .sort((a, b) => b.timestamp - a.timestamp);

    const mapRef = this.map;

    sortedDrones.forEach(drone => {
      const item = document.createElement('div');
      item.className = 'drone-item';
      item.innerHTML = `
        <div class="drone-id">${drone.displayId}</div>
        <div class="drone-type">${drone.type} | ${drone.protocol}</div>
        <div class="drone-coords">
          ${drone.lat.toFixed(5)}, ${drone.lng.toFixed(5)} | 
          ${drone.altitude.toFixed(0)}m | 
          ${drone.speedH?.toFixed(1) || 0}m/s
        </div>
        <div class="drone-meta">
          ${drone.packetType} | ${drone.timestamp.toLocaleTimeString()}
          ${drone.crcValid === false ? ' | <span style="color:#ff5252">CRC FAIL</span>' : ''}
        </div>
      `;

      item.onclick = () => {
        mapRef.setView([drone.lat, drone.lng], 17);
        drone.marker.openPopup();

        // Highlight in list
        document.querySelectorAll('.drone-item').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
      };

      list.appendChild(item);
    });

    logger.info(MODULE, `updateDroneList: drone count=${this.detectedDrones.size}`);
  }

  /**
   * Update scan time display using requestAnimationFrame.
   * @param {number} scanStartTime - Timestamp when scanning started (Date.now())
   */
  updateStats(scanStartTime) {
    const scanTimeEl = document.getElementById('scanTime');
    if (!scanTimeEl) return;

    const elapsed = Math.floor((Date.now() - scanStartTime) / 1000);
    scanTimeEl.textContent = `${elapsed}s`;
  }

  /**
   * Update packet rate display.
   * @param {number} packetCount - Total packets received so far
   */
  updatePacketRate(packetCount) {
    const now = Date.now();
    const dt = (now - this.lastPacketTime) / 1000;
    const dp = packetCount - this.lastPacketCount;
    const rate = Math.round(dp / dt);

    const packetRateEl = document.getElementById('packetRate');
    if (packetRateEl) packetRateEl.textContent = rate;

    this.lastPacketCount = packetCount;
    this.lastPacketTime = now;
  }

  /**
   * Update signal strength display from raw I/Q data.
   * Computes RMS power and converts to approximate dBm.
   * @param {Uint8Array} iqData - Raw I/Q sample data
   */
  updateSignalStrength(iqData) {
    // Calculate RMS power from I/Q samples
    let power = 0;
    for (let i = 0; i < iqData.length; i += 2) {
      const iSample = (iqData[i] & 0xFF) - 128;
      const qSample = (iqData[i + 1] & 0xFF) - 128;
      power += (iSample * iSample + qSample * qSample);
    }
    power = power / (iqData.length / 2);

    // Convert to dBm (approximate for HackRF)
    const dbm = 10 * Math.log10(power) - 30;

    const signalEl = document.getElementById('signalStrength');
    if (signalEl) signalEl.textContent = `${dbm.toFixed(1)} dBm`;

    logger.debug(MODULE, `updateSignalStrength: rmsPower=${power.toFixed(2)}, dBm=${dbm.toFixed(1)}`);
  }

  /**
   * Update decoder step icon and CSS class.
   * @param {string} step - Step key: 'iq', 'fft', 'demod', 'decode', 'parse'
   * @param {string} status - Status: 'active', 'complete', 'error', or '' (reset)
   */
  updateDecoderStep(step, status) {
    const steps = {
      'iq': 'step-iq',
      'fft': 'step-fft',
      'demod': 'step-demod',
      'decode': 'step-decode',
      'parse': 'step-parse'
    };

    const element = document.getElementById(steps[step]);
    if (!element) return;

    element.className = `decoder-step ${status}`;
    const icon = element.querySelector('.step-icon');

    if (status === 'active') {
      icon.textContent = '◐';
    } else if (status === 'complete') {
      icon.textContent = '✓';
    } else if (status === 'error') {
      icon.textContent = '✗';
    } else {
      icon.textContent = '○';
    }

    logger.debug(MODULE, `updateDecoderStep: step=${step}, status=${status}`);
  }

  /**
   * Update connection status indicator and text.
   * @param {boolean} connected - Whether the device is connected
   */
  updateConnectionStatus(connected) {
    const indicator = document.querySelector('.status-indicator');
    const statusText = document.getElementById('statusText');

    if (connected) {
      if (indicator) indicator.className = 'status-indicator connected';
      if (statusText) statusText.textContent = 'Connected';
    } else {
      if (indicator) indicator.className = 'status-indicator disconnected';
      if (statusText) statusText.textContent = 'Disconnected';
    }

    logger.info(MODULE, `updateConnectionStatus: ${connected ? 'connected' : 'disconnected'}`);
  }

  /**
   * Centralized button enable/disable control.
   * @param {object} state - Object with button IDs as keys and boolean enabled states as values
   *   e.g. { connectBtn: true, disconnectBtn: false, startBtn: false, stopBtn: false }
   */
  setButtonStates(state) {
    for (const [id, enabled] of Object.entries(state)) {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = !enabled;
    }
  }
}

export default new UIManager();
