/**
 * HackRF Connection Manager Module
 * Handles WebUSB device connection, configuration, and data transfer with the HackRF device.
 */

import logger from './logger.js';

const MODULE = 'HackRFManager';

// ==================== USB CONSTANTS ====================
export const HACKRF_VENDOR_ID = 0x1d50;
export const HACKRF_PRODUCT_ID = 0x6089;
export const HACKRF_VENDOR_REQUEST_SET_TRANSCEIVER_MODE = 1;
export const HACKRF_VENDOR_REQUEST_SET_FREQUENCY = 2;
export const HACKRF_VENDOR_REQUEST_SET_SAMPLE_RATE = 3;
export const HACKRF_VENDOR_REQUEST_SET_LNA_GAIN = 4;
export const HACKRF_VENDOR_REQUEST_SET_VGA_GAIN = 5;
export const HACKRF_VENDOR_REQUEST_SET_BASEBAND_FILTER_BANDWIDTH = 8;
export const HACKRF_VENDOR_REQUEST_BOARD_ID_READ = 14;
export const HACKRF_VENDOR_REQUEST_VERSION_STRING_READ = 15;
export const HACKRF_VENDOR_REQUEST_SET_FREQ = 16;
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

            logger.info(MODULE, `Setting frequency: ${freqHz} Hz (${(freqHz / 1000000).toFixed(3)} MHz), value=${freqMhz & 0xFFFF}, index=${(freqMhz >> 16) & 0xFFFF}`);

            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: HACKRF_VENDOR_REQUEST_SET_FREQUENCY,
                value: freqMhz & 0xFFFF,
                index: (freqMhz >> 16) & 0xFFFF
            });

            if (freqHzRemainder > 0) {
                logger.debug(MODULE, `Setting fine frequency: remainder=${freqHzRemainder} Hz, value=${freqHzRemainder & 0xFFFF}, index=${(freqHzRemainder >> 16) & 0xFFFF}`);

                await this.device.controlTransferOut({
                    requestType: 'vendor',
                    recipient: 'device',
                    request: HACKRF_VENDOR_REQUEST_SET_FREQ,
                    value: freqHzRemainder & 0xFFFF,
                    index: (freqHzRemainder >> 16) & 0xFFFF
                });
            }

            logger.info(MODULE, `Frequency set: ${(freqHz / 1000000).toFixed(3)} MHz`);
        } catch (error) {
            logger.error(MODULE, `Frequency set failed: ${error.message} (request=SET_FREQUENCY, freqHz=${freqHz})`);
        }
    }

    async setSampleRate(rateHz) {
        if (!this.device || !this.isConnected) return;
        try {
            logger.info(MODULE, `Setting sample rate: ${rateHz} Hz (${(rateHz / 1000000).toFixed(1)} MS/s), value=${rateHz & 0xFFFF}, index=${(rateHz >> 16) & 0xFFFF}`);

            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: HACKRF_VENDOR_REQUEST_SET_SAMPLE_RATE,
                value: rateHz & 0xFFFF,
                index: (rateHz >> 16) & 0xFFFF
            });

            logger.info(MODULE, `Sample rate set: ${(rateHz / 1000000).toFixed(1)} MS/s`);
        } catch (error) {
            logger.error(MODULE, `Sample rate set failed: ${error.message} (request=SET_SAMPLE_RATE, rateHz=${rateHz})`);
        }
    }

    async setLNAGain(gain) {
        if (!this.device || !this.isConnected) return;
        try {
            logger.info(MODULE, `Setting LNA gain: ${gain} dB`);

            await this.device.controlTransferIn({
                requestType: 'vendor',
                recipient: 'device',
                request: HACKRF_VENDOR_REQUEST_SET_LNA_GAIN,
                value: 0,
                index: gain
            }, 1);

            logger.info(MODULE, `LNA gain set: ${gain} dB`);
        } catch (error) {
            logger.error(MODULE, `LNA gain set failed: ${error.message} (request=SET_LNA_GAIN, gain=${gain} dB)`);
        }
    }

    async setVGAGain(gain) {
        if (!this.device || !this.isConnected) return;
        try {
            logger.info(MODULE, `Setting VGA gain: ${gain} dB`);

            await this.device.controlTransferIn({
                requestType: 'vendor',
                recipient: 'device',
                request: HACKRF_VENDOR_REQUEST_SET_VGA_GAIN,
                value: 0,
                index: gain
            }, 1);

            logger.info(MODULE, `VGA gain set: ${gain} dB`);
        } catch (error) {
            logger.error(MODULE, `VGA gain set failed: ${error.message} (request=SET_VGA_GAIN, gain=${gain} dB)`);
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
