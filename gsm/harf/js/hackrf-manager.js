/**
 * HackRF Connection Manager Module
 * Handles WebUSB device connection, configuration, and data transfer with the HackRF device.
 */

import logger from './logger.js';

const MODULE = 'HackRFManager';

// ==================== USB CONSTANTS ====================
export const HACKRF_VENDOR_ID = 0x1d50;
export const HACKRF_PRODUCT_ID = 0x6089;
export const HACKRF_VENDOR_REQUEST_SET_TRANSCEIVER_MODE = 0x01;
export const HACKRF_VENDOR_REQUEST_SAMPLE_RATE_SET = 0x06;
export const HACKRF_VENDOR_REQUEST_BASEBAND_FILTER_BANDWIDTH_SET = 0x07;
export const HACKRF_VENDOR_REQUEST_BOARD_ID_READ = 0x0e;
export const HACKRF_VENDOR_REQUEST_VERSION_STRING_READ = 0x0f;
export const HACKRF_VENDOR_REQUEST_SET_FREQ = 0x10;
export const HACKRF_VENDOR_REQUEST_SET_LNA_GAIN = 0x13;
export const HACKRF_VENDOR_REQUEST_SET_VGA_GAIN = 0x14;
export const HACKRF_TRANSCEIVER_MODE_OFF = 0;
export const HACKRF_TRANSCEIVER_MODE_RECEIVE = 1;
export const SAMPLE_BUFFER_SIZE = 262144;

class HackRFManager {
    constructor() {
        this.device = null;
        this.isConnected = false;
    }

    async connectHackRF() {
        try {
            logger.info(MODULE, 'Requesting USB device access...');

            this.device = await navigator.usb.requestDevice({
                filters: [{ vendorId: HACKRF_VENDOR_ID, productId: HACKRF_PRODUCT_ID }]
            });

            logger.success(MODULE, `Device selected: ${this.device.productName}`);

            await this.device.open();
            logger.success(MODULE, 'Device opened');

            await this.device.selectConfiguration(1);
            logger.success(MODULE, 'Configuration selected');

            await this.device.claimInterface(0);
            logger.success(MODULE, 'Interface claimed');

            await this.getBoardInfo();

            this.isConnected = true;

            logger.success(MODULE, 'HackRF connected successfully!');
        } catch (error) {
            logger.error(MODULE, `Connection error: ${error.message}`);
            console.error(error);
            throw error;
        }
    }

    async getBoardInfo() {
        try {
            logger.info(MODULE, 'Reading board info...');

            const versionResult = await this.device.controlTransferIn({
                requestType: 'vendor',
                recipient: 'device',
                request: HACKRF_VENDOR_REQUEST_VERSION_STRING_READ,
                value: 0,
                index: 0
            }, 255);

            const decoder = new TextDecoder();
            const version = decoder.decode(versionResult.data).replace(/\0/g, '').trim();
            logger.info(MODULE, `HackRF Version: ${version}`);
        } catch (error) {
            logger.warning(MODULE, `Error reading board info: ${error.message}`);
        }
    }

    async disconnectHackRF() {
        if (this.device) {
            try {
                logger.info(MODULE, 'Setting transceiver mode to OFF...');
                await this.setTransceiverMode(HACKRF_TRANSCEIVER_MODE_OFF);
                logger.info(MODULE, 'Transceiver mode set to OFF');

                await this.device.close();
                logger.info(MODULE, 'Device closed');
            } catch (error) {
                logger.error(MODULE, `Disconnect error: ${error.message}`);
            }
        }

        this.isConnected = false;
        this.device = null;
        logger.info(MODULE, 'Device disconnected');
    }

    async setFrequency(freqHz) {
        if (!this.device || !this.isConnected) return;
        try {
            const freqMhz = Math.floor(freqHz / 1000000);
            const freqHzRemainder = freqHz % 1000000;

            // HackRF SET_FREQ (0x10) expects 8-byte little-endian payload:
            // bytes 0-3: MHz part, bytes 4-7: Hz remainder
            const buf = new Uint8Array(8);
            buf[0] = (freqMhz >>>  0) & 0xFF;
            buf[1] = (freqMhz >>>  8) & 0xFF;
            buf[2] = (freqMhz >>> 16) & 0xFF;
            buf[3] = (freqMhz >>> 24) & 0xFF;
            buf[4] = (freqHzRemainder >>>  0) & 0xFF;
            buf[5] = (freqHzRemainder >>>  8) & 0xFF;
            buf[6] = (freqHzRemainder >>> 16) & 0xFF;
            buf[7] = (freqHzRemainder >>> 24) & 0xFF;

            logger.info(MODULE, `Setting frequency: ${freqHz} Hz (${(freqHz / 1000000).toFixed(3)} MHz), MHz=${freqMhz}, remainder=${freqHzRemainder} Hz`);

            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: HACKRF_VENDOR_REQUEST_SET_FREQ,
                value: 0,
                index: 0
            }, buf);

