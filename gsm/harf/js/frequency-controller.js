/**
 * Frequency Controller Module
 * Handles band selection, custom frequency slider, and gain slider controls.
 * Ported from the FREQUENCY CONTROL section of harf.html.
 */

import logger from './logger.js';

const MODULE = 'FrequencyController';

// DJI DroneID frequency constants
export const DRONEID_FREQ_2_4 = 2437000000;
export const DRONEID_FREQ_5_8 = 5200000000;
export const DRONEID_FREQ_1_4 = 1420000000;

const BAND_NAMES = {
  '2.4': '2.4 GHz (Wi-Fi Ch 6 - DroneID)',
  '5.8': '5.8 GHz (Wi-Fi DroneID)',
  '1.4': '1.4 GHz (OcuSync Legacy)',
  'custom': 'Custom Frequency'
};

class FrequencyController {
  constructor() {
    this.currentBand = '2.4';
  }

  /**
   * Select a frequency band. Ported from selectBand() in harf.html.
   * Updates UI band buttons and shows/hides custom frequency control.
   */
  selectBand(band) {
    const previousBand = this.currentBand;
    this.currentBand = band;

    document.querySelectorAll('.band-btn').forEach(btn => {
      btn.classList.remove('active');
      if (btn.dataset.band === band) {
        btn.classList.add('active');
      }
    });

    const customControl = document.getElementById('customFreqControl');
    if (customControl) {
      customControl.style.display = band === 'custom' ? 'block' : 'none';
    }

    const freq = this.getFrequencyForBand(band);
    const freqMHz = freq !== null ? (freq / 1000000).toFixed(3) : 'N/A';

    logger.info(MODULE, `Band selected: ${BAND_NAMES[band] || band}, center freq: ${freqMHz} MHz, previous band: ${previousBand}`);
  }

  /**
   * Returns the frequency in Hz for a given band name.
   * Ported from the switch statement in startDetection() of harf.html.
   */
  getFrequencyForBand(band) {
    switch (band) {
      case '2.4': return DRONEID_FREQ_2_4;
      case '5.8': return DRONEID_FREQ_5_8;
      case '1.4': return DRONEID_FREQ_1_4;
      case 'custom': return this.getCustomFrequency();
      default: return DRONEID_FREQ_2_4;
    }
  }

  /**
   * Bind slider event handlers for frequency, LNA gain, and VGA gain.
   * Ported from the addEventListener calls in harf.html.
   */
  initSliderListeners() {
    const freqSlider = document.getElementById('freqSlider');
    if (freqSlider) {
      freqSlider.addEventListener('input', (e) => {
        const freqValue = document.getElementById('freqValue');
        if (freqValue) {
          freqValue.textContent = `${e.target.value} MHz`;
        }
        logger.info(MODULE, `Custom frequency changed: ${e.target.value} MHz`);
      });
    }

    const lnaGainSlider = document.getElementById('lnaGain');
    if (lnaGainSlider) {
      let previousLNA = lnaGainSlider.value;
      lnaGainSlider.addEventListener('input', (e) => {
        const lnaValue = document.getElementById('lnaValue');
        if (lnaValue) {
          lnaValue.textContent = e.target.value;
        }
        logger.info(MODULE, `Gain changed: LNA, new value: ${e.target.value} dB, previous value: ${previousLNA} dB`);
        previousLNA = e.target.value;
      });
    }

    const vgaGainSlider = document.getElementById('vgaGain');
    if (vgaGainSlider) {
      let previousVGA = vgaGainSlider.value;
      vgaGainSlider.addEventListener('input', (e) => {
        const vgaValue = document.getElementById('vgaValue');
        if (vgaValue) {
          vgaValue.textContent = e.target.value;
        }
        logger.info(MODULE, `Gain changed: VGA, new value: ${e.target.value} dB, previous value: ${previousVGA} dB`);
        previousVGA = e.target.value;
      });
    }
  }

  /**
   * Read the custom frequency slider value and return frequency in Hz.
   * Ported from: parseInt(document.getElementById('freqSlider').value) * 1000000
   */
  getCustomFrequency() {
    const slider = document.getElementById('freqSlider');
    if (!slider) return DRONEID_FREQ_2_4;
    return parseInt(slider.value) * 1000000;
  }

  /**
   * Read the LNA gain slider value.
   * Ported from: parseInt(document.getElementById('lnaGain').value)
   */
  getLNAGain() {
    const slider = document.getElementById('lnaGain');
    if (!slider) return 20;
    return parseInt(slider.value);
  }

  /**
   * Read the VGA gain slider value.
   * Ported from: parseInt(document.getElementById('vgaGain').value)
   */
  getVGAGain() {
    const slider = document.getElementById('vgaGain');
    if (!slider) return 30;
    return parseInt(slider.value);
  }

  /**
   * Read the sample rate dropdown value.
   * Ported from: parseInt(document.getElementById('sampleRate').value)
   */
  getSampleRate() {
    const select = document.getElementById('sampleRate');
    if (!select) return 4000000;
    return parseInt(select.value);
  }
}

export default new FrequencyController();