            logger.info(MODULE, `Frequency set: ${(freqHz / 1000000).toFixed(3)} MHz`);
        } catch (error) {
            logger.error(MODULE, `Frequency set failed: ${error.message} (request=SET_FREQ, freqHz=${freqHz})`);
        }
    }

    async setSampleRate(rateHz) {
        if (!this.device || !this.isConnected) return;
        try {
            // HackRF SAMPLE_RATE_SET (0x06) expects 8-byte little-endian payload:
            // bytes 0-3: frequency in Hz, bytes 4-7: divider (1)
            const divider = 1;
            const buf = new Uint8Array(8);
            buf[0] = (rateHz >>>  0) & 0xFF;
            buf[1] = (rateHz >>>  8) & 0xFF;
            buf[2] = (rateHz >>> 16) & 0xFF;
            buf[3] = (rateHz >>> 24) & 0xFF;
            buf[4] = (divider >>>  0) & 0xFF;
            buf[5] = (divider >>>  8) & 0xFF;
            buf[6] = (divider >>> 16) & 0xFF;
            buf[7] = (divider >>> 24) & 0xFF;

            logger.info(MODULE, `Setting sample rate: ${rateHz} Hz (${(rateHz / 1000000).toFixed(1)} MS/s)`);

            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: HACKRF_VENDOR_REQUEST_SAMPLE_RATE_SET,
                value: 0,
                index: 0
            }, buf);

            // Also set baseband filter bandwidth to match
            await this.setBasebandFilterBandwidth(rateHz);

            logger.info(MODULE, `Sample rate set: ${(rateHz / 1000000).toFixed(1)} MS/s`);
        } catch (error) {
            logger.error(MODULE, `Sample rate set failed: ${error.message} (request=SAMPLE_RATE_SET, rateHz=${rateHz})`);
        }
    }

    async setBasebandFilterBandwidth(bandwidthHz) {
        if (!this.device || !this.isConnected) return;
        try {
            // Bandwidth is sent via value/index fields (little-endian split)
            const lo = bandwidthHz & 0xFFFF;
            const hi = (bandwidthHz >>> 16) & 0xFFFF;

            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: HACKRF_VENDOR_REQUEST_BASEBAND_FILTER_BANDWIDTH_SET,
                value: lo,
                index: hi
            });

            logger.debug(MODULE, `Baseband filter bandwidth set: ${(bandwidthHz / 1000000).toFixed(1)} MHz`);
        } catch (error) {
            logger.error(MODULE, `Baseband filter bandwidth set failed: ${error.message}`);
        }
    }

    async setLNAGain(gain) {
        if (!this.device || !this.isConnected) return;
        try {
            logger.info(MODULE, `Setting LNA gain: ${gain} dB`);

            const result = await this.device.controlTransferIn({
                requestType: 'vendor',
                recipient: 'device',
                request: HACKRF_VENDOR_REQUEST_SET_LNA_GAIN,
                value: 0,
                index: gain
            }, 1);

            const success = new Uint8Array(result.data.buffer)[0];
            if (success) {
                logger.info(MODULE, `LNA gain set: ${gain} dB`);
            } else {
                logger.warning(MODULE, `LNA gain set returned failure for ${gain} dB (must be multiple of 8, 0-40)`);
            }
        } catch (error) {
            logger.error(MODULE, `LNA gain set failed: ${error.message} (request=SET_LNA_GAIN 0x13, gain=${gain} dB)`);
        }
    }

    async setVGAGain(gain) {
        if (!this.device || !this.isConnected) return;
        try {
            logger.info(MODULE, `Setting VGA gain: ${gain} dB`);

            const result = await this.device.controlTransferIn({
                requestType: 'vendor',
                recipient: 'device',
                request: HACKRF_VENDOR_REQUEST_SET_VGA_GAIN,
                value: 0,
                index: gain
            }, 1);

            const success = new Uint8Array(result.data.buffer)[0];
            if (success) {
                logger.info(MODULE, `VGA gain set: ${gain} dB`);
            } else {
                logger.warning(MODULE, `VGA gain set returned failure for ${gain} dB (must be even, 0-62)`);
            }
        } catch (error) {
            logger.error(MODULE, `VGA gain set failed: ${error.message} (request=SET_VGA_GAIN 0x14, gain=${gain} dB)`);
        }
    }

    async setTransceiverMode(mode) {
        if (!this.device || !this.isConnected) return;
        const modeNames = {
            [HACKRF_TRANSCEIVER_MODE_OFF]: 'OFF',
            [HACKRF_TRANSCEIVER_MODE_RECEIVE]: 'RECEIVE'
        };
        const modeName = modeNames[mode] || `UNKNOWN(${mode})`;

        try {
            logger.info(MODULE, `Setting transceiver mode: ${modeName} (${mode})`);

            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: HACKRF_VENDOR_REQUEST_SET_TRANSCEIVER_MODE,
                value: mode,
                index: 0
            });

            logger.info(MODULE, `Transceiver mode set: ${modeName}`);
        } catch (error) {
            logger.error(MODULE, `Transceiver mode set failed: ${error.message} (request=SET_TRANSCEIVER_MODE, mode=${modeName})`);
        }
    }

    async transferIn(endpoint, length) {
        return await this.device.transferIn(endpoint, length);
    }
}

export default new HackRFManager();
